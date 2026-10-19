'use strict';
(async () => {
  const $ = id => document.getElementById(id);
  let strings = {}, entries = [], selected = 'global', config = {}, busy = false, loaded = false;
  let initialized = false, loadAttempted = false, accountsSnapshot = '';
  const clouds = {
    global: {key: 'outlook_global', port: 53687, portal: 'https://portal.azure.com'},
    china: {key: 'outlook_china', port: 53688, portal: 'https://portal.azure.cn'},
  };
  const t = key => strings[key] || key;
  const entry = cloud => entries.find(e => e.key === clouds[cloud].key);
  const defaultCloud = () => config.default_cloud === 'china' ? 'china' : 'global';
  async function request(path, init) {
    const r = await fetch(path, init?.body ? {...init, headers: {'Content-Type': 'application/json'}} : init);
    if (!r.ok) throw new Error(t('requestFailed') + ' (HTTP ' + r.status + ')');
    return r.status === 204 ? null : r.json();
  }
  async function locale() {
    let lang = 'en';
    try { const c = await request('/app-context'); if (['en', 'zh-CN', 'ja', 'ko'].includes(c?.context?.locale)) lang = c.context.locale; } catch (_) { /* English fallback */ }
    try { strings = await request('/ui/' + lang + '.json'); }
    catch (_) { lang = 'en'; strings = await request('/ui/en.json'); }
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    $('client-id').placeholder = t('clientPlaceholder');
  }
  function status(message) { $('status').textContent = message; }
  function errorText(r) {
    const code = typeof r?.error === 'string' ? r.error : '';
    return t(code) === code ? t('connectFailed') : t(code);
  }
  function closeMenu(restoreFocus = false) {
    $('service-menu').hidden = true;
    $('cloud').setAttribute('aria-expanded', 'false');
    if (restoreFocus) $('cloud').focus();
  }
  function openMenu() {
    if (busy || !loaded) return;
    $('service-menu').hidden = false;
    $('cloud').setAttribute('aria-expanded', 'true');
    $('service-menu').querySelector('[aria-checked="true"]').focus();
  }
  function selectCloud(cloud) {
    if (busy || !loaded || !clouds[cloud]) return;
    if (selected !== cloud) {
      selected = cloud;
      $('client-id').value = '';
      $('advanced').open = false;
      status('');
    }
    closeMenu(true);
    render();
  }
  function addButton(row, label, action, fn) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.dataset.action = action;
    b.onclick = () => void perform(fn); row.appendChild(b);
  }
  function renderAccounts() {
    // Rebuild only when metadata changes; busy/service changes must not close
    // a mailbox's controls or steal keyboard focus.
    const snapshot = JSON.stringify([loaded, entries.map(e => [e.key, e.accounts])]);
    if (snapshot !== accountsSnapshot) {
      accountsSnapshot = snapshot;
      const hadFocus = $('accounts').contains(document.activeElement);
      $('accounts').textContent = '';
      let count = 0;
      if (loaded) for (const [cloud, cfg] of Object.entries(clouds)) {
        for (const a of entry(cloud)?.accounts || []) {
          count++;
          const row = document.createElement('div');
          row.className = 'account'; row.dataset.cloud = cloud; row.dataset.accountId = a.id;
          const name = document.createElement('span');
          name.className = 'identity'; name.textContent = a.label || a.id;
          const tag = document.createElement('span'); tag.className = 'tag';
          tag.textContent = [t(cloud), a.isDefault ? t('defaultAccount') : '', a.status !== 'connected' ? t('expired') : a.scopeStale ? t('scopeStale') : t('connected')].filter(Boolean).join(' · ');
          name.appendChild(tag); row.appendChild(name);
          if (a.status !== 'connected' || a.scopeStale) addButton(row, t('reconnect'), 'reconnect', () => connect(cloud));
          const actions = document.createElement('details'); actions.className = 'account-actions';
          const summary = document.createElement('summary'); summary.textContent = '⋯';
          summary.setAttribute('aria-label', t('accountActions') + ': ' + (a.label || a.id));
          actions.appendChild(summary);
          const buttons = document.createElement('div'); buttons.className = 'actions';
          if (!a.isDefault && a.status === 'connected') addButton(buttons, t('setDefault'), 'default', async () => {
            await request('/oauth/' + cfg.key + '/default', {method: 'POST', body: JSON.stringify({accountId: a.id})}); status(t('saved'));
          });
          addButton(buttons, t('disconnect'), 'disconnect', async () => {
            await request('/oauth/' + cfg.key + '/accounts/' + encodeURIComponent(a.id), {method: 'DELETE'}); status(t('disconnected'));
          });
          actions.appendChild(buttons); row.appendChild(actions); $('accounts').appendChild(row);
        }
      }
      if (loaded && !count) {
        const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = t('noAccounts'); $('accounts').appendChild(empty);
      }
      if (hadFocus) $('accounts-title').focus();
    }
    $('accounts').querySelectorAll('button').forEach(b => { b.disabled = busy || !loaded; });
  }
  function render() {
    const c = clouds[selected], e = entry(selected), required = loaded && !e?.clientConfigured;
    $('service-name').textContent = t(selected);
    $('cloud').setAttribute('aria-label', t('region') + ': ' + t(selected));
    $('cloud').disabled = busy || !loaded;
    $('service-menu').querySelectorAll('[data-cloud]').forEach(option => {
      option.setAttribute('aria-checked', String(option.dataset.cloud === selected));
      option.querySelector('.default-badge').hidden = option.dataset.cloud !== defaultCloud();
      option.disabled = busy || !loaded;
    });
    $('default-cloud').textContent = t(selected === defaultCloud() ? 'alreadyDefault' : 'defaultCloud');
    $('default-cloud').disabled = busy || !loaded || selected === defaultCloud();
    $('redirect').value = 'http://127.0.0.1:' + c.port + '/callback';
    $('portal').href = c.portal;
    $('setup-note').textContent = !loaded ? t(loadAttempted ? 'loadFailed' : 'loading') : required ? t('appMissing') : t(e.clientCustom ? 'customReady' : 'builtInReady');
    $('setup-note').parentElement.hidden = required;
    $('connect').hidden = required;
    $('connect').disabled = busy || !loaded || !e?.clientConfigured;
    $('edit-client').hidden = !loaded || !e?.clientCustom;
    $('edit-client').disabled = busy;
    $('retry').hidden = loaded || !loadAttempted;
    $('retry').disabled = busy;
    $('required-application').hidden = !required;
    $('advanced').hidden = !loaded || required;
    const container = $(required ? 'required-application' : 'optional-application');
    if ($('application-form').parentElement !== container) container.appendChild($('application-form'));
    $('application-title').hidden = !required;
    $('application-help').textContent = t(required ? 'requiredHelp' : 'setupHelp');
    $('application-state').textContent = t(e?.clientCustom ? 'configured' : 'builtIn');
    $('cancel-client').hidden = required;
    $('reset-client').hidden = !e?.clientCustom;
    for (const id of ['save-client', 'reset-client', 'client-id', 'cancel-client', 'copy-redirect']) $(id).disabled = busy || !loaded;
    $('reset-client').disabled = busy || !loaded || !e?.clientCustom;
    renderAccounts();
  }
  async function load() {
    try {
      const values = await Promise.all([request('/oauth'), request('/kv')]);
      if (!Array.isArray(values[0])) throw new Error(t('loadFailed'));
      entries = values[0]; config = values[1] || {};
      if (!initialized) { selected = defaultCloud(); initialized = true; }
      loaded = true;
    } catch (_) { loaded = false; entries = []; status(t('loadFailed')); }
    loadAttempted = true;
    render();
  }
  async function perform(fn) {
    if (busy || !loaded) return;
    busy = true; closeMenu(); render();
    try { await fn(); } catch (e) { status(e.message || t('requestFailed')); }
    finally { await load(); busy = false; render(); }
  }
  async function connect(cloud = selected) {
    // An existing mailbox may belong to a different service than the selector.
    if (!entry(cloud)?.clientConfigured) {
      selected = cloud; $('client-id').value = ''; $('advanced').open = false;
      render(); status(t('appMissing'));
      return;
    }
    status(t('connecting'));
    const r = await request('/oauth/' + clouds[cloud].key + '/connect', {method: 'POST'});
    if (!r.ok) { status(errorText(r)); return; }
    status(t('connected') + ': ' + (r.account?.label || ''));
  }
  $('cloud').onclick = () => $('service-menu').hidden ? openMenu() : closeMenu(true);
  $('cloud').onkeydown = event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMenu(); }
  };
  $('service-menu').querySelectorAll('[data-cloud]').forEach(option => { option.onclick = () => selectCloud(option.dataset.cloud); });
  $('service-menu').onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
    if (event.key === 'Tab') { closeMenu(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...$('service-menu').querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  document.addEventListener('pointerdown', event => {
    if (!$('service-menu').contains(event.target) && !$('cloud').contains(event.target)) closeMenu();
  });
  document.addEventListener('focusin', event => {
    if (!$('service-menu').contains(event.target) && !$('cloud').contains(event.target)) closeMenu();
  });
  $('connect').onclick = () => void perform(() => connect());
  $('default-cloud').onclick = () => {
    $('cloud').focus();
    void perform(async () => {
      const current = await request('/kv');
      await request('/kv', {method: 'PUT', body: JSON.stringify({...current, default_cloud: selected})}); status(t('saved'));
    });
  };
  $('edit-client').onclick = () => {
    $('more').open = true; $('advanced').open = true; $('client-id').focus();
  };
  $('cancel-client').onclick = () => {
    $('client-id').value = ''; $('advanced').open = false; $('advanced').querySelector('summary').focus();
  };
  $('application-form').onsubmit = event => {
    event.preventDefault();
    void perform(async () => {
      const clientId = $('client-id').value.trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) throw new Error(t('invalidClient'));
      await request('/oauth/' + clouds[selected].key + '/client', {method: 'PUT', body: JSON.stringify({clientId})});
      $('client-id').value = ''; $('advanced').open = false; $('more').open = false; status(t('clientSaved'));
    }).then(() => { if (loaded && entry(selected)?.clientConfigured && !$('client-id').value) $('connect').focus(); });
  };
  $('reset-client').onclick = () => void perform(async () => {
    await request('/oauth/' + clouds[selected].key + '/client', {method: 'DELETE'});
    $('client-id').value = ''; status(t('clientCleared'));
  });
  $('copy-redirect').onclick = async () => {
    try { await navigator.clipboard.writeText($('redirect').value); status(t('copied')); }
    catch (_) { $('redirect').focus(); $('redirect').select(); status(t('copyManually')); }
  };
  $('retry').onclick = async () => {
    if (busy) return;
    busy = true; render(); status('');
    await load(); busy = false; render();
  };
  await locale(); render(); await load();
})();
