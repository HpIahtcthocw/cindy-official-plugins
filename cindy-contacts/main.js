'use strict';
/**
 * cindy-contacts 电子脑：数据层 + AI 工具 + 主视图请求通道。
 *
 * 数据放在插件 Library 的 contacts.sqlite（按账号隔离、卸载插件不删资料）。
 * 表结构沿用旧版内置通讯录（contacts / contact_identities / contact_events /
 * contact_groups / contact_group_members / contact_relations），旧数据按行原样
 * 复制，id、状态与时间戳都不变。全文索引与设备同步状态不迁移：前者用子串检索
 * 代替（中文为主的通讯录里 FTS 本来就要回落子串），后者需要宿主设备通道，暂不提供。
 *
 * 并发：所有读改写都排进同一条串行队列；对外入口（工具、主视图请求）各自只进一次队列，
 * 队列内部的函数互相调用时不再排队，避免自锁。
 */

const DB = 'contacts.sqlite';
const CHANNEL = 'cindy-contacts';
const BATCH_MAX = 200;

/* ───────────── 基础工具 ───────────── */

function fail(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) e.extra = extra;
  return e;
}

function uuid() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

function parseAliases(raw) {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch (_) {
    return [];
  }
}

function uniqueStrings(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const s = str(v);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

/** platform 归一化：trim + 小写；与旧版一致校验 [a-z0-9_-]{1,32}。 */
function normalizePlatform(platform) {
  const p = str(platform).toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(p)) throw fail('INVALID_PARAMS', `invalid platform: ${platform}`);
  return p;
}

/** 身份匹配键：与旧版一致（小写、去 @ 前缀；电话只留数字和 +）。 */
function normalizeIdentityValue(value, platform) {
  let v = str(value).toLowerCase();
  if (v.startsWith('@')) v = v.slice(1);
  if (platform === 'phone') {
    const c = v.replace(/[^0-9+]/g, '');
    if (c.replace(/\+/g, '').length > 0) return c;
  }
  return v;
}

function nameFacet(name) {
  const lower = str(name).toLowerCase();
  const norm = lower.replace(/[\s·.,_-]+/g, '');
  return {
    norm,
    cjk: /[㐀-鿿豈-﫿]/.test(norm),
    toks: new Set(lower.split(/[\s·.,_-]+/).filter(Boolean)),
  };
}

/** 名字相似：完全相同；含中文时短名（≥2 字）被长名包含；拉丁名按整词子集。 */
function facetsSimilar(a, b) {
  if (!a.norm || !b.norm) return false;
  if (a.norm === b.norm) return true;
  // 只差编号的名字（客户1 / 客户10、门店 A2 / A20）不是同一个人。
  const da = a.norm.replace(/\D+/g, ' ').trim();
  const db = b.norm.replace(/\D+/g, ' ').trim();
  if ((da || db) && da !== db) return false;
  if (a.cjk || b.cjk) {
    const [s, l] = a.norm.length <= b.norm.length ? [a, b] : [b, a];
    if (s.cjk) return s.norm.length >= 2 && l.norm.includes(s.norm);
  }
  const [sm, bg] = a.toks.size <= b.toks.size ? [a.toks, b.toks] : [b.toks, a.toks];
  if (sm.size === 0) return false;
  for (const t of sm) if (!bg.has(t)) return false;
  return [...sm].some((t) => t.length >= 3);
}

/* ───────────── Library 访问 ───────────── */

async function lib(req) {
  const r = await cindy.library(req);
  if (!r || r.ok === false) {
    throw fail((r && r.errorCode) || 'LIBRARY_ERROR', (r && r.message) || 'Library request failed');
  }
  return r;
}

async function q(sql, params) {
  const r = await lib({ op: 'db.exec', dbPath: DB, sql, params: params || [] });
  return r.rows || [];
}

/** 分页取全量（宿主单次结果最多 2000 行）。 */
async function qAll(sql, params) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await q(`${sql} LIMIT ? OFFSET ?`, [...(params || []), 1000, offset]);
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

/** 单批原子提交；超过 200 条的写入由调用方自行切成多个幂等批次。 */
async function batch(statements) {
  const list = statements.filter(Boolean);
  if (!list.length) return;
  if (list.length > BATCH_MAX) throw fail('INTERNAL', 'batch too large');
  await lib({ op: 'db.batch', dbPath: DB, statements: list });
}

async function batchChunks(statements) {
  for (let i = 0; i < statements.length; i += BATCH_MAX) {
    await batch(statements.slice(i, i + BATCH_MAX));
  }
}

let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/* ───────────── 建库 ───────────── */

