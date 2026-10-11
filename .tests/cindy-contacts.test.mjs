import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import vm from 'node:vm';

const pluginDir = path.resolve(import.meta.dirname, '..', 'cindy-contacts');
const mainSource = fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8');

/* ───────── 模拟宿主：Library SQL、Node worker、工具派发、BroadcastChannel ───────── */

function isReader(sql) {
  return /^\s*(SELECT|WITH)\b/i.test(sql);
}

const migrations = { count: 0 };

function makeLibrary(dir) {
  const dbs = new Map();
  const open = (dbPath) => {
    if (!dbs.has(dbPath)) {
      const db = new DatabaseSync(path.join(dir, dbPath));
      db.exec('PRAGMA foreign_keys = ON');
      dbs.set(dbPath, db);
    }
    return dbs.get(dbPath);
  };
  const bind = (params) => (Array.isArray(params) ? params : params && typeof params === 'object' ? [params] : []);
  const run = (db, sql, params) => {
    const stmt = db.prepare(sql);
    if (isReader(sql)) return { rows: stmt.all(...bind(params)).map((r) => ({ ...r })) };
    const out = stmt.run(...bind(params));
    return { changes: Number(out.changes) };
  };
  const library = async (req) => {
    try {
      switch (req.op) {
        case 'open':
          return { ok: true, state: 'ready' };
        case 'db.open':
          open(req.dbPath);
          return { ok: true };
        case 'db.exec': {
          const rows = run(open(req.dbPath), req.sql, req.params);
          if (rows.rows && rows.rows.length > 2000) return { ok: false, errorCode: 'DB_ROW_LIMIT', message: 'too many rows' };
          return { ok: true, op: 'db.exec', ...rows };
        }
        case 'db.batch': {
          const db = open(req.dbPath);
          assert.ok(req.statements.length <= 200, 'batch over 200 statements');
          db.exec('BEGIN');
          try {
            for (const st of req.statements) run(db, st.sql, st.params);
            db.exec('COMMIT');
          } catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
          return { ok: true, applied: req.statements.length };
        }
        case 'db.userVersion':
          return { ok: true, op: 'db.userVersion', version: Number(open(req.dbPath).prepare('PRAGMA user_version').get().user_version) };
        case 'db.migrate': {
          migrations.count += 1;
          const db = open(req.dbPath);
          const current = Number(db.prepare('PRAGMA user_version').get().user_version);
          for (const step of req.steps) {
            if (step.toVersion <= current) continue;
            db.exec('BEGIN');
            for (const sql of step.sql) db.prepare(sql).run();
            db.exec(`PRAGMA user_version = ${step.toVersion}`);
            db.exec('COMMIT');
          }
          return { ok: true };
        }
        default:
          return { ok: false, errorCode: 'UNSUPPORTED', message: req.op };
      }
    } catch (e) {
      return { ok: false, errorCode: 'DB_ERROR', message: e.message };
    }
  };
  library.close = () => {
    for (const db of dbs.values()) db.close();
  };
  library.db = (dbPath) => open(dbPath);
  return library;
}

function makeWorker(env) {
  const child = spawn(process.execPath, ['--no-warnings', path.join(pluginDir, 'node', 'worker.cjs')], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  let next = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    p(msg.error ? { ok: false, message: msg.error.message } : { ok: true, result: msg.result });
  });
  return {
    request: ({ method, params }) =>
      new Promise((resolve) => {
        const id = next++;
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      }),
    close: () => child.kill(),
  };
}

