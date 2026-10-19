'use strict';
const http=require('node:http');const fs=require('node:fs');const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'control.html'));
const chineseHtml=fs.readFileSync(path.join(__dirname,'control.zh-CN.html'));
// Baguette 0.2.7 Defaults routes read/rewrite any app's UserDefaults and relaunch with
// an injected dylib; they ignore the private device set, so they stay unavailable.
const BLOCKED_ROUTE=/^\/simulators\/[^/]+\/(?:defaults(?:\.json)?|defaults-groups\.json|apps\.json|relaunch)\/?$/i;
function blockedRoute(url){
 try{return BLOCKED_ROUTE.test(decodeURIComponent(String(url).split(/[?#]/,1)[0]).replace(/\/{2,}/g,'/'));}catch{return true;}
}
// Cindy draws the controller chrome; the device page only renders the screen.
// Injected into the page HTML before its scripts run, so the 3D stage reads the
// matching background at attach time. `?cindyFull=1` keeps the upstream workbench.
const STAGE_STYLE='<style id="cindy-stage-style">'+[
 '.preview-banner,#nativeRightRails,.handheld-ui,.handheld-hint,#nativeHandheldUI,#nativeHandheldHint{display:none!important}',
 'html:not([data-cindy-full]) .top-bar,html:not([data-cindy-full]) #nativeSidebarViewToggle,html:not([data-cindy-full]) #nativeThemeToggle,html:not([data-cindy-full]) #nativeStatus{display:none!important}',
 'html,body{background:transparent!important}',
 '@media (prefers-color-scheme:light){#simNativeView{--nv-page-bg:#f8f8f6!important}}',
 '@media (prefers-color-scheme:dark){#simNativeView{--nv-page-bg:#1f1f1e!important}}',
 '#simNativeView[data-handheld] #nativeDeviceFrame{background:transparent!important}',
 '#simNativeView[data-handheld] #nativeDeviceFrame>div>div:first-child{border-radius:var(--cindy-screen-radius,0)!important}',
 '#simNativeView[data-handheld] #nativeDeviceFrame>div{outline:1px solid rgba(0,0,0,.08);outline-offset:-1px;border-radius:var(--cindy-screen-radius,0)}',
].join('\n')+'</style>';
const DEVICE_PAGE=/^\/simulators\/[^/?#]+\/?(?:[?#]|$)/;
function stagedPage(url){
 if(!DEVICE_PAGE.test(url))return false;
 try{return new URL(url,'http://localhost').searchParams.get('cindyFull')!=='1';}catch{return false;}
}
// The panel is not an HTTP origin, so this frame holds no capability cookie; it
// carries the capability in its own URL and hands it to the stream socket here.
function authScript(token){
 return token?`<script src="/viewer-auth.js?cindyViewer=${encodeURIComponent(token)}"></script>`:'';
}
function injectStage(html,token){
 const inject=STAGE_STYLE+authScript(token);
 const at=html.search(/<\/head>/i);
 if(at>=0)return html.slice(0,at)+inject+html.slice(at);
 const open=html.search(/<head[^>]*>/i);
 if(open>=0){const end=html.indexOf('>',open)+1;return html.slice(0,end)+inject+html.slice(end);}
 return inject+html;
}
function proxyRequest(req,res,port,token){
 if(blockedRoute(req.url)){res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify({error:'Not available in Cindy'}));}
 const forwarded={...req.headers};delete forwarded.cookie;delete forwarded['x-cindy-clipboard'];
 const staging=req.method==='GET'&&stagedPage(req.url);
 if(staging)delete forwarded['accept-encoding'];
 const upstream=http.request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:{...forwarded,host:`127.0.0.1:${port}`,origin:`http://127.0.0.1:${port}`}},response=>{
  const headers={...response.headers};delete headers['x-frame-options'];
  // Only our controller (same origin) under this plugin's Cindy panel page may embed the native page.
  headers['content-security-policy']=((headers['content-security-policy']||'').replace(/frame-ancestors[^;]*(;|$)/gi,'')+"; frame-ancestors 'self' cindy-ghost://baguette-simulator").replace(/^;\s*/,'');
  const html=staging&&response.statusCode===200&&/text\/html/i.test(headers['content-type']||'')&&!headers['content-encoding'];
  if(!html){res.writeHead(response.statusCode,headers);return response.pipe(res);}
  const chunks=[];
  response.on('data',chunk=>chunks.push(chunk));
  response.on('end',()=>{
   const body=Buffer.from(injectStage(Buffer.concat(chunks).toString('utf8'),token),'utf8');
   delete headers['content-length'];delete headers['transfer-encoding'];
   // Same-origin requests from this page must keep the capability in Referer;
   // nothing is ever sent to another origin.
   res.writeHead(200,{...headers,'referrer-policy':'same-origin','content-length':String(body.length)});res.end(body);
  });
 });
 upstream.on('error',()=>{if(!res.headersSent){res.writeHead(503,{'Content-Type':'text/html; charset=utf-8'});res.end('<p data-viewer-unavailable>画面连接中断，请点击上方“恢复画面”。</p>');}else res.destroy();});
 upstream.setTimeout(15000,()=>upstream.destroy());req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
}
// `clients` holds the live browser-side stream sockets: an open viewer window.
function attachUpgrade(server,port,sockets,authorized=()=>false,clients=new Set()){
 server.on('upgrade',(req,socket,head)=>{
  const own=`127.0.0.1:${server.address().port}`;
  if(!authorized(req)||req.headers.host!==own||req.headers.origin!==`http://${own}`||typeof req.headers['sec-websocket-key']!=='string'){socket.destroy();return;}
  // Native HTTP/1 upgrade requires a fresh connection, never a pooled HTTP socket.
  const request=http.request({agent:false,hostname:'127.0.0.1',port,path:req.url,headers:{host:`127.0.0.1:${port}`,connection:'upgrade',upgrade:'websocket','sec-websocket-key':req.headers['sec-websocket-key'],'sec-websocket-version':'13','sec-fetch-mode':'websocket'}});
  request.on('upgrade',(response,upstream,upHead)=>{
   sockets.add(upstream);sockets.add(socket);clients.add(socket);
   socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');
   if(head.length)upstream.write(head);if(upHead.length)socket.write(upHead);
   socket.pipe(upstream);upstream.pipe(socket);
   // WebSocket traffic includes automatic pong and stream negotiation.
   // The controller reports trusted pointer/key/wheel input separately;
   // network traffic alone must never postpone idle shutdown.
   for(const [a,b] of [[socket,upstream],[upstream,socket]]){a.on('error',()=>b.destroy());a.on('close',()=>{sockets.delete(a);clients.delete(a);b.destroy();});}
   // A tab that is closed or crashes may half-close without a WebSocket close
   // frame; the server side would stay open and count as a viewer forever.
   socket.once('end',()=>socket.destroy());
  });
  request.on('response',()=>socket.destroy());request.on('error',()=>socket.destroy());socket.on('error',()=>request.destroy());socket.on('close',()=>request.destroy());request.end();
 });
}
module.exports={html,chineseHtml,blockedRoute,stagedPage,injectStage,STAGE_STYLE,authScript,proxyRequest,attachUpgrade};
