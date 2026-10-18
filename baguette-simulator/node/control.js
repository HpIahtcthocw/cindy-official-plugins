'use strict';
// Controller page: Cindy draws the chrome; the Baguette page in the iframe only
// renders the live screen. All strings and derived state live in control-model.js.
(() => {
  const M = globalThis.CindySimModel;
  const lang = document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en';
  const t = M.strings(lang);
  const params = new URLSearchParams(location.search);
  let udid = params.get('udid');
  const token = new URLSearchParams(location.hash.slice(1)).get('cindyClipboard')?.split('.')[1];
  const $ = (id) => document.getElementById(id);
  const screen = $('screen'), stage = $('stage'), frame = $('frame'), overlay = $('overlay'), dock = $('dock');

  // Page state. `status` is the last successful status response; flags are page-local.
  const state = { status: null, lost: false, generation: null, zoom: 1, fullToolbar: false,
    recovering: false, stopping: false, switching: false, phase: null, handledJob: null, lastTouch: 0, screenWidth: 0 };

  const ICON = {
    phone: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2.5"/><path d="M12 18h.01"/></svg>',
    pad: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M12 18h.01"/></svg>',
    off: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/></svg>',
    unplug: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m19 5 3-3"/><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M10 15V9"/><path d="M14 15V9"/></svg>',
    check: '<svg class="check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>',
    shake: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2.5 3.5 4m15.5-1.5L20.5 4M3 20l1.5-1.5M21 20l-1.5-1.5"/><rect width="10" height="16" x="7" y="4" rx="2"/></svg>',
    grid: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/></svg>',
    bar: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/></svg>',
    key: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
    power: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/></svg>',
    camera: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
    ok: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
    error: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
  };

  function h(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  }

  async function api(action, extra = {}) {
    const r = await fetch('/control-api', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cindy-Clipboard': token },
      body: JSON.stringify({ ...extra, action, udid, locale: lang }), signal: AbortSignal.timeout(['shutdown', 'create', 'boot'].includes(action) ? 120000 : 20000) });
    const p = await r.json();
    if (!r.ok || p.ok === false) throw Object.assign(Error(p.errorCode || 'CONTROL_FAILED'), { code: p.errorCode });
    return p;
  }

  // ---- stage / iframe ----
  function load() {
    state.generation = state.status?.generation ?? state.generation;
    screen.src = `/simulators/${encodeURIComponent(udid)}?${state.fullToolbar ? 'handheld=0&cindyFull=1' : 'handheld=1'}${location.hash}`;
  }
  function blank() { state.generation = null; screen.src = 'about:blank'; }
  function applyZoom() {
    const { width, height } = stage.getBoundingClientRect();
    frame.style.width = Math.round(width * state.zoom) + 'px';
    frame.style.height = Math.round(height * state.zoom) + 'px';
  }
  function decorate() {
    let doc; try { doc = screen.contentDocument; } catch { return; }
    if (!doc?.documentElement || doc.location?.href === 'about:blank') return;
    if (state.fullToolbar) { doc.documentElement.setAttribute('data-cindy-full', ''); stage.setAttribute('data-full', ''); } else { doc.documentElement.removeAttribute('data-cindy-full'); stage.removeAttribute('data-full'); }
    const view = doc.getElementById('simNativeView');
    const width = view ? parseFloat(doc.defaultView.getComputedStyle(view).getPropertyValue('--nv-hh-w')) : 0;
    if (width && width !== state.screenWidth) {
      state.screenWidth = width;
      doc.documentElement.style.setProperty('--cindy-screen-radius', M.screenRadius(state.status?.device, width) + 'px');
    }
  }
  function activity(event) {
    if (event && !event.isTrusted) return;
    if (!state.status || state.status.device?.state !== 'Booted' || state.switching || Date.now() - state.lastTouch < 10000) return;
    state.lastTouch = Date.now();
    api('activity').catch(() => {});
  }
  screen.addEventListener('load', () => {
    decorate();
    try {
      const doc = screen.contentDocument;
      for (const name of ['pointerdown', 'keydown', 'wheel']) doc?.addEventListener(name, activity, { passive: true, capture: true });
      doc?.defaultView?.addEventListener('resize', () => setTimeout(decorate, 50));
    } catch {}
    setTimeout(decorate, 300); setTimeout(decorate, 1500);
  });
  const native = (name, ...args) => { try { const fn = screen.contentWindow?.[name]; if (typeof fn === 'function') { fn(...args); return true; } } catch {} return false; };

  // ---- rendering ----
  function renderBar() {
    const s = state.lost ? null : state.status;
    const p = M.presence(s, state);
    $('chip-dot').dataset.tone = p.tone;
    $('chip-name').textContent = s?.device?.name || state.status?.device?.name || '…';
    $('status').textContent = t[p.key];
    const live = !!s?.ready && s.device?.state === 'Booted' && !state.switching && !state.recovering && !state.stopping;
    for (const id of ['btn-home', 'btn-rotate', 'btn-shot']) $(id).disabled = !live;
    $('btn-home').title = $('btn-home').ariaLabel = t.home; $('btn-rotate').title = $('btn-rotate').ariaLabel = t.rotate;
    $('btn-shot').title = $('btn-shot').ariaLabel = t.screenshot; $('btn-more').title = $('btn-more').ariaLabel = t.more;
    $('device-chip').title = t.devices;
  }
  function renderOverlay() {
    const s = state.lost ? null : state.status;
    const o = M.overlay(s, state);
    overlay.replaceChildren();
    overlay.hidden = !o;
    if (o) stage.setAttribute('data-dim', ''); else stage.removeAttribute('data-dim');
    if (!o) return;
    const name = state.status?.device?.name || '';
    const card = (glyph, title, body, actions) => h('div', { class: 'card' }, [
      h('div', { class: 'glyph', html: glyph }), h('h2', { text: title }), body && h('p', { text: body }),
      actions && h('div', { class: 'actions' }, actions)]);
    const busy = (label) => h('div', { class: 'card plain' }, [h('div', { class: 'spinner' }), h('p', { text: label })]);
    if (o.kind === 'offline') overlay.append(card(ICON.unplug, t.offlineTitle, t.offlineBody, [h('button', { class: 'btn primary', text: t.recover, onclick: recover })]));
    else if (o.kind === 'off') overlay.append(card(ICON.off, t.offTitle(name), t.offBody, [h('button', { class: 'btn cta', text: t.boot, onclick: boot })]));
    else if (o.kind === 'paused') overlay.append(card(ICON.pause, t.pausedTitle, t.pausedBody));
    else if (o.kind === 'switching') {
      const target = state.status?.devices?.find((d) => d.udid === state.switchTarget)?.name || '';
      const phase = t.switching[o.phase] || t.switching.preparing;
      overlay.append(busy(typeof phase === 'function' ? phase(o.phase === 'stopping' ? name : target) : phase));
    } else overlay.append(busy(t[o.kind] || t.connecting));
  }
  let toastTimer = null;
  function toast(text, tone = 'info') {
    dock.querySelector?.('.toast')?.remove?.();
    const node = h('div', { class: 'toast', 'data-tone': tone, role: 'status' }, [h('span', { class: 'ico', html: ICON[tone] || ICON.info }), h('span', { text })]);
    dock.append(node); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.remove(), 4000);
  }
  function renderIdle() {
    const left = M.idleLeft(state.lost ? null : state.status, Date.now());
    const existing = dock.querySelector?.('.idle');
    if (left === null) { existing?.remove?.(); return; }
    if (existing) { existing.querySelector('strong').textContent = t.idleTitle(M.clock(left)); return; }
    dock.append(h('div', { class: 'idle', role: 'status' }, [
      h('div', { class: 'text' }, [h('strong', { text: t.idleTitle(M.clock(left)) }), h('small', { text: t.idleBody })]),
      h('button', { class: 'btn primary', text: t.keepUsing, onclick: () => { state.lastTouch = 0; activity(); state.status.idleDeadline = Date.now() + 15 * 60000; renderIdle(); } })]));
  }
  function render() { renderBar(); renderOverlay(); renderIdle(); }

  // ---- status loop ----
  let checking = false;
  async function check() {
    if (checking) return; checking = true;
    try {
      const s = await api('status');
      state.status = s; state.lost = false;
      trackSwitch(s);
      if (!state.switching && s.device?.state === 'Booted' && s.ready) {
        let unavailable = false; try { unavailable = !!screen.contentDocument?.querySelector('[data-viewer-unavailable]'); } catch {}
        if (state.generation === null || screen.src === 'about:blank' || unavailable) load();
        else decorate();
      }
      if (s.device?.state === 'Shutdown' && screen.src !== 'about:blank') blank();
    } catch { state.lost = true; }
    finally { checking = false; render(); }
  }
  function trackSwitch(s) {
    const job = s.deviceJob, relevant = job && (job.sourceUdid === udid || job.targetUdid === udid);
    if (relevant && job.state === 'running') { state.switching = true; state.phase = job.phase; state.switchTarget = job.targetUdid; if (screen.src !== 'about:blank') blank(); return; }
    if (relevant && job.id !== state.handledJob && job.state !== 'running') {
      state.handledJob = job.id; state.switching = false; state.phase = null;
      if (job.activeUdid && job.activeUdid !== udid) adopt(job.activeUdid);
      if (job.state === 'done') toast(t.switching.done, 'ok'); else toast(`${t.switching.failed} (${job.errorCode || 'SWITCH_FAILED'})`, 'error');
      return;
    }
    if (!relevant) state.switching = false;
  }
  function adopt(id) {
    udid = id; state.generation = null; state.screenWidth = 0;
    const url = new URL(location.href); url.searchParams.set('udid', id); history.replaceState(null, '', url);
    blank();
  }

  // ---- actions ----
  async function recover() {
    if (state.recovering) return;
    state.recovering = true; blank(); render();
    try { const s = await api('restart'); state.generation = s.generation; state.lost = false; load(); }
    catch { state.lost = true; }
    finally { state.recovering = false; render(); }
  }
  async function boot() {
    if (state.stopping || state.switching) return;
    state.status = { ...state.status, device: { ...state.status?.device, state: 'Booting' } }; render();
    try { await api('boot'); state.generation = null; } catch (error) { toast(error.code === 'RUNTIME_DISABLED' ? t.pausedTitle : t.actionFailed, 'error'); }
    await check();
  }
  function confirmShutdown() {
    const name = state.status?.device?.name || '';
    $('confirm-title').textContent = t.confirmShutdownTitle(name); $('confirm-body').textContent = t.confirmShutdownBody;
    $('confirm-cancel').textContent = t.cancel; $('confirm-ok').textContent = t.confirmShutdown;
    $('confirm-dialog').showModal();
  }
  $('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close());
  $('confirm-ok').addEventListener('click', async () => {
    $('confirm-dialog').close();
    if (state.stopping || state.switching) return;
    state.stopping = true; blank(); render();
    try {
      const result = await api('shutdown');
      if (!result.devices?.some((d) => d.udid === udid && d.state === 'Shutdown')) throw Error('UNCONFIRMED');
      toast(t.stopped, 'ok');
    } catch { toast(t.actionFailed, 'error'); }
    finally { state.stopping = false; await check(); }
  });
  async function release() {
    try { screen.contentWindow?.postMessage({ type: 'cindy-release-input' }, location.origin); } catch {}
    try { await api('release'); toast(t.released, 'ok'); } catch { toast(t.actionFailed, 'error'); }
  }
  async function screenshot() {
    $('btn-shot').disabled = true;
    try { const r = await api('screenshot'); toast(`${t.shotSaved} · ${(r.path || '').split('/').pop()}`, 'ok'); }
    catch { toast(t.shotFailed, 'error'); }
    finally { renderBar(); }
  }
  $('btn-home').addEventListener('click', () => { if (native('__nativeHome')) activity({ isTrusted: true }); });
  $('btn-rotate').addEventListener('click', () => { if (native('__nativeRotate')) activity({ isTrusted: true }); });
  $('btn-shot').addEventListener('click', screenshot);

  // ---- menus ----
  let openMenu = null;
  function closeMenu() { openMenu?.menu.remove(); openMenu?.scrim.remove(); openMenu?.anchor.setAttribute('aria-expanded', 'false'); openMenu = null; }
  function showMenu(anchor, items) {
    closeMenu();
    const menu = h('div', { class: 'menu', role: 'menu' }, items);
    const scrim = h('div', { class: 'scrim', onclick: closeMenu });
    const r = anchor.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    if (r.left + 240 > vw) menu.style.right = Math.max(8, Math.round(vw - r.right)) + 'px'; else menu.style.left = Math.round(r.left) + 'px';
    document.body.append(scrim, menu); anchor.setAttribute('aria-expanded', 'true'); openMenu = { menu, scrim, anchor };
    menu.querySelector?.('button:not(:disabled)')?.focus?.();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  const item = (icon, label, onclick, extra = {}) => h('button', { class: 'item', role: 'menuitem', onclick: () => { closeMenu(); onclick(); }, ...extra }, [
    h('span', { html: icon }), h('span', { class: 'label', text: label })]);

  $('btn-more').addEventListener('click', () => {
    const live = !$('btn-home').disabled;
    const zoomGroup = h('div', { class: 'group', role: 'radiogroup', 'aria-label': t.zoom },
      [[1, t.zoomFit], [1.25, '125%'], [1.5, '150%'], [2, '200%']].map(([z, label]) => h('button', { class: 'seg', role: 'radio', 'aria-checked': String(state.zoom === z), text: label,
        onclick: () => { state.zoom = z; applyZoom(); closeMenu(); } })));
    showMenu($('btn-more'), [
      item(ICON.shake, t.shake, () => native('__nativeShake'), { disabled: !live }),
      item(ICON.grid, t.appSwitcher, () => native('__nativeAppSwitcher'), { disabled: !live }),
      h('div', { class: 'sep' }), h('div', { class: 'head', text: t.zoom }), zoomGroup,
      h('div', { class: 'sep' }),
      item(ICON.bar, t.fullToolbar, () => { state.fullToolbar = !state.fullToolbar; load(); }, { role: 'menuitemcheckbox', 'aria-checked': String(state.fullToolbar) }),
      item(ICON.key, t.releaseKeys, release, { disabled: !live }),
      item(ICON.refresh, t.recover, recover, { disabled: state.recovering || state.switching }),
      h('div', { class: 'sep' }),
      item(ICON.power, t.shutdown, confirmShutdown, { 'data-danger': true, disabled: !state.status || state.status.device?.state !== 'Booted' || state.switching }),
    ]);
  });

  $('device-chip').addEventListener('click', () => {
    const rows = M.deviceRows(state.status?.devices, udid, lang);
    const paused = state.status?.settings?.enabled === false;
    showMenu($('device-chip'), [
      h('div', { class: 'head', text: t.devices }),
      ...rows.map((d) => h('button', { class: 'item', role: 'menuitemradio', 'aria-checked': String(d.current), disabled: paused || state.switching || !d.available || (d.current && d.tone === 'on'),
        title: d.current ? t.current : t.switchTo, onclick: () => { closeMenu(); switchTo(d.udid); } }, [
        h('span', { class: 'dot', 'data-tone': d.tone }),
        h('span', { class: 'label' }, [h('span', { text: d.name }), h('span', { class: 'sub', text: d.meta })]),
        d.current ? h('span', { html: ICON.check }) : null])),
      h('div', { class: 'sep' }),
      item(ICON.plus, t.addDevice, () => openDialog('add'), { disabled: paused }),
      item(ICON.pencil, t.rename, () => openDialog('rename'), { disabled: paused }),
    ]);
  });
  async function switchTo(targetUdid) {
    if (state.switching) return;
    state.switching = true; state.phase = 'preparing'; state.switchTarget = targetUdid; state.handledJob = null; blank(); render();
    try { await api('switch', { targetUdid }); }
    catch (error) { state.switching = false; toast(`${t.switching.failed} (${error.code || 'SWITCH_FAILED'})`, 'error'); }
    await check();
  }

  // ---- add / rename dialog ----
  let catalog = null, mode = 'add';
  function fillRuntimes() {
    const runtime = $('f-runtime'), options = M.runtimesFor(catalog, $('f-model').value), previous = runtime.value;
    runtime.replaceChildren(...options.map((r) => h('option', { value: r.identifier, text: r.name })));
    runtime.value = options.some((r) => r.identifier === previous) ? previous : (options.at(-1)?.identifier || '');
    $('dialog-error').textContent = options.length ? '' : t.noRuntime;
    $('dialog-save').disabled = !options.length;
  }
  async function openDialog(kind) {
    mode = kind;
    const current = state.status?.devices?.find((d) => d.udid === udid);
    $('dialog-title').textContent = kind === 'add' ? t.dialogAdd : t.dialogRename;
    $('dialog-hint').textContent = kind === 'add' ? t.addHint : t.renameHint;
    $('f-name-text').textContent = t.name; $('f-model-text').textContent = t.model; $('f-runtime-text').textContent = t.runtime;
    $('dialog-cancel').textContent = t.cancel; $('dialog-save').textContent = kind === 'add' ? t.create : t.save;
    $('f-model-label').hidden = $('f-runtime-label').hidden = kind !== 'add';
    $('dialog-error').textContent = '';
    $('f-name').value = kind === 'rename' ? current?.name || '' : ''; delete $('f-name').dataset.edited;
    $('dialog-save').disabled = kind === 'add';
    $('device-dialog').showModal();
    if (kind === 'rename') { $('f-name').focus(); return; }
    $('dialog-error').textContent = t.loading;
    try {
      catalog = catalog || await api('catalog');
      const model = $('f-model');
      model.replaceChildren(...catalog.deviceTypes.map((d) => h('option', { value: d.identifier, text: d.name })));
      const choice = M.defaultChoice(catalog);
      if (choice) { model.value = choice.deviceType; fillRuntimes(); $('f-runtime').value = choice.runtime; $('f-name').value = choice.name; }
      else fillRuntimes();
      $('dialog-error').textContent = $('dialog-save').disabled ? t.noRuntime : '';
      $('f-name').focus();
    } catch (error) { $('dialog-error').textContent = `${t.actionFailed} (${error.code || 'CATALOG_FAILED'})`; }
  }
  $('f-model').addEventListener('change', () => { fillRuntimes(); if (!$('f-name').dataset.edited) $('f-name').value = catalog?.deviceTypes.find((d) => d.identifier === $('f-model').value)?.name || ''; });
  $('f-name').addEventListener('input', () => { $('f-name').dataset.edited = 'true'; });
  $('dialog-cancel').addEventListener('click', () => $('device-dialog').close());
  $('device-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('f-name').value.trim(); if (!name) return;
    $('dialog-save').disabled = true; $('dialog-error').textContent = '';
    try {
      if (mode === 'add') await api('create', { name, deviceType: $('f-model').value, runtime: $('f-runtime').value });
      else await api('rename', { name, targetUdid: udid });
      $('device-dialog').close(); toast(mode === 'add' ? t.created : t.saved, 'ok'); await check();
    } catch (error) { $('dialog-error').textContent = `${t.actionFailed} (${error.code || 'FAILED'})`; }
    finally { $('dialog-save').disabled = false; }
  });

  // ---- boot ----
  if (typeof ResizeObserver === 'function') new ResizeObserver(applyZoom).observe(stage);
  applyZoom();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  render(); check();
  setInterval(check, 3000);
  setInterval(renderIdle, 1000);
  globalThis.cindySim = { state, check, api, recover, boot, native, applyZoom, decorate };
})();
