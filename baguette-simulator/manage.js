'use strict';
// Management view: every private simulator on this Mac, which tasks use it, and
// the device actions. Not tied to a task; "Open in this task" opens a device in
// the task currently in front.
const TEXT = {
  en: {
    title: 'Simulators', sub: 'All iOS simulators of this plugin on this Mac',
    create: 'New iPhone', creating: 'Creating…', start: 'Start', stop: 'Shut down', open: 'Open in current task', rename: 'Rename', save: 'Save', cancel: 'Cancel',
    tasks: (n) => n === 1 ? 'used by 1 task' : `used by ${n} tasks`, free: 'not in use',
    emptyTitle: 'No simulators yet', emptyBody: 'Create one and Cindy can run iOS apps for your tasks.', createFirst: 'Create your first iPhone',
    paused: 'Simulators are turned off. Turn them on in Plugins → iOS Simulator; shutting down still works here.',
    foot: (m) => (m ? `Devices shut down after ${m} minutes idle, ` : 'Devices are only shut down manually, ') + 'but never while a screen is open or a tool or script is using them. Change this in Plugins → iOS Simulator. Each task can use its own device, chosen by Cindy or by you on the task page.',
    running: (n) => `${n} running`, none: 'All off',
    opened: 'Opened in the current task.', needTask: 'Open a task first, then try again.', needXcode: 'Needs full Xcode with an iOS runtime installed.',
    failed: 'Not completed. Refresh to see the actual state.', busy: 'Another simulator operation is running. Try again in a moment.', timeout: 'No response from the simulator service. Reopen this page.', pluginOff: 'The iOS Simulator plugin is turned off.',
    readFailed: 'Could not read the devices.',
  },
  'zh-CN': {
    title: '模拟器', sub: '这台电脑上本插件的所有 iOS 模拟器',
    create: '新建 iPhone', creating: '正在创建…', start: '启动', stop: '关闭', open: '在当前任务中打开', rename: '改名', save: '保存', cancel: '取消',
    tasks: (n) => `${n} 个任务在用`, free: '没有任务在用',
    emptyTitle: '还没有模拟器', emptyBody: '创建一台，Cindy 就能在你的任务里运行 iOS App。', createFirst: '创建第一台 iPhone',
    paused: '模拟器运行已关闭。在「插件 → iOS 模拟器」里打开；这里仍可关闭设备。',
    foot: (m) => (m ? `设备闲置 ${m} 分钟后自动关闭，` : '设备只在手动操作时关闭，') + '但画面开着、或有工具和脚本在操作时不会关闭。在「插件 → iOS 模拟器」里修改。每个任务可以用自己的设备，由 Cindy 或你在任务页里选择。',
    running: (n) => `${n} 台运行中`, none: '全部已关闭',
    opened: '已在当前任务中打开。', needTask: '先打开一个任务，再试一次。', needXcode: '需要先安装完整的 Xcode 和一个 iOS 运行时。',
    failed: '操作没有完成，请刷新查看实际状态。', busy: '有其他模拟器操作正在进行，稍后再试。', timeout: '模拟器服务没有响应，请重新打开本页。', pluginOff: '「iOS 模拟器」插件已停用。',
    readFailed: '没能读取设备。',
  },
};
const { rpc, h, locale, GLYPH } = globalThis.CindySimPages;
const M = globalThis.CindySimModel;
const $ = (id) => document.getElementById(id);
let T = TEXT.en, lang = 'en', state = null, busy = null, renaming = null;