const SCHEMA_V1 = [
  `CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('person', 'org')),
    display_name TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL DEFAULT '',
    narrative TEXT NOT NULL DEFAULT '',
    agent_notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'pending')),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'agent', 'import')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS contact_identities (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    value TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (platform, normalized_value)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_contact_identities_contact ON contact_identities(contact_id)',
  `CREATE TABLE IF NOT EXISTS contact_events (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_contact_events_contact ON contact_events(contact_id, date DESC)',
  `CREATE TABLE IF NOT EXISTS contact_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS contact_group_members (
    group_id TEXT NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, contact_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_contact_group_members_contact ON contact_group_members(contact_id)',
  `CREATE TABLE IF NOT EXISTS contact_relations (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (from_id, to_id, relation)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_contact_relations_from ON contact_relations(from_id)',
  'CREATE INDEX IF NOT EXISTS idx_contact_relations_to ON contact_relations(to_id)',
  `CREATE TABLE IF NOT EXISTS plugin_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

const SCHEMA_VERSION = 1;

const state = {
  ready: false,
  error: null,
  platform: null,
  importing: null, // 'legacy' | 'system' | null
  progress: null,
  legacy: null, // { status, counts?, at? }
};

let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const opened = await lib({ op: 'open' });
      if (opened.state && opened.state !== 'ready') {
        throw fail('LIBRARY_UNAVAILABLE', `资料库当前不可用（${opened.reason || opened.state}），请在 Cindy 设置中检查插件资料库位置。`);
      }
      await lib({ op: 'db.open', dbPath: DB });
      // 宿主每次 db.migrate 都会先做一份备份；已是最新版本时跳过，避免每次启动都多一份备份。
      let version = -1;
      try {
        version = Number((await lib({ op: 'db.userVersion', dbPath: DB })).version);
      } catch (_) {
        version = -1;
      }
      if (!(version >= SCHEMA_VERSION)) {
        await lib({ op: 'db.migrate', dbPath: DB, targetVersion: SCHEMA_VERSION, steps: [{ toVersion: 1, sql: SCHEMA_V1 }] });
      }
      state.ready = true;
      state.error = null;
      state.legacy = await getMeta('legacy_import');
      startLegacyImportOnce();
    })();
    readyPromise.catch((e) => {
      state.error = { code: e.code || 'INTERNAL', message: e.message };
      readyPromise = null;
    });
  }
  return readyPromise;
}

async function getMeta(key) {
  const rows = await q('SELECT value FROM plugin_meta WHERE key = ?', [key]);
  if (!rows.length) return null;
  try {
    return JSON.parse(rows[0].value);
  } catch (_) {
    return null;
  }
}

function setMetaStmt(key, value) {
  return { sql: 'REPLACE INTO plugin_meta (key, value) VALUES (?, ?)', params: [key, JSON.stringify(value)] };
}

/* ───────────── Node 工作进程 ───────────── */

async function nodeCall(method, params, opts) {
  const r = await cindy.node.request({ method, params: params || {}, timeoutMs: (opts && opts.timeoutMs) || 30000 });
  if (!r || !r.ok) {
    const message = (r && r.message) || 'Node worker request failed';
    const m = /^([A-Z_]+): /.exec(message);
    throw fail(m ? m[1] : 'NODE_FAILED', m ? message.slice(m[0].length) : message);
  }
  return r.result;
}

async function platform() {
  if (!state.platform) {
    try {
      state.platform = (await nodeCall('env/info')).platform;
    } catch (_) {
      state.platform = 'unknown';
    }
  }
  return state.platform;
}

/* ───────────── 读 ───────────── */

const LIST_SQL = `SELECT c.id, c.kind, c.display_name, c.aliases, c.summary, c.status, c.source, c.updated_at,
  (SELECT MAX(e.date) FROM contact_events e WHERE e.contact_id = c.id) AS last_event,
  (SELECT group_concat(g.name, char(31)) FROM contact_group_members m JOIN contact_groups g ON g.id = m.group_id
    WHERE m.contact_id = c.id) AS group_names
  FROM contacts c ORDER BY c.display_name`;

function lastTouched(row) {
  const a = str(row.last_event).slice(0, 10);
  const b = str(row.updated_at).slice(0, 10);
  return a > b ? a : b;
}

function listRow(r) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.display_name,
    aliases: parseAliases(r.aliases),
    summary: r.summary,
    status: r.status,
    source: r.source,
    last: lastTouched(r),
    groups: r.group_names ? String(r.group_names).split('\u001f') : [],
  };
}

async function listContacts() {
  return (await qAll(LIST_SQL)).map(listRow);
}

async function listGroups() {
  return q(
    `SELECT g.id, g.name, g.description, (SELECT count(*) FROM contact_group_members m WHERE m.group_id = g.id) AS members
     FROM contact_groups g ORDER BY g.name`,
  );
}

async function requireContact(id) {
  const rows = await q('SELECT * FROM contacts WHERE id = ?', [str(id)]);
  if (!rows.length) throw fail('NOT_FOUND', `contact not found: ${id}`);
  return rows[0];
}

async function getContact(id, opts) {
  const c = await requireContact(id);
  const eventLimit = (opts && opts.eventLimit) || 500;
  const [identities, events, groups, relations] = await Promise.all([
    q('SELECT id, platform, value, label, note FROM contact_identities WHERE contact_id = ? ORDER BY created_at', [c.id]),
    q('SELECT id, date, text, source FROM contact_events WHERE contact_id = ? ORDER BY date DESC, created_at DESC LIMIT ?', [c.id, eventLimit]),
    q(
      `SELECT g.id, g.name FROM contact_group_members m JOIN contact_groups g ON g.id = m.group_id
       WHERE m.contact_id = ? ORDER BY g.name`,
      [c.id],
    ),
    q(
      `SELECT r.id, r.relation, r.note, CASE WHEN r.from_id = :id THEN 'out' ELSE 'in' END AS direction,
         o.id AS other_id, o.display_name AS other_name, o.kind AS other_kind
       FROM contact_relations r JOIN contacts o ON o.id = CASE WHEN r.from_id = :id THEN r.to_id ELSE r.from_id END
       WHERE r.from_id = :id OR r.to_id = :id ORDER BY r.created_at`,
      { id: c.id },
    ),
  ]);
  return {
    id: c.id,
    kind: c.kind,
    name: c.display_name,
    aliases: parseAliases(c.aliases),
    summary: c.summary,
    narrative: c.narrative,
    agentNotes: c.agent_notes,
    status: c.status,
    source: c.source,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    identities,
    events,
    groups,
    relations: relations.map((r) => ({
      id: r.id,
      relation: r.relation,
      note: r.note,
      direction: r.direction,
      otherId: r.other_id,
      otherName: r.other_name,
      otherKind: r.other_kind,
    })),
  };
}

/** 任意线索找人：身份精确 → 名字/别名精确 → 子串检索。 */
async function findContacts(query, limit) {
  const raw = str(query);
  if (!raw) throw fail('INVALID_PARAMS', 'query is required');
  const max = Math.min(50, Math.max(1, Number(limit) || 10));
  const hits = new Map();
  const add = (id, matchType, matched) => {
    if (!hits.has(id)) hits.set(id, { id, matchType, matched });
  };
  const lower = raw.toLowerCase();
  const asPhone = normalizeIdentityValue(raw, 'phone');
  for (const r of await q(
    'SELECT contact_id, platform, value FROM contact_identities WHERE normalized_value = ? OR (platform = ? AND normalized_value = ?) LIMIT 50',
    [normalizeIdentityValue(raw), 'phone', asPhone],
  )) {
    add(r.contact_id, 'identity', `${r.platform}: ${r.value}`);
  }
  for (const r of await q(
    `SELECT id FROM contacts WHERE lower(display_name) = :name OR instr(lower(aliases), :alias) > 0 LIMIT 50`,
    { name: lower, alias: JSON.stringify(lower).toLowerCase() },
  )) {
    add(r.id, 'name');
  }
  // 已存的短名被线索包含（查「徐紫旎」找到「紫旎」）。只认 ≥2 字的中文名或 ≥4 字母的名字，避免 al ⊂ alan 这类误中。
  for (const r of await q(
    `SELECT id FROM contacts
     WHERE instr(:q, lower(display_name)) > 0 AND lower(display_name) <> :q
       AND ((length(display_name) >= 2 AND display_name GLOB '*[^ -~]*') OR length(display_name) >= 4)
     LIMIT 20`,
    { q: lower },
  )) {
    add(r.id, 'partial');
  }
  if (hits.size < max) {
    const rows = await q(
      `SELECT c.id,
         CASE WHEN instr(lower(c.display_name), :q) > 0 OR instr(lower(c.aliases), :q) > 0 THEN 'name'
              WHEN EXISTS (SELECT 1 FROM contact_identities i WHERE i.contact_id = c.id AND instr(i.normalized_value, :q) > 0) THEN 'identity'
              WHEN instr(lower(c.summary), :q) > 0 THEN 'summary'
              WHEN instr(lower(c.narrative), :q) > 0 OR instr(lower(c.agent_notes), :q) > 0 THEN 'story'
              ELSE 'event' END AS field
       FROM contacts c
       WHERE instr(lower(c.display_name), :q) > 0 OR instr(lower(c.aliases), :q) > 0
          OR instr(lower(c.summary), :q) > 0 OR instr(lower(c.narrative), :q) > 0 OR instr(lower(c.agent_notes), :q) > 0
          OR EXISTS (SELECT 1 FROM contact_identities i WHERE i.contact_id = c.id AND instr(i.normalized_value, :q) > 0)
          OR EXISTS (SELECT 1 FROM contact_events e WHERE e.contact_id = c.id AND instr(lower(e.text), :q) > 0)
       LIMIT :lim`,
      { q: lower, lim: max * 3 },
    );
    const order = { name: 0, identity: 1, summary: 2, story: 3, event: 4 };
    rows.sort((a, b) => order[a.field] - order[b.field]);
    for (const r of rows) add(r.id, r.field === 'name' || r.field === 'identity' ? r.field : 'text');
  }
  const ids = [...hits.keys()].slice(0, max);
  const out = [];
  for (const id of ids) {
    const c = await getContact(id, { eventLimit: 3 });
    out.push({
      id: c.id,
      name: c.name,
      kind: c.kind,
      status: c.status,
      summary: c.summary,
      aliases: c.aliases,
      matchType: hits.get(id).matchType,
      matched: hits.get(id).matched,
      identities: c.identities.map((i) => ({ platform: i.platform, value: i.value })),
      groups: c.groups.map((g) => g.name),
      agentNotes: c.agentNotes,
      recentEvents: c.events,
    });
  }
  return out;
}

async function similarNamed(name, aliases, excludeId) {
  const want = [name, ...(aliases || [])].map(nameFacet);
  // 先用分桶键在 SQL 里粗筛候选，再逐个精判；避免每次建档都扫全表。
  const terms = [...blockingKeys(want)].map((k) => k.slice(2)).filter(Boolean).slice(0, 24);
  if (!terms.length) return [];
  const where = terms.map((_, i) => `instr(lower(display_name), :t${i}) > 0 OR instr(lower(aliases), :t${i}) > 0`).join(' OR ');
  const params = Object.fromEntries(terms.map((t, i) => [`t${i}`, t]));
  const rows = await q(`SELECT id, display_name, aliases, summary, kind FROM contacts WHERE ${where} LIMIT 500`, params);
  const out = [];
  for (const r of rows) {
    if (r.id === excludeId) continue;
    const theirs = [r.display_name, ...parseAliases(r.aliases)].map(nameFacet);
    if (want.some((a) => theirs.some((b) => facetsSimilar(a, b)))) {
      out.push({ id: r.id, name: r.display_name, summary: r.summary, kind: r.kind });
    }
  }
  return out.slice(0, 10);
}

async function stats() {
  const [row] = await q(
    `SELECT
      (SELECT count(*) FROM contacts WHERE kind = 'person') AS people,
      (SELECT count(*) FROM contacts WHERE kind = 'org') AS orgs,
      (SELECT count(*) FROM contacts WHERE status = 'pending') AS pending,
      (SELECT count(*) FROM contact_groups) AS groups`,
  );
  return row;
}

/* ───────────── 写 ───────────── */

async function groupIdFor(name, statements, createdAt) {
  const n = str(name);
  if (!n) throw fail('INVALID_PARAMS', 'group name is required');
  const rows = await q('SELECT id FROM contact_groups WHERE name = ?', [n]);
  if (rows.length) return rows[0].id;
  const id = uuid();
  statements.push({
    sql: 'INSERT INTO contact_groups (id, name, description, created_at) VALUES (?, ?, ?, ?)',
    params: [id, n, '', createdAt],
  });
  return id;
}

/** 规范化并检查身份冲突；返回待插入的身份。 */
async function prepareIdentities(contactId, list) {
  const out = [];
  for (const raw of list || []) {
    if (!raw || !str(raw.value)) continue;
    const platform = normalizePlatform(raw.platform || 'other');
    const normalized = normalizeIdentityValue(raw.value, platform);
    if (!normalized) continue;
    if (out.some((o) => o.platform === platform && o.normalized === normalized)) continue;
    const owner = await q('SELECT contact_id FROM contact_identities WHERE platform = ? AND normalized_value = ?', [platform, normalized]);
    if (owner.length) {
      if (owner[0].contact_id === contactId) continue;
      throw fail('IDENTITY_CONFLICT', `${platform}:${str(raw.value)} already belongs to another contact`, {
        conflictContactId: owner[0].contact_id,
      });
    }
    out.push({ platform, value: str(raw.value), normalized, label: str(raw.label) });
  }
  return out;
}

function identityInsert(contactId, i, createdAt) {
  return {
    sql: `INSERT INTO contact_identities (id, contact_id, platform, value, normalized_value, label, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, '', ?)`,
    params: [uuid(), contactId, i.platform, i.value, i.normalized, i.label || '', createdAt],
  };
}

/**
 * 新建或更新档案。
 * - 新建：同名/相似名已存在且未传 allowDuplicate 时返回 DUPLICATE_SUSPECT 及候选。
 * - 更新：只改传入的字段；aliases / identities / groups 为追加。
 */
async function saveContact(input) {
  const createdAt = nowIso();
  const statements = [];
  const isCreate = !str(input.id);
  if (isCreate) {
    const name = str(input.name);
    if (!name) throw fail('INVALID_PARAMS', 'name is required to create a contact');
    const kind = input.kind === 'org' ? 'org' : 'person';
    const aliases = uniqueStrings(input.aliases || []);
    if (!input.allowDuplicate) {
      const similar = await similarNamed(name, aliases);
      if (similar.length) {
        throw fail('DUPLICATE_SUSPECT', 'A contact with a similar name already exists. Use get to confirm; update it by id, or pass allow_duplicate if this is a different person.', { candidates: similar });
      }
    }
    const id = uuid();
    const identities = await prepareIdentities(id, input.identities);
    const status = input.status === 'pending' ? 'pending' : 'confirmed';
    const source = ['manual', 'agent', 'import'].includes(input.source) ? input.source : 'manual';
    statements.push({
      sql: `INSERT INTO contacts (id, kind, display_name, aliases, summary, narrative, agent_notes, status, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [id, kind, name, JSON.stringify(aliases), str(input.summary), str(input.narrative), str(input.agentNotes), status, source, createdAt, createdAt],
    });
    for (const i of identities) statements.push(identityInsert(id, i, createdAt));
    for (const g of uniqueStrings(input.groups || [])) {
      const gid = await groupIdFor(g, statements, createdAt);
      statements.push({ sql: 'INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?, ?)', params: [gid, id] });
    }
    await batch(statements);
    return { id, created: true };
  }

  const c = await requireContact(input.id);
  const sets = [];
  const params = [];
  const setField = (col, v) => {
    sets.push(`${col} = ?`);
    params.push(v);
  };
  if (input.name !== undefined && str(input.name)) setField('display_name', str(input.name));
  if (input.kind === 'person' || input.kind === 'org') setField('kind', input.kind);
  if (input.summary !== undefined) setField('summary', str(input.summary));
  if (input.narrative !== undefined) setField('narrative', str(input.narrative));
  if (input.agentNotes !== undefined) setField('agent_notes', str(input.agentNotes));
  if (input.status === 'pending' || input.status === 'confirmed') setField('status', input.status);
  let aliases = parseAliases(c.aliases);
  if (Array.isArray(input.aliases)) aliases = uniqueStrings([...aliases, ...input.aliases]);
  if (Array.isArray(input.removeAliases)) {
    const drop = new Set(input.removeAliases.map((a) => str(a).toLowerCase()));
    aliases = aliases.filter((a) => !drop.has(a.toLowerCase()));
  }
  setField('aliases', JSON.stringify(aliases));
  setField('updated_at', createdAt);
  params.push(c.id);
  statements.push({ sql: `UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`, params });
  for (const i of await prepareIdentities(c.id, input.identities)) statements.push(identityInsert(c.id, i, createdAt));
  for (const rid of input.removeIdentityIds || []) {
    statements.push({ sql: 'DELETE FROM contact_identities WHERE id = ? AND contact_id = ?', params: [str(rid), c.id] });
  }
  for (const g of uniqueStrings(input.groups || [])) {
    const gid = await groupIdFor(g, statements, createdAt);
    statements.push({ sql: 'INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?, ?)', params: [gid, c.id] });
  }
  await batch(statements);
  return { id: c.id, created: false };
}

