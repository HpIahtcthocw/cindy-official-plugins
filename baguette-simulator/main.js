cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'tool-call') return;
  try {
    let locale='en';
    try { const context=await cindy.request({kind:'app-context'}); if(context?.context?.locale==='zh-CN')locale='zh-CN'; } catch {}
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
      try {
        const opened=await cindy.preview({url:viewer.url,sessionId:msg.args?.session_context?.session_id});
        viewer.previewOpened=opened.ok===true;
        viewer.location='Cindy 侧边栏浏览器';
        if(!opened.ok) viewer.previewError=opened.message || opened.errorCode || 'Preview did not open';
      } catch(error) {viewer.previewOpened=false;viewer.previewError=String(error.message || error);}
    }
    await cindy.send(result.ok ? {type:'tool-result',callId:msg.callId,ok:true,result:result} : {type:'tool-result',callId:msg.callId,ok:false,errorCode:result.errorCode,message:result.message+' (execution: '+result.execution+')'});
  } catch (error) {
    await cindy.send({type:'tool-result',callId:msg.callId,ok:false,errorCode:'BRIDGE_FAILED',message:String(error.message || error)+'; execution unknown, inspect before retrying.'});
  }
});

// The settings page is same-origin with the logic page. It exposes only
// explicit device controls, never a generic Node method or shell command.
if (typeof BroadcastChannel !== 'undefined') {
  const settings = new BroadcastChannel('baguette-settings');
  settings.onmessage = async ({data: msg}) => {
    const methods = {status:'settings_status',save:'settings_save',shutdown:'settings_shutdown',stopAll:'settings_stop_all',boot:'settings_boot',viewer:'settings_viewer'};
    if (msg?.type !== 'request' || typeof msg.id !== 'string' || !Object.hasOwn(methods,msg.action)) return;
    let result;
    try {
      let locale = 'en';
      try { if ((await cindy.request({kind:'app-context'}))?.context?.locale === 'zh-CN') locale = 'zh-CN'; } catch {}
      const params = msg.action === 'save' ? {enabled:msg.enabled,idleMinutes:msg.idleMinutes}
        : {udid:msg.udid,_locale:locale};
      const response = await cindy.node.request({method:methods[msg.action],params,timeoutMs:120000});
      result = response.ok ? {...response.result,ok:response.result?.ok !== false}
        : {ok:false,errorCode:'NODE_UNAVAILABLE',execution:'unknown'};
      if (msg.action === 'viewer' && result.ok && result.url) {
        const opened = await cindy.preview({url:result.url});
        result.previewOpened = opened.ok === true;
        if (!opened.ok) result = {ok:false,errorCode:opened.errorCode === 'HOST_NOT_READY' ? 'PREVIEW_NEEDS_SESSION' : 'PREVIEW_FAILED',execution:'executed'};
      }
    } catch { result = {ok:false,errorCode:'SETTINGS_UNAVAILABLE',execution:'unknown'}; }
    settings.postMessage({type:'response',id:msg.id,result});
  };
}
