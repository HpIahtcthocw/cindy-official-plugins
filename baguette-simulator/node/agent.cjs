'use strict';
// Agent-facing simulator operations: observe, act, wait, capture, state, logs.
// Everything the model sends or reads is in view points (geometry.cjs); this
// module owns the conversion, so a point read off a screenshot is a point to tap.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const G = require('./geometry.cjs');
const input = require('./input.cjs');
const pixels = require('./pixels.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SCREEN_TTL_MS = 8000;
// An app with no accessibility elements (a game) is read with OCR first for this long.
const NO_AX_TTL_MS = 60000;
// Cindy's inline image budget per tool result (ghostModelImages.ts in the host), with headroom.
const INLINE_BYTES = 130000;
const inlineImage = (bytes, enabled) => enabled && bytes?.length > 0 && bytes.length <= INLINE_BYTES
  ? [{data: bytes.toString('base64')}] : null;
const sameScreen = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function createAgent({binary, deviceSet, root, run, sim, Failure, spawnImpl = spawn, now = Date.now}) {
  const screens = new Map(); // udid → {screen, at (screen confirmed), tree, treeAt}
  const seen = new Map(); // udid → the screen the model last looked at (orientation and size)
  const noAx = new Map(); // udid → when the screen last had no accessibility elements
  const texts = new Map(); // udid → {elements, at, shape}: the last text read off the screen
  const corners = new Map(); // `${udid}|${panel}` → radius in points
  const dargs = device => ['--udid', device.udid, '--device-set', deviceSet];
  const bag = (words, device, args = [], options) => run(binary, [...words, ...dargs(device), ...args], options);
  const failure = (code, message, execution = 'not_executed') => new Failure(code, message, execution);
  // Reuse command timeouts; a wait's observation and optional image share a
  // deadline rather than each starting a fresh full command budget.
  const budget = (timeout, deadline) => {
    if (deadline === undefined) return {timeout};
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) throw failure('WAIT_TIMEOUT', 'Wait image/observation budget exhausted. Request screenshot separately if needed.');
    return {timeout: Math.min(timeout, remaining)};
  };
  const number = (value, name, min, max, fallback) => {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw failure('INVALID_ARGUMENT', `${name} must be ${min}–${max}`);
    return value;
  };
  const point = (value, name) => {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(n => typeof n === 'number' && Number.isFinite(n))) throw failure('INVALID_ARGUMENT', `${name} must be [x, y] in view points`);
    return value;
  };

  // ---- observing ----
  async function readTree(device, extra = [], deadline) {
    const {stdout} = await bag(['describe-ui'], device, extra, budget(20000, deadline));
    try { return JSON.parse(stdout); } catch { throw failure('INVALID_OUTPUT', 'Accessibility output was not JSON'); }
  }
  /** Current screen geometry (and tree). Cached briefly so taps stay fast. */
  async function observe(device, {fresh = false, deadline} = {}) {
    const cached = screens.get(device.udid);
    if (!fresh && cached?.tree && now() - cached.treeAt < SCREEN_TTL_MS) return cached;
    let tree;
    try { tree = await readTree(device, [], deadline); }
    catch (error) {
      // An old tree cannot prove what is currently visible or safe to tap.
      // Geometry has its own separately confirmed cache for coordinate input.
      throw failure('SCREEN_UNAVAILABLE', `Could not read the screen geometry: ${error.message}. Take a screenshot and retry.`);
    }
    const screen = tree?.screen;
    if (!screen || !(screen.width > 0) || !(screen.height > 0)) throw failure('SCREEN_UNAVAILABLE', 'The simulator did not report its screen. Retry after the App finishes launching.');
    const entry = {screen: screenOf(screen), tree, at: now(), treeAt: now()};
    screens.set(device.udid, entry);
    if (G.compactTree(tree, entry.screen, {limit: 1}).total) noAx.delete(device.udid); else noAx.set(device.udid, now());
    return entry;
  }
  const screenOf = screen => ({width: screen.width, height: screen.height, orientation: screen.orientation || 'portrait', target: screen.target});
  // What Baguette's `input --expected-screen` checks: the screen we planned against.
  const pinned = screen => screen.target?.pixelSize && screen.target.screenId !== undefined
    ? ['--expected-screen', JSON.stringify({width: screen.width, height: screen.height, orientation: screen.orientation, target: {screenId: screen.target.screenId, litPanel: screen.target.litPanel, pixelSize: screen.target.pixelSize}})] : [];
  /**
   * Is a cached screen still the live one? An input session pinned to it binds
   * only if it is (about 0.3 s, nothing is sent), versus about 2 s for a probe.
   */
  async function confirm(device, screen, deadline) {
    const pin = pinned(screen);
    if (!pin.length) return false;
    try { await bag(['input'], device, pin, budget(5000, deadline)); return true; } catch { return false; }
  }
  /**
   * Screen geometry only (orientation, size, lit panel), for screenshots and
   * coordinate input. A one-point hit test reports it without walking the tree
   * or sweeping the status bar: about 1.6 s on iPhone Duo versus 4–6 s.
   */
  async function geometry(device, {maxAge = SCREEN_TTL_MS, deadline} = {}) {
    const cached = screens.get(device.udid);
    if (cached && now() - cached.at < maxAge) return cached;
    if (cached && await confirm(device, cached.screen, deadline)) { cached.at = now(); return cached; }
    let probe;
    try { probe = await readTree(device, ['--x', '1', '--y', '1'], deadline); }
    catch (error) {
      if (cached) return {...cached, stale: true};
      throw failure('SCREEN_UNAVAILABLE', `Could not read the screen geometry: ${error.message}. Take a screenshot and retry.`);
    }
    const screen = probe?.screen;
    if (!screen || !(screen.width > 0) || !(screen.height > 0)) throw failure('SCREEN_UNAVAILABLE', 'The simulator did not report its screen. Retry after the App finishes launching.');
    const entry = {screen: screenOf(screen), tree: null, at: now(), treeAt: 0};
    screens.set(device.udid, entry);
    return entry;
  }
  function forget(udid) { screens.delete(udid); noAx.delete(udid); }
  // The screen content changed (a tap), its geometry most likely did not.
  function forgetTree(udid) { const entry = screens.get(udid); if (entry) { entry.tree = null; entry.treeAt = 0; } }
  const shape = screen => { const v = G.viewSize(screen); return `${v.width}×${v.height} ${screen.orientation}${screen.target?.litPanel && screen.target.litPanel !== 'primary' ? ` (${screen.target.litPanel} panel)` : ''}`; };
  function look(device, screen) { seen.set(device.udid, shape(screen)); }
  // A point read off an older screenshot means something else once the screen turned.
  function sameAsSeen(device, screen) {
    const last = seen.get(device.udid), current = shape(screen);
    if (last && last !== current) throw failure('SCREEN_CHANGED', `The screen is now ${current}; it was ${last} when you last looked. Take a screenshot and choose the point again.`);
  }
  // Pixels per point of each device's screen, learned from its geometry (raw captures start at that density).
  const densities = new Map();
  const viewInfo = screen => ({...G.viewSize(screen), orientation: screen.orientation, ...(screen.target?.litPanel && screen.target.litPanel !== 'primary' ? {panel: screen.target.litPanel} : {})});

  async function cornerRadius(device, screen, deadline) {
    const panel = screen.target?.litPanel || 'primary', key = `${device.udid}|${panel}`;
    if (corners.has(key)) return corners.get(key);
    let radius = 0;
    try {
      const layout = JSON.parse((await bag(['chrome', 'layout'], device, panel !== 'primary' ? ['--panel', panel] : [], budget(10000, deadline))).stdout);
      if (layout.innerCornerRadius > 0 && layout.screen?.width > 0) radius = layout.innerCornerRadius * screen.width / layout.screen.width;
    } catch {}
    corners.set(key, radius);
    return radius;
  }

  async function describe(device, p = {}) {
    if (p.x !== undefined || p.y !== undefined) {
      // What is under a point: the elements whose frame contains it, innermost first.
      // (Baguette's hit test can answer with a whole container, i.e. the page.)
      const {screen, tree} = await observe(device, {fresh: true});
      look(device, screen);
      const view = G.viewSize(screen);
      const vx = number(p.x, 'x', 0, view.width), vy = number(p.y, 'y', 0, view.height);
      const under = G.compactTree(tree, screen, {limit: 2000}).elements
        .filter(e => vx >= e.frame[0] && vx <= e.frame[0] + e.frame[2] && vy >= e.frame[1] && vy <= e.frame[1] + e.frame[3])
        .sort((a, b) => a.frame[2] * a.frame[3] - b.frame[2] * b.frame[3]);
      return {udid: device.udid, screen: viewInfo(screen), at: [vx, vy], elements: under.slice(0, 8),
        ...(under.length ? {} : {note: 'No accessibility element contains this point. On a game or custom-drawn screen, use screenshot with region to look closer.'})};
    }
    const {screen, tree} = await observe(device, {fresh: true});
    look(device, screen);
    if (p.mode === 'full') {
      const turned = G.axTurned(tree, screen);
      const convert = node => node && typeof node === 'object' ? {...node, screen: undefined, frame: node.frame ? G.frameToView(screen, G.axFrameToNative(screen, node.frame, turned)) : node.frame, children: Array.isArray(node.children) ? node.children.map(convert) : node.children} : node;
      const encoded = JSON.stringify(convert(tree));
      return {udid: device.udid, screen: viewInfo(screen), ...(encoded.length > 180000 ? {treePreview: encoded.slice(0, 180000), truncated: true} : {tree: JSON.parse(encoded)})};
    }
    const limit = number(p.limit, 'limit', 1, 600, 250);
    const result = G.compactTree(tree, screen, {query: p.query, role: p.role, limit});
    // No accessibility at all (a game, an engine-drawn UI): read the text off the pixels instead.
    if (!result.total && (p.role === undefined || p.role === 'text') && noAx.has(device.udid)) {
      const read = await readText(device).catch(() => null);
      if (read) {
        const q = typeof p.query === 'string' ? p.query.trim().toLowerCase() : '';
        const elements = q ? read.elements.filter(e => e.label.toLowerCase().includes(q)) : read.elements;
        return {udid: device.udid, screen: viewInfo(read.screen), source: 'ocr', elements: elements.slice(0, limit), total: elements.length, truncated: elements.length > limit,
          note: 'No accessibility elements (a game or custom-drawn UI). These are text lines read from the screen image (OCR); tap text=… and wait_for text=… work on them. Icons and art without text are not listed: use screenshot for those.'};
      }
    }
    return {udid: device.udid, screen: viewInfo(screen), ...result,
      ...(!result.total && !p.query && !p.role ? {note: 'No accessibility elements: a game or custom-drawn UI. Use screenshot (grid on) and tap by coordinates.'} : {})};
  }

  /**
   * Text on the screen image, via Vision on this Mac, as view-point elements.
   * With `find`, a longer line containing it is located by just that part.
   */
  async function readText(device, {find, deadline} = {}) {
    const shot = await screenshot(device, {scale: 2, corners: false, format: 'png', _internal: true, _deadline: deadline});
    try {
      const items = JSON.parse((await run('/usr/bin/osascript', ['-l', 'JavaScript', path.join(__dirname, 'ocr.jxa.js'), shot.path, JSON.stringify(typeof find === 'string' && find.trim() ? {find: find.trim()} : {})], budget(40000, deadline))).stdout);
      const {width, height} = G.viewSize(shot._screen);
      const elements = items.filter(o => o.text && o.text.trim()).map(o => {
        const b = o.part || o.box, frame = [b[0] * width, b[1] * height, b[2] * width, b[3] * height].map(round);
        return {role: 'text', label: o.text.trim(), frame, center: [round(frame[0] + frame[2] / 2), round(frame[1] + frame[3] / 2)], confidence: o.confidence};
      }).sort((a, b) => (Math.abs(a.frame[1] - b.frame[1]) < 6 ? a.frame[0] - b.frame[0] : a.frame[1] - b.frame[1]));
      texts.set(device.udid, {elements, at: now(), shape: shape(shot._screen)});
      return {screen: shot._screen, elements};
    } finally { await fs.rm(shot.path, {force: true}); }
  }

  async function shotsDir(kind = 'screenshots') {
    const dir = path.join(root, kind);
    await fs.mkdir(dir, {recursive: true, mode: 0o700});
    // Keep the folder bounded: drop files older than a day.
    try {
      const cutoff = now() - 24 * 3600 * 1000;
      for (const name of await fs.readdir(dir)) {
        const file = path.join(dir, name), stat = await fs.stat(file).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) await fs.rm(file, {recursive: true, force: true});
      }
    } catch {}
    return dir;
  }

  async function screenshot(device, p = {}) {
    const scale = number(p.scale, 'scale', 1, 3, 1);
    const dir = await shotsDir();
    const id = crypto.randomUUID(), raw = path.join(dir, `${id}.raw.png`), file = path.join(dir, `${id}.${p.format === 'png' ? 'png' : 'jpg'}`);
    // Confirm live geometry on both sides of capture; cached age alone cannot
    // establish which orientation and panel these pixels belong to.
    const known = densities.get(device.udid);
    const divisor = known ? Math.max(1, Math.floor(known / scale)) : 1;
    const before = await geometry(device, {maxAge: 0, deadline: p._deadline});
    if (before.stale) throw failure('SCREEN_UNAVAILABLE', 'Current screen geometry could not be confirmed.');
    const screen = before.screen;
    // Baguette's capture occasionally fails once with an internal error; the next frame is fine.
    await bag(['screenshot'], device, ['--format', 'png', '--output', raw, '--scale', String(divisor)], budget(20000, p._deadline))
      .catch(() => sleep(300).then(() => bag(['screenshot'], device, ['--format', 'png', '--output', raw, '--scale', String(divisor)], budget(20000, p._deadline))));
    const afterFrame = await geometry(device, {maxAge: 0, deadline: p._deadline});
    if (afterFrame.stale || !sameScreen(afterFrame.screen, screen)) {
      await fs.rm(raw, {force: true});
      throw failure('SCREEN_CHANGED', 'The screen turned or folded while capturing. Take a new screenshot.');
    }
    if (screen.target?.pixelSize?.width) densities.set(device.udid, screen.target.pixelSize.width / screen.width);
    const view = G.viewSize(screen);
    let region = null;
    if (p.region) {
      const r = p.region;
      const x = number(r.x, 'region.x', 0, view.width), y = number(r.y, 'region.y', 0, view.height);
      region = {x, y, width: number(r.width, 'region.width', 1, view.width - x), height: number(r.height, 'region.height', 1, view.height - y)};
    }
    const grid = p.grid === true ? (region ? 25 : 100) : number(p.grid, 'grid', 0, 1000, 0);
    try {
      const radius = p.corners === false ? 0 : await cornerRadius(device, screen, p._deadline);
      const options = {rotate: G.rotation(screen), view, scale, region, radius, grid, format: p.format === 'png' ? 'png' : 'jpeg', quality: 0.82};
      const render = async (out, extra) => JSON.parse((await run('/usr/bin/osascript', ['-l', 'JavaScript', path.join(__dirname, 'image.jxa.js'), raw, out, JSON.stringify({...options, ...extra})], budget(20000, p._deadline))).stdout);
      const size = await render(file, {});
      if (p._internal) return {path: file, _screen: screen};
      look(device, screen);
      // Shown to the model inline when it asked for the screenshot: a JPEG copy
      // within the host's inline budget, lowering quality but never the pixel
      // size (pixels are points), whatever format the saved file is.
      let inline = null;
      if (p._inline) {
        const copy = path.join(dir, `${id}.inline.jpg`);
        try {
          for (const quality of [0.82, 0.62, 0.45]) {
            const bytes = options.format === 'jpeg' && quality === 0.82 ? await fs.readFile(file) : (await render(copy, {format: 'jpeg', quality}), await fs.readFile(copy));
            inline = inlineImage(bytes, p._inline);
            if (inline) break;
          }
        } finally { await fs.rm(copy, {force: true}); }
      }
      return {udid: device.udid, path: file, mimeType: p.format === 'png' ? 'image/png' : 'image/jpeg', pixels: size, scale, screen: viewInfo(screen),
        ...(inline ? {_modelImages: inline} : {}),
        ...(region ? {region} : {}), note: `${inline ? 'The screenshot is attached to this result and the user sees it in this tool step; do not import or re-embed it (the file at path is the same image).' : 'Open the file at path with your image tool.'} ${scale === 1 ? 'Image pixels are view points' : `Divide pixels by ${scale} for view points`}${region ? ` and add the region origin (${region.x}, ${region.y})` : ''}; pass view points to tap and gesture.`};
    } finally { await fs.rm(raw, {force: true}); }
  }

  // ---- acting ----
  // Text on screen that has an element with no accessibility behind it: read it off the pixels.
  async function findByText(device, p, nth, deadline) {
    if (p.id !== undefined || typeof p.text !== 'string' || (p.role !== undefined && p.role !== 'text')) return null;
    const read = await readText(device, {find: p.text, deadline});
    const {element, matches} = G.findElement(read.elements, {text: p.text, nth, view: G.viewSize(read.screen)});
    return {read, element, matches};
  }

  async function resolveTarget(device, p) {
    G.validateSelector(p);
    if (typeof p.text === 'string' || typeof p.id === 'string') {
      const nth = number(p.nth, 'nth', 0, 200, 0);
      const target = element => ({x: element.center[0], y: element.center[1]});
      // Recently a screen without accessibility (a game): try the pixels first.
      if (noAx.has(device.udid) && now() - noAx.get(device.udid) < NO_AX_TTL_MS && typeof p.id !== 'string') {
        const hit = await findByText(device, p, nth);
        if (hit?.element) return {screen: hit.read.screen, ...target(hit.element), element: {label: hit.element.label, role: 'text', frame: hit.element.frame, source: 'ocr'}, matches: hit.matches};
      }
      const {screen, tree} = await observe(device, {fresh: true});
      const {elements} = G.compactTree(tree, screen, {limit: 1000});
      const {element, matches} = G.findElement(elements, {text: p.text, id: p.id, role: p.role, nth, view: G.viewSize(screen)});
      if (element) return {screen, ...target(element), element: {label: element.label, id: element.id, role: element.role, frame: element.frame}, matches};
      const hit = noAx.has(device.udid) || !elements.length ? await findByText(device, p, nth) : null;
      if (hit?.element) return {screen: hit.read.screen, ...target(hit.element), element: {label: hit.element.label, role: 'text', frame: hit.element.frame, source: 'ocr'}, matches: hit.matches};
      const visible = elements.length ? elements.filter(e => e.label || e.id || e.value).slice(0, 25).map(e => `${e.label || e.value || e.id} (${e.role})`)
        : (hit?.read.elements || []).slice(0, 25).map(e => e.label);
      throw failure('ELEMENT_NOT_FOUND', `No visible ${elements.length ? 'element' : 'text'} matches ${JSON.stringify(p.text ?? p.id)}. ${elements.length ? 'Visible' : 'Text read from the screen'}: ${JSON.stringify(visible)}. ${elements.length ? 'Scroll (gesture kind=scroll_to) or use coordinates.' : 'Icons and art have no text: take a screenshot and tap by coordinates.'}`);
    }
    const {screen} = await geometry(device);
    sameAsSeen(device, screen);
    const view = G.viewSize(screen);
    return {screen, x: number(p.x, 'x', 0, view.width), y: number(p.y, 'y', 0, view.height)};
  }

  async function act(device, screen, gesture) {
    const steps = input.plan(screen, gesture);
    // Pinned to the screen the points were planned on: Baguette refuses if it turned meanwhile.
    const session = input.openSession(binary, [...dargs(device), ...pinned(screen)], {spawnImpl});
    try { return await input.perform(session, steps); }
    catch (error) {
      if (error.execution === 'not_executed' && /changed|observe again/.test(error.message)) {
        forget(device.udid);
        throw failure('SCREEN_CHANGED', 'The screen turned or changed panel just now; nothing was sent. Take a screenshot and try again.');
      }
      throw error;
    } finally { session.close(); }
  }

  async function after(device, p, result) {
    // `until`: the text the action should bring up; waiting for it replaces a guessed settle time.
    const until = typeof p.until === 'string' && p.until.trim() ? p.until.trim() : null;
    const observeMode = p.observe ?? (until ? 'none' : 'ui');
    let out = {...result};
    if (until) {
      forgetTree(device.udid);
      const waited = await waitFor(device, {text: until, timeout: 15, _inline: p._inline});
      const {_modelImages, ...rest} = waited;
      out.until = rest;
      if (_modelImages) out._modelImages = _modelImages;
      // Not there: the wait already attached the screen; do not take another.
      if (!waited.met) return out;
    }
    if (observeMode === 'none') return out;
    if (!until) await sleep(number(p.settle, 'settle', 0, 5, 0.6) * 1000);
    forgetTree(device.udid);
    if (observeMode === 'ui' || observeMode === 'both') {
      try { const ui = await describe(device, {limit: 120}); out.ui = {screen: ui.screen, elements: ui.elements, total: ui.total, ...(ui.source ? {source: ui.source} : {}), ...(ui.note ? {note: ui.note} : {})}; }
      catch (error) { out.ui = {error: error.message}; }
    }
    if (observeMode === 'screenshot' || observeMode === 'both') {
      try { const {_modelImages, ...shot} = await screenshot(device, {_inline: p._inline}); out.screenshot = shot; if (_modelImages) out._modelImages = _modelImages; }
      catch (error) { out.screenshot = {error: error.message}; }
    }
    return out;
  }

  async function tap(device, p) {
    const target = await resolveTarget(device, p);
    const count = number(p.count, 'count', 1, 3, 1), duration = number(p.duration, 'duration', 0.02, 10, undefined);
    const hint = target.element ? null : overlap(device, target.screen, target.x, target.y);
    await act(device, target.screen, {kind: 'tap', x: target.x, y: target.y, count, duration});
    return after(device, p, {udid: device.udid, execution: 'executed', tapped: [round(target.x), round(target.y)], ...(target.element ? {element: target.element, matches: target.matches} : {}),
      ...(duration >= 0.5 ? {held: duration} : {}), ...(hint ? {hint} : {})});
  }

  // A coordinate inside text read off the screen moments ago: say so, the touch may land on that text's control.
  function overlap(device, screen, x, y) {
    const last = texts.get(device.udid);
    if (!last || now() - last.at > 30000 || last.shape !== shape(screen)) return null;
    const hit = last.elements.find(e => x >= e.frame[0] - 2 && x <= e.frame[0] + e.frame[2] + 2 && y >= e.frame[1] - 2 && y <= e.frame[1] + e.frame[3] + 2);
    return hit ? `This point is on the text ${JSON.stringify(hit.label)} read from the screen; if that text belongs to another control (it may cover an icon), the tap goes there. Check the result.` : null;
  }

  async function gesture(device, p) {
    const kind = p.kind;
    if (kind === 'scroll_to') return scrollTo(device, p);
    const {screen} = await geometry(device);
    if (p.from || p.to || p.center || kind === 'pan') sameAsSeen(device, screen);
    const view = G.viewSize(screen);
    const g = {kind, duration: number(p.duration, 'duration', 0.05, 10, undefined)};
    if (kind === 'swipe' || kind === 'drag') {
      if (p.direction) {
        const d = directionVector(p.direction, view, number(p.distance, 'distance', 10, Math.max(view.width, view.height), undefined));
        g.from = p.from ? point(p.from, 'from') : d.from; g.to = [g.from[0] + d.dx, g.from[1] + d.dy];
      } else { g.from = point(p.from, 'from'); g.to = point(p.to, 'to'); }
      if (kind === 'drag') g.hold = number(p.hold, 'hold', 0, 5, 0.6);
    } else if (kind === 'pinch') {
      g.center = p.center ? point(p.center, 'center') : [view.width / 2, view.height / 2];
      g.from = number(p.from_spread, 'from_spread', 10, 1000, 60); g.to = number(p.to_spread, 'to_spread', 10, 1000, 240);
    } else if (kind === 'pan') {
      g.from = p.from ? point(p.from, 'from') : [view.width / 2, view.height / 2]; g.by = point(p.by, 'by');
    } else if (kind === 'edge') {
      g.edge = ['bottom', 'top', 'left', 'right'].includes(p.edge) ? p.edge : 'bottom'; g.view = view;
      if (p.to) g.to = point(p.to, 'to');
      if (p.from) g.x = point(p.from, 'from')[0];
    } else throw failure('INVALID_ARGUMENT', 'kind must be swipe, drag, pinch, pan, edge or scroll_to');
    await act(device, screen, g);
    return after(device, p, {udid: device.udid, execution: 'executed', kind});
  }

  // Swipe until the element is fully on screen, or the content stops moving.
  async function scrollTo(device, p) {
    G.validateSelector(p);
    if (typeof p.text !== 'string' && typeof p.id !== 'string') throw failure('INVALID_ARGUMENT', 'scroll_to needs text or id');
    const max = number(p.max_swipes, 'max_swipes', 1, 30, 10), direction = p.direction || 'up';
    let last = null;
    for (let i = 0; i <= max; i++) {
      const {screen, tree} = await observe(device, {fresh: true});
      const view = G.viewSize(screen);
      const {elements} = G.compactTree(tree, screen, {limit: 1000});
      const {element} = G.findElement(elements, {text: p.text, id: p.id, role: p.role});
      const margin = 40;
      if (element && element.frame[1] >= margin && element.frame[1] + element.frame[3] <= view.height - margin && element.frame[0] >= 0 && element.frame[0] + element.frame[2] <= view.width) {
        return after(device, {...p, observe: p.observe ?? 'none'}, {udid: device.udid, execution: i ? 'executed' : 'not_executed', swipes: i, element: {label: element.label, id: element.id, role: element.role, frame: element.frame, center: element.center}});
      }
      const signature = JSON.stringify(elements.map(e => [e.label, e.frame[1]]));
      if (signature === last) throw failure('ELEMENT_NOT_FOUND', `Reached the end of the content after ${i} swipes without finding ${JSON.stringify(p.text ?? p.id)}. Visible now: ${JSON.stringify(elements.filter(e => e.label).slice(-20).map(e => e.label))}.`, i ? 'executed' : 'not_executed');
      last = signature;
      if (i === max) break;
      const area = p.within ? point(p.within, 'within') : [view.width / 2, view.height / 2];
      const d = directionVector(direction, view, view.height * 0.45);
      await act(device, screen, {kind: 'swipe', from: [area[0] - d.dx / 2, area[1] - d.dy / 2], to: [area[0] + d.dx / 2, area[1] + d.dy / 2], duration: 0.35});
      await sleep(450);
    }
    throw failure('ELEMENT_NOT_FOUND', `Not found after ${max} swipes: ${JSON.stringify(p.text ?? p.id)}.`, 'executed');
  }

  // ---- waiting ----
  // A small PNG of the whole screen in native orientation (about 270 px wide on iPad).
  async function frame(device, deadline) {
    try {
      const {stdout} = await run(binary, ['screenshot', ...dargs(device), '--format', 'png', '--scale', '6'], {...budget(10000, deadline), trimOutput: false, encoding: 'buffer'});
      return stdout && stdout.length ? {bytes: stdout, image: pixels.decodePng(stdout)} : null;
    } catch { return null; }
  }
  // A view-point region as a rectangle on that native-orientation frame.
  function frameRect(screen, image, region) {
    if (!region || !image) return null;
    const corners = [[region.x, region.y], [region.x + region.width, region.y], [region.x, region.y + region.height], [region.x + region.width, region.y + region.height]].map(([x, y]) => G.toNative(screen, x, y));
    const k = image.width / screen.width, xs = corners.map(c => c.x * k), ys = corners.map(c => c.y * k);
    return {x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys)};
  }
  function viewRegion(screen, r) {
    if (r === undefined) return null;
    const view = G.viewSize(screen);
    const x = number(r?.x, 'region.x', 0, view.width), y = number(r?.y, 'region.y', 0, view.height);
    return {x, y, width: number(r.width, 'region.width', 1, view.width - x), height: number(r.height, 'region.height', 1, view.height - y)};
  }
  const share = (a, b, rect) => (a.image && b.image ? pixels.changedShare(a.image, b.image, rect) : a.bytes.equals(b.bytes) ? 0 : 1);

  /**
   * After boot or launch: wait until the frame is no longer a single colour (a
   * black launch frame) and has stopped moving; an animated scene (a game menu)
   * is accepted after a few seconds of content.
   */
  async function settle(device, {timeout = 20000} = {}) {
    const started = now();
    let prev = null, since = now(), content = null;
    while (now() - started < timeout) {
      const f = await frame(device);
      if (f && !(f.image && pixels.isBlank(f.image))) {
        content ??= now();
        if (!prev || share(prev, f) > 0.02) since = now();
        else if (now() - since >= 1000) return {settled: true, waitedMs: now() - started};
        if (now() - content >= 6000) return {settled: false, animated: true, waitedMs: now() - started};
        prev = f;
      } else { prev = null; content = null; }
      await sleep(200);
    }
    return {settled: false, waitedMs: now() - started, ...(content ? {} : {blank: true})};
  }

  async function waitFor(device, p) {
    const timeout = number(p.timeout, 'timeout', 1, 90, 15) * 1000, started = now();
    const deadline = started + timeout;
    const done = extra => ({udid: device.udid, met: true, waitedMs: now() - started, ...extra});
    // Leave 20s of the Host's 120s ceiling for worker preflight and delivery.
    // Optional images must not consume the wait result when the simulator is slow.
    const finish = async (result, look = p.screenshot === true) => {
      if (!look) return result;
      try { const {_modelImages, ...shot} = await screenshot(device, {_inline: p._inline, _deadline: started + 100000}); return {...result, screenshot: shot, ...(_modelImages ? {_modelImages} : {})}; }
      catch (error) { return {...result, screenshot: {error: error.message}}; }
    };
    const unmet = (reason, extra = {}) => finish({udid: device.udid, met: false, waitedMs: now() - started, reason, ...extra}, true);
    if (typeof p.log === 'string') {
      try { return await finish(await waitForLog(device, p, timeout, started, done)); }
      catch (error) { if (error.code === 'WAIT_TIMEOUT') return unmet(error.message); throw error; }
    }
    if (p.stable !== undefined) {
      const quiet = number(p.stable, 'stable', 0.2, 30, 1) * 1000, tolerance = number(p.tolerance, 'tolerance', 0, 50, 0.5) / 100;
      const {screen} = p.region !== undefined ? await geometry(device, {deadline}) : {screen: null};
      const region = screen ? viewRegion(screen, p.region) : null;
      let prev = null, since = now(), rect = null;
      const changes = [];
      while (now() - started < timeout) {
        const f = await frame(device, deadline);
        if (f) {
          if (region && f.image && !rect) rect = frameRect(screen, f.image, region);
          const moved = prev ? share(prev, f, rect) : 1;
          if (prev) changes.push(moved);
          if (moved > tolerance) since = now();
          else if (now() - since >= quiet) return finish(done({stableMs: now() - since, ...(f.image && pixels.isBlank(f.image, rect) ? {blank: true, note: 'The screen is a single colour (blank, or still loading).'} : {})}));
          prev = f;
        }
        await sleep(150);
      }
      const typical = changes.length ? [...changes].sort((a, b) => a - b)[Math.floor(changes.length / 2)] * 100 : null;
      const ambient = typical !== null && typical < 15;
      return unmet(`The ${region ? 'region' : 'screen'} kept changing for ${Math.round(timeout / 1000)} s${typical !== null ? `, typically ${typical.toFixed(1)}% of pixels per frame` : ''}.${ambient ? ` That looks like ongoing animation (a game scene); if so, wait with tolerance=${Math.min(50, Math.ceil(typical * 1.5 + 1))} or watch a calm region.` : ''}`);
    }
    G.validateSelector(p);
    if (typeof p.text !== 'string' && typeof p.id !== 'string') throw failure('INVALID_ARGUMENT', 'wait_for needs text, id, stable or log');
    const gone = p.gone === true;
    let seenText = [], source = 'ui';
    while (now() - started < timeout) {
      try {
        const {screen, tree} = await observe(device, {fresh: true, deadline});
        const {elements} = G.compactTree(tree, screen, {limit: 1000});
        let {element} = G.findElement(elements, {text: p.text, id: p.id, role: p.role});
        seenText = elements.filter(e => e.label).slice(0, 20).map(e => e.label);
        // No accessibility (a game): look for the text in the pixels.
        if (!element && !elements.length && typeof p.text === 'string') {
          const hit = await findByText(device, p, 0, deadline);
          if (!hit) throw failure('SCREEN_UNAVAILABLE', 'The requested text could not be read from this screen.');
          if (hit) { source = 'ocr'; element = hit.element; seenText = hit.read.elements.slice(0, 20).map(e => e.label); }
        }
        if (gone ? !element : element) return finish(done(element ? {element: {label: element.label, id: element.id, role: element.role, frame: element.frame, center: element.center}, ...(source === 'ocr' ? {source} : {})} : {}));
      } catch {}
      await sleep(400);
    }
    return unmet(`${gone ? 'Still visible' : 'Not visible'} after ${Math.round(timeout / 1000)} s: ${JSON.stringify(p.text ?? p.id)}. On screen${source === 'ocr' ? ' (text read from the image)' : ''}: ${JSON.stringify(seenText)}.`);
  }

  async function waitForLog(device, p, timeout, started, done) {
    let pattern;
    try { pattern = new RegExp(p.log, 'i'); } catch { throw failure('INVALID_ARGUMENT', 'log must be a valid regular expression'); }
    const processName = await logProcess(device, p);
    const args = ['simctl', '--set', deviceSet, 'spawn', device.udid, 'log', 'stream', '--style', 'ndjson', '--level', 'debug'];
    if (processName) args.push('--predicate', `process == ${JSON.stringify(processName)}`);
    let child;
    try { child = spawnImpl('/usr/bin/xcrun', args, {stdio: ['ignore', 'pipe', 'pipe']}); }
    catch (error) { throw failure('LOGS_UNAVAILABLE', error.message); }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    return new Promise((resolve, reject) => {
      let buffer = '', stderr = '', settled = false;
      const end = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); fn(value); };
      const timer = setTimeout(() => end(reject, failure('WAIT_TIMEOUT', `No log line matched /${p.log}/ within ${Math.round(timeout / 1000)} s.`)), Math.max(0, timeout - (now() - started)));
      const consume = raw => {
        const line = matchingLogLine(raw, pattern);
        if (line !== null) end(resolve, done({line}));
      };
      child.stdout.on('data', chunk => {
        if (settled) return;
        buffer += chunk;
        let i;
        while (!settled && (i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          consume(line);
        }
      });
      child.stderr.on('data', chunk => { if (!settled) stderr = (stderr + chunk).slice(-4000); });
      child.on('error', error => end(reject, failure('LOGS_UNAVAILABLE', error.message)));
      // close follows drained stdout/stderr; exit may precede the last log line.
      child.on('close', (code, signal) => {
        if (settled) return;
        if (buffer) consume(buffer);
        if (!settled) end(reject, failure('LOGS_UNAVAILABLE', `Log stream closed (${signal || code})${stderr.trim() ? ': ' + stderr.trim() : ''}`));
      });
    });
  }

  // ---- typing ----
  /** Whether the current screen exposes accessibility elements (false for most games). */
  async function hasAccessibility(device) {
    const at = noAx.get(device.udid);
    if (at && now() - at < NO_AX_TTL_MS) return false;
    const cached = screens.get(device.udid);
    if (cached?.tree && now() - cached.treeAt < NO_AX_TTL_MS) return true;
    try { await observe(device, {fresh: true}); } catch { return true; }
    return !noAx.has(device.udid);
  }
  // The input source the hardware keyboard types through, e.g. "en_US@sw=QWERTY;hw=Automatic".
  async function inputSource(device) {
    try {
      const {stdout} = await sim(['spawn', device.udid, 'defaults', 'read', 'com.apple.keyboard.preferences', 'KeyboardsCurrentAndNext'], {timeout: 5000});
      const first = stdout.replace(/^\s*\(\s*/, '').split(/,|\)/)[0].trim().replace(/^"|"$/g, '');
      return first || null;
    } catch { return null; }
  }
  // US key codes type US characters only through an English layout; Pinyin, Kana
  // and the like would compose them into candidates instead.
  const english = source => !source || /^en(_[A-Z]{2})?@sw=QWERTY(;|$)/.test(source);

  /**
   * Type US-keyboard text key by key, as a hardware keyboard would. Reaches
   * fields that ignore paste (games). A Pinyin, Kana or similar input source
   * would turn the keys into candidates, so it first switches to English with
   * Ctrl+Space (as on a Mac) and leaves it there: iOS records the switch about
   * 2 s late, and switching back would make the next call read a stale source.
   */
  async function typeText(device, text) {
    const session = input.openSession(binary, dargs(device), {spawnImpl});
    let switched = false, typed = 0;
    const send = async envelope => {
      try { await input.perform(session, [{envelope, waitMs: 0}]); }
      catch (error) { if (typed || switched) error.execution = 'unknown'; throw error; }
    };
    try {
      let source = await inputSource(device);
      for (let i = 0; i < 4 && !english(source); i++) {
        await send({type: 'key', code: 'Space', modifiers: ['control']});
        switched = true;
        const before = source, until = now() + 3500;
        do { await sleep(250); source = await inputSource(device); } while (source === before && now() < until);
        if (source === before) break;
      }
      if (!english(source)) throw failure('INPUT_SOURCE', `The simulator keyboard is set to ${source} and Ctrl+Space did not reach an English input source. Use method=paste, or add an English keyboard in Settings.`, switched ? 'executed' : 'not_executed');
      // Newlines and tabs are keys; the rest goes in short runs (about 0.1 s per character).
      for (const part of text.split(/(\n|\t)/)) {
        if (part === '\n' || part === '\t') { await send({type: 'key', code: part === '\n' ? 'Enter' : 'Tab'}); typed++; continue; }
        for (let i = 0; i < part.length; i += 30) { await send({type: 'type', text: part.slice(i, i + 30)}); typed += Math.min(30, part.length - i); }
      }
      return {typed, ...(switched ? {inputSource: 'The simulator keyboard was switched to English for typing (Ctrl+Space switches back).'} : {})};
    } finally { session.close(); }
  }

  // The edit menu's Paste item, as iOS labels it in common languages.
  const PASTE = new Set(['粘贴', '貼上', 'Paste', '貼り付け', '붙여넣기', 'Coller', 'Einfügen', 'Pegar', 'Incolla', 'Вставить', 'Colar', 'Plakken']);
  /**
   * Paste the clipboard into the focused field through its edit menu, by touch
   * only: no key event, so the on-screen keyboard stays (keyboard layout checks).
   */
  async function pasteByTouch(device) {
    const items = async () => { const {screen, tree} = await observe(device, {fresh: true}); return {screen, elements: G.compactTree(tree, screen, {limit: 1000}).elements}; };
    const pasteItem = list => list.find(e => PASTE.has((e.label || '').trim()));
    let {screen, elements} = await items();
    const field = elements.find(e => e.focused);
    if (!field) throw failure('NO_FOCUSED_FIELD', 'No focused text field. Tap the field first (its on-screen keyboard appears), then type with method=touch.');
    let item = pasteItem(elements);
    // A tap on the focused field opens its edit menu; a press-and-hold does where a tap only moves the cursor.
    for (const hold of [undefined, 0.8]) {
      if (item) break;
      await act(device, screen, {kind: 'tap', x: field.center[0], y: field.center[1], duration: hold});
      for (let i = 0; i < 6 && !item; i++) { await sleep(250); ({screen, elements} = await items()); item = pasteItem(elements); }
    }
    if (!item) throw failure('PASTE_MENU', 'The edit menu with Paste did not appear on the focused field. Use method=paste (hides the on-screen keyboard).', 'executed');
    await act(device, screen, {kind: 'tap', x: item.center[0], y: item.center[1]});
    forgetTree(device.udid);
    return {pastedInto: field.label || field.id || field.role};
  }

  // ---- capturing a transition ----
  async function capture(device, p, perform) {
    const seconds = number(p.seconds, 'seconds', 0.5, 15, 3), fps = number(p.fps, 'fps', 1, 20, 10), maxFrames = number(p.max_frames, 'max_frames', 2, 30, 12);
    const {screen, stale} = await geometry(device, {maxAge: 0});
    if (stale) throw failure('SCREEN_UNAVAILABLE', 'Current screen geometry could not be confirmed.');
    const view = G.viewSize(screen);
    const nativeScale = (screen.target?.pixelSize?.width || screen.width * 3) / screen.width;
    const dir = path.join(await shotsDir('captures'), crypto.randomUUID());
    await fs.mkdir(dir, {recursive: true, mode: 0o700});
    const child = spawnImpl(binary, ['stream', ...dargs(device), '--format', 'mjpeg', '--fps', String(fps), '--scale', String(Math.max(1, Math.round(nativeScale))), '--quality', '0.6'], {stdio: ['pipe', 'pipe', 'ignore']});
    const frames = [];
    let buffer = Buffer.alloc(0), t0 = null;
    child.stdout.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      let s, e;
      while ((s = buffer.indexOf(SOI)) >= 0 && (e = buffer.indexOf(EOI, s + 2)) >= 0) {
        const jpeg = buffer.subarray(s, e + 2); buffer = buffer.subarray(e + 2);
        frames.push({at: now(), jpeg: Buffer.from(jpeg)});
      }
      if (buffer.length > 8 * 1024 * 1024) buffer = Buffer.alloc(0);
    });
    child.stdin.on('error', () => {});
    let streamFailure = null;
    child.once('error', error => { streamFailure = error; });
    let actionResult = null, actionError = null, screenError = null;
    const checkScreen = async () => {
      const current = await geometry(device, {maxAge: 0});
      if (current.stale) throw failure('SCREEN_UNAVAILABLE', 'Capture screen geometry could not be confirmed; no contact sheet was generated.');
      if (!sameScreen(current.screen, screen)) throw failure('SCREEN_CHANGED', 'Capture requires a fixed orientation and panel. The screen changed; no contact sheet was generated. The action may already have run; check execution before continuing.');
    };
    try {
      await sleep(400); // first frame = the "before" state
      if (p.action) {
        try { actionResult = await perform(p.action); } catch (error) { actionError = error; }
      }
      // Times are measured from the moment the action finished (the touch landed);
      // keep recording for `seconds` after it so the whole transition is in.
      t0 = now();
      await checkScreen();
      await sleep(seconds * 1000);
      await checkScreen();
    } catch (error) { screenError = error; }
    finally { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref?.(); }
    const execution = actionError ? (actionError.execution || 'unknown') : actionResult ? (actionResult.execution || 'executed') : 'not_executed';
    if (screenError) { screenError.execution = execution; throw screenError; }
    if (!frames.length) throw failure('CAPTURE_EMPTY', `No frames arrived. ${streamFailure ? streamFailure.message : 'The screen may not have changed, or streaming failed.'}`, execution);
    try {
      // Keep frames that differ from the last kept one; then thin evenly in time.
      const kept = [];
      let lastHash = null;
      for (const f of frames) {
        const hash = crypto.createHash('sha1').update(f.jpeg).digest('hex');
        if (hash === lastHash) continue;
        kept.push(f); lastHash = hash;
      }
      const chosen = kept.length <= maxFrames ? kept : Array.from({length: maxFrames}, (_, i) => kept[Math.round(i * (kept.length - 1) / (maxFrames - 1))]);
      const base = t0 ?? frames[0].at;
      const files = [];
      for (const [i, f] of chosen.entries()) {
        const file = path.join(dir, `frame-${String(i).padStart(2, '0')}.jpg`);
        await fs.writeFile(file, f.jpeg);
        const ms = f.at - base;
        files.push({path: file, ms, label: `${ms >= 0 ? '+' : ''}${ms}ms`});
      }
      const columns = Math.min(files.length, view.width > view.height ? 3 : 6);
      const cellWidth = Math.min(view.width, Math.floor(1560 / columns)), cellHeight = Math.round(cellWidth * view.height / view.width);
      const sheet = path.join(dir, 'sheet.jpg');
      await run('/usr/bin/osascript', ['-l', 'JavaScript', path.join(__dirname, 'sheet.jxa.js'), sheet, JSON.stringify({frames: files, rotate: G.rotation(screen), cell: {width: cellWidth, height: cellHeight}, columns})], {timeout: 30000});
      // Share screenshots' inline budget; oversized sheets remain available by path.
      const sheetBytes = await fs.readFile(sheet).catch(() => null);
      const inline = inlineImage(sheetBytes, p._inline);
      return {udid: device.udid, execution, sheet, frames: files.map(({path: file, ms}) => ({path: file, ms})), received: frames.length, distinct: kept.length,
        ...(inline ? {_modelImages: inline} : {}),
        screen: viewInfo(screen), ...(actionResult ? {action: actionResult} : {}), ...(actionError ? {actionError: {code: actionError.code, message: actionError.message, execution}} : {}),
        note: `${inline ? 'The contact sheet is attached to this result and shown to the user in this tool step' : 'Open sheet with your image tool'}: frames left to right, labelled with milliseconds since the action finished (negative = before). Individual frames are native-orientation JPEGs.`};
    } catch (error) { error.execution = execution; throw error; }
  }

  // ---- device state ----
  async function setState(device, p) {
    const applied = [], operations = [];
    const add = (name, words, args, options = {}) => operations.push({name, run: () => bag(words, device, args, {mutation: true, ...options})});
    const requiredNumber = (value, name, min, max) => {
      if (value === undefined || value === null) throw failure('INVALID_ARGUMENT', `${name} is required`);
      return number(value, name, min, max);
    };
    const enumOf = (value, list, name) => { if (!list.includes(value)) throw failure('INVALID_ARGUMENT', `${name} must be one of ${list.join(', ')}`); return value; };
    if (p.orientation !== undefined) add('orientation', ['orientation'], [enumOf(p.orientation, Object.keys(G.ROTATION), 'orientation')]);
    if (p.posture !== undefined) {
      const args = typeof p.posture === 'number' ? ['--angle', String(requiredNumber(p.posture, 'posture', 0, 180))] : ['--pose', enumOf(p.posture, ['closed', 'open', 'flat'], 'posture')];
      add('posture', ['hinge'], args, {timeout: 20000});
    }
    if (p.appearance !== undefined) add('appearance', ['interface', 'appearance'], [enumOf(p.appearance, ['light', 'dark'], 'appearance')]);
    if (p.contrast !== undefined) {
      if (typeof p.contrast !== 'boolean') throw failure('INVALID_ARGUMENT', 'contrast must be boolean');
      add('contrast', ['interface', 'contrast'], [p.contrast ? 'enabled' : 'disabled']);
    }
    if (p.text_size !== undefined) {
      add('text_size', ['interface', 'text-size'], [enumOf(p.text_size, ['extra-small', 'small', 'medium', 'large', 'extra-large', 'extra-extra-large', 'extra-extra-extra-large', 'accessibility-medium', 'accessibility-large', 'accessibility-extra-large', 'accessibility-extra-extra-large', 'accessibility-extra-extra-extra-large'], 'text_size')]);
    }
    if (p.network !== undefined) {
      const n = p.network;
      if (n === 'clear') add('network', ['network', 'clear'], []);
      else if (n === 'offline' || n?.offline === true) add('network', ['network', 'set'], ['--offline']);
      else if (typeof n === 'string') add('network', ['network', 'set'], ['--profile', enumOf(n, ['wifi', 'dsl', 'lte', '3g', 'edge', 'very-bad-network', '100-loss'], 'network')]);
      else if (n && typeof n === 'object') {
        const args = [];
        if (n.latency !== undefined) args.push('--latency', String(requiredNumber(n.latency, 'network.latency', 0, 60000)));
        if (n.bandwidth !== undefined) args.push('--bandwidth', String(requiredNumber(n.bandwidth, 'network.bandwidth', 1, 10000000)));
        if (n.loss !== undefined) args.push('--loss', String(requiredNumber(n.loss, 'network.loss', 0, 100)));
        if (!args.length) throw failure('INVALID_ARGUMENT', 'network needs a profile, "offline", "clear" or latency/bandwidth/loss');
        add('network', ['network', 'set'], args);
      } else throw failure('INVALID_ARGUMENT', 'Invalid network');
    }
    if (p.location !== undefined) {
      if (p.location === 'clear') add('location', ['location', 'clear'], []);
      else {
        const lat = requiredNumber(p.location?.lat, 'location.lat', -90, 90), lon = requiredNumber(p.location?.lon, 'location.lon', -180, 180);
        add('location', ['location', 'set'], [`${lat},${lon}`]);
      }
    }
    if (p.status_bar !== undefined) {
      if (p.status_bar === 'clear') add('status_bar', ['status-bar', 'clear'], []);
      else if (p.status_bar === 'clean') add('status_bar', ['status-bar', 'override'], ['--time', '9:41', '--data-network', 'wifi', '--wifi-mode', 'active', '--wifi-bars', '3', '--cellular-mode', 'active', '--cellular-bars', '4', '--battery-state', 'charged', '--battery-level', '100']);
      else throw failure('INVALID_ARGUMENT', 'status_bar must be "clean" or "clear"');
    }
    if (p.privacy !== undefined) {
      const q = p.privacy || {};
      const action = enumOf(q.action, ['grant', 'revoke', 'reset'], 'privacy.action');
      const service = enumOf(q.service, ['all', 'calendar', 'contacts-limited', 'contacts', 'location', 'location-always', 'photos-add', 'photos', 'media-library', 'microphone', 'motion', 'reminders', 'siri', 'camera'], 'privacy.service');
      const args = ['privacy', device.udid, action, service];
      if (q.bundleId !== undefined) { if (typeof q.bundleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(q.bundleId)) throw failure('INVALID_ARGUMENT', 'Invalid privacy.bundleId'); args.push(q.bundleId); }
      else if (action !== 'reset') throw failure('INVALID_ARGUMENT', 'privacy.bundleId is required for grant/revoke');
      operations.push({name: 'privacy', run: () => sim(args, {mutation: true})});
    }
    // Validate the entire request before the first command. Once a command is
    // sent, failures cannot claim that the compound request did nothing.
    for (const operation of operations) {
      try { await operation.run(); applied.push(operation.name); }
      catch (error) { forget(device.udid); error.execution = applied.length ? 'unknown' : (error.execution || 'unknown'); throw error; }
    }
    // Nothing to change: report the current state (what `set_state` would otherwise have to be trusted for).
    if (!applied.length) {
      const screen = await geometry(device, {maxAge: 0}).then(g => g.screen, () => null);
      if (screen) look(device, screen);
      return {udid: device.udid, execution: 'not_executed', current: {...await interfaceState(device), ...(screen ? {orientation: screen.orientation} : {})}, ...(screen ? {screen: viewInfo(screen)} : {})};
    }
    forget(device.udid);
    let screen = null;
    if (applied.includes('orientation') || applied.includes('posture')) {
      await sleep(700);
      try { const turned = (await geometry(device, {maxAge: 0})).screen; look(device, turned); screen = viewInfo(turned); } catch {}
    }
    const read = applied.some(k => ['appearance', 'contrast', 'text_size'].includes(k)) ? await interfaceState(device) : null;
    return {udid: device.udid, execution: 'executed', applied, ...(read ? {current: read} : {}), ...(screen ? {screen} : {}),
      ...(applied.includes('network') ? {note: 'Network conditioning reaches apps launched after this call; relaunch the App (app action=launch) if it was already running.'}
        : read ? {note: 'The device changed; an App that reads appearance or text size only at launch shows it after a relaunch (app action=launch). Check with a screenshot.'} : {})};
  }

  // Appearance, Increase Contrast and Dynamic Type as the device reports them now.
  async function interfaceState(device) {
    const read = async what => { try { return (await bag(['interface', what], device, [], {timeout: 10000})).stdout.trim().split('\n').pop().trim() || null; } catch { return null; } };
    const [appearance, contrast, textSize] = await Promise.all([read('appearance'), read('contrast'), read('text-size')]);
    return {appearance, contrast, text_size: textSize};
  }

  // ---- logs and crashes ----
  async function executableOf(device, bundleId) {
    const container = (await sim(['get_app_container', device.udid, bundleId, 'app'], {timeout: 10000})).stdout;
    return (await run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(container, 'Info.plist')], {timeout: 5000})).stdout;
  }

  // Both history and live waits keep an explicit app/process scope or fail;
  // lookup/validation failure must never widen it to the entire device.
  async function logProcess(device, p) {
    const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
    if (p.process !== undefined && !valid(p.process)) throw failure('INVALID_ARGUMENT', 'process must be 1–100 characters without control characters');
    if (p.bundleId !== undefined && (typeof p.bundleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(p.bundleId))) throw failure('INVALID_ARGUMENT', 'Invalid bundleId');
    if (p.process !== undefined) return p.process;
    if (p.bundleId === undefined) return null;
    const name = await executableOf(device, p.bundleId).catch(() => { throw failure('APP_NOT_INSTALLED', `Could not resolve ${p.bundleId} on this device. Check app action=info before reading logs.`); });
    if (!valid(name)) throw failure('LOGS_UNAVAILABLE', 'The App executable name could not be read; log scope was not widened.');
    return name;
  }

  async function logs(device, p) {
    const last = number(p.last_seconds, 'last_seconds', 5, 3600, 120), limit = number(p.limit, 'limit', 1, 1000, 150);
    let pattern = null;
    if (p.match !== undefined) { try { pattern = new RegExp(p.match, 'i'); } catch { throw failure('INVALID_ARGUMENT', 'match must be a valid regular expression'); } }
    const processName = await logProcess(device, p);
    const level = ['error', 'default', 'info', 'debug'].includes(p.level) ? p.level : 'default';
    const args = ['spawn', device.udid, 'log', 'show', '--last', `${last}s`, '--style', 'ndjson'];
    if (level === 'info' || level === 'debug') args.push('--info');
    if (level === 'debug') args.push('--debug');
    const clauses = [];
    if (processName) clauses.push(`process == ${JSON.stringify(processName)}`);
    if (level === 'error') clauses.push('(messageType == error OR messageType == fault)');
    if (clauses.length) args.push('--predicate', clauses.join(' AND '));
    const out = await sim(args, {timeout: 60000, maxBuffer: 64 * 1024 * 1024}).catch(error => { throw failure('LOGS_UNAVAILABLE', error.message); });
    const lines = [];
    for (const line of out.stdout.split('\n')) {
      const shown = matchingLogLine(line, pattern);
      if (shown !== null) lines.push(shown);
    }
    const result = {udid: device.udid, ...(processName ? {process: processName} : {}), level, lastSeconds: last, total: lines.length, lines: lines.slice(-limit), truncated: lines.length > limit};
    if (p.crashes !== false) result.crashes = await crashReports(device, processName, Math.max(last, 3600)).catch(() => []);
    return result;
  }

  async function crashReports(device, processName, withinSeconds) {
    const dir = path.join(require('node:os').homedir(), 'Library/Logs/DiagnosticReports');
    const cutoff = now() - withinSeconds * 1000, reports = [];
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith('.ips')) continue;
      const file = path.join(dir, name), stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.mtimeMs < cutoff || stat.size > 8 * 1024 * 1024) continue;
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      if (!text.includes(device.udid)) continue;
      const newline = text.indexOf('\n');
      let header = {}, body = {};
      try { header = JSON.parse(text.slice(0, newline)); body = JSON.parse(text.slice(newline + 1)); } catch { continue; }
      if ([header, body].some(part => !part || typeof part !== 'object' || Array.isArray(part))) continue;
      const process = body.procName || header.app_name;
      if (processName && process !== processName) continue;
      const thread = (body.threads || [])[body.faultingThread ?? -1] || (body.threads || []).find(t => t.triggered);
      const images = body.usedImages || [];
      reports.push({file, time: header.timestamp || new Date(stat.mtimeMs).toISOString(), process,
        exception: body.exception ? [body.exception.type, body.exception.signal, body.exception.subtype].filter(Boolean).join(' ') : undefined,
        reason: body.termination?.indicator || body.termination?.reasons?.join('; ') || undefined,
        frames: (thread?.frames || []).slice(0, 14).map(f => `${images[f.imageIndex]?.name || '?'} ${f.symbol || ''}${f.symbolLocation !== undefined ? `+${f.symbolLocation}` : ''}`.trim())});
    }
    return reports.sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 5);
  }

  return {observe, geometry, forget, forgetTree, describe, readText, screenshot, tap, gesture, waitFor, settle, capture, setState, logs, executableOf, typeText, pasteByTouch, hasAccessibility, after};
}