async function logEvent(input) {
  const c = await requireContact(input.contactId);
  const text = str(input.text);
  if (!text) throw fail('INVALID_PARAMS', 'text is required');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(str(input.date)) ? str(input.date) : today();
  const id = uuid();
  const at = nowIso();
  await batch([
    { sql: 'INSERT INTO contact_events (id, contact_id, date, text, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', params: [id, c.id, date, text, str(input.source), at] },
    { sql: 'UPDATE contacts SET updated_at = ? WHERE id = ?', params: [at, c.id] },
  ]);
  return { id, contactId: c.id, date };
}

async function deleteEvent(eventId) {
  await batch([{ sql: 'DELETE FROM contact_events WHERE id = ?', params: [str(eventId)] }]);
  return { deleted: true };
}

async function relate(input) {
  const a = await requireContact(input.fromId);
  const b = await requireContact(input.toId);
  const relation = str(input.relation);
  if (!relation) throw fail('INVALID_PARAMS', 'relation is required');
  if (input.remove) {
    await batch([{ sql: 'DELETE FROM contact_relations WHERE from_id = ? AND to_id = ? AND relation = ?', params: [a.id, b.id, relation] }]);
    return { removed: true };
  }
  if (a.id === b.id) throw fail('INVALID_PARAMS', 'cannot relate a contact to itself');
  await batch([
    {
      sql: 'INSERT OR IGNORE INTO contact_relations (id, from_id, to_id, relation, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      params: [uuid(), a.id, b.id, relation, str(input.note), nowIso()],
    },
  ]);
  return { related: true };
}

