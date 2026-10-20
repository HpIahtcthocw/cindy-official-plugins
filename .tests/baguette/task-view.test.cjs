const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createTaskBindings}=require('../../baguette-simulator/node/tasks.cjs');
const {createRuntime}=require('../../baguette-simulator/node/runtime.cjs');
const A='00000000-0000-4000-8000-00000000000A',B='00000000-0000-4000-8000-00000000000B';
const tmp=async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'baguette-task-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;};

test('task bindings persist, count tasks per device, and ignore malformed ids',async t=>{
 const file=path.join(await tmp(t),'task-bindings.json');
 const store=createTaskBindings(file);
 await Promise.all([store.bind('task-1',A),store.bind('task-2',A),store.bind('task-3',B)]);
 assert.equal(await store.bind('../x',A),false);assert.equal(await store.bind('task-4','not-a-udid'),false);
 const reloaded=createTaskBindings(file);
 assert.equal((await reloaded.get('task-1')).udid,A);assert.deepEqual(await reloaded.counts(),{[A]:2,[B]:1});
 assert.equal((await fs.stat(file)).mode&0o777,0o600);
});

async function runtimeFixture(t,{viewerUrl=null}={}){
 const dir=await tmp(t);const tasks=createTaskBindings(path.join(dir,'b.json'));const calls=[];
 const states={[A]:'Shutdown',[B]:'Booted'};
 const runtime=createRuntime({settingsFile:path.join(dir,'s.json'),tasks,existingViewerUrl:()=>viewerUrl,
  dispatch:async(method,p={})=>{calls.push(method);
   if(method==='devices')return {devices:[{udid:A,name:'Alpha',state:states[A]},{udid:B,name:'Beta',state:states[B]}]};
   if(method==='boot'){states[p.udid]='Booted';return {ok:true,execution:'executed'};}
   if(method==='open_viewer')return {ok:true,ready:true,url:`http://127.0.0.1:9/control?udid=${p.udid}&lang=en#cindyClipboard=9.t`};
   return {ok:true};}});
 return {runtime,tasks,calls,states};
}

test('starting a device from a task assigns it, and devices tell each task what is free',async t=>{
 const f=await runtimeFixture(t);
 await f.runtime.request('boot',{udid:A,session_context:{session_id:'task-1'}});
 const seen=await f.runtime.request('devices',{session_context:{session_id:'task-1'}});
 assert.deepEqual(seen.devices.map(d=>[d.name,d.tasks,d.thisTask]),[['Alpha',1,true],['Beta',0,false]]);
 const other=await f.runtime.request('devices',{session_context:{session_id:'task-2'}});
 assert.deepEqual(other.devices.map(d=>d.thisTask),[false,false]);
 // A failed start does not move the task.
 const failing=await runtimeFixture(t);
 await failing.tasks.bind('task-9',B);
 await assert.rejects(createRuntime({settingsFile:path.join(await tmp(t),'s.json'),tasks:failing.tasks,dispatch:async m=>{if(m==='boot')throw Object.assign(Error('boot failed'),{code:'BOOT_FAILED'});return {devices:[]};}}).request('boot',{udid:A,session_context:{session_id:'task-9'}}));
 assert.equal((await failing.tasks.get('task-9')).udid,B);
});

test('the task page state reuses a running viewer without the runtime lock and names the task in the address',async t=>{
 const f=await runtimeFixture(t,{viewerUrl:'http://127.0.0.1:9/control?udid=B&lang=en#cindyClipboard=9.t'});
 await f.tasks.bind('task-1',B);
 const state=await f.runtime.request('task_state',{_task:'task-1'});
 assert.equal(state.device.name,'Beta');assert.equal(state.viewer.url,'http://127.0.0.1:9/control?udid=B&lang=en&task=task-1#cindyClipboard=9.t');
 assert.ok(!f.calls.includes('open_viewer'),'no lock taken when the viewer already runs');
 const none=await f.runtime.request('task_state',{_task:'task-2'});
 assert.equal(none.device,null);assert.equal(none.viewer,null);
 await assert.rejects(f.runtime.request('task_bind',{_task:'task-2',udid:'00000000-0000-4000-8000-0000000000FF'}),e=>e.code==='INVALID_ARGUMENT');
 await assert.rejects(f.runtime.request('task_state',{_task:'../x'}),e=>e.code==='INVALID_ARGUMENT');
});