function boot({ libDir, legacyDb = '', systemFixture = '' }) {
  const library = makeLibrary(libDir);
  const worker = makeWorker({
    CINDY_CONTACTS_LEGACY_DB_FOR_TEST: legacyDb,
    CINDY_CONTACTS_SYSTEM_FIXTURE_FOR_TEST: systemFixture,
  });
  const listeners = [];
  const results = new Map();
  const waiters = new Map();
  const channels = [];
  class Channel extends BroadcastChannel {
    constructor(name) {
      super(name);
      channels.push(this);
    }
  }
  const schedules = [];
  const cindy = {
    library,
    node: { request: worker.request },
    agent: {
      requestSchedule: async (req) => {
        schedules.push(structuredClone(req));
        return { ok: true };
      },
    },
    onHostMessage: (cb) => listeners.push(cb),
    send: async (raw) => {
      // 真实宿主经 IPC 结构化克隆传递；这里同样克隆，脱离沙箱 realm。
      const m = structuredClone(raw);
      if (m.type === 'tool-result') {
        results.set(m.callId, m);
        waiters.get(m.callId)?.(m);
      }
      return { ok: true };
    },
  };
  // 宿主沙箱页的计时器不会阻止测试进程退出。
  const unrefTimeout = (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  };
  const ctx = vm.createContext({ cindy, BroadcastChannel: Channel, crypto: globalThis.crypto, console, setTimeout: unrefTimeout, clearTimeout });
  vm.runInContext(mainSource, ctx, { filename: 'main.js' });
  let n = 0;
  const call = (tool, args = {}) =>
    new Promise((resolve) => {
      const callId = `call-${++n}`;
      waiters.set(callId, resolve);
      for (const l of listeners) l({ type: 'tool-call', tool, args, callId });
    });
  const view = (method, params = {}) =>
    new Promise((resolve) => {
      const ch = new BroadcastChannel('cindy-contacts');
      const id = `req-${++n}`;
      ch.onmessage = (ev) => {
        if (ev.data && ev.data.kind === 'res' && ev.data.id === id) {
          ch.close();
          resolve(ev.data);
        }
      };
      ch.postMessage({ kind: 'req', id, method, params });
    });
  const close = () => {
    for (const c of channels) c.close();
    worker.close();
    library.close();
  };
  return { call, view, close, library, schedules };
}

/* ───────── 旧版通讯录夹具（与旧版内置 schema 同构，数据全部为占位） ───────── */

function makeLegacyDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE contacts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '', narrative TEXT NOT NULL DEFAULT '', agent_notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'confirmed', source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE contact_identities (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, platform TEXT NOT NULL, value TEXT NOT NULL,
      normalized_value TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      UNIQUE (platform, normalized_value));
    CREATE TABLE contact_events (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, date TEXT NOT NULL, text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE contact_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE contact_group_members (group_id TEXT NOT NULL, contact_id TEXT NOT NULL, PRIMARY KEY (group_id, contact_id));
    CREATE TABLE contact_relations (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, relation TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE (from_id, to_id, relation));
    CREATE TABLE contacts_sync_state (singleton INTEGER PRIMARY KEY, node_id TEXT NOT NULL, state_json TEXT NOT NULL, projection_json TEXT NOT NULL);
  `);
  const t = '2026-07-21T00:00:00.000Z';
  const ins = (sql, ...args) => db.prepare(sql).run(...args);
  // 120 人，跨越多页读取与多个写入批次
  for (let i = 0; i < 120; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    ins(
      'INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, 'person', `测试人${i}`, JSON.stringify([`Tester ${i}`]), `示例公司 · 职位${i}`, `第 ${i} 位的故事。`, '', i === 7 ? 'pending' : 'confirmed', 'agent', t, t,
    );
    ins('INSERT INTO contact_identities VALUES (?, ?, ?, ?, ?, ?, ?, ?)', `id-mail-${i}`, id, 'email', `t${i}@example.test`, `t${i}@example.test`, '', '', t);
    ins('INSERT INTO contact_events VALUES (?, ?, ?, ?, ?, ?)', `ev-${i}`, id, '2026-08-0' + ((i % 9) + 1), `事件 ${i}`, 'session', t);
  }
  ins('INSERT INTO contact_identities VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'id-phone-1', '00000000-0000-4000-8000-000000000001', 'phone', '+86 138 0000 0001', '+8613800000001', '', '', t);
  ins('INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'org-1', 'org', '示例公司', '["Example Co"]', '一家示例公司', '', '', 'confirmed', 'agent', t, t);
  ins('INSERT INTO contact_groups VALUES (?, ?, ?, ?)', 'g-1', '同事', '', t);
  ins('INSERT INTO contact_group_members VALUES (?, ?)', 'g-1', '00000000-0000-4000-8000-000000000001');
  ins('INSERT INTO contact_group_members VALUES (?, ?)', 'g-1', '00000000-0000-4000-8000-000000000002');
  ins('INSERT INTO contact_relations VALUES (?, ?, ?, ?, ?, ?)', 'rel-1', '00000000-0000-4000-8000-000000000001', 'org-1', 'works_at', '', t);
  db.close();
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-contacts-test-'));
}

const ok = (r) => {
  assert.equal(r.ok, true, r.message);
  return r.result;
};

/* ───────── 测试 ───────── */

test('首次启动从旧版通讯录完整复制一份，保留 id、状态、身份、事件、分组与关系；再次启动不重复导入', async () => {
  const dir = tmp();
  const legacy = path.join(dir, 'legacy.db');
  makeLegacyDb(legacy);
  const libDir = path.join(dir, 'lib');
  fs.mkdirSync(libDir);

  const a = boot({ libDir, legacyDb: legacy });
  try {
    const s = ok(await a.call('stats'));
    assert.deepEqual({ people: s.people, orgs: s.orgs, pending: s.pending, groups: s.groups }, { people: 120, orgs: 1, pending: 1, groups: 1 });
    const one = ok(await a.call('get', { id: '00000000-0000-4000-8000-000000000001' }));
    assert.equal(one.name, '测试人1');
    assert.deepEqual(one.aliases, ['Tester 1']);
    assert.equal(one.identities.length, 2);
    assert.equal(one.events.length, 1);
    assert.deepEqual(one.groups.map((g) => g.name), ['同事']);
    assert.equal(one.relations[0].otherName, '示例公司');
    const st = await a.view('state');
    assert.equal(st.ok, true);
    assert.equal(st.result.legacy.status, 'done');
    assert.equal(st.result.legacy.counts.contacts.local, 121);
  } finally {
    a.close();
  }

  // 第二次启动：已导入，不重复；库已是最新版本，不再触发迁移（宿主每次迁移都会备份）
  const migrationsBefore = migrations.count;
  const b = boot({ libDir, legacyDb: legacy });
  try {
    const s = ok(await b.call('stats'));
    assert.equal(s.people, 120);
    assert.equal(migrations.count, migrationsBefore);
  } finally {
    b.close();
  }
  // 旧库未被改动
  const check = new DatabaseSync(legacy, { readOnly: true });
  assert.equal(check.prepare('SELECT count(*) AS n FROM contacts').get().n, 121);
  check.close();
});

test('没有旧版通讯录时不导入，资料库保持为空', async () => {
  const dir = tmp();
  const a = boot({ libDir: dir });
  try {
    const s = ok(await a.call('stats'));
    assert.equal(s.people, 0);
    const st = await a.view('state');
    assert.equal(st.result.legacy.status, 'none');
  } finally {
    a.close();
  }
});

test('查人、建档去重、身份冲突、追加更新、记事件、整理分组、合并与删除', async () => {
  const dir = tmp();
  const a = boot({ libDir: dir });
  try {
    const created = ok(await a.call('save', {
      name: '林知夏', aliases: ['Connie'], summary: '星屿的设计负责人',
      identities: [{ platform: 'email', value: 'Zhixia@Example.test' }, { platform: 'phone', value: '+86 138-0000-2041' }],
      groups: ['星屿科技'],
    }));
    assert.equal(created.created, true);

    // 同名再建 → 疑似重复
    const dup = await a.call('save', { name: '林知夏' });
    assert.equal(dup.ok, false);
    assert.equal(dup.errorCode, 'DUPLICATE_SUSPECT');

    // 身份已属于别人 → 冲突
    const other = ok(await a.call('save', { name: '周叙白', identities: [{ platform: 'feishu', value: 'xubai' }] }));
    const conflict = await a.call('save', { id: other.id, identities: [{ platform: 'email', value: 'zhixia@example.test' }] });
    assert.equal(conflict.errorCode, 'IDENTITY_CONFLICT');

    // 各种线索都能找到
    for (const query of ['zhixia@example.test', '13800002041', '+86 138 0000 2041', 'connie', '知夏', '设计负责人']) {
      const r = ok(await a.call('find', { query }));
      assert.equal(r.results[0]?.id, created.id, `find ${query}`);
    }

    // 只记了名的人，用全名也能找到；短拉丁名不会被长词误中
    const short = ok(await a.call('save', { name: '紫旎', summary: 'QA' }));
    const al = ok(await a.call('save', { name: 'Al' }));
    const full = ok(await a.call('find', { query: '徐紫旎' }));
    assert.equal(full.results[0]?.id, short.id);
    assert.equal(full.results[0]?.matchType, 'partial');
    assert.ok(!ok(await a.call('find', { query: 'alan' })).results.some((r) => r.id === al.id));
    ok(await a.call('delete', { id: short.id, confirm: true }));
    ok(await a.call('delete', { id: al.id, confirm: true }));

    // 追加更新：别名并集，不丢旧值
    ok(await a.call('save', { id: created.id, aliases: ['Zhixia Lin'], summary: '增长设计负责人' }));
    let c = ok(await a.call('get', { id: created.id }));
    assert.deepEqual(c.aliases, ['Connie', 'Zhixia Lin']);
    assert.equal(c.summary, '增长设计负责人');

    ok(await a.call('log_event', { contact_id: created.id, date: '2026-10-08', text: '转到增长团队' }));
    c = ok(await a.call('get', { id: created.id }));
    assert.equal(c.events[0].text, '转到增长团队');

    ok(await a.call('organize', { action: 'move_to_group', contact_ids: [created.id], group: '前同事' }));
    c = ok(await a.call('get', { id: created.id }));
    assert.deepEqual(c.groups.map((g) => g.name), ['前同事']);

    ok(await a.call('relate', { from_id: created.id, to_id: other.id, relation: '同组' }));

    // 合并：other 并入 created
    const m = ok(await a.call('merge', { source_id: other.id, target_id: created.id }));
    assert.equal(m.id, created.id);
    c = ok(await a.call('get', { id: created.id }));
    assert.ok(c.aliases.includes('周叙白'));
    assert.ok(c.identities.some((i) => i.platform === 'feishu'));
    assert.equal(c.relations.length, 0, 'self relation removed after merge');
    assert.equal((await a.call('get', { id: other.id })).errorCode, 'NOT_FOUND');

    // 删除必须显式确认
    assert.equal((await a.call('delete', { id: created.id })).errorCode, 'CONFIRM_REQUIRED');
    ok(await a.call('delete', { id: created.id, confirm: true }));
    assert.equal(ok(await a.call('stats')).people, 0);
  } finally {
    a.close();
  }
});

test('从 macOS 通讯录导入：先预览，再按锚点、邮箱、电话合并；重名进待确认；重复导入不重复建档', async () => {
  const dir = tmp();
  const fixture = path.join(dir, 'system.json');
  fs.writeFileSync(fixture, JSON.stringify([
    { name: '林知夏', org: '星屿科技', title: '设计', id: 'AB-1', isCompany: false, emails: [{ v: 'zhixia@example.test', l: '_$!<Work>!$_' }], phones: [] },
    { name: '新朋友', org: '', title: '', id: 'AB-2', isCompany: false, emails: [], phones: [{ v: '+1 (555) 010-0002', l: 'mobile' }] },
    { name: '林知夏', org: '', title: '', id: 'AB-3', isCompany: false, emails: [], phones: [] },
    { name: '星屿科技', org: '星屿科技', title: '', id: 'AB-4', isCompany: true, emails: [], phones: [] },
  ]));
  const a = boot({ libDir: dir, systemFixture: fixture });
  try {
    const existing = ok(await a.call('save', { name: '林知夏', identities: [{ platform: 'email', value: 'zhixia@example.test' }] }));
    const preview = ok(await a.call('import_macos', {}));
    assert.equal(preview.dryRun, true);
    assert.equal(ok(await a.call('stats')).people, 1, 'dry run writes nothing');

    const r = ok(await a.call('import_macos', { dry_run: false }));
    assert.deepEqual({ created: r.created, updated: r.updated }, { created: 3, updated: 1 });
    assert.equal(r.needsReview.length, 1);
    const c = ok(await a.call('get', { id: existing.id }));
    assert.ok(c.identities.some((i) => i.platform === 'apple-contacts' && i.value === 'AB-1'));
    const s = ok(await a.call('stats'));
    assert.deepEqual({ people: s.people, orgs: s.orgs, pending: s.pending }, { people: 3, orgs: 1, pending: 1 });

    const again = ok(await a.call('import_macos', { dry_run: false }));
    assert.equal(again.created, 0);
    assert.equal(again.unchanged, 4);
  } finally {
    a.close();
  }
});

test('主视图请求通道：列表、详情与修改后的变更通知', async () => {
  const dir = tmp();
  const a = boot({ libDir: dir });
  try {
    const saved = await a.view('save', { name: '许嘉言', summary: '律师', groups: ['物业与生活'] });
    assert.equal(saved.ok, true);
    const list = await a.view('list');
    assert.equal(list.result.contacts.length, 1);
    assert.deepEqual(list.result.contacts[0].groups, ['物业与生活']);
    assert.equal(list.result.groups[0].members, 1);
    const detail = await a.view('get', { id: saved.result.id });
    assert.equal(detail.result.summary, '律师');
    const bad = await a.view('nope');
    assert.equal(bad.ok, false);
  } finally {
    a.close();
  }
});

test('自动维护：begin 给出检查点与档位，end 记录结果并推进检查点；档位切换改变节奏', async () => {
  const dir = tmp();
  const a = boot({ libDir: dir });
  try {
    const b1 = ok(await a.call('maintenance', { action: 'begin' }));
    assert.equal(b1.firstRun, true);
    assert.equal(b1.profile, 'colleagues');
    assert.equal(b1.maxChanges, 30);
    assert.ok(Date.parse(b1.checkpoint) < Date.parse(b1.now));
    ok(await a.call('maintenance', { action: 'end', checkpoint: b1.now, scanned: 4, created: 2, updated: 1, pending: 1, note: '新认识两位' }));
    const b2 = ok(await a.call('maintenance', { action: 'begin' }));
    assert.equal(b2.firstRun, false);
    assert.equal(b2.checkpoint, b1.now);
    const st = (await a.view('state')).result;
    assert.equal(st.maintenance.last.created, 2);
    assert.equal(st.maintenance.runs.length, 1);

    // 未来的检查点不被接受
    ok(await a.call('maintenance', { action: 'end', checkpoint: '2999-01-01T00:00:00Z' }));
    assert.ok(Date.parse(ok(await a.call('maintenance', { action: 'begin' })).checkpoint) <= Date.now() + 1000);

    // 客户很多：节奏更快、上限更高；请求自动化时带上对应间隔
    const set = await a.view('settings', { profile: 'clients' });
    assert.equal(set.result.profile, 'clients');
    assert.equal(ok(await a.call('maintenance', { action: 'begin' })).maxChanges, 100);
    const req = await a.view('requestAutomation');
    assert.equal(req.ok, true);
    assert.equal(a.schedules.length, 1);
    assert.equal(a.schedules[0].intervalMs, 6 * 3600 * 1000);
    assert.match(a.schedules[0].prompt, /maintenance/);
    assert.ok(a.schedules[0].prompt.length <= 2000);
    assert.equal((await a.view('state')).result.automationRequested.profile, 'clients');
  } finally {
    a.close();
  }
});

test('批量建档：逐条返回结果，单条失败不影响其它', async () => {
  const dir = tmp();
  const a = boot({ libDir: dir });
  try {
    ok(await a.call('save', { name: '已存在客户', identities: [{ platform: 'email', value: 'old@example.test' }] }));
    const items = Array.from({ length: 60 }, (_, i) => ({ name: `客户${i}`, kind: 'person', groups: ['客户A公司'], identities: [{ platform: 'email', value: `c${i}@example.test` }] }));
    items.push({ name: '冲突的人', identities: [{ platform: 'email', value: 'OLD@example.test' }] });
    items.push({ name: '已存在客户' });
    const r = ok(await a.call('save_many', { items }));
    assert.equal(r.saved, 60);
    assert.equal(r.failed, 2);
    assert.deepEqual(r.results.filter((x) => !x.ok).map((x) => x.errorCode).sort(), ['DUPLICATE_SUSPECT', 'IDENTITY_CONFLICT']);
    const g = ok(await a.call('groups', { action: 'list' }));
    assert.equal(g.groups.find((x) => x.name === '客户A公司').members, 60);
  } finally {
    a.close();
  }
});

test('导入过 macOS 通讯录后，超过一天会在自动维护开始时自动增量对账（不需要模型）', async () => {
  const dir = tmp();
  const fixture = path.join(dir, 'system.json');
  const write = (list) => fs.writeFileSync(fixture, JSON.stringify(list));
  write([{ name: '甲', org: '', title: '', id: 'AB-1', isCompany: false, emails: [], phones: [{ v: '+1 555 010 0001', l: '' }] }]);
  const a = boot({ libDir: dir, systemFixture: fixture });
  try {
    ok(await a.call('import_macos', { dry_run: false }));
    write([
      { name: '甲', org: '', title: '', id: 'AB-1', isCompany: false, emails: [], phones: [{ v: '+1 555 010 0001', l: '' }] },
      { name: '乙丙', org: '', title: '', id: 'AB-2', isCompany: false, emails: [], phones: [] },
    ]);
    // 未满一天：不对账
    ok(await a.call('maintenance', { action: 'begin' }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ok(await a.call('stats')).people, 1);
    // 把上次导入时间改到两天前
    a.library.db('contacts.sqlite').prepare("UPDATE plugin_meta SET value = json_set(value, '$.at', ?) WHERE key = 'system_import'").run(new Date(Date.now() - 2 * 86400000).toISOString());
    ok(await a.call('maintenance', { action: 'begin' }));
    let people = 0;
    for (let i = 0; i < 40 && people < 2; i++) {
      await new Promise((r) => setTimeout(r, 100));
      people = ok(await a.call('stats')).people;
    }
    assert.equal(people, 2);
    // 关掉每日对账后不再自动执行
    await a.view('settings', { macAutoSync: false });
    a.library.db('contacts.sqlite').prepare("UPDATE plugin_meta SET value = json_set(value, '$.at', ?) WHERE key = 'system_import'").run(new Date(Date.now() - 2 * 86400000).toISOString());
    write([{ name: '丁', org: '', title: '', id: 'AB-3', isCompany: false, emails: [], phones: [] }]);
    ok(await a.call('maintenance', { action: 'begin' }));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(ok(await a.call('stats')).people, 2);
  } finally {
    a.close();
  }
});

test('几千人的规模：批量写入、列表与查重都在可接受时间内完成', async () => {
  const dir = tmp();
  const a = boot({ libDir: dir });
  try {
    const t0 = Date.now();
    for (let b = 0; b < 30; b++) {
      const items = Array.from({ length: 100 }, (_, i) => {
        const n = b * 100 + i;
        return { name: `客户联系人${n}`, aliases: [`Client ${n}`], groups: [`公司${n % 50}`], identities: [{ platform: 'email', value: `p${n}@example.test` }] };
      });
      const r = ok(await a.call('save_many', { items }));
      assert.equal(r.failed, 0);
    }
    const list = await a.view('list');
    assert.equal(list.result.contacts.length, 3000);
    const t1 = Date.now();
    const d = ok(await a.call('find_duplicates'));
    const dupMs = Date.now() - t1;
    assert.ok(Array.isArray(d.pairs));
    assert.ok(dupMs < 8000, `find_duplicates took ${dupMs}ms`);
    const f = ok(await a.call('find', { query: 'p2999@example.test' }));
    assert.equal(f.results[0].name, '客户联系人2999');
    console.log(`# 3000 people: write+list ${t1 - t0}ms, duplicates ${dupMs}ms`);
  } finally {
    a.close();
  }
});