async function organize(input) {
  const ids = uniqueStrings(input.contactIds || []);
  if (!ids.length) throw fail('INVALID_PARAMS', 'contact_ids is required');
  for (const id of ids) await requireContact(id);
  const at = nowIso();
  const statements = [];
  const action = input.action;
  if (action === 'add_to_group' || action === 'remove_from_group' || action === 'move_to_group') {
    const groupName = str(input.group);
    if (!groupName) throw fail('INVALID_PARAMS', 'group is required');
    if (action === 'remove_from_group') {
      for (const id of ids) {
        statements.push({
          sql: 'DELETE FROM contact_group_members WHERE contact_id = ? AND group_id = (SELECT id FROM contact_groups WHERE name = ?)',
          params: [id, groupName],
        });
      }
    } else {
      const gid = await groupIdFor(groupName, statements, at);
      for (const id of ids) {
        if (action === 'move_to_group') statements.push({ sql: 'DELETE FROM contact_group_members WHERE contact_id = ?', params: [id] });
        statements.push({ sql: 'INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?, ?)', params: [gid, id] });
      }
    }
  } else if (action === 'confirm' || action === 'mark_pending') {
    for (const id of ids) {
      statements.push({ sql: 'UPDATE contacts SET status = ?, updated_at = ? WHERE id = ?', params: [action === 'confirm' ? 'confirmed' : 'pending', at, id] });
    }
  } else {
    throw fail('INVALID_PARAMS', 'action must be one of add_to_group, remove_from_group, move_to_group, confirm, mark_pending');
  }
  await batchChunks(statements);
  return { action, count: ids.length };
}

/** 合并：source 的身份、事件、分组、关系整体并入 target，别名取并集，叙事拼接，然后删除 source。单批原子。 */
async function mergeContacts(input) {
  const src = await requireContact(input.sourceId);
  const dst = await requireContact(input.targetId);
  if (src.id === dst.id) throw fail('INVALID_PARAMS', 'source and target are the same contact');
  const aliases = uniqueStrings([...parseAliases(dst.aliases), src.display_name, ...parseAliases(src.aliases)]).filter(
    (a) => a.toLowerCase() !== dst.display_name.toLowerCase(),
  );
  const joinText = (a, b) => [str(a), str(b)].filter(Boolean).join('\n\n');
  const at = nowIso();
  await batch([
    { sql: 'UPDATE contact_identities SET contact_id = ? WHERE contact_id = ?', params: [dst.id, src.id] },
    { sql: 'UPDATE contact_events SET contact_id = ? WHERE contact_id = ?', params: [dst.id, src.id] },
    { sql: 'INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) SELECT group_id, ? FROM contact_group_members WHERE contact_id = ?', params: [dst.id, src.id] },
    { sql: 'DELETE FROM contact_group_members WHERE contact_id = ?', params: [src.id] },
    { sql: 'UPDATE OR IGNORE contact_relations SET from_id = ? WHERE from_id = ? AND to_id <> ?', params: [dst.id, src.id, dst.id] },
    { sql: 'UPDATE OR IGNORE contact_relations SET to_id = ? WHERE to_id = ? AND from_id <> ?', params: [dst.id, src.id, dst.id] },
    { sql: 'DELETE FROM contact_relations WHERE from_id = ? OR to_id = ?', params: [src.id, src.id] },
    {
      sql: `UPDATE contacts SET aliases = ?, summary = ?, narrative = ?, agent_notes = ?, status = ?, updated_at = ? WHERE id = ?`,
      params: [
        JSON.stringify(aliases),
        str(dst.summary) || str(src.summary),
        joinText(dst.narrative, src.narrative),
        joinText(dst.agent_notes, src.agent_notes),
        dst.status === 'confirmed' || src.status === 'confirmed' ? 'confirmed' : 'pending',
        at,
        dst.id,
      ],
    },
    { sql: 'DELETE FROM contacts WHERE id = ?', params: [src.id] },
  ]);
  return { id: dst.id, mergedFrom: src.id };
}

async function deleteContact(id) {
  const c = await requireContact(id);
  await batch([
    { sql: 'DELETE FROM contact_identities WHERE contact_id = ?', params: [c.id] },
    { sql: 'DELETE FROM contact_events WHERE contact_id = ?', params: [c.id] },
    { sql: 'DELETE FROM contact_group_members WHERE contact_id = ?', params: [c.id] },
    { sql: 'DELETE FROM contact_relations WHERE from_id = ? OR to_id = ?', params: [c.id, c.id] },
    { sql: 'DELETE FROM contacts WHERE id = ?', params: [c.id] },
  ]);
  return { deleted: c.id, name: c.display_name };
}

