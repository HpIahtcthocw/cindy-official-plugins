'use strict';
// Task page: this task's own simulator. With a running device it shows the live
// controller full-bleed; otherwise it says what this task has and offers the one
// next step (use a device, create one, start it).
const TEXT = {
  en: {
    loading: 'Loading…', connecting: 'Connecting to the screen…',
    noneTitle: 'This task has no simulator yet', noneBody: 'Pick a device for this task or create a new one. Cindy also picks one when it opens the simulator.',
    use: 'Use', create: 'Create an iPhone', creating: 'Creating…', inOther: (n) => n === 1 ? 'used by another task' : `used by ${n} other tasks`,
    offTitle: (name) => `${name} is off`, offBody: 'Start it to see the screen here. Apps and data are kept.', start: 'Start', starting: 'Starting…', change: 'Use another device',
    pausedTitle: 'Simulators are turned off', pausedBody: 'Turn them on in Plugins → iOS Simulator to use them here.',
    pluginOff: 'The iOS Simulator plugin is turned off.', needXcode: 'Needs full Xcode with an iOS runtime installed.',
    failed: 'Not completed. Check the device and try again.', busy: 'Another simulator operation is running. Trying again shortly…', timeout: 'No response from the simulator service. Reopen this tab.',
    devices: 'Devices', back: 'Back',
  },
  'zh-CN': {
    loading: '正在读取…', connecting: '正在连接画面…',
    noneTitle: '这个任务还没有模拟器', noneBody: '选一台设备给这个任务用，或新建一台。Cindy 打开模拟器时也会自己选。',
    use: '用这台', create: '新建一台 iPhone', creating: '正在创建…', inOther: (n) => `另有 ${n} 个任务在用`,
    offTitle: (name) => `${name} 已关闭`, offBody: '启动后画面会显示在这里，App 和数据都保留。', start: '启动', starting: '正在启动…', change: '换一台设备',
    pausedTitle: '模拟器运行已关闭', pausedBody: '在「插件 → iOS 模拟器」里打开开关后即可在这里使用。',
    pluginOff: '「iOS 模拟器」插件已停用。', needXcode: '需要先安装完整的 Xcode 和一个 iOS 运行时。',
    failed: '操作没有完成，请核对设备后重试。', busy: '有其他模拟器操作正在进行，稍后自动重试…', timeout: '模拟器服务没有响应，请重新打开这个页签。',
    devices: '设备', back: '返回',
  },
};
const { rpc, h, locale, GLYPH, onPush } = globalThis.CindySimPages;
const M = globalThis.CindySimModel;
const session = new URLSearchParams(location.search).get('session') || '';
const $ = (id) => document.getElementById(id);
let T = TEXT.en, lang = 'en', state = null, busy = null, choosing = false, note = null, viewerUrl = null;