function logicPage({taskView,preview=async()=>({ok:true})}={}){
 const code=require('node:fs').readFileSync('baguette-simulator/main.js','utf8');
 const buses=new Map();
 class BroadcastChannel{constructor(n){this.name=n;this.onmessage=null;(buses.get(n)||buses.set(n,new Set()).get(n)).add(this);}postMessage(data){for(const p of buses.get(this.name))if(p!==this)queueMicrotask(()=>p.onmessage?.({data}));}}
 let handler;const sent=[],previews=[],views=[],calls=[];
 const cindy={onHostMessage:fn=>handler=fn,request:async()=>({ok:true,context:{locale:'en'}}),send:async p=>sent.push(p),
  preview:async p=>{previews.push(p);return preview(p);},
  node:{request:async r=>{calls.push(r);if(r.method==='device_hold')return {ok:true,result:{running:false}};
   if(r.method==='task_state')return {ok:true,result:{ok:true,sessionId:r.params._task,device:null,devices:[],viewer:null}};
   return {ok:true,result:{ok:true,ready:true,url:'http://127.0.0.1:9/control?udid=A&lang=en#cindyClipboard=9.t'}};}}};
 if(taskView)cindy.taskView=async r=>{views.push(r);return taskView(r);};
 vm.runInNewContext(code,{cindy,BroadcastChannel,Object,String,Promise,Set,RegExp,queueMicrotask,setTimeout});
 const page=new BroadcastChannel('baguette-pages');const pushed=[],replies=[];
 page.onmessage=({data})=>{if(data.type==='viewer')pushed.push(data);if(data.type==='response')replies.push(data);};
 return {call:args=>handler({type:'tool-call',tool:'open_viewer',callId:'c',args}),sent,previews,views,calls,page,pushed,replies};
}
const settle=()=>new Promise(r=>setTimeout(r,10));

test('a host with task pages shows the live view in the calling task, not the browser',async()=>{
 const r=logicPage({taskView:async req=>({ok:true,sessionId:req.sessionId})});
 await r.call({udid:'A',session_context:{session_id:'task-1'}});await settle();
 assert.deepEqual(JSON.parse(JSON.stringify(r.views)),[{sessionId:'task-1'}]);assert.equal(r.previews.length,0);
 assert.equal(r.sent[0].result.previewOpened,true);assert.match(r.sent[0].result.location,/task sidebar/);
 assert.deepEqual(JSON.parse(JSON.stringify(r.pushed)),[{type:'viewer',sessionId:'task-1',udid:'A',url:'http://127.0.0.1:9/control?udid=A&lang=en&task=task-1#cindyClipboard=9.t'}]);
});

test('older hosts, and an install without a task page, fall back to the sidebar browser',async()=>{
 const old=logicPage();await old.call({udid:'A',session_context:{session_id:'task-1'}});await settle();
 assert.equal(old.previews.length,1);assert.equal(old.sent[0].result.previewOpened,true);
 const denied=logicPage({taskView:async()=>({ok:false,errorCode:'PERMISSION_DENIED'})});await denied.call({udid:'A',session_context:{session_id:'task-1'}});await settle();
 assert.equal(denied.previews.length,1);
 const noTask=logicPage({taskView:async()=>({ok:false,errorCode:'HOST_NOT_READY',message:'no task'})});await noTask.call({udid:'A'});await settle();
 assert.equal(noTask.previews.length,0);assert.equal(noTask.sent[0].result.previewOpened,false);
});

test('pages reach only the listed actions, scoped to their own task',async()=>{
 const r=logicPage({taskView:async()=>({ok:true,sessionId:'front'})});
 r.page.postMessage({type:'request',id:'1',action:'task_state',sessionId:'task-1'});
 r.page.postMessage({type:'request',id:'2',action:'settings_save',enabled:false});
 r.page.postMessage({type:'request',id:'3',action:'task_state',sessionId:'../x'});
 r.page.postMessage({type:'request',id:'4',action:'environment'});
 await settle();await settle();
 assert.deepEqual(r.replies.map(x=>x.id).sort(),['1','3']);
 assert.equal(r.replies.find(x=>x.id==='3').result.errorCode,'INVALID_ARGUMENT');
 assert.deepEqual(r.calls.filter(c=>c.method!=='device_hold').map(c=>[c.method,c.params._task]),[['task_state','task-1']]);
});