async function manageGroups(input) {
  const action = input.action || 'list';
  if (action === 'list') return { groups: await listGroups() };
  const name = str(input.name);
  if (!name) throw fail('INVALID_PARAMS', 'name is required');
  if (action === 'create') {
    const exists = await q('SELECT id FROM contact_groups WHERE name = ?', [name]);
    if (exists.length) return { id: exists[0].id, created: false };
    const id = uuid();
    await batch([{ sql: 'INSERT INTO contact_groups (id, name, description, created_at) VALUES (?, ?, ?, ?)', params: [id, name, str(input.description), nowIso()] }]);
    return { id, created: true };
  }
  const rows = await q('SELECT id FROM contact_groups WHERE name = ?', [name]);
  if (!rows.length) throw fail('NOT_FOUND', `group not found: ${name}`);
  if (action === 'rename') {
    const next = str(input.newName);
    if (!next) throw fail('INVALID_PARAMS', 'new_name is required');
    await batch([{ sql: 'UPDATE contact_groups SET name = ? WHERE id = ?', params: [next, rows[0].id] }]);
    return { id: rows[0].id, name: next };
  }
  if (action === 'delete') {
    await batch([
      { sql: 'DELETE FROM contact_group_members WHERE group_id = ?', params: [rows[0].id] },
      { sql: 'DELETE FROM contact_groups WHERE id = ?', params: [rows[0].id] },
    ]);
    return { deleted: name };
  }
  throw fail('INVALID_PARAMS', 'action must be list, create, rename or delete');
}

/** 相似名候选的分桶键：中文取双字片段，拉丁名取 ≥3 字母的词。只在同桶内两两比较，几千人也很快。 */
function blockingKeys(facets) {
  const keys = new Set();
  for (const f of facets) {
    if (f.cjk) {
      for (let i = 0; i + 2 <= f.norm.length; i++) keys.add(`c:${f.norm.slice(i, i + 2)}`);
    }
    for (const t of f.toks) if (t.length >= 3) keys.add(`t:${t}`);
    if (f.norm) keys.add(`n:${f.norm}`);
  }
  return keys;
}

async function findDuplicates() {
  const rows = await qAll('SELECT id, kind, display_name, aliases, summary FROM contacts ORDER BY id');
  const items = rows.map((r) => {
    const facets = [r.display_name, ...parseAliases(r.aliases)].map(nameFacet);
    return { r, facets, keys: blockingKeys(facets) };
  });
  const buckets = new Map();
  items.forEach((it, idx) => {
    for (const k of it.keys) {
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(idx);
    }
  });
  const seen = new Set();
  const pairs = [];
  for (const list of buckets.values()) {
    if (list.length < 2 || list.length > 200) continue; // 超大桶是常见字，不代表重复
    for (let x = 0; x < list.length && pairs.length < 100; x++) {
      for (let y = x + 1; y < list.length && pairs.length < 100; y++) {
        const a = items[list[x]];
        const b = items[list[y]];
        const key = `${list[x]}|${list[y]}`;
        if (seen.has(key) || a.r.kind !== b.r.kind) continue;
        seen.add(key);
        if (a.facets.some((f) => b.facets.some((g) => facetsSimilar(f, g)))) {
          pairs.push({
            a: { id: a.r.id, name: a.r.display_name, summary: a.r.summary },
            b: { id: b.r.id, name: b.r.display_name, summary: b.r.summary },
          });
        }
      }
    }
  }
  return { pairs };
}

/* ───────────── 设置与自动维护 ───────────── */

/**
 * 两种规模档位。只影响自动维护的节奏和单次改动上限；数据结构一致。
 * colleagues：同事、朋友为主，每天一次。clients：客户很多，频率更高、上限更大，并按客户公司组织。
 */
const PROFILES = {
  colleagues: {
    intervalHours: 24,
    maxChanges: 30,
    guidance: '以同事、朋友、家人为主：记录职位与团队变化、新联系方式、约定和值得记住的往来。',
  },
  clients: {
    intervalHours: 6,
    maxChanges: 100,
    guidance:
      '客户很多：每位客户联系人都挂到其公司（relate 任职，公司不存在时先建 kind:"org" 的档案），并放进以公司名命名的分组；' +
      '重点记录需求、报价、合同、跟进约定和下次联系时间，事件里写清日期。',
  },
};
const DEFAULT_SETTINGS = { profile: 'colleagues', macAutoSync: true };

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...((await getMeta('settings')) || {}) };
}

async function setSettings(patch) {
  const next = await getSettings();
  if (patch.profile === 'colleagues' || patch.profile === 'clients') next.profile = patch.profile;
  if (typeof patch.macAutoSync === 'boolean') next.macAutoSync = patch.macAutoSync;
  await batch([setMetaStmt('settings', next)]);
  return next;
}

function automationPrompt(profile) {
  const p = PROFILES[profile] || PROFILES.colleagues;
  return [
    '整理我的通讯录（cindy-contacts 插件），按插件手册 maintenance 一节执行：',
    '1. 调用 ghost_call({ ghost_id: "cindy-contacts", tool: "maintenance", args: { action: "begin" } })，拿到检查点、单次上限和本档位要求。',
    '2. 用 Cindy 历史工具（list_sessions、get_chat_history，只看 user 和 assistant）读取检查点之后我的对话；如果装了邮件或日历插件，也看看同一时间段的邮件往来和会议参与人。',
    '3. 找出与我真实往来的人和组织的新信息。每个人先 find，再用 save、log_event、relate 更新；拿不准的写成 pending。不记营销邮件、通知机器人和一次性发件人，不删除也不合并。',
    `4. 本次改动不超过单次上限（${p.maxChanges} 处），其余留到下次。`,
    '5. 最后调用 maintenance，action 为 "end"，带上扫描的会话数、新增、更新、待确认数量和新的检查点。没有新信息也要调用 end。',
  ].join('\n');
}

async function requestAutomation() {
  const settings = await getSettings();
  const p = PROFILES[settings.profile] || PROFILES.colleagues;
  if (!cindy.agent || typeof cindy.agent.requestSchedule !== 'function') {
    throw fail('UNSUPPORTED', '当前 Cindy 版本不支持由插件请求新建自动化');
  }
  const r = await cindy.agent.requestSchedule({
    name: '整理通讯录',
    prompt: automationPrompt(settings.profile),
    intervalMs: p.intervalHours * 3600 * 1000,
  });
  if (!r || r.ok === false) throw fail((r && r.errorCode) || 'SCHEDULE_FAILED', (r && r.message) || '没有打开自动化面板');
  const requested = { at: nowIso(), profile: settings.profile };
  await batch([setMetaStmt('automation_requested', requested)]);
  return requested;
}

async function maintenance(input) {
  const settings = await getSettings();
  const p = PROFILES[settings.profile] || PROFILES.colleagues;
  const meta = (await getMeta('maintenance')) || { runs: [] };
  if (input.action === 'begin') {
    maybeAutoSyncMac();
    const firstRun = !meta.checkpoint;
    return {
      checkpoint: meta.checkpoint || new Date(Date.now() - 7 * 86400000).toISOString(),
      firstRun,
      now: nowIso(),
      profile: settings.profile,
      maxChanges: p.maxChanges,
      guidance: p.guidance,
      stats: await stats(),
      manual: 'ghost_manual({ ghost_id: "cindy-contacts", path: "usage" }) 的「自动维护」一节',
    };
  }
  if (input.action === 'end') {
    const now = nowIso();
    let checkpoint = str(input.checkpoint) || now;
    if (Number.isNaN(Date.parse(checkpoint)) || Date.parse(checkpoint) > Date.now() + 3600000) checkpoint = now;
    const num = (v) => Math.max(0, Math.floor(Number(v) || 0));
    const run = {
      at: now,
      scanned: num(input.scanned),
      created: num(input.created),
      updated: num(input.updated),
      pending: num(input.pending),
      note: str(input.note).slice(0, 300),
    };
    const next = { checkpoint, lastRunAt: now, last: run, runs: [run, ...(meta.runs || [])].slice(0, 10) };
    await batch([setMetaStmt('maintenance', next)]);
    return { recorded: true, checkpoint };
  }
  throw fail('INVALID_PARAMS', 'action must be begin or end');
}

