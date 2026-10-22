'use strict';
// Installing and identifying apps on a private device.
// - Unchanged builds are not reinstalled (identity = bundle id, version, build,
//   executable hash, then a dry-run diff of the whole bundle).
// - A build that changes only a few files is synced file by file into the
//   installed bundle (multi-GB games often change a handful per build);
//   otherwise simctl installs the whole bundle.
// - A first install runs in the background; the tool returns a job to poll
//   instead of timing out.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9.-]+$/;
const SYNC_LIMIT = 300;

function createApps({sim, run, Failure, now = Date.now, rsync = '/usr/bin/rsync'}) {
  const jobs = new Map();
  const failure = (code, message, execution = 'not_executed') => new Failure(code, message, execution);

  async function plist(appDir) {
    const {stdout} = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(appDir, 'Info.plist')], {timeout: 10000});
    try { return JSON.parse(stdout); } catch { throw failure('INVALID_APP', 'Info.plist is unreadable'); }
  }
  function sha256(file) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
    });
  }
  /** Who an app bundle is: what a tester means by "the same build". */
  async function identity(appDir) {
    const info = await plist(appDir);
    const executable = info.CFBundleExecutable;
    if (typeof info.CFBundleIdentifier !== 'string' || typeof executable !== 'string') throw failure('INVALID_APP', 'Info.plist has no bundle identifier or executable');
    const exe = path.join(appDir, executable), stat = await fsp.stat(exe);
    return {bundleId: info.CFBundleIdentifier, version: info.CFBundleShortVersionString ?? null, build: info.CFBundleVersion ?? null,
      executable, executableSha256: await sha256(exe), executableModified: new Date(stat.mtimeMs).toISOString()};
  }
  async function appPath(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || !value.replace(/\/$/, '').endsWith('.app')) throw failure('INVALID_ARGUMENT', 'appPath must be an absolute simulator .app bundle path');
    const real = await fsp.realpath(value).catch(() => { throw failure('INVALID_ARGUMENT', `No app bundle at ${value}`); });
    if (!(await fsp.stat(real)).isDirectory()) throw failure('INVALID_ARGUMENT', 'App bundle must be a directory');
    return real;
  }
  async function installedAt(device, bundleId) {
    try { return (await sim(['get_app_container', device.udid, bundleId, 'app'], {timeout: 10000})).stdout || null; }
    catch { return null; }
  }
  /** Compare bytes, including resources whose size and timestamp were preserved. */
  async function differences(from, to) {
    const {stdout} = await run(rsync, ['-ac', '--delete', '--dry-run', '--itemize-changes', from + '/', to + '/'], {timeout: 120000, maxBuffer: 32 * 1024 * 1024});
    // A line starting with "." changes attributes only (installd resets dylib permissions); count content changes.
    return stdout.split('\n').filter(line => line && !line.startsWith('.'));
  }

  async function info(device, p) {
    let local = null;
    if (p.appPath !== undefined) local = await identity(await appPath(p.appPath));
    const bundleId = p.bundleId ?? local?.bundleId;
    if (typeof bundleId !== 'string' || !BUNDLE.test(bundleId)) throw failure('INVALID_ARGUMENT', 'Pass bundleId or appPath');
    const container = await installedAt(device, bundleId);
    if (!container) return {udid: device.udid, bundleId, installed: false, ...(local ? {local} : {})};
    const installed = await identity(container);
    const result = {udid: device.udid, bundleId, installed: true, version: installed.version, build: installed.build, executable: installed.executable,
      executableSha256: installed.executableSha256.slice(0, 16), executableModified: installed.executableModified};
    if (local) {
      const sameExecutable = local.executableSha256 === installed.executableSha256;
      const changedFiles = sameExecutable ? await differences(await appPath(p.appPath), container).then(lines => lines.length).catch(() => null) : null;
      result.local = {version: local.version, build: local.build, executableSha256: local.executableSha256.slice(0, 16), executableModified: local.executableModified};
      result.matchesLocal = sameExecutable && local.version === installed.version && local.build === installed.build && changedFiles === 0;
      if (changedFiles) result.changedFiles = changedFiles;
    }
    return result;
  }

  function runningFor(udid) { return [...jobs.values()].find(j => j.udid === udid && j.state === 'running') || null; }

  async function install(device, p, {terminate}) {
    const source = await appPath(p.appPath);
    if (runningFor(device.udid)) throw failure('INSTALL_RUNNING', `An install is still running on this device (job ${runningFor(device.udid).id}). Poll it with app action=install_status.`);
    const local = await identity(source);
    const container = p.mode === 'full' ? null : await installedAt(device, local.bundleId);
    let mode = 'full';
    if (container) {
      const installed = await identity(container).catch(() => null);
      const changes = installed ? await differences(source, container).catch(() => null) : null;
      const changed = changes?.length ?? Infinity;
      if (changed === 0 && installed.executableSha256 === local.executableSha256 && installed.version === local.version && installed.build === local.build) {
        return {udid: device.udid, bundleId: local.bundleId, execution: 'not_executed', mode: 'unchanged', version: local.version, build: local.build,
          note: 'The installed app already matches this build; nothing was copied.'};
      }
      // A handful of changed files syncs in seconds; many changed files install
      // faster as a whole bundle (simctl clones files on APFS).
      // Registration and signing changes need installd, including nested bundles.
      if (changed <= SYNC_LIMIT && !changes.some(line => /(?:Info\.plist|embedded\.mobileprovision|_CodeSignature)(?:\/|$)/.test(line))) mode = 'sync';
    }
    const job = {id: crypto.randomUUID().slice(0, 8), udid: device.udid, bundleId: local.bundleId, appPath: source, mode, state: 'running', startedAt: now()};
    jobs.set(job.id, job);
    for (const [id, old] of jobs) if (old.state !== 'running' && now() - (old.finishedAt || 0) > 3600000) jobs.delete(id);
    job.promise = (async () => {
      if (mode === 'sync') {
        // The app must not run while its files are replaced.
        await terminate(local.bundleId).catch(error => {
          if (!/not running|found nothing|No matching processes/i.test(error.message)) throw error;
        });
        await run(rsync, ['-ac', '--delete', source + '/', container + '/'], {timeout: 1800000, mutation: true});
        const after = await identity(container);
        if (after.executableSha256 !== local.executableSha256 || (await differences(source, container)).length) throw failure('INSTALL_UNVERIFIED', 'The synced bundle does not match the build', 'unknown');
        job.changedFiles = null;
      } else {
        await sim(['install', device.udid, source], {timeout: 1800000, mutation: true});
      }
      return {version: local.version, build: local.build};
    })().then(result => { Object.assign(job, {state: 'done', finishedAt: now(), result}); },
      error => { Object.assign(job, {state: 'failed', finishedAt: now(), error: {code: error.code || 'INSTALL_FAILED', message: error.message, execution: error.execution || 'unknown'}}); });
    return wait(job, p.wait ?? 80);
  }

  async function wait(job, seconds) {
    const limit = Math.max(0, Math.min(Number(seconds) || 0, 90)) * 1000;
    let timer;
    await Promise.race([job.promise, new Promise(resolve => { timer = setTimeout(resolve, limit); })]);
    clearTimeout(timer);
    return describeJob(job);
  }
  function describeJob(job) {
    const base = {udid: job.udid, bundleId: job.bundleId, job: job.id, mode: job.mode, state: job.state, elapsedSeconds: Math.round(((job.finishedAt || now()) - job.startedAt) / 1000)};
    if (job.state === 'running') return {...base, execution: 'unknown', note: `Still ${job.mode === 'sync' ? 'syncing changed files' : 'installing'}. Call app action=install_status job=${job.id} to wait for it; do not start another install.`};
    if (job.state === 'failed') { const error = new Failure(job.error.code, job.error.message, job.error.execution); throw error; }
    return {...base, execution: 'executed', ...job.result, note: job.mode === 'sync' ? 'Changed files were synced into the installed app; App data was kept.' : 'Installed.'};
  }
  async function status(p) {
    const job = p.job !== undefined ? jobs.get(p.job) : [...jobs.values()].filter(j => j.udid === p.udid).sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!job || (p.udid !== undefined && job.udid !== p.udid)) throw failure('JOB_NOT_FOUND', 'No such install job for this device. Installs are forgotten when the plugin worker restarts; check with app action=info.');
    return wait(job, p.wait ?? 85);
  }

  const installing = () => [...jobs.values()].some(j => j.state === 'running');
  const pending = udid => {
    const promises = [...jobs.values()].filter(j => j.state === 'running' && (!udid || j.udid.toUpperCase() === udid.toUpperCase())).map(j => j.promise);
    return promises.length ? Promise.all(promises) : null;
  };
  return {install, status, info, identity, runningFor, installing, pending};
}

module.exports = {createApps};
