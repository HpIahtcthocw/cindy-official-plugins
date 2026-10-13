'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

// One owner for tools, settings and viewer actions. Polling never renews use.
function createRuntime({dispatch, settingsFile, now = Date.now}) {
  let config, busy = false, lastActivity = now(), lastStop = null, closing = false;
  let idleHandled = false;
  const assertEnabled=async()=>{if(!(await load()).enabled||closing)throw failure('RUNTIME_DISABLED','Baguette is paused. Open plugin settings.');};
  const manager=require('./device-manager.cjs').createDeviceManager({dispatch,exclusive,assertEnabled,touch,contextFile:settingsFile+'.apps.json'});
  const failure = (code, message, execution = 'not_executed') => Object.assign(new Error(message), {code, execution});
  async function load() {
    if (config) return config;
    try {
      const value = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
      if (typeof value.enabled !== 'boolean' || ![0,15,30,60].includes(value.idleMinutes)) throw Error('Invalid settings');
      config = {enabled: value.enabled, idleMinutes: value.idleMinutes};
    } catch (error) {
      if (error.code !== 'ENOENT') throw failure('SETTINGS_UNREADABLE', 'Cannot read Baguette settings. Restore the settings file before starting a device.');
      config = {enabled: true, idleMinutes: 15};
    }
    return config;
  }
  async function save(value) {
    await fs.mkdir(path.dirname(settingsFile), {recursive: true, mode: 0o700});
    const temporary = settingsFile + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(value), {mode: 0o600});
      await fs.rename(temporary, settingsFile);
      config = value;
    } finally { await fs.rm(temporary, {force:true}).catch(() => {}); }
  }
  function touch() { lastActivity = now(); idleHandled = false; }
  async function status() {
    let settings, settingsError;
    try { settings = await load(); }
    catch (error) {
      if (error.code !== 'SETTINGS_UNREADABLE') throw error;
      // Read/stop controls survive damaged settings; this is not a saved default.
      settings = {enabled:false, idleMinutes:null};
      settingsError = {code:error.code, message:error.message};
    }
    return {...await dispatch('devices'), settings: {...settings}, settingsError, lastStop,
      deviceJob:manager.snapshot(),idleDeadline: settings.idleMinutes ? lastActivity + settings.idleMinutes * 60000 : null};
  }
  async function stopAll(reason) {
    const before = (await dispatch('devices')).devices;
    const outcomes = [];
    // Enumerate exact private-set UDIDs; never use simctl shutdown all.
    for (const device of before.filter(d => d.state !== 'Shutdown')) {
      try { await dispatch('shutdown', {udid:device.udid}); }
      catch (error) { outcomes.push({udid:device.udid, errorCode:error.code || 'STOP_FAILED', execution:error.execution || 'unknown'}); }
    }
    await dispatch('close_viewer');
    const result = await status(), after = result.devices;
    const remaining = after.filter(d => d.state !== 'Shutdown').map(d => d.udid);
    lastStop = {reason, at:now(), remaining};
    if (remaining.length) return {...result, ok:false, errorCode:'STOP_INCOMPLETE', execution:'unknown', remaining, outcomes, lastStop};
    return {...result, ok:true, execution:'executed', lastStop};
  }
  async function stopOne(udid) {
    await dispatch('shutdown', {udid});
    const result = await status();
    const device = result.devices.find(d => d.udid === udid);
    if (!device || device.state !== 'Shutdown') throw failure('STOP_UNCONFIRMED', 'Device shutdown is not confirmed. Refresh the device list.', 'unknown');
    return {...result, ok:true, execution:'executed'};
  }
  async function exclusive(fn) {
    if (busy || closing) throw failure('BUSY', 'A Baguette operation is still running. Wait for it to finish, then try again.');
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }
  async function request(method, params = {}) {
    // A settings refresh must not reject a user's stop/permission change.
    // Reading simulator state is safe while a command is in flight.
    if (method === 'settings_status') return status();
    if (method === 'viewer_switch') return manager.start(params);
    if (method === 'viewer_catalog') return dispatch('environment');
    return exclusive(async () => {
      // Emergency stop stays available even if settings are damaged.
      if (method === 'shutdown') return dispatch(method, params);
      if (method === 'close_viewer') return dispatch(method, params);
      if (method === 'settings_shutdown') return stopOne(params.udid);
      if (method === 'settings_stop_all') return stopAll('manual');
      if (['environment','devices'].includes(method)) return dispatch(method, params);
      const settings = await load();
      if (method === 'settings_save') {
        if (typeof params.enabled !== 'boolean' || ![0,15,30,60].includes(params.idleMinutes)) throw failure('INVALID_ARGUMENT', 'Invalid runtime settings. Refresh this page.');
        // Persist the stop switch BEFORE touching devices. Partial failure must
        // not allow a new boot to undo the user's decision.
        await save({enabled:params.enabled, idleMinutes:params.idleMinutes});
        if (!params.enabled) return stopAll('disabled');
        touch();
        return {...await status(), ok:true, execution:'executed'};
      }
      const actual = {settings_boot:'boot', settings_viewer:'open_viewer'}[method] || method;
      if (!settings.enabled) throw failure('RUNTIME_DISABLED', 'Baguette is paused. Enable simulator operation in Plugins → Baguette settings.');
      // A command can mutate a device and then fail (e.g. bootstatus timeout).
      // Re-arm cleanup before dispatch, even when no success result follows.
      touch();
      const result = await dispatch(actual, params);
      if(actual==='launch_app')await manager.remember(params.udid,params.bundleId).catch(()=>{});
      touch();
      return result;
    });
  }
  async function checkIdle() {
    if (busy || closing || idleHandled) return;
    return exclusive(async () => {
      const settings = await load();
      if (settings.enabled && (!settings.idleMinutes || now() - lastActivity < settings.idleMinutes * 60000)) return;
      const result = await stopAll(settings.enabled ? 'idle' : 'disabled');
      // Incomplete shutdown stays visible; do not silently retry forever.
      idleHandled = true;
      return result;
    });
  }
  return {request, status, checkIdle, touch, exclusive,currentApp:manager.currentApp,assertEnabled,
    async close() { closing = true; return stopAll('worker-exit'); }};
}
module.exports = {createRuntime};