/** 批量建档/更新，单次最多 100 条；逐条返回结果，单条失败不影响其它条。 */
async function saveMany(items) {
  const list = Array.isArray(items) ? items.slice(0, 100) : [];
  if (!list.length) throw fail('INVALID_PARAMS', 'items is required');
  const results = [];
  for (let i = 0; i < list.length; i++) {
    try {
      const r = await saveContact(list[i]);
      results.push({ index: i, ok: true, id: r.id, created: r.created });
    } catch (e) {
      results.push({ index: i, ok: false, errorCode: e.code || 'CONTACTS_ERROR', message: e.message, ...(e.extra || {}) });
    }
  }
  return { saved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

let macSyncing = false;
/**
 * 用户曾经手动从 macOS 通讯录导入过，才在之后每天自动增量对账一次（不调用模型）。
 * 在后台排进串行队列，不阻塞当前请求；失败（如用户撤销了授权）只记录不打扰。
 */
async function maybeAutoSyncMac() {
  if (macSyncing || state.importing) return;
  try {
    const settings = await getSettings();
    const last = await getMeta('system_import');
    if (!settings.macAutoSync || !last || !last.at) return;
    if (Date.now() - Date.parse(last.at) < 24 * 3600 * 1000) return;
    if ((await platform()) !== 'darwin') return;
    macSyncing = true;
    serial(() => importSystem({ dryRun: false, auto: true }))
      .then((r) => {
        if (r && (r.created || r.updated)) notifyChanged();
      })
      .catch((e) =>
        serial(() => batch([setMetaStmt('system_import', { ...last, at: nowIso(), lastError: e.code || 'FAILED' })])).catch(() => {}),
      )
      .finally(() => {
        macSyncing = false;
      });
  } catch (_) {
    macSyncing = false;
  }
}

/* ───────────── 导入：旧版内置通讯录 ───────────── */

const LEGACY_IMPORT = [
  {
    table: 'contacts',
    page: 50,
    sql: `INSERT OR IGNORE INTO contacts (id, kind, display_name, aliases, summary, narrative, agent_notes, status, source, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    cols: ['id', 'kind', 'display_name', 'aliases', 'summary', 'narrative', 'agent_notes', 'status', 'source', 'created_at', 'updated_at'],
  },
  {
    table: 'contact_groups',
    page: 200,
    sql: 'INSERT OR IGNORE INTO contact_groups (id, name, description, created_at) VALUES (?, ?, ?, ?)',
    cols: ['id', 'name', 'description', 'created_at'],
  },
  {
    table: 'contact_identities',
    page: 200,
    sql: `INSERT OR IGNORE INTO contact_identities (id, contact_id, platform, value, normalized_value, label, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    cols: ['id', 'contact_id', 'platform', 'value', 'normalized_value', 'label', 'note', 'created_at'],
  },
  {
    table: 'contact_events',
    page: 100,
    sql: 'INSERT OR IGNORE INTO contact_events (id, contact_id, date, text, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    cols: ['id', 'contact_id', 'date', 'text', 'source', 'created_at'],
  },
  {
    table: 'contact_group_members',
    page: 200,
    sql: 'INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?, ?)',
    cols: ['group_id', 'contact_id'],
  },
  {
    table: 'contact_relations',
    page: 200,
    sql: 'INSERT OR IGNORE INTO contact_relations (id, from_id, to_id, relation, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    cols: ['id', 'from_id', 'to_id', 'relation', 'note', 'created_at'],
  },
];

function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'string') return v;
  return String(v);
}

/**
 * 从旧版内置通讯录复制一份。只在本插件资料库为空时进行；重复执行幂等（INSERT OR IGNORE，
 * 保留原 id）。完成后按表核对数量并记下结果，之后不再自动执行。
 */
async function importLegacy(opts) {
  const force = !!(opts && opts.force);
  const done = await getMeta('legacy_import');
  if (done && done.status === 'done' && !force) return done;
  const [{ n }] = await q('SELECT count(*) AS n FROM contacts');
  if (n > 0 && !force && !(done && done.status === 'partial')) {
    const skipped = { status: 'skipped', reason: 'not-empty', at: nowIso() };
    await batch([setMetaStmt('legacy_import', skipped)]);
    state.legacy = skipped;
    return skipped;
  }
  let probe;
  try {
    probe = await nodeCall('legacy/probe', {}, { timeoutMs: 60000 });
  } catch (e) {
    return { status: 'error', code: e.code, message: e.message };
  }
  if (!probe.found) {
    const none = { status: 'none', at: nowIso() };
    await batch([setMetaStmt('legacy_import', none)]);
    state.legacy = none;
    return none;
  }
  state.importing = 'legacy';
  try {
    await batch([setMetaStmt('legacy_import', { status: 'partial', at: nowIso() })]);
    const total = Object.values(probe.counts).reduce((a, b) => a + b, 0) || 1;
    let copied = 0;
    for (const spec of LEGACY_IMPORT) {
      for (let offset = 0; ; offset += spec.page) {
        const { rows } = await nodeCall('legacy/read', { table: spec.table, offset, limit: spec.page }, { timeoutMs: 60000 });
        if (!rows.length) break;
        await batchChunks(rows.map((r) => ({ sql: spec.sql, params: spec.cols.map((c) => cell(r[c])) })));
        copied += rows.length;
        state.progress = { done: copied, total };
        broadcast({ kind: 'event', name: 'progress', data: { phase: 'legacy', done: copied, total } });
        if (rows.length < spec.page) break;
      }
    }
    const counts = {};
    let verified = true;
    for (const spec of LEGACY_IMPORT) {
      const [{ n: local }] = await q(`SELECT count(*) AS n FROM ${spec.table}`);
      counts[spec.table] = { legacy: probe.counts[spec.table] || 0, local };
      if (local < (probe.counts[spec.table] || 0)) verified = false;
    }
    const result = { status: verified ? 'done' : 'partial', at: nowIso(), counts };
    await batch([setMetaStmt('legacy_import', result)]);
    state.legacy = result;
    return result;
  } finally {
    state.importing = null;
    state.progress = null;
    nodeCall('legacy/close').catch(() => {});
  }
}

/* ───────────── 导入：macOS 系统通讯录 ───────────── */

/**
 * 读取系统通讯录并按 anchor → 邮箱 → 电话 匹配已有档案：命中则补齐缺失身份与锚点；
 * 否则新建（与已有档案重名的放进待确认，等用户判断）。只读系统通讯录，不改它。
 */
async function importSystem(opts) {
  const dryRun = !!(opts && opts.dryRun);
  const groupName = str(opts && opts.group);
  if ((await platform()) !== 'darwin') throw fail('UNSUPPORTED', 'macOS 系统通讯录只在 Mac 上可用');
  state.importing = 'system';
  broadcast({ kind: 'event', name: 'progress', data: { phase: 'system-read' } });
  try {
    const { total } = await nodeCall('system/read', {}, { timeoutMs: 120000 });
    const records = [];
    for (let offset = 0; offset < total; offset += 200) {
      const page = await nodeCall('system/page', { offset, limit: 200 });
      records.push(...page.records);
      if (page.done) break;
    }
    const owners = new Map();
    for (const r of await qAll(
      "SELECT platform, normalized_value, contact_id FROM contact_identities WHERE platform IN ('apple-contacts', 'email', 'phone') ORDER BY id",
    )) {
      owners.set(`${r.platform}:${r.normalized_value}`, r.contact_id);
    }
    const facets = (await qAll('SELECT id, display_name, aliases FROM contacts ORDER BY id')).map((r) => ({
      id: r.id,
      facets: [r.display_name, ...parseAliases(r.aliases)].map(nameFacet),
    }));
    const at = nowIso();
    const head = [];
    const perRecord = [];
    const result = { total: records.length, created: 0, updated: 0, unchanged: 0, needsReview: [] };
    let groupId = null;
    if (groupName && !dryRun) groupId = await groupIdFor(groupName, head, at);

    for (const rec of records) {
      const ids = [{ platform: 'apple-contacts', value: rec.id, label: '' }]
        .concat(rec.emails.map((e) => ({ platform: 'email', value: e.value, label: e.label })))
        .concat(rec.phones.map((p) => ({ platform: 'phone', value: p.value, label: p.label })))
        .map((i) => ({ ...i, normalized: normalizeIdentityValue(i.value, i.platform) }))
        .filter((i) => i.normalized);
      let match = null;
      for (const i of ids) {
        const owner = owners.get(`${i.platform}:${i.normalized}`);
        if (owner) {
          match = owner;
          break;
        }
      }
      const fresh = ids.filter((i) => !owners.has(`${i.platform}:${i.normalized}`));
      if (match) {
        if (!fresh.length) {
          result.unchanged += 1;
          continue;
        }
        result.updated += 1;
        const statements = [];
        perRecord.push(statements);
        for (const i of fresh) {
          owners.set(`${i.platform}:${i.normalized}`, match);
          statements.push(identityInsert(match, i, at));
        }
        statements.push({ sql: 'UPDATE contacts SET updated_at = ? WHERE id = ?', params: [at, match] });
        if (groupId) statements.push({ sql: 'INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?, ?)', params: [groupId, match] });
        continue;
      }
      const f = nameFacet(rec.name);
      const similar = facets.find((x) => x.facets.some((y) => facetsSimilar(f, y)));
      const id = uuid();
      const status = similar ? 'pending' : 'confirmed';
      if (similar) result.needsReview.push({ name: rec.name, similarTo: similar.id });
      result.created += 1;
      const statements = [];
      perRecord.push(statements);
      const kind = rec.isCompany ? 'org' : 'person';
      const summary = rec.isCompany ? '' : [rec.title, rec.org].filter(Boolean).join(' · ');
      statements.push({
        sql: `INSERT INTO contacts (id, kind, display_name, aliases, summary, narrative, agent_notes, status, source, created_at, updated_at)
              VALUES (?, ?, ?, '[]', ?, '', '', ?, 'import', ?, ?)`,
        params: [id, kind, rec.name, summary, status, at, at],
      });
      for (const i of ids) {
        owners.set(`${i.platform}:${i.normalized}`, id);
        statements.push(identityInsert(id, i, at));
      }
      if (groupId) statements.push({ sql: 'INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?, ?)', params: [groupId, id] });
      facets.push({ id, facets: [f] });
    }
    if (!dryRun) {
      // 按档案装批：一个人的语句不会被拆进两个批次，中断时不会留下半个档案。
      let chunk = head.slice();
      for (const group of perRecord) {
        if (chunk.length + group.length > BATCH_MAX) {
          await batch(chunk);
          chunk = [];
        }
        chunk.push(...group);
      }
      await batch(chunk);
      await batch([setMetaStmt('system_import', { at, total: result.total, created: result.created, updated: result.updated, auto: !!(opts && opts.auto) })]);
    }
    result.needsReview = result.needsReview.slice(0, 50);
    result.dryRun = dryRun;
    return result;
  } finally {
    state.importing = null;
  }
}

/* ───────────── 问 AI（普通任务） ───────────── */

async function tasksAvailable() {
  if (!cindy.tasks || typeof cindy.tasks.capabilities !== 'function') return false;
  try {
    const caps = await cindy.tasks.capabilities();
    const ops = (caps && caps.operations) || [];
    return ops.includes('create') && ops.includes('send');
  } catch (_) {
    return false;
  }
}

async function askAI(input) {
  const text = str(input.text);
  if (!text) throw fail('INVALID_PARAMS', 'text is required');
  if (!(await tasksAvailable())) throw fail('UNSUPPORTED', '当前 Cindy 版本不支持由插件新建任务');
  let about = '';
  if (str(input.contactId)) {
    const c = await getContact(input.contactId, { eventLimit: 5 });
    about = `\n\n当前在看的联系人：${c.name}（id: ${c.id}）。`;
  }
  const key = uuid();
  const task = await cindy.tasks.create({ requestKey: `${key}-create`, title: `通讯录 · ${text}`.slice(0, 100) });
  await cindy.tasks.send({
    taskId: task.taskId,
    expectedRevision: task.revision,
    requestKey: `${key}-send`,
    text:
      `${text}${about}\n\n` +
      '请使用 cindy-contacts 插件的工具（ghost_call，ghost_id 为 cindy-contacts）查询和修改通讯录；' +
      '删除与合并前先向我确认。',
  });
  return { taskId: task.taskId };
}

/* ───────────── 广播与主视图请求 ───────────── */

let channel = null;
function broadcast(message) {
  try {
    if (!channel) channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(message);
  } catch (_) {
    /* 没有页面在听时忽略 */
  }
}

function notifyChanged() {
  broadcast({ kind: 'event', name: 'changed' });
}

async function viewState() {
  const s = state.ready ? await stats() : null;
  return {
    ready: state.ready,
    error: state.error,
    importing: state.importing,
    progress: state.progress,
    legacy: state.legacy,
    systemImport: state.ready ? await getMeta('system_import') : null,
    platform: await platform(),
    stats: s,
    tasks: await tasksAvailable(),
    schedule: !!(cindy.agent && typeof cindy.agent.requestSchedule === 'function'),
    settings: state.ready ? await getSettings() : null,
    maintenance: state.ready ? await getMeta('maintenance') : null,
    automationRequested: state.ready ? await getMeta('automation_requested') : null,
  };
}

const VIEW_METHODS = {
  state: () => viewState(),
  list: async () => ({ contacts: await listContacts(), groups: await listGroups() }),
  get: (p) => getContact(p.id),
  save: (p) => saveContact(p),
  logEvent: (p) => logEvent(p),
  deleteEvent: (p) => deleteEvent(p.id),
  relate: (p) => relate(p),
  organize: (p) => organize(p),
  merge: (p) => mergeContacts(p),
  delete: (p) => deleteContact(p.id),
  groups: (p) => manageGroups(p),
  duplicates: () => findDuplicates(),
  importSystem: (p) => importSystem(p),
  importLegacy: () => importLegacy({ force: true }),
  ask: (p) => askAI(p),
  settings: (p) => setSettings(p || {}),
  requestAutomation: () => requestAutomation(),
};
const MUTATING = new Set(['save', 'logEvent', 'deleteEvent', 'relate', 'organize', 'merge', 'delete', 'groups', 'importSystem', 'importLegacy']);

const answered = new Map();
function startViewChannel() {
  let listen;
  try {
    listen = new BroadcastChannel(CHANNEL);
  } catch (_) {
    return;
  }
  listen.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || msg.kind !== 'req' || typeof msg.id !== 'string') return;
    // 页面会按 id 重发直到收到回执；同一 id 只执行一次。
    if (answered.has(msg.id)) {
      const prev = answered.get(msg.id);
      if (prev) broadcast(prev);
      return;
    }
    answered.set(msg.id, null);
    const handler = VIEW_METHODS[msg.method];
    const run = async () => {
      if (!handler) throw fail('INVALID_PARAMS', `unknown method ${msg.method}`);
      // 状态查询不排队：导入进行中时页面要靠它显示进度。
      if (msg.method === 'state') {
        if (!state.ready) ensureReady().catch(() => {});
        else if (!pendingImport) maybeAutoSyncMac();
        return handler(msg.params || {});
      }
      await ensureReady();
      if (pendingImport) await pendingImport;
      return serial(() => handler(msg.params || {}));
    };
    run()
      .then((result) => ({ kind: 'res', id: msg.id, ok: true, result }))
      .catch((e) => ({ kind: 'res', id: msg.id, ok: false, error: { code: e.code || 'INTERNAL', message: e.message, extra: e.extra } }))
      .then((res) => {
        answered.set(msg.id, res);
        setTimeout(() => answered.delete(msg.id), 60000);
        broadcast(res);
        if (res.ok && MUTATING.has(msg.method)) notifyChanged();
      });
  };
}

