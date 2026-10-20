'use strict';
// Shared by the task page and the management view: talks to the logic page over
// the plugin's own BroadcastChannel; only the actions main.js lists exist.
(function (root) {
  const channel = new BroadcastChannel('baguette-pages');
  const pending = new Map(), listeners = new Set();
  const READS = new Set(['task_state', 'manage_state', 'catalog']);
  channel.onmessage = ({ data: m }) => {
    if (m?.type === 'response') {
      const p = pending.get(m.id); if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer); clearInterval(p.retry); p.resolve(m.result);
      return;
    }
    for (const fn of listeners) fn(m);
  };
  // The logic page starts on demand: wake it, then ask. Reads may be re-sent while
  // it comes up; device changes are sent once and never replayed.
  async function rpc(action, params = {}, timeoutText = 'No response') {
    let wake;
    try { wake = await fetch('/wake', { signal: AbortSignal.timeout(15000) }); } catch { throw Object.assign(Error(timeoutText), { code: 'TIMEOUT' }); }
    if (!wake.ok) throw Object.assign(Error(timeoutText), { code: 'TIMEOUT' });
    const state = (await wake.json().catch(() => ({}))).state;
    if (state === 'off') throw Object.assign(Error('PLUGIN_OFF'), { code: 'PLUGIN_OFF' });
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const send = () => channel.postMessage({ type: 'request', id, action, ...params });
      const read = READS.has(action);
      const retry = read ? setInterval(send, 500) : null;
      const timer = setTimeout(() => { clearInterval(retry); pending.delete(id); reject(Object.assign(Error(timeoutText), { code: 'TIMEOUT' })); }, read ? 20000 : 125000);
      pending.set(id, { resolve, timer, retry }); send();
    });
  }
  function h(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c) n.append(c);
    return n;
  }
  async function locale() {
    try { const r = await (await fetch('/app-context')).json(); return r.context?.locale === 'zh-CN' ? 'zh-CN' : 'en'; } catch { return 'en'; }
  }
  const GLYPH = {
    iphone: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2.5"/><path d="M12 18h.01"/></svg>',
    ipad: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M12 18h.01"/></svg>',
    big: '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2.5"/><path d="M12 18h.01"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M10 15V9"/><path d="M14 15V9"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>',
  };
  root.CindySimPages = { rpc, h, locale, GLYPH, onPush: (fn) => listeners.add(fn) };
})(globalThis);