function show(url) {
  if (url && url !== viewerUrl) { viewerUrl = url; $('screen').src = url; }
  if (!url && viewerUrl) { viewerUrl = null; $('screen').src = 'about:blank'; }
  $('screen').hidden = !viewerUrl; $('home').hidden = !!viewerUrl;
}
function errorText(r) {
  return ({ BUSY: T.busy, RUNTIME_DISABLED: T.pausedTitle, TIMEOUT: T.timeout, PLUGIN_OFF: T.pluginOff })[r?.errorCode || r?.code] || T.failed;
}
function hero(glyph, title, body, actions = []) {
  return h('div', { class: 'hero' }, [h('div', { class: 'glyph', html: glyph }), h('h2', { text: title }), body ? h('p', { text: body }) : null,
    actions.length ? h('div', { class: 'actions' }, actions) : null]);
}
function deviceList(exclude) {
  const devices = (state?.devices || []).filter((d) => d.udid !== exclude);
  const rows = M.deviceRows(devices, null, lang);
  if (!rows.length) return null;
  return h('div', { class: 'card' }, rows.map((row) => {
    const d = devices.find((x) => x.udid === row.udid);
    const others = (d.tasks || 0) - (d.thisTask ? 1 : 0);
    return h('div', { class: 'device' }, [
      h('span', { class: 'glyph', html: GLYPH[row.family] }),
      h('div', { class: 'text' }, [h('div', { class: 'name', text: row.name }),
        h('div', { class: 'meta' }, [h('span', { class: 'dot', 'data-tone': busy === row.udid ? 'busy' : row.tone }), h('span', { text: row.meta + (others > 0 ? ' · ' + T.inOther(others) : '') })])]),
      busy === row.udid ? h('span', { class: 'spinner' }) : h('button', { class: 'btn sm', text: T.use, disabled: !!busy || !row.available, onclick: () => act('task_bind', { udid: row.udid }, row.udid) }),
    ]);
  }));
}
function render() {
  const inner = $('inner'); inner.replaceChildren();
  if (!state) { inner.append(hero(GLYPH.big, note?.text || T.loading, '')); return; }
  if (state.settings?.enabled === false) inner.append(hero(GLYPH.pause, T.pausedTitle, T.pausedBody));
  else if (state.device && !choosing) {
    const d = state.device;
    if (d.state === 'Booted') inner.append(hero(GLYPH.big, d.name, state.busy ? T.busy : T.connecting, [h('span', { class: 'spinner' })]));
    else inner.append(hero(GLYPH.big, T.offTitle(d.name), T.offBody, [
      h('button', { class: 'btn cta', text: busy === d.udid ? T.starting : T.start, disabled: !!busy, onclick: () => act('task_boot', { udid: d.udid }, d.udid) }),
      (state.devices || []).length > 1 ? h('button', { class: 'link', text: T.change, disabled: !!busy, onclick: () => { choosing = true; render(); } }) : null,
    ]));
  } else {
    const actions = [h('button', { class: (state.devices || []).length ? 'btn quiet' : 'btn cta', text: busy === 'create' ? T.creating : T.create, disabled: !!busy, onclick: createDevice })];
    if (choosing) actions.push(h('button', { class: 'link', text: T.back, onclick: () => { choosing = false; render(); } }));
    inner.append(hero(GLYPH.big, T.noneTitle, T.noneBody, actions));
    const list = deviceList(choosing ? state.device?.udid : null);
    if (list) { inner.append(h('div', { class: 'list-label', text: T.devices })); inner.append(list); }
  }
  inner.append(h('p', { class: 'status' + (note?.error ? ' error' : ''), text: note?.text || '' }));
}
async function refresh() {
  try {
    const r = await rpc('task_state', { sessionId: session }, T.timeout);
    if (!r.ok) throw r;
    state = r; if (note && !note.sticky) note = null;
    if (r.viewer?.url) { choosing = false; show(r.viewer.url); } else show(null);
  } catch (error) { if (!viewerUrl) note = { text: errorText(error), error: true }; }
  render();
}
async function act(action, params, marker) {
  if (busy) return;
  busy = marker; note = null; render();
  try {
    const r = await rpc(action, { sessionId: session, ...params }, T.timeout);
    if (!r.ok) throw r;
    state = r; choosing = false;
    if (r.viewer?.url) show(r.viewer.url);
  } catch (error) { note = { text: errorText(error), error: true, sticky: true }; }
  finally { busy = null; render(); if (!viewerUrl) refresh(); }
}
async function createDevice() {
  if (busy) return;
  busy = 'create'; note = null; render();
  try {
    const catalog = await rpc('catalog', {}, T.timeout);
    const choice = catalog.ok ? M.defaultChoice(catalog) : null;
    if (!choice) throw { errorCode: 'NO_RUNTIME', text: T.needXcode };
    const r = await rpc('task_create', { sessionId: session, name: choice.name, deviceType: choice.deviceType, runtime: choice.runtime }, T.timeout);
    if (!r.ok) throw r;
    state = r; choosing = false;
  } catch (error) { note = { text: error?.text || errorText(error), error: true, sticky: true }; }
  finally { busy = null; render(); }
}
// The logic page pushes a fresh viewer when Cindy opens the simulator for this task.
onPush((m) => { if (m?.type === 'viewer' && m.sessionId === session && typeof m.url === 'string') { choosing = false; show(m.url); } });
(async () => {
  lang = await locale(); T = TEXT[lang] || TEXT.en; document.documentElement.lang = lang;
  $('screen').title = lang === 'zh-CN' ? 'iOS 模拟器' : 'iOS Simulator';
  render(); await refresh();
  // Poll only while no screen is shown: picks up a device Cindy starts or assigns.
  setInterval(() => { if (!document.hidden && !viewerUrl && !busy) refresh(); }, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !viewerUrl) refresh(); });
})();