/* ───────────── AI 工具 ───────────── */

const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);

const TOOLS = {
  find: (a) => findContacts(a.query, a.limit).then((results) => ({ results })),
  get: (a) => getContact(a.id),
  list: async (a) => {
    let rows = await listContacts();
    if (str(a.group)) rows = rows.filter((r) => r.groups.includes(str(a.group)));
    if (a.status === 'pending' || a.status === 'confirmed') rows = rows.filter((r) => r.status === a.status);
    if (a.kind === 'person' || a.kind === 'org') rows = rows.filter((r) => r.kind === a.kind);
    const offset = Math.max(0, Number(a.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(a.limit) || 50));
    return { total: rows.length, offset, contacts: rows.slice(offset, offset + limit) };
  },
  save: (a) =>
    saveContact({
      id: a.id,
      name: a.name,
      kind: a.kind,
      aliases: arr(a.aliases),
      removeAliases: arr(a.remove_aliases),
      summary: a.summary,
      narrative: a.narrative,
      agentNotes: a.agent_notes,
      status: a.status,
      identities: arr(a.identities),
      removeIdentityIds: arr(a.remove_identity_ids),
      groups: arr(a.groups),
      source: 'agent',
      allowDuplicate: !!a.allow_duplicate,
    }),
  log_event: (a) => logEvent({ contactId: a.contact_id, date: a.date, text: a.text, source: a.source || 'agent' }),
  relate: (a) => relate({ fromId: a.from_id, toId: a.to_id, relation: a.relation, note: a.note, remove: !!a.remove }),
  organize: (a) => organize({ action: a.action, contactIds: arr(a.contact_ids), group: a.group }),
  merge: (a) => mergeContacts({ sourceId: a.source_id, targetId: a.target_id }),
  delete: (a) => {
    if (a.confirm !== true) throw fail('CONFIRM_REQUIRED', '删除不可恢复：确认用户明确要求后，传 confirm:true 再调用');
    return deleteContact(a.id);
  },
  groups: (a) => manageGroups({ action: a.action, name: a.name, newName: a.new_name, description: a.description }),
  find_duplicates: () => findDuplicates(),
  import_macos: (a) => importSystem({ dryRun: a.dry_run !== false, group: a.group }),
  stats: () => stats(),
  save_many: (a) =>
    saveMany(
      (Array.isArray(a.items) ? a.items : []).map((x) => ({
        id: x.id,
        name: x.name,
        kind: x.kind,
        aliases: arr(x.aliases),
        summary: x.summary,
        narrative: x.narrative,
        agentNotes: x.agent_notes,
        status: x.status,
        identities: arr(x.identities),
        groups: arr(x.groups),
        source: 'agent',
        allowDuplicate: !!x.allow_duplicate,
      })),
    ),
  maintenance: (a) =>
    maintenance({ action: a.action, checkpoint: a.checkpoint, scanned: a.scanned, created: a.created, updated: a.updated, pending: a.pending, note: a.note }),
};
const MUTATING_TOOLS = new Set(['save', 'save_many', 'log_event', 'relate', 'organize', 'merge', 'delete', 'groups', 'import_macos', 'maintenance']);

