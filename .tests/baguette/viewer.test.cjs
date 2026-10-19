const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const code=fs.readFileSync('baguette-simulator/main.js','utf8');
// One in-memory bus per channel name, like the browser's same-origin BroadcastChannel.
function fakeChannels(){
 const buses=new Map();
 class BroadcastChannel{
  constructor(name){this.name=name;this.listeners=new Set();this.onmessage=null;(buses.get(name)||buses.set(name,new Set()).get(name)).add(this);}
  postMessage(data){for(const peer of buses.get(this.name)){if(peer===this)continue;const event={data};queueMicrotask(()=>{peer.onmessage?.(event);for(const fn of peer.listeners)fn(event);});}}
  addEventListener(_n,fn){this.listeners.add(fn);}removeEventListener(_n,fn){this.listeners.delete(fn);}
 }
 return BroadcastChannel;
}
function load({workerResult,panel}){
 const BroadcastChannel=fakeChannels();let handler;const sent=[],previews=[],nodeCalls=[];
 vm.runInNewContext(code,{BroadcastChannel,crypto,setTimeout,clearTimeout,Object,String,Promise,cindy:{onHostMessage:fn=>handler=fn,request:async()=>({ok:true,context:{locale:'zh-CN'}}),node:{request:async r=>{nodeCalls.push(r);return typeof workerResult==='function'?workerResult(r):{ok:true,result:workerResult};}},preview:async p=>{previews.push(p);return {ok:true};},send:async p=>sent.push(p)}});
 const side=new BroadcastChannel('baguette-panel');const seen=[];
 side.onmessage=({data})=>{seen.push(data);if(data.type==='viewer'&&panel)side.postMessage({type:'viewer-ack',id:data.id});};
 return {handler,sent,previews,nodeCalls,seen,BroadcastChannel};
}
const call=(h,tool,args={})=>h({type:'tool-call',tool,callId:'call',args:{...args,session_context:{session_id:'test-session'}}});
const settle=()=>new Promise(r=>setTimeout(r,0));

test('open_viewer hands the controller URL to the docked panel and reports it shown when the panel answers',async()=>{
 const r=load({workerResult:{ok:true,ready:true,url:'http://127.0.0.1:1234/control?udid=x'},panel:true});
 await call(r.handler,'open_viewer',{udid:'x'});await settle();
 assert.equal(r.previews.length,0,'the sidebar browser is no longer used');
 assert.deepEqual(r.seen.map(m=>[m.type,m.url,m.udid]),[['viewer','http://127.0.0.1:1234/control?udid=x','x']]);
 assert.equal(r.sent[0].result.previewOpened,true);assert.match(r.sent[0].result.location,/面板/);
});

test('launch_app with a viewer behaves the same; a background launch never touches the panel',async()=>{
 const shown=load({workerResult:{ok:true,execution:'executed',viewer:{ready:true,url:'http://127.0.0.1:1234/control?udid=x'}},panel:true});
 await call(shown.handler,'launch_app',{udid:'x',bundleId:'a.b'});await settle();
 assert.equal(shown.sent[0].result.viewer.previewOpened,true);assert.equal(shown.seen.length,1);
 const quiet=load({workerResult:{ok:true,execution:'executed'},panel:true});
 await call(quiet.handler,'launch_app',{udid:'x',bundleId:'a.b',showViewer:false});await settle();
 assert.equal(quiet.seen.length,0);assert.equal(quiet.sent[0].result.execution,'executed');
});

test('a panel that does not answer keeps the launch success and says the view is not shown',async()=>{
 const r=load({workerResult:{ok:true,execution:'executed',viewer:{ready:true,url:'http://127.0.0.1:1234/control?udid=x'}},panel:false});
 await call(r.handler,'launch_app',{udid:'x',bundleId:'a.b'});
 assert.equal(r.sent[0].ok,true);assert.equal(r.sent[0].result.execution,'executed');
 assert.equal(r.sent[0].result.viewer.previewOpened,false);assert.match(r.sent[0].result.viewer.previewError,/面板未打开/);
});

test('the panel channel serves read-only state and device actions, but not settings writes',async()=>{
 const r=load({workerResult:req=>({ok:true,result:req.method==='viewer_current'?{ok:true,devices:[],settings:{enabled:true},viewer:null}:{ok:true,url:'http://127.0.0.1:1234/control?udid=x'}}),panel:true});
 const client=new r.BroadcastChannel('baguette-panel');const replies=[];client.onmessage=({data})=>{if(data.type==='response')replies.push(data);};
 client.postMessage({type:'request',id:'r1',action:'current'});
 client.postMessage({type:'request',id:'r2',action:'viewer',udid:'x'});
 client.postMessage({type:'request',id:'r3',action:'save',enabled:false,idleMinutes:15});
 await new Promise(res=>setTimeout(res,30));
 assert.deepEqual(replies.map(x=>x.id).sort(),['r1','r2']);
 assert.equal(replies.find(x=>x.id==='r1').result.viewer,null);
 assert.equal(replies.find(x=>x.id==='r2').result.previewOpened,true);
 assert.deepEqual(r.nodeCalls.map(c=>c.method),['viewer_current','settings_viewer']);
});