function message(text, error = false) { $('message').textContent = text || ''; $('message').classList.toggle('error', !!error); }
function errorText(r) {
  return ({ BUSY: T.busy, TIMEOUT: T.timeout, PLUGIN_OFF: T.pluginOff, PREVIEW_NEEDS_SESSION: T.needTask, RUNTIME_DISABLED: T.paused })[r?.errorCode || r?.code] || T.failed;
}
function row(d, r) {
  const working = busy === d.udid;
  const enabled = state.settings?.enabled === true;
  const nameNode = renaming === d.udid
    ? h('form', { class: 'name', onsubmit: (e) => { e.preventDefault(); const v = e.target.elements.n.value.trim(); if (v && v !== d.name) act('rename', { udid: d.udid, name: v }, d.udid); else { renaming = null; render(); } } }, [
        h('input', { name: 'n', value: d.name, maxlength: '64', 'aria-label': T.rename }),
        h('button', { class: 'btn sm', type: 'submit', text: T.save }), h('button', { class: 'link', type: 'button', text: T.cancel, onclick: () => { renaming = null; render(); } })])
    : h('div', { class: 'name' }, [h('span', { text: d.name }), h('button', { class: 'icon-btn', title: T.rename, 'aria-label': T.rename, html: GLYPH.pencil, disabled: !!busy, onclick: () => { renaming = d.udid; render(); } })]);
  const actions = working ? [h('span', { class: 'spinner' })] : [
    d.state === 'Booted'
      ? h('button', { class: 'btn sm quiet', text: T.stop, disabled: !!busy, onclick: () => act('shutdown', { udid: d.udid }, d.udid) })
      : h('button', { class: 'btn sm quiet', text: T.start, disabled: !!busy || !enabled || !r.available, onclick: () => act('boot', { udid: d.udid }, d.udid) }),
    h('button', { class: 'btn sm', text: T.open, disabled: !!busy || !enabled || !r.available, onclick: () => act('open_in_task', { udid: d.udid }, d.udid, T.opened) }),
  ];
  return h('div', { class: 'device' }, [
    h('span', { class: 'glyph', html: GLYPH[r.family] }),
    h('div', { class: 'text' }, [nameNode, h('div', { class: 'meta' }, [h('span', { class: 'dot', 'data-tone': working ? 'busy' : r.tone }), h('span', { text: `${r.meta} · ${d.tasks ? T.tasks(d.tasks) : T.free}` })])]),
    h('div', { class: 'actions' }, actions),
  ]);
}
function render() {
  $('title').textContent = T.title;
  const devices = state?.devices || [];
  const on = devices.filter((d) => d.state === 'Booted').length;
  $('sub').textContent = state ? `${T.sub} · ${on ? T.running(on) : T.none}` : T.sub;
  $('create').textContent = busy === 'create' ? T.creating : T.create;
  $('create').disabled = !!busy || !state || state.settings?.enabled === false;
  $('create').hidden = !devices.length;
  $('notice').hidden = !(state && state.settings?.enabled === false); $('notice').textContent = T.paused;
  $('foot').textContent = state ? T.foot(state.settings?.idleMinutes || 0) : '';
  const list = $('list'); list.replaceChildren();
  if (!state) return;
  if (!devices.length) {
    list.append(h('div', { class: 'card' }, [h('div', { class: 'empty' }, [h('div', { class: 'glyph', html: GLYPH.big }), h('h4', { text: T.emptyTitle }), h('p', { text: T.emptyBody }),
      h('button', { class: 'btn cta', text: busy === 'create' ? T.creating : T.createFirst, disabled: !!busy || state.settings?.enabled === false, onclick: createDevice })])]));
    return;
  }
  const rows = M.deviceRows(devices, null, lang);
  list.append(h('div', { class: 'card' }, rows.map((r) => row(devices.find((d) => d.udid === r.udid), r))));
}
async function refresh() {
  try { const r = await rpc('manage_state', {}, T.timeout); if (!r.ok) throw r; state = r; }
  catch (error) { if (!state) message(error?.code ? errorText(error) : T.readFailed, true); }
  render();
}
async function act(action, params, marker, done) {
  if (busy) return;
  busy = marker; message(''); render();
  try { const r = await rpc(action, params, T.timeout); if (!r.ok) throw r; renaming = null; if (done) message(done); }
  catch (error) { message(errorText(error), true); }
  finally { busy = null; await refresh(); }
}
async function createDevice() {
  if (busy) return;
  busy = 'create'; message(''); render();
  try {
    const catalog = await rpc('catalog', {}, T.timeout);
    const choice = catalog.ok ? M.defaultChoice(catalog) : null;
    if (!choice) throw { text: T.needXcode };
    const r = await rpc('create', { name: choice.name, deviceType: choice.deviceType, runtime: choice.runtime }, T.timeout);
    if (!r.ok) throw r;
  } catch (error) { message(error?.text || errorText(error), true); }
  finally { busy = null; await refresh(); }
}
(async () => {
  lang = await locale(); T = TEXT[lang] || TEXT.en; document.documentElement.lang = lang;
  $('create').addEventListener('click', createDevice);
  render(); await refresh();
  setInterval(() => { if (!document.hidden && !busy && !renaming) refresh(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
