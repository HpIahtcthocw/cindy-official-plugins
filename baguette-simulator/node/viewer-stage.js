'use strict';
// Injected into the embedded device page before its scripts run. The 3D stage
// bakes the page background into its stream when it attaches and only changes
// it from the workbench theme button, which Cindy hides. A nested frame can
// attach before Cindy's light/dark mode reaches it, so the stage would keep the
// wrong backdrop; re-send the page background whenever the mode changes.
(function () {
  const panels = new Set();
  function background() {
    const root = document.getElementById('simNativeView');
    const value = root ? getComputedStyle(root).getPropertyValue('--nv-page-bg').trim() : '';
    return /^#[0-9a-f]{6}$/i.test(value) ? value : null;
  }
  function sync() {
    const value = background();
    if (!value) return;
    for (const panel of panels) {
      try { panel.setBackground(value); } catch { /* a stale panel must not stop the others */ }
    }
  }
  function track(Panel) {
    if (typeof Panel !== 'function' || !Panel.prototype || Panel.prototype.cindyStageTracked) return;
    const { attach, detach } = Panel.prototype;
    if (typeof attach !== 'function' || typeof Panel.prototype.setBackground !== 'function') return;
    Panel.prototype.attach = function (...args) {
      panels.add(this);
      const result = attach.apply(this, args);
      Promise.resolve(result).then(sync, () => {});
      return result;
    };
    if (typeof detach === 'function') {
      Panel.prototype.detach = function (...args) {
        panels.delete(this);
        return detach.apply(this, args);
      };
    }
    Object.defineProperty(Panel.prototype, 'cindyStageTracked', { value: true });
  }
  let current = window.Sim3DPanel;
  track(current);
  try {
    Object.defineProperty(window, 'Sim3DPanel', {
      configurable: true,
      enumerable: true,
      get() { return current; },
      set(value) { current = value; track(value); },
    });
  } catch { /* already locked by the page; the stage just keeps its first backdrop */ }
  const scheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (scheme && typeof scheme.addEventListener === 'function') scheme.addEventListener('change', sync);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
})();