let pendingImport = null;
// 宿主保留的错误码不能由插件写入（与 Cindy 的 GHOST_HOST_ERROR_CODES 一致）。
const HOST_ERROR_CODES = new Set(['GHOST_NOT_FOUND', 'GHOST_ASLEEP', 'GHOST_DISABLED_IN_WORKDIR', 'TOOL_NOT_FOUND', 'GHOST_CRASHED', 'TIMEOUT', 'ATTACHMENT_INVALID', 'DIR_INVALID', 'INTERNAL']);

cindy.onHostMessage(async (msg) => {
  if (!msg || msg.type !== 'tool-call') return;
  const handler = TOOLS[msg.tool];
  try {
    if (!handler) throw fail('UNKNOWN_TOOL', `unknown tool ${msg.tool}`);
    await ensureReady();
    if (pendingImport) await pendingImport;
    const result = await serial(() => handler(msg.args || {}));
    await cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result });
    if (MUTATING_TOOLS.has(msg.tool) && !(msg.tool === 'import_macos' && result && result.dryRun)) notifyChanged();
  } catch (e) {
    const extra = e.extra ? ` ${JSON.stringify(e.extra)}` : '';
    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      errorCode: e.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(e.code) && !HOST_ERROR_CODES.has(e.code) ? e.code : 'CONTACTS_ERROR',
      message: `${e.message}${extra}`,
    });
  }
});

/* ───────────── 启动 ───────────── */

let legacyKicked = false;
/** 首次启动：资料库为空且找得到旧版通讯录时，自动复制一份。排在串行队列最前面。 */
function startLegacyImportOnce() {
  if (legacyKicked) return;
  legacyKicked = true;
  pendingImport = serial(() => importLegacy())
    .catch((e) => ({ status: 'error', code: e.code, message: e.message }))
    .then((r) => {
      pendingImport = null;
      broadcast({ kind: 'event', name: 'legacy', data: r });
      notifyChanged();
    });
}

startViewChannel();
ensureReady().catch(() => {});
