'use strict';
/**
 * 通讯录主视图：两栏（书页式名单 + 信笺式详情）。
 * 页面没有任何宿主能力，所有数据经同源 BroadcastChannel 交给 main.js 处理。
 */
(() => {
  /* ───────── 文案 ───────── */
  const STRINGS = {
    'zh-CN': {
      all: '所有人', recent: '最近联系', pending: '待确认', orgs: '公司与团队', groups: '分组',
      byName: '按名字', byRecent: '按最近', people: (n) => `${n} 人`, search: '找一个人…',
      pendingLine: (n) => ['有 ', `${n} 件事`, '等你确认'],
      week: '这周', month: '这个月', earlier: '更早',
      today: '今天', yesterday: '昨天', days: (n) => `${n}天`, weeks: (n) => `${n}周`, months: (n) => `${n}个月`, years: (n) => `${n}年`,
      noMatch: '没有找到这个人。', emptyScope: '这里还没有人。',
      edit: '编辑', more: '更多', back: '返回', save: '保存', cancel: '取消', create: '新建',
      newContact: '新建联系人', importMac: '从 macOS 通讯录导入', findDups: '查找重复', retryLegacy: '重新导入旧版通讯录',
      related: '相关的人', events: '往来', showAll: (n) => `查看全部 ${n} 条`, showLess: '收起',
      addEvent: '记一笔，比如：约了下周四午饭', add: '添加',
      emptyStory: '还没有关于 TA 的故事。点这里写几句，或让 AI 帮忙补全。',
      noteLabel: '给 AI 的提示',
      pendingAsk: 'AI 不太确定这份档案，确认后才会正式记下。', confirm: '确认', notThis: '删除',
      inGroups: '分组', copied: (v) => `已复制 ${v}`,
      markPending: '标记为待确认', markConfirmed: '标记为已确认', addToGroup: '加入分组', newGroup: '新分组名，回车创建',
      removeFromGroup: (g) => `移出「${g}」`, del: '删除这个人…', delAsk: (n) => `确定删除「${n}」？他的往来和联系方式会一起删除，无法恢复。`, delYes: '删除',
      deleted: (n) => `已删除 ${n}`, savedOk: '已保存', added: '已记下', confirmed: '已确认',
      fName: '名字', fAliases: '别名（逗号分隔）', fKind: '类型', person: '人', org: '组织', fSummary: '一句话介绍', fStory: '你们的故事',
      fNote: '给 AI 的提示（只给 AI 看）', fIds: '联系方式与身份', addId: '添加一项', fGroups: '分组（逗号分隔）',
      dupSuspect: '已有名字相似的人：', createAnyway: '仍然新建',
      helloTitle: '建立你的通讯录', helloText: '从 Mac 的通讯录导入名片，之后 AI 会在对话中帮你慢慢记住每个人是谁、你们聊过什么。',
      helloManual: '手动新建一位', helloNonMac: '可以先手动新建，之后让 AI 在对话中帮你记人。',
      legacyFailed: (m) => `旧版通讯录没有导入成功：${m}`,
      loading: '正在打开通讯录…', importingLegacy: '正在从旧版通讯录导入…', legacyDone: (n) => `已从旧版通讯录导入 ${n} 份档案`,
      readMac: '读取 Mac 通讯录', reading: '正在读取 Mac 通讯录…第一次会弹出系统授权，请选择允许。',
      importIntro: '只读取，不会修改 Mac 通讯录。邮箱或电话相同的名片会并入已有档案，名字相似的会放进「待确认」。',
      preview: (r) => `共 ${r.total} 张名片：新建 ${r.created} 位，补全 ${r.updated} 位已有档案，${r.unchanged} 位已经在了。`,
      previewReview: (n) => `其中 ${n} 位和已有档案重名，会放进「待确认」等你判断。`,
      doImport: '导入', importing: '正在导入…', imported: (r) => `已导入：新建 ${r.created} 位，补全 ${r.updated} 位`,
      noPerm: '没有通讯录权限。请到「系统设置 › 隐私与安全性 › 自动化」允许 Cindy 控制「通讯录」，然后重试。',
      macOnly: '只有 Mac 可以从系统通讯录导入。', retry: '重试',
      dupsTitle: '可能重复的档案', dupsNone: '没有发现重复的档案。', mergeLeft: '并入左边', notSame: '不是同一人', merged: '已合并',
      askPh: (n) => (n ? `问 AI 关于${n}的任何事` : '让 AI 帮你整理通讯录'), askSent: '已交给 AI，在新任务里处理', failed: '没有成功：',
      libError: '通讯录资料库暂时打不开：',
      autoOff: '让 AI 自动整理通讯录', autoOn: '开启', autoWaiting: '自动整理：等你在自动化页保存', settingsLink: '设置',
      autoLast: (when, r) => `上次自动整理 ${when} · 新增 ${r.created} · 更新 ${r.updated}${r.pending ? ` · 待确认 ${r.pending}` : ''}`,
      autoTitle: '自动整理',
      autoText: '开启后，Cindy 会定期读一遍你最近的对话（装了邮件、日历插件时也会看），把新认识的人、职位变化、联系方式和约定记进通讯录。拿不准的放进「待确认」，不会删除或合并。每一轮都会用到 AI 额度。',
      profileLabel: '你的通讯录主要是', profColleagues: '同事和朋友', profClients: '很多客户',
      profColleaguesHint: '每天整理一次', profClientsHint: '每 6 小时整理一次，客户按公司归类，记下需求、报价和跟进约定',
      macSync: '每天和 macOS 通讯录对一次账（不用 AI）', macSyncHint: '只在你导入过一次后生效；只读，不改 Mac 通讯录',
      openAutomation: '去自动化页开启', automationOpened: '已打开 Cindy 的自动化页：选好模型后点保存，自动整理就开始了。',
      automationAgain: '重新打开自动化页', stopHint: '想停用或改频率：在 Cindy 的自动化页暂停或删除「整理通讯录」。',
      runsTitle: '最近几次', runLine: (r) => `新增 ${r.created} · 更新 ${r.updated} · 待确认 ${r.pending} · 读了 ${r.scanned} 段对话`,
      noSchedule: '当前 Cindy 版本还不支持由插件发起自动化。',
    },
    en: {
      all: 'Everyone', recent: 'Recent', pending: 'To confirm', orgs: 'Companies & teams', groups: 'Groups',
      byName: 'By name', byRecent: 'By recent', people: (n) => `${n} people`, search: 'Find someone…',
      pendingLine: (n) => ['', `${n} ${n === 1 ? 'item' : 'items'}`, ' to confirm'],
      week: 'This week', month: 'This month', earlier: 'Earlier',
      today: 'today', yesterday: 'yesterday', days: (n) => `${n}d`, weeks: (n) => `${n}w`, months: (n) => `${n}mo`, years: (n) => `${n}y`,
      noMatch: 'No one matches.', emptyScope: 'No one here yet.',
      edit: 'Edit', more: 'More', back: 'Back', save: 'Save', cancel: 'Cancel', create: 'Create',
      newContact: 'New contact', importMac: 'Import from macOS Contacts', findDups: 'Find duplicates', retryLegacy: 'Re-import old contacts',
      related: 'Related', events: 'Timeline', showAll: (n) => `Show all ${n}`, showLess: 'Show less',
      addEvent: 'Note something, e.g. lunch next Thursday', add: 'Add',
      emptyStory: 'No story yet. Click to write a few lines, or let AI fill it in.',
      noteLabel: 'Note for AI',
      pendingAsk: 'AI is not sure about this entry. Confirm it to keep it.', confirm: 'Confirm', notThis: 'Delete',
      inGroups: 'Groups', copied: (v) => `Copied ${v}`,
      markPending: 'Mark as to confirm', markConfirmed: 'Mark as confirmed', addToGroup: 'Add to group', newGroup: 'New group name, press Enter',
      removeFromGroup: (g) => `Remove from “${g}”`, del: 'Delete…', delAsk: (n) => `Delete “${n}”? Their timeline and contact details are deleted too. This cannot be undone.`, delYes: 'Delete',
      deleted: (n) => `Deleted ${n}`, savedOk: 'Saved', added: 'Noted', confirmed: 'Confirmed',
      fName: 'Name', fAliases: 'Other names (comma separated)', fKind: 'Type', person: 'Person', org: 'Organization', fSummary: 'One-line intro', fStory: 'Your story',
      fNote: 'Note for AI (only AI sees this)', fIds: 'Contact details', addId: 'Add', fGroups: 'Groups (comma separated)',
      dupSuspect: 'Someone with a similar name exists: ', createAnyway: 'Create anyway',
      helloTitle: 'Start your contacts', helloText: 'Import cards from your Mac’s Contacts. Later, AI remembers who people are and what you talked about.',
      helloManual: 'Add someone', helloNonMac: 'Add people by hand, and let AI remember people as you chat.',
      legacyFailed: (m) => `Old contacts were not imported: ${m}`,
      loading: 'Opening contacts…', importingLegacy: 'Importing your old contacts…', legacyDone: (n) => `Imported ${n} entries from old contacts`,
      readMac: 'Read Mac Contacts', reading: 'Reading Mac Contacts… macOS asks for permission the first time.',
      importIntro: 'Read-only: your Mac Contacts are not changed. Cards with the same email or phone join existing entries; similar names go to “To confirm”.',
      preview: (r) => `${r.total} cards: ${r.created} new, ${r.updated} existing entries completed, ${r.unchanged} already here.`,
      previewReview: (n) => `${n} share a name with an existing entry and go to “To confirm”.`,
      doImport: 'Import', importing: 'Importing…', imported: (r) => `Imported: ${r.created} new, ${r.updated} completed`,
      noPerm: 'No access to Contacts. Allow Cindy to control Contacts in System Settings › Privacy & Security › Automation, then retry.',
      macOnly: 'Importing from system contacts works only on a Mac.', retry: 'Retry',
      dupsTitle: 'Possible duplicates', dupsNone: 'No duplicates found.', mergeLeft: 'Merge into left', notSame: 'Not the same', merged: 'Merged',
      askPh: (n) => (n ? `Ask AI anything about ${n}` : 'Ask AI to tidy up your contacts'), askSent: 'Sent to AI in a new task', failed: 'Did not work: ',
      libError: 'The contacts library cannot be opened right now: ',
      autoOff: 'Let AI keep your contacts up to date', autoOn: 'Turn on', autoWaiting: 'Auto-tidy: waiting for you to save the automation', settingsLink: 'Settings',
      autoLast: (when, r) => `Last tidy ${when} · ${r.created} new · ${r.updated} updated${r.pending ? ` · ${r.pending} to confirm` : ''}`,
      autoTitle: 'Auto-tidy',
      autoText: 'When on, Cindy regularly reads your recent conversations (and mail or calendar, if those plugins are installed) and records new people, role changes, contact details and plans. Anything uncertain goes to “To confirm”; nothing is deleted or merged. Each run uses AI quota.',
      profileLabel: 'Your contacts are mostly', profColleagues: 'Colleagues and friends', profClients: 'Many clients',
      profColleaguesHint: 'Tidy once a day', profClientsHint: 'Tidy every 6 hours, group clients by company, note needs, quotes and follow-ups',
      macSync: 'Reconcile with macOS Contacts daily (no AI)', macSyncHint: 'Starts after your first import; read-only, your Mac Contacts are not changed',
      openAutomation: 'Open Automations to turn on', automationOpened: 'Cindy’s Automations page is open: pick a model and save to start auto-tidy.',
      automationAgain: 'Open Automations again', stopHint: 'To pause or change the schedule, pause or delete “整理通讯录” on Cindy’s Automations page.',
      runsTitle: 'Recent runs', runLine: (r) => `${r.created} new · ${r.updated} updated · ${r.pending} to confirm · ${r.scanned} conversations read`,
      noSchedule: 'This Cindy version cannot start automations from plugins yet.',
    },
  };
  let T = STRINGS.en;
  let LOCALE = 'en';

  /* ───────── 小工具 ───────── */
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ICONS = {
    down: '<path d="m6 9 6 6 6-6"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="9" r="2.5"/><path d="M6 8.5v7M18 11.5c0 3-3 4-6.5 4.5"/>',
    at: '<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
    spark: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
  };
  const I = (n, cls) => `<svg class="i${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
  const PLATFORM_ICON = { email: 'mail', phone: 'phone', feishu: 'chat', lark: 'chat', slack: 'chat', wechat: 'chat', telegram: 'chat', dingtalk: 'chat', discord: 'chat', github: 'git', gitlab: 'git', x: 'at', twitter: 'at' };
  const PLATFORM_NAME = { feishu: '飞书', lark: 'Lark', slack: 'Slack', wechat: '微信', telegram: 'Telegram', dingtalk: '钉钉', discord: 'Discord' };
  /** 飞书 open_id 这类机器 id 不直接给人看，显示平台名，点击仍复制原值。 */
  function identityLabel(i) {
    const opaque = /^[a-z]{2,3}_[0-9a-z]{16,}$/i.test(i.value) || (i.value.length > 28 && !/[\s@.]/.test(i.value));
    if (opaque) return i.label || PLATFORM_NAME[i.platform] || i.platform;
    return i.value;
  }
  /** 旧数据里的说明文字：去掉导入标记注释，**粗体** 渲染成粗体，其余一律转义。 */
  function richText(text) {
    const clean = String(text || '').replace(/<!--[\s\S]*?-->/g, '').trim();
    return esc(clean).replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
  }
  const PLATFORMS = ['email', 'phone', 'feishu', 'wechat', 'slack', 'telegram', 'github', 'x', 'other'];

  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  /* ───────── 与 main.js 通信 ───────── */
  const channel = new BroadcastChannel('cindy-contacts');
  const pending = new Map();
  let lastWake = 0;
  async function wake() {
    if (Date.now() - lastWake < 20000) return;
    lastWake = Date.now();
    try {
      await fetch('/wake');
    } catch (_) {
      /* 已经在跑时也可能失败，交给重发兜底 */
    }
  }
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = uid();
      const send = () => channel.postMessage({ kind: 'req', id, method, params: params || {} });
      const timer = setInterval(() => {
        wake();
        send();
      }, 800);
      pending.set(id, { resolve, reject, timer });
      wake().then(send);
    });
  }
  channel.onmessage = (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.kind === 'res' && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearInterval(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(Object.assign(new Error(m.error?.message || 'failed'), { code: m.error?.code, extra: m.error?.extra }));
    } else if (m.kind === 'event') {
      onEvent(m);
    }
  };

  /* ───────── 状态 ───────── */
  const S = {
    boot: 'loading',
    meta: null,
    contacts: [],
    groups: [],
    scope: 'all',
    sort: 'az',
    query: '',
    selId: null,
    detail: null,
    mode: 'view', // view | edit | new | import | dups | hello
    showAllEvents: false,
    confirmDelete: false,
    importStep: null,
    importResult: null,
    importError: null,
    dups: null,
    dismissedDups: new Set(),
    formError: null,
    progress: null,
  };

  /* ───────── 名单分组与时间 ───────── */
  const collator = new Intl.Collator(['zh-Hans-CN-u-co-pinyin', 'zh-Hans', 'en'], { sensitivity: 'base', numeric: true });
  const BOUNDS = [['A', '阿'], ['B', '八'], ['C', '嚓'], ['D', '哒'], ['E', '妸'], ['F', '发'], ['G', '旮'], ['H', '哈'], ['J', '讥'], ['K', '咔'], ['L', '垃'], ['M', '妈'], ['N', '拿'], ['O', '噢'], ['P', '妑'], ['Q', '七'], ['R', '呥'], ['S', '仨'], ['T', '他'], ['W', '屲'], ['X', '夕'], ['Y', '丫'], ['Z', '帀']];
  function letterOf(name) {
    const ch = String(name || '').trim().charAt(0);
    if (/[A-Za-z]/.test(ch)) return ch.toUpperCase();
    if (/[㐀-鿿]/.test(ch)) {
      for (let i = BOUNDS.length - 1; i >= 0; i--) if (collator.compare(ch, BOUNDS[i][1]) >= 0) return BOUNDS[i][0];
    }
    return '#';
  }
  function daysSince(day) {
    if (!day) return Infinity;
    const d = Date.parse(`${day}T00:00:00`);
    if (Number.isNaN(d)) return Infinity;
    const now = new Date();
    const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return Math.max(0, Math.round((t0 - d) / 86400000));
  }
  function ago(day) {
    const n = daysSince(day);
    if (n === Infinity) return '';
    if (n === 0) return T.today;
    if (n === 1) return T.yesterday;
    if (n < 7) return T.days(n);
    if (n < 30) return T.weeks(Math.floor(n / 7));
    if (n < 365) return T.months(Math.floor(n / 30));
    return T.years(Math.floor(n / 365));
  }
  function fmtDate(day) {
    const d = new Date(`${day}T00:00:00`);
    if (Number.isNaN(d.getTime())) return day;
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(LOCALE, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function visible() {
    let rows = S.contacts;
    if (S.scope === 'recent') rows = rows.filter((c) => daysSince(c.last) <= 30);
    else if (S.scope === 'pending') rows = rows.filter((c) => c.status === 'pending');
    else if (S.scope === 'orgs') rows = rows.filter((c) => c.kind === 'org');
    else if (S.scope.startsWith('g:')) rows = rows.filter((c) => c.groups.includes(S.scope.slice(2)));
    const q = S.query.trim().toLowerCase();
    if (q) {
      rows = rows.filter((c) =>
        [c.name, c.summary, ...c.aliases, ...c.groups].some((v) => String(v || '').toLowerCase().includes(q)),
      );
    }
    return rows;
  }

  function grouped(rows) {
    if (S.sort === 'recent') {
      const sorted = rows.slice().sort((a, b) => daysSince(a.last) - daysSince(b.last) || collator.compare(a.name, b.name));
      const buckets = [[T.week, 7], [T.month, 31], [T.earlier, Infinity]];
      const out = [];
      let lo = -1;
      for (const [label, hi] of buckets) {
        const items = sorted.filter((c) => {
          const d = daysSince(c.last);
          return d > lo && d <= hi;
        });
        if (items.length) out.push({ key: label, when: true, items });
        lo = hi;
      }
      return out;
    }
    const withLetter = rows.map((c) => ({ c, l: letterOf(c.name) }));
    withLetter.sort((a, b) => (a.l === b.l ? collator.compare(a.c.name, b.c.name) : a.l === '#' ? 1 : b.l === '#' ? -1 : a.l.localeCompare(b.l)));
    const out = [];
    for (const { c, l } of withLetter) {
      if (!out.length || out[out.length - 1].key !== l) out.push({ key: l, items: [] });
      out[out.length - 1].items.push(c);
    }
    return out;
  }

  function scopeTitle() {
    if (S.scope === 'all') return T.all;
    if (S.scope === 'recent') return T.recent;
    if (S.scope === 'pending') return T.pending;
    if (S.scope === 'orgs') return T.orgs;
    return S.scope.slice(2);
  }

  /* ───────── 渲染：名单 ───────── */
  const listpane = $('#listpane');
  const detailEl = $('#detail');

  function renderList() {
    const rows = visible();
    const pendingCount = S.contacts.filter((c) => c.status === 'pending').length;
    let h = `<div class="lhead">
      <button class="scope" id="scopeBtn" aria-haspopup="menu">${esc(scopeTitle())}${I('down')}</button>
      <div class="lsub"><span>${esc(T.people(rows.length))}</span><span>·</span>
        <button data-sort="az" aria-pressed="${S.sort === 'az'}">${esc(T.byName)}</button><span>/</span>
        <button data-sort="recent" aria-pressed="${S.sort === 'recent'}">${esc(T.byRecent)}</button></div>
      <label class="find">${I('search')}<input id="findInput" type="search" value="${esc(S.query)}" placeholder="${esc(T.search)}" autocomplete="off" spellcheck="false">${S.query ? `<button class="clear" id="clearFind" aria-label="clear">${I('x', 's')}</button>` : ''}</label>`;
    if (pendingCount && S.scope !== 'pending') {
      const [a, b, c] = T.pendingLine(pendingCount);
      h += `<button class="pend" id="pendLink"><span>${esc(a)}<b>${esc(b)}</b>${esc(c)}</span>${I('arrow', 's')}</button>`;
    }
    h += '</div><div class="lscroll" id="lscroll">';
    if (!rows.length) {
      h += `<div class="lempty">${esc(S.query ? T.noMatch : T.emptyScope)}</div>`;
    } else {
      for (const g of grouped(rows)) {
        const cur = g.items.some((c) => c.id === S.selId);
        h += `<div class="lg${cur ? ' cur' : ''}${g.when ? ' when' : ''}"><div class="ll">${esc(g.key)}</div><div>`;
        for (const c of g.items) {
          h += `<button class="row${c.status === 'pending' ? ' pending' : ''}" data-id="${esc(c.id)}" aria-selected="${c.id === S.selId}">
            <span class="nm">${esc(c.name)}</span><span class="sub">${esc(c.summary || c.groups[0] || '')}</span><span class="t">${esc(ago(c.last))}</span></button>`;
        }
        h += '</div></div>';
      }
    }
    h += '</div>' + autoFooter();
    const keepScroll = $('#lscroll')?.scrollTop || 0;
    const hadFocus = document.activeElement?.id === 'findInput';
    const caret = hadFocus ? document.activeElement.selectionStart : null;
    listpane.innerHTML = h;
    $('#lscroll').scrollTop = keepScroll;
    if (hadFocus) {
      const inp = $('#findInput');
      inp.focus();
      if (caret !== null) inp.setSelectionRange(caret, caret);
    }
  }

  function whenText(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const time = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
    const n = daysSince(day);
    return n === 0 ? `${T.today} ${time}` : n === 1 ? `${T.yesterday} ${time}` : fmtDate(day);
  }

  function autoFooter() {
    if (S.boot !== 'ready' || !S.meta || !S.meta.schedule) return '';
    const m = S.meta.maintenance;
    let text;
    if (m && m.last) text = `<span>${esc(T.autoLast(whenText(m.lastRunAt), m.last))}</span>`;
    else if (S.meta.automationRequested) text = `<span>${esc(T.autoWaiting)}</span>`;
    else text = `<span>${esc(T.autoOff)}</span>`;
    const action = m && m.last || S.meta.automationRequested ? T.settingsLink : T.autoOn;
    return `<button class="lfoot" data-action="auto">${I('spark', 's')}${text}<b>${esc(action)}</b></button>`;
  }

  /* ───────── 渲染：详情 ───────── */
  function contactFooter(d) {
    const ids = d.identities.filter((i) => i.platform !== 'apple-contacts');
    let h = '';
    if (ids.length) {
      h += '<div class="contact">';
      for (const i of ids) {
        h += `<button data-copy="${esc(i.value)}" title="${esc(i.platform)}">${I(PLATFORM_ICON[i.platform] || 'link')}<span>${esc(identityLabel(i))}</span></button>`;
      }
      h += '</div>';
    }
    if (d.groups.length) {
      h += `<div class="groups"${ids.length ? '' : ' style="margin-top:44px"'}><span>${esc(T.inGroups)}</span>${d.groups
        .map((g) => `<button data-scope="g:${esc(g.name)}">${esc(g.name)}</button>`)
        .join('')}</div>`;
    }
    return h;
  }

  function storyBlock(d) {
    const paras = String(d.narrative || '').replace(/<!--[\s\S]*?-->/g, '').split(/\n{2,}|\r\n\r\n/).map((p) => p.trim()).filter(Boolean);
    let h = '<div class="story">';
    if (paras.length) h += paras.map((p) => `<p>${richText(p)}</p>`).join('');
    else if (!d.events.length) h += `<p class="empty" data-action="edit">${esc(T.emptyStory)}</p>`;
    if (String(d.agentNotes || '').trim()) h += `<p class="note">${richText(d.agentNotes)}</p>`;
    if (d.relations.length) {
      const zh = LOCALE === 'zh-CN';
      h += `<p class="note">${esc(T.related)}${zh ? '：' : ': '}${d.relations
        .map((r) => `<span class="link" data-goto="${esc(r.otherId)}">${esc(r.otherName)}</span>${r.relation ? (zh ? `（${esc(r.relation)}）` : ` (${esc(r.relation)})`) : ''}`)
        .join(zh ? '、' : ', ')}</p>`;
    }
    return h + '</div>';
  }

  function eventsBlock(d) {
    const list = S.showAllEvents ? d.events : d.events.slice(0, 6);
    let h = `<div class="sec"><div class="sech"><span>${esc(T.events)}</span>`;
    if (d.events.length > 6) h += `<button data-action="toggleEvents">${esc(S.showAllEvents ? T.showLess : T.showAll(d.events.length))}</button>`;
    h += '</div>';
    for (const e of list) {
      h += `<div class="ev"><span class="d">${esc(fmtDate(e.date))}</span><span class="tx">${esc(e.text)}</span><button class="x" data-del-event="${esc(e.id)}" aria-label="delete">${I('x', 's')}</button></div>`;
    }
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    h += `<form class="addev" id="addEvent"><input id="evText" placeholder="${esc(T.addEvent)}" autocomplete="off"><input id="evDate" type="date" value="${iso}"><button class="pill" type="submit">${esc(T.add)}</button></form></div>`;
    return h;
  }

  function askBar(d) {
    if (!S.meta?.tasks) return '';
    return `<div class="askwrap"><form class="askbar" id="askForm">${I('spark')}<input id="askInput" placeholder="${esc(T.askPh(d ? d.name : ''))}" autocomplete="off"><button class="askgo" type="submit" aria-label="send">${I('arrow', 's')}</button></form></div>`;
  }

  function renderView() {
    const d = S.detail;
    if (!d) {
      detailEl.innerHTML = askBar(null);
      return;
    }
    const latin = d.aliases.find((a) => /^[A-Za-z][A-Za-z .'-]*$/.test(a));
    let h = `<div class="tools"><button class="tbtn back" data-action="back">${I('back', 's')}${esc(T.back)}</button>`;
    if (S.confirmDelete) {
      h += '</div>';
    } else {
      h += `<button class="tbtn" data-action="edit">${esc(T.edit)}</button><button class="tbtn" id="moreBtn" aria-label="${esc(T.more)}">${I('more')}</button></div>`;
    }
    h += `<article class="page"><h1 class="name">${esc(d.name)}${latin ? `<small>${esc(latin)}</small>` : ''}</h1>`;
    h += `<div class="who">${esc(d.summary || '')}</div>`;
    if (S.confirmDelete) {
      h += `<div class="confirmrow"><span>${esc(T.delAsk(d.name))}</span><span class="sp"></span><button class="pill" data-action="cancelDelete">${esc(T.cancel)}</button><button class="pill pri" data-action="doDelete">${esc(T.delYes)}</button></div>`;
    }
    h += storyBlock(d);
    if (d.status === 'pending') {
      h += `<div class="confirmrow"><span>${esc(T.pendingAsk)}</span><span class="sp"></span><button class="pill" data-action="askDelete">${esc(T.notThis)}</button><button class="pill pri" data-action="confirm">${esc(T.confirm)}</button></div>`;
    }
    h += eventsBlock(d);
    h += contactFooter(d);
    h += '</article>';
    h += askBar(d);
    detailEl.innerHTML = h;
  }

  function idRow(i, n) {
    return `<div class="idrow" data-row="${n}"${i.id ? ` data-idid="${esc(i.id)}"` : ''}>
      <select aria-label="platform">${[...new Set([i.platform || 'email', ...PLATFORMS])].map((p) => `<option value="${esc(p)}"${p === (i.platform || 'email') ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>
      <input value="${esc(i.value || '')}" autocomplete="off" spellcheck="false">
      <button type="button" class="rm" data-rm-row="${n}" aria-label="remove">${I('x', 's')}</button></div>`;
  }

  function renderForm(isNew) {
    const d = isNew ? { name: '', kind: 'person', aliases: [], summary: '', narrative: '', agentNotes: '', identities: [], groups: [] } : S.detail;
    const ids = d.identities.filter((i) => i.platform !== 'apple-contacts');
    let h = `<div class="tools"><button class="tbtn" data-action="cancelEdit">${esc(T.cancel)}</button></div><article class="page"><form class="form" id="editForm">`;
    h += `<label class="field"><span>${esc(T.fName)}</span><input class="big" name="name" value="${esc(d.name)}" required autocomplete="off"></label>`;
    h += `<div class="field"><span>${esc(T.fKind)}</span><div class="seg" id="kindSeg"><button type="button" data-kind="person" aria-pressed="${d.kind !== 'org'}">${esc(T.person)}</button><button type="button" data-kind="org" aria-pressed="${d.kind === 'org'}">${esc(T.org)}</button></div></div>`;
    h += `<label class="field"><span>${esc(T.fSummary)}</span><input name="summary" value="${esc(d.summary)}" autocomplete="off"></label>`;
    h += `<label class="field"><span>${esc(T.fStory)}</span><textarea name="narrative">${esc(d.narrative)}</textarea></label>`;
    h += `<div class="field"><span>${esc(T.fIds)}</span><div id="idRows" style="display:grid;gap:8px">${ids.map((i, n) => idRow(i, n)).join('')}</div><div><button type="button" class="pill" data-action="addId">${esc(T.addId)}</button></div></div>`;
    h += `<label class="field"><span>${esc(T.fAliases)}</span><input name="aliases" value="${esc(d.aliases.join(', '))}" autocomplete="off"></label>`;
    h += `<label class="field"><span>${esc(T.fGroups)}</span><input name="groups" value="${esc((d.groups || []).map((g) => g.name || g).join(', '))}" autocomplete="off"></label>`;
    h += `<label class="field"><span>${esc(T.fNote)}</span><textarea name="agentNotes" style="min-height:80px">${esc(d.agentNotes)}</textarea></label>`;
    if (S.formError) h += `<div class="err" id="formErr">${S.formError}</div>`;
    h += `<div class="formacts"><span class="sp"></span><button type="button" class="pill" data-action="cancelEdit">${esc(T.cancel)}</button><button type="submit" class="pill pri">${esc(isNew ? T.create : T.save)}</button></div>`;
    h += '</form></article>';
    detailEl.innerHTML = h;
    detailEl.dataset.kind = d.kind === 'org' ? 'org' : 'person';
    $('#editForm [name=name]').focus();
  }

  function renderHello() {
    const legacy = S.meta?.legacy;
    const mac = S.meta?.platform === 'darwin';
    let h = '<div class="center"><div class="hello">';
    h += `<h1>${esc(T.helloTitle)}</h1><p>${esc(mac ? T.helloText : T.helloNonMac)}</p><div class="acts">`;
    if (mac) h += `<button class="pill pri" data-action="import">${esc(T.importMac)}</button>`;
    h += `<button class="pill" data-action="new">${esc(T.helloManual)}</button></div>`;
    if (legacy && (legacy.status === 'error' || legacy.status === 'partial')) {
      h += `<div class="stat">${esc(T.legacyFailed(legacy.message || legacy.status))} <button class="link" data-action="retryLegacy">${esc(T.retry)}</button></div>`;
    }
    h += '</div></div>';
    detailEl.innerHTML = h;
  }

  function renderImport() {
    let h = `<div class="tools"><button class="tbtn" data-action="closePanel">${esc(T.cancel)}</button></div><div class="center"><div class="hello"><h1>${esc(T.importMac)}</h1>`;
    if (S.importError) {
      const msg = S.importError.code === 'PERMISSION_DENIED' ? T.noPerm : S.importError.code === 'UNSUPPORTED' ? T.macOnly : T.failed + S.importError.message;
      h += `<p>${esc(msg)}</p><div class="acts"><button class="pill pri" data-action="readMac">${esc(T.retry)}</button></div>`;
    } else if (S.importStep === 'reading' || S.importStep === 'importing') {
      h += `<p><span class="spin"></span>${esc(S.importStep === 'reading' ? T.reading : T.importing)}</p>`;
    } else if (S.importStep === 'preview' && S.importResult) {
      const r = S.importResult;
      h += `<p>${esc(T.preview(r))}${r.needsReview.length ? `<br>${esc(T.previewReview(r.needsReview.length))}` : ''}</p>`;
      h += `<div class="acts"><button class="pill pri" data-action="doImport"${r.created + r.updated === 0 ? ' disabled' : ''}>${esc(T.doImport)}</button><button class="pill" data-action="closePanel">${esc(T.cancel)}</button></div>`;
    } else {
      h += `<p>${esc(T.importIntro)}</p><div class="acts"><button class="pill pri" data-action="readMac">${esc(T.readMac)}</button></div>`;
    }
    h += '</div></div>';
    detailEl.innerHTML = h;
  }

  function renderDups() {
    const pairs = (S.dups || []).filter((p) => !S.dismissedDups.has(`${p.a.id}|${p.b.id}`));
    let h = `<div class="tools"><button class="tbtn" data-action="closePanel">${esc(T.cancel)}</button></div><article class="page"><h1 class="name" style="font-size:34px">${esc(T.dupsTitle)}</h1><div class="who"></div>`;
    if (S.dups === null) h += `<p><span class="spin"></span></p>`;
    else if (!pairs.length) h += `<p class="who">${esc(T.dupsNone)}</p>`;
    for (const p of pairs) {
      h += `<div class="dup"><div class="who2"><b>${esc(p.a.name)}</b><small>${esc(p.a.summary)}</small></div><span class="arrow">${I('back', 's')}</span>
        <div class="who2"><b>${esc(p.b.name)}</b><small>${esc(p.b.summary)}</small></div>
        <div style="display:flex;gap:6px"><button class="pill" data-not-same="${esc(p.a.id)}|${esc(p.b.id)}">${esc(T.notSame)}</button><button class="pill pri" data-merge="${esc(p.b.id)}|${esc(p.a.id)}">${esc(T.mergeLeft)}</button></div></div>`;
    }
    h += '</article>';
    detailEl.innerHTML = h;
  }

  function renderAuto() {
    const st = S.meta?.settings || { profile: 'colleagues', macAutoSync: true };
    const m = S.meta?.maintenance;
    const opt = (key, label, hint) =>
      `<button class="opt" data-profile="${key}" aria-pressed="${st.profile === key}"><b>${esc(label)}</b><small>${esc(hint)}</small></button>`;
    let h = `<div class="tools"><button class="tbtn" data-action="closePanel">${esc(T.cancel)}</button></div><article class="page">`;
    h += `<h1 class="name" style="font-size:36px">${esc(T.autoTitle)}</h1><p class="who" style="margin-bottom:30px">${esc(T.autoText)}</p>`;
    h += `<div class="sech">${esc(T.profileLabel)}</div><div class="opts">${opt('colleagues', T.profColleagues, T.profColleaguesHint)}${opt('clients', T.profClients, T.profClientsHint)}</div>`;
    if (S.meta?.platform === 'darwin') {
      h += `<label class="toggle"><span><b>${esc(T.macSync)}</b><small>${esc(T.macSyncHint)}</small></span><input type="checkbox" id="macSync"${st.macAutoSync ? ' checked' : ''}></label>`;
    }
    h += '<div class="sec">';
    if (!S.meta?.schedule) h += `<p class="who">${esc(T.noSchedule)}</p>`;
    else {
      h += `<div class="acts" style="display:flex;gap:10px;flex-wrap:wrap"><button class="pill pri" data-action="requestAutomation">${esc(S.meta.automationRequested ? T.automationAgain : T.openAutomation)}</button></div>`;
      if (S.autoOpened) h += `<p class="who" style="margin:14px 0 0">${esc(T.automationOpened)}</p>`;
      h += `<p class="who" style="margin:14px 0 0;color:var(--c-text-3)">${esc(T.stopHint)}</p>`;
    }
    h += '</div>';
    if (m && m.runs && m.runs.length) {
      h += `<div class="sec"><div class="sech">${esc(T.runsTitle)}</div>`;
      for (const r of m.runs.slice(0, 6)) h += `<div class="ev"><span class="d">${esc(whenText(r.at))}</span><span class="tx">${esc(T.runLine(r))}${r.note ? `<br><span style="color:var(--c-text-3)">${esc(r.note)}</span>` : ''}</span><span></span></div>`;
      h += '</div>';
    }
    h += '</article>';
    detailEl.innerHTML = h;
  }

  function renderStatus() {
    if (S.boot === 'error') {
      detailEl.innerHTML = `<div class="center"><div class="hello"><p>${esc(T.libError)}${esc(S.meta?.error?.message || '')}</p><div class="acts"><button class="pill pri" data-action="reload">${esc(T.retry)}</button></div></div></div>`;
      return;
    }
    const p = S.progress;
    const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
    const msg = S.meta?.importing === 'legacy' ? T.importingLegacy : T.loading;
    detailEl.innerHTML = `<div class="center"><div class="hello"><p><span class="spin"></span>${esc(msg)}</p>${p && p.total ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div></div>`;
  }

  function renderDetail() {
    $('#app').classList.toggle('showing', !!S.selId || S.mode !== 'view');
    if (S.boot !== 'ready') return renderStatus();
    if (S.mode === 'hello') return renderHello();
    if (S.mode === 'import') return renderImport();
    if (S.mode === 'dups') return renderDups();
    if (S.mode === 'auto') return renderAuto();
    if (S.mode === 'new') return renderForm(true);
    if (S.mode === 'edit' && S.detail) return renderForm(false);
    return renderView();
  }

  function render() {
    renderList();
    renderDetail();
  }

  /* ───────── 数据加载 ───────── */
  async function loadList() {
    const r = await rpc('list');
    S.contacts = r.contacts;
    S.groups = r.groups;
  }
  async function loadDetail(id) {
    if (!id) {
      S.detail = null;
      return;
    }
    try {
      S.detail = await rpc('get', { id });
    } catch (e) {
      if (e.code === 'NOT_FOUND') {
        S.detail = null;
        S.selId = null;
      } else throw e;
    }
  }

  async function select(id) {
    S.selId = id;
    S.mode = 'view';
    S.showAllEvents = false;
    S.confirmDelete = false;
    renderList();
    await loadDetail(id);
    renderDetail();
    detailEl.scrollTop = 0;
  }

  function pickDefault() {
    const rows = visible();
    if (!S.contacts.length) {
      S.mode = S.mode === 'import' || S.mode === 'new' ? S.mode : 'hello';
      S.selId = null;
      return;
    }
    if (S.mode === 'hello') S.mode = 'view';
    if (!S.selId || !S.contacts.some((c) => c.id === S.selId)) {
      const first = grouped(rows)[0]?.items[0];
      S.selId = first ? first.id : null;
    }
  }

  async function refreshAll() {
    await loadList();
    pickDefault();
    if (S.mode === 'view' || S.mode === 'edit') await loadDetail(S.selId);
    render();
  }

  let changeTimer = null;
  function onEvent(m) {
    if (m.name === 'progress') {
      S.progress = m.data && m.data.total ? m.data : null;
      if (S.boot !== 'ready') renderStatus();
      return;
    }
    if (m.name === 'legacy') {
      boot();
      return;
    }
    if (m.name === 'changed' && S.boot === 'ready') {
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        if (S.mode === 'edit' || S.mode === 'new') {
          loadList().then(renderList).catch(() => {});
          return;
        }
        rpc('state')
          .then((meta) => {
            S.meta = meta;
          })
          .catch(() => {})
          .finally(() => refreshAll().catch(() => {}));
      }, 150);
    }
  }

  /* ───────── 提示 ───────── */
  function toast(msg, undo) {
    const el = document.createElement('div');
    el.className = `toast${undo ? '' : ' plain'}`;
    el.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button>${esc(LOCALE === 'zh-CN' ? '撤销' : 'Undo')}</button>` : ''}`;
    if (undo) el.querySelector('button').onclick = () => {
      el.remove();
      undo();
    };
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 3800);
  }
  const failToast = (e) => toast(T.failed + (e && e.message ? e.message : e));

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(T.copied(text));
  }

  /* ───────── 菜单 ───────── */
  const menu = $('#menu');
  function openMenu(anchor, html, onReady) {
    menu.innerHTML = html;
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left));
    menu.style.left = `${anchor.id === 'moreBtn' ? Math.max(8, r.right - w) : left}px`;
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8)}px`;
    if (onReady) onReady();
  }
  function closeMenu() {
    menu.hidden = true;
    menu.innerHTML = '';
  }
  function scopeMenu(anchor) {
    const count = (fn) => S.contacts.filter(fn).length;
    const item = (key, label, n) => `<button class="mi" data-scope="${esc(key)}"><span>${esc(label)}</span><span class="r">${n}</span></button>`;
    let h = item('all', T.all, S.contacts.length) + item('recent', T.recent, count((c) => daysSince(c.last) <= 30));
    h += item('pending', T.pending, count((c) => c.status === 'pending')) + item('orgs', T.orgs, count((c) => c.kind === 'org'));
    if (S.groups.length) {
      h += `<div class="msep"></div><div class="mhead">${esc(T.groups)}</div>`;
      for (const g of S.groups) h += item(`g:${g.name}`, g.name, g.members);
    }
    h += `<div class="msep"></div><button class="mi" data-action="new">${esc(T.newContact)}</button>`;
    if (S.meta?.platform === 'darwin') h += `<button class="mi" data-action="import">${esc(T.importMac)}</button>`;
    h += `<button class="mi" data-action="dups">${esc(T.findDups)}</button>`;
    if (S.meta?.legacy?.status === 'partial' || S.meta?.legacy?.status === 'error') h += `<button class="mi" data-action="retryLegacy">${esc(T.retryLegacy)}</button>`;
    openMenu(anchor, h);
  }
  function moreMenu(anchor) {
    const d = S.detail;
    if (!d) return;
    const inGroups = new Set(d.groups.map((g) => g.name));
    let h = `<button class="mi" data-action="${d.status === 'pending' ? 'confirm' : 'markPending'}">${esc(d.status === 'pending' ? T.markConfirmed : T.markPending)}</button>`;
    h += `<div class="msep"></div><div class="mhead">${esc(T.addToGroup)}</div>`;
    for (const g of S.groups) {
      if (!inGroups.has(g.name)) h += `<button class="mi" data-add-group="${esc(g.name)}">${esc(g.name)}</button>`;
    }
    h += `<div style="padding:4px 6px"><input id="newGroupInput" placeholder="${esc(T.newGroup)}" style="width:100%;height:30px;border:1px solid var(--c-line);border-radius:8px;background:var(--c-bg);padding:0 10px;outline:none"></div>`;
    for (const g of inGroups) h += `<button class="mi" data-remove-group="${esc(g)}">${esc(T.removeFromGroup(g))}</button>`;
    h += `<div class="msep"></div><button class="mi danger" data-action="askDelete">${esc(T.del)}</button>`;
    openMenu(anchor, h);
  }

  /* ───────── 操作 ───────── */
  async function mutate(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
      await refreshAll();
      return r;
    } catch (e) {
      failToast(e);
      return null;
    }
  }

  function readForm() {
    const f = $('#editForm');
    const val = (n) => f.querySelector(`[name=${n}]`).value.trim();
    const list = (n) => val(n).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    const kind = f.querySelector('#kindSeg [aria-pressed="true"]')?.dataset.kind || 'person';
    const rows = [...f.querySelectorAll('.idrow')].map((r) => ({
      id: r.dataset.idid || null,
      platform: r.querySelector('select').value,
      value: r.querySelector('input').value.trim(),
    }));
    return { name: val('name'), kind, summary: val('summary'), narrative: val('narrative'), agentNotes: val('agentNotes'), aliases: list('aliases'), groups: list('groups'), rows };
  }

  async function submitForm(allowDuplicate) {
    const isNew = S.mode === 'new';
    const v = readForm();
    if (!v.name) return;
    try {
      if (isNew) {
        const r = await rpc('save', {
          name: v.name, kind: v.kind, summary: v.summary, narrative: v.narrative, agentNotes: v.agentNotes, aliases: v.aliases, groups: v.groups,
          identities: v.rows.filter((r) => r.value).map((r) => ({ platform: r.platform, value: r.value })), allowDuplicate: !!allowDuplicate,
        });
        S.formError = null;
        S.mode = 'view';
        S.selId = r.id;
        toast(T.savedOk);
        await refreshAll();
        return;
      }
      const d = S.detail;
      const keptIds = new Set(v.rows.filter((r) => r.id).map((r) => r.id));
      const changedIds = v.rows.filter((r) => r.id && d.identities.some((i) => i.id === r.id && (i.value !== r.value || i.platform !== r.platform)));
      const removeIdentityIds = d.identities.filter((i) => i.platform !== 'apple-contacts' && (!keptIds.has(i.id) || changedIds.some((c) => c.id === i.id))).map((i) => i.id);
      const identities = v.rows.filter((r) => r.value && (!r.id || changedIds.some((c) => c.id === r.id))).map((r) => ({ platform: r.platform, value: r.value }));
      const oldGroups = d.groups.map((g) => g.name);
      await rpc('save', {
        id: d.id, name: v.name, kind: v.kind, summary: v.summary, narrative: v.narrative, agentNotes: v.agentNotes,
        aliases: v.aliases, removeAliases: d.aliases.filter((a) => !v.aliases.includes(a)), identities, removeIdentityIds,
        groups: v.groups.filter((g) => !oldGroups.includes(g)),
      });
      for (const g of oldGroups.filter((g) => !v.groups.includes(g))) {
        await rpc('organize', { action: 'remove_from_group', contactIds: [d.id], group: g });
      }
      S.formError = null;
      S.mode = 'view';
      toast(T.savedOk);
      await refreshAll();
    } catch (e) {
      if (e.code === 'DUPLICATE_SUSPECT') {
        const c = e.extra?.candidates || [];
        S.formError = `${esc(T.dupSuspect)}${c.map((x) => `<span class="link" data-goto="${esc(x.id)}">${esc(x.name)}</span>`).join('、')} · <button type="button" class="link" data-action="createAnyway">${esc(T.createAnyway)}</button>`;
      } else if (e.code === 'IDENTITY_CONFLICT') {
        S.formError = `${esc(e.message)} <span class="link" data-goto="${esc(e.extra?.conflictContactId || '')}">→</span>`;
      } else {
        S.formError = esc(T.failed + e.message);
      }
      const keep = readForm();
      renderForm(isNew);
      // 保留已填写的内容
      const f = $('#editForm');
      f.querySelector('[name=name]').value = keep.name;
      f.querySelector('[name=summary]').value = keep.summary;
      f.querySelector('[name=narrative]').value = keep.narrative;
      f.querySelector('[name=agentNotes]').value = keep.agentNotes;
      f.querySelector('[name=aliases]').value = keep.aliases.join(', ');
      f.querySelector('[name=groups]').value = keep.groups.join(', ');
      $('#idRows').innerHTML = keep.rows.map((r, n) => idRow(r, n)).join('');
    }
  }

  async function readMac() {
    S.importError = null;
    S.importStep = 'reading';
    renderImport();
    try {
      S.importResult = await rpc('importSystem', { dryRun: true });
      S.importStep = 'preview';
    } catch (e) {
      S.importError = { code: e.code, message: e.message };
    }
    if (S.mode === 'import') renderImport();
  }

  async function doImport() {
    S.importStep = 'importing';
    renderImport();
    try {
      const r = await rpc('importSystem', { dryRun: false });
      toast(T.imported(r));
      S.mode = 'view';
      S.importStep = null;
      S.selId = null;
      await refreshAll();
    } catch (e) {
      S.importError = { code: e.code, message: e.message };
      renderImport();
    }
  }

  async function openDups() {
    S.mode = 'dups';
    S.dups = null;
    renderDetail();
    try {
      S.dups = (await rpc('duplicates')).pairs;
    } catch (e) {
      S.dups = [];
      failToast(e);
    }
    if (S.mode === 'dups') renderDups();
  }

  /* ───────── 事件绑定 ───────── */
  document.addEventListener('click', async (e) => {
    const t = e.target;
    const c = (sel) => t.closest(sel);
    if (!c('#menu') && !c('#scopeBtn') && !c('#moreBtn')) closeMenu();
    let x;
    if ((x = c('#scopeBtn'))) return menu.hidden ? scopeMenu(x) : closeMenu();
    if ((x = c('#moreBtn'))) return menu.hidden ? moreMenu(x) : closeMenu();
    if ((x = c('[data-scope]'))) {
      closeMenu();
      S.scope = x.dataset.scope;
      S.selId = null;
      S.mode = S.contacts.length ? 'view' : 'hello';
      pickDefault();
      renderList();
      if (S.selId) return select(S.selId);
      S.detail = null;
      return renderDetail();
    }
    if ((x = c('[data-sort]'))) {
      S.sort = x.dataset.sort;
      return renderList();
    }
    if (c('#pendLink')) {
      S.scope = 'pending';
      S.selId = null;
      pickDefault();
      renderList();
      return select(S.selId);
    }
    if (c('#clearFind')) {
      S.query = '';
      renderList();
      return $('#findInput').focus();
    }
    if ((x = c('.row[data-id]'))) return select(x.dataset.id);
    if ((x = c('[data-goto]'))) {
      const id = x.dataset.goto;
      if (!id) return;
      if (!visible().some((r) => r.id === id)) {
        S.scope = 'all';
        S.query = '';
      }
      return select(id);
    }
    if ((x = c('[data-copy]'))) return copy(x.dataset.copy);
    if ((x = c('[data-del-event]'))) return mutate(() => rpc('deleteEvent', { id: x.dataset.delEvent }));
    if ((x = c('[data-add-group]'))) {
      closeMenu();
      return mutate(() => rpc('organize', { action: 'add_to_group', contactIds: [S.selId], group: x.dataset.addGroup }), T.savedOk);
    }
    if ((x = c('[data-remove-group]'))) {
      closeMenu();
      return mutate(() => rpc('organize', { action: 'remove_from_group', contactIds: [S.selId], group: x.dataset.removeGroup }), T.savedOk);
    }
    if ((x = c('[data-merge]'))) {
      const [sourceId, targetId] = x.dataset.merge.split('|');
      try {
        await rpc('merge', { sourceId, targetId });
        toast(T.merged);
        S.dups = S.dups.filter((p) => p.a.id !== sourceId && p.b.id !== sourceId);
        await loadList();
        renderList();
        renderDups();
      } catch (err) {
        failToast(err);
      }
      return;
    }
    if ((x = c('[data-not-same]'))) {
      S.dismissedDups.add(x.dataset.notSame);
      return renderDups();
    }
    if ((x = c('[data-profile]'))) {
      try {
        S.meta.settings = await rpc('settings', { profile: x.dataset.profile });
      } catch (err) {
        failToast(err);
      }
      return renderAuto();
    }
    if ((x = c('[data-rm-row]'))) return x.closest('.idrow').remove();
    if ((x = c('[data-kind]'))) {
      for (const b of x.parentNode.children) b.setAttribute('aria-pressed', String(b === x));
      return;
    }
    if (!(x = c('[data-action]'))) return;
    const a = x.dataset.action;
    closeMenu();
    if (a === 'edit') {
      S.mode = 'edit';
      S.formError = null;
      return renderDetail();
    }
    if (a === 'new') {
      S.mode = 'new';
      S.formError = null;
      return renderDetail();
    }
    if (a === 'cancelEdit' || a === 'closePanel') {
      S.mode = S.contacts.length ? 'view' : 'hello';
      S.formError = null;
      S.importStep = null;
      S.importError = null;
      pickDefault();
      if (S.selId) await loadDetail(S.selId);
      return render();
    }
    if (a === 'createAnyway') return submitForm(true);
    if (a === 'addId') {
      const box = $('#idRows');
      box.insertAdjacentHTML('beforeend', idRow({ platform: 'email', value: '' }, box.children.length));
      return box.lastElementChild.querySelector('input').focus();
    }
    if (a === 'toggleEvents') {
      S.showAllEvents = !S.showAllEvents;
      return renderView();
    }
    if (a === 'confirm') return mutate(() => rpc('organize', { action: 'confirm', contactIds: [S.selId] }), T.confirmed);
    if (a === 'markPending') return mutate(() => rpc('organize', { action: 'mark_pending', contactIds: [S.selId] }), T.savedOk);
    if (a === 'askDelete') {
      S.confirmDelete = true;
      renderView();
      return detailEl.scrollTo({ top: 0 });
    }
    if (a === 'cancelDelete') {
      S.confirmDelete = false;
      return renderView();
    }
    if (a === 'doDelete') {
      const name = S.detail?.name;
      const id = S.selId;
      S.confirmDelete = false;
      S.selId = null;
      return mutate(() => rpc('delete', { id }), T.deleted(name));
    }
    if (a === 'import') {
      S.mode = 'import';
      S.importStep = null;
      S.importError = null;
      S.importResult = null;
      return renderDetail();
    }
    if (a === 'auto') {
      S.mode = 'auto';
      S.autoOpened = false;
      try {
        S.meta = await rpc('state');
      } catch (_) {
        /* 用已有状态 */
      }
      return render();
    }
    if (a === 'requestAutomation') {
      try {
        S.meta.automationRequested = await rpc('requestAutomation');
        S.autoOpened = true;
      } catch (err) {
        failToast(err);
      }
      return render();
    }
    if (a === 'readMac') return readMac();
    if (a === 'doImport') return doImport();
    if (a === 'dups') return openDups();
    if (a === 'retryLegacy') {
      S.boot = 'loading';
      S.meta = { ...(S.meta || {}), importing: 'legacy' };
      renderStatus();
      try {
        const r = await rpc('importLegacy');
        if (r.status === 'done') toast(T.legacyDone(r.counts?.contacts?.local || 0));
      } catch (err) {
        failToast(err);
      }
      return boot();
    }
    if (a === 'back') {
      S.selId = null;
      S.detail = null;
      return render();
    }
    if (a === 'reload') return boot();
  });

  document.addEventListener('change', async (e) => {
    if (e.target.id === 'macSync') {
      try {
        S.meta.settings = await rpc('settings', { macAutoSync: e.target.checked });
      } catch (err) {
        e.target.checked = !e.target.checked;
        failToast(err);
      }
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'findInput') {
      S.query = e.target.value;
      renderList();
    }
  });

  document.addEventListener('keydown', async (e) => {
    const t = e.target;
    if (t.id === 'newGroupInput' && e.key === 'Enter') {
      const name = t.value.trim();
      if (!name) return;
      closeMenu();
      return mutate(() => rpc('organize', { action: 'add_to_group', contactIds: [S.selId], group: name }), T.savedOk);
    }
    if (e.key === 'Escape') {
      if (!menu.hidden) return closeMenu();
      if (S.mode === 'edit' || S.mode === 'new') {
        S.mode = 'view';
        return render();
      }
      if (t.id === 'findInput' && S.query) {
        S.query = '';
        return renderList();
      }
    }
    const typing = /INPUT|TEXTAREA|SELECT/.test(t.tagName);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      return $('#findInput')?.focus();
    }
    if (typing || S.mode !== 'view') return;
    if (e.key === '/') {
      e.preventDefault();
      return $('#findInput')?.focus();
    }
    if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      const flat = grouped(visible()).flatMap((g) => g.items);
      const i = flat.findIndex((c) => c.id === S.selId);
      const next = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1)))];
      if (next && next.id !== S.selId) {
        await select(next.id);
        listpane.querySelector(`[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (e.key === 'e' && S.detail) {
      e.preventDefault();
      S.mode = 'edit';
      return renderDetail();
    }
  });

  document.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.id === 'editForm') return submitForm(false);
    if (f.id === 'addEvent') {
      const text = $('#evText').value.trim();
      if (!text) return;
      return mutate(() => rpc('logEvent', { contactId: S.selId, text, date: $('#evDate').value, source: 'manual' }), T.added);
    }
    if (f.id === 'askForm') {
      const inp = $('#askInput');
      const text = inp.value.trim();
      if (!text) return;
      inp.value = '';
      try {
        await rpc('ask', { text, contactId: S.selId || '' });
        toast(T.askSent);
      } catch (err) {
        inp.value = text;
        failToast(err);
      }
    }
  });

  /* ───────── 启动 ───────── */
  let pollTimer = null;
  async function boot() {
    clearTimeout(pollTimer);
    try {
      S.meta = await rpc('state');
    } catch (e) {
      S.boot = 'error';
      S.meta = { error: { message: e.message } };
      return render();
    }
    if (S.meta.error && !S.meta.ready) {
      S.boot = 'error';
      return render();
    }
    if (!S.meta.ready || S.meta.importing === 'legacy') {
      S.boot = 'loading';
      S.progress = S.meta.progress;
      renderList();
      renderStatus();
      pollTimer = setTimeout(boot, 1000);
      return;
    }
    S.boot = 'ready';
    await refreshAll();
  }

  (async () => {
    try {
      const ctx = await (await fetch('/app-context')).json();
      LOCALE = ctx?.context?.locale || 'en';
    } catch (_) {
      LOCALE = 'en';
    }
    T = STRINGS[LOCALE] || STRINGS.en;
    document.documentElement.lang = LOCALE;
    render();
    boot();
  })();
})();
