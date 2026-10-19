// Chip logic page. Agent tools go to the Node worker; the live controller URL is
// handed to the docked panel (panel.html) over a BroadcastChannel instead of the
// sidebar browser, so the simulator shows without browser chrome.
async function hostLocale() {
  try { const context = await cindy.request({kind:'app-context'}); if (context?.context?.locale === 'zh-CN') return 'zh-CN'; } catch {}
  return 'en';
}

const panel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('baguette-panel') : null;
// Push the controller URL to the panel and wait for its acknowledgement. A
// minimized or unmounted panel does not answer; callers report that truthfully.
function showInPanel(url, udid) {
  if (!panel) return Promise.resolve(false);
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const done = (shown) => { clearTimeout(timer); panel.removeEventListener('message', onMessage); resolve(shown); };
    const onMessage = ({data}) => { if (data?.type === 'viewer-ack' && data.id === id) done(true); };
    const timer = setTimeout(() => done(false), 1500);
    panel.addEventListener('message', onMessage);
    panel.postMessage({type:'viewer', id, url, udid});
  });
}
const PANEL_CLOSED_NOTE = {
  'zh-CN': '面板未打开：请在 Cindy 左侧展开「iOS 模拟器」面板（最小化时点击悬浮气泡）后再调用 open_viewer。',
  en: 'Panel not open: expand the "iOS Simulator" panel on the left of Cindy (or click its bubble when minimized), then call open_viewer again.',
};

cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'tool-call') return;
  try {
    const locale = await hostLocale();
    // Host ceiling is 120s; worker preflight is 3s + 5s.
    // Boot retains 15s start + 90s readiness (113s total).
    const response = await cindy.node.request({method: msg.tool, params: {...msg.args,_locale:locale}, timeoutMs: 120000});
    if (!response.ok) {
      await cindy.send({type:'tool-result',callId:msg.callId,ok:false,errorCode:'NODE_REQUEST_FAILED',message:response.message || 'Worker failed; execution may be unknown. Inspect device before retrying.'});
      return;
    }
    const result=response.result;
    const viewer=result.viewer || (msg.tool==='open_viewer' ? result : null);
    if(result.ok && viewer && viewer.ready && viewer.url) {
      const shown = await showInPanel(viewer.url, msg.args?.udid);
      viewer.previewOpened = shown;
      viewer.location = shown ? 'Cindy 停靠面板「iOS 模拟器」' : null;
      if (!shown) viewer.previewError = PANEL_CLOSED_NOTE[locale] || PANEL_CLOSED_NOTE.en;
    }
    await cindy.send(result.ok ? {type:'tool-result',callId:msg.callId,ok:true,result:result} : {type:'tool-result',callId:msg.callId,ok:false,errorCode:result.errorCode,message:result.message+' (execution: '+result.execution+')'});
  } catch (error) {
    await cindy.send({type:'tool-result',callId:msg.callId,ok:false,errorCode:'BRIDGE_FAILED',message:String(error.message || error)+'; execution unknown, inspect before retrying.'});
  }
});

// Settings page and panel are same-origin with this page. Each exposes only
// explicit device controls, never a generic Node method or shell command.
const METHODS = {
  status:'settings_status', save:'settings_save', shutdown:'settings_shutdown', stopAll:'settings_stop_all',
  boot:'settings_boot', viewer:'settings_viewer', catalog:'viewer_catalog', create:'create_device', current:'viewer_current',
};
function serve(channel, allowed) {
  if (!channel) return;
  channel.onmessage = async ({data: msg}) => {
    if (msg?.type !== 'request' || typeof msg.id !== 'string' || !allowed.includes(msg.action) || !Object.hasOwn(METHODS, msg.action)) return;
    let result;
    try {
      const locale = await hostLocale();
      const params = msg.action === 'save' ? {enabled:msg.enabled,idleMinutes:msg.idleMinutes}
        : msg.action === 'create' ? {name:msg.name,deviceType:msg.deviceType,runtime:msg.runtime}
        : {udid:msg.udid,_locale:locale};
      const response = await cindy.node.request({method:METHODS[msg.action],params,timeoutMs:120000});
      result = response.ok ? {...response.result,ok:response.result?.ok !== false}
        : {ok:false,errorCode:'NODE_UNAVAILABLE',execution:'unknown'};
      if (msg.action === 'viewer' && result.ok && result.url) {
        const shown = channel === panel ? true : await showInPanel(result.url, msg.udid);
        result.previewOpened = shown;
        if (!shown) result = {ok:false,errorCode:'PANEL_CLOSED',execution:'executed',url:result.url};
      }
    } catch { result = {ok:false,errorCode:'SETTINGS_UNAVAILABLE',execution:'unknown'}; }
    channel.postMessage({type:'response',id:msg.id,result});
  };
}
serve(typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('baguette-settings') : null, ['status','save','shutdown','stopAll','boot','viewer','catalog','create']);
serve(panel, ['current','boot','viewer','shutdown','catalog','create']);