const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);
const round = n => Math.round(n * 10) / 10;
function directionVector(direction, view, distance) {
  // `up` moves the finger up (content scrolls toward the end), as on a phone.
  const d = distance ?? (direction === 'left' || direction === 'right' ? view.width * 0.6 : view.height * 0.45);
  const cx = view.width / 2, cy = view.height / 2;
  switch (direction) {
    case 'up': return {from: [cx, cy + d / 2], dx: 0, dy: -d};
    case 'down': return {from: [cx, cy - d / 2], dx: 0, dy: d};
    case 'left': return {from: [cx + d / 2, cy], dx: -d, dy: 0};
    case 'right': return {from: [cx - d / 2, cy], dx: d, dy: 0};
    default: throw Object.assign(new Error('direction must be up, down, left or right'), {code: 'INVALID_ARGUMENT'});
  }
}
// Metro and other tools colour their messages; control characters are not text.
const plain = text => String(text).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const logMessage = entry => entry.eventMessage || entry.composedMessage || '';
// Match the complete normalized line; only the returned display is shortened.
function matchingLogLine(raw, pattern) {
  let entry;
  try { entry = JSON.parse(raw); } catch { return null; }
  if (!entry || typeof entry !== 'object' || !logMessage(entry)) return null;
  if (pattern && !pattern.test(formatLog(entry, Infinity))) return null;
  return formatLog(entry);
}
function formatLog(entry, messageLimit = 600) {
  const time = (entry.timestamp || '').replace(/^.*?(\d\d:\d\d:\d\d\.\d{3}).*$/, '$1');
  const type = entry.messageType && entry.messageType !== 'Default' ? `[${entry.messageType.toLowerCase()}] ` : '';
  const where = [entry.subsystem, entry.category].filter(Boolean).join('/');
  const message = plain(logMessage(entry)).replace(/\s+/g, ' ').slice(0, messageLimit);
  return `${time} ${type}${where ? where + ': ' : ''}${message}`;
}

module.exports = {createAgent, directionVector, formatLog};
