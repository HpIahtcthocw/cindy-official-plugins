const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createRuntime}=require('../../baguette-simulator/node/runtime.cjs');
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'baguette-switch-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const devices=[{udid:a,name:'Duo',state:'Booted',isAvailable:true},{udid:b,name:'Phone',state:'Shutdown',isAvailable:true}],calls=[];
 let failAt,hold,unconfirmed=false;
 const opts={settingsFile:path.join(dir,'settings.json'),dispatch:async(method,p={})=>{
  calls.push({method,...p});if(method==='devices')return {devices:devices.map(d=>({...d}))};
  if(method===failAt)throw Object.assign(Error('Fixture failure'),{code:'FIXTURE_ERROR',execution:'unknown'});
  if(method==='shutdown'){if(hold)await hold;if(!unconfirmed)devices.find(d=>d.udid===p.udid).state='Shutdown';}
  if(method==='boot'){assert.ok(devices.filter(d=>d.udid!==p.udid).every(d=>d.state==='Shutdown'),'old device must be off first');devices.find(d=>d.udid===p.udid).state='Booted';}
  if(method==='app_bundle')return {appPath:'/private-fixture/Test.app'};
  if(method==='open_viewer')return {url:'http://127.0.0.1:1/control?udid='+p.udid};
  return {ok:true};
 }};
 const runtime=createRuntime(opts);
 return {runtime,devices,calls,restart:()=>createRuntime(opts),fail:m=>failAt=m,hold:p=>hold=p,unconfirmed:()=>unconfirmed=true};
}
async function finish(f){for(let i=0;i<100;i++){const job=(await f.runtime.status()).deviceJob;if(job.state!=='running')return job;await new Promise(r=>setTimeout(r,2));}assert.fail('switch did not finish');}
test('switch preserves app context across runtime restart, shuts down before boot, and installs only app bundle',async t=>{
 const f=await fixture(t);await f.runtime.request('launch_app',{udid:a,bundleId:'test.example.app'});f.runtime=f.restart();
 await f.runtime.request('viewer_switch',{udid:a,targetUdid:b});const job=await finish(f);assert.equal(job.state,'done');assert.equal(job.activeUdid,b);
 const mutations=f.calls.filter(c=>!['devices','launch_app'].includes(c.method));assert.deepEqual(mutations.map(c=>c.method),['app_bundle','shutdown','boot','install_app','open_viewer']);
 assert.deepEqual(mutations.find(c=>c.method==='install_app'),{method:'install_app',udid:b,appPath:'/private-fixture/Test.app'});
 assert.equal(await f.restart().currentApp(b),'test.example.app');assert.equal(f.devices[0].state,'Shutdown');
});
test('foreign/unavailable targets and paused runtime never start a switch',async t=>{
 const f=await fixture(t);await assert.rejects(f.runtime.request('viewer_switch',{udid:a,targetUdid:'foreign'}),e=>e.code==='DEVICE_NOT_OWNED');
 f.devices[1].isAvailable=false;await assert.rejects(f.runtime.request('viewer_switch',{udid:a,targetUdid:b}),e=>e.code==='DEVICE_UNAVAILABLE');
 assert.ok(f.calls.every(c=>c.method==='devices'));
 await f.runtime.request('settings_save',{enabled:false,idleMinutes:15});f.calls.length=0;
 await assert.rejects(f.runtime.request('viewer_switch',{udid:a,targetUdid:b}),e=>e.code==='RUNTIME_DISABLED');assert.equal(f.calls.length,0);
});
test('unconfirmed shutdown never boots target, and reports actual source still running',async t=>{
 const f=await fixture(t);f.unconfirmed();await f.runtime.request('viewer_switch',{udid:a,targetUdid:b});const job=await finish(f);
 assert.equal(job.state,'failed');assert.equal(job.execution,'unknown');assert.equal(job.errorCode,'STOP_UNCONFIRMED');assert.equal(job.activeUdid,a);assert.ok(!f.calls.some(c=>c.method==='boot'));
});
test('app installation failure reports target running, never claims successful switch or copies data',async t=>{
 const f=await fixture(t);await f.runtime.request('launch_app',{udid:a,bundleId:'test.example.app'});f.fail('install_app');
 await f.runtime.request('viewer_switch',{udid:a,targetUdid:b});const job=await finish(f);assert.equal(job.state,'failed');assert.equal(job.activeUdid,b);assert.equal(job.execution,'unknown');assert.equal(f.calls.filter(c=>c.method==='launch_app').length,1);
});
test('two concurrent switches cannot interleave; idle shutdown cannot interrupt the reserved operation',async t=>{
 const f=await fixture(t);let release;f.hold(new Promise(r=>release=r));
 const results=await Promise.allSettled([f.runtime.request('viewer_switch',{udid:a,targetUdid:b}),f.runtime.request('viewer_switch',{udid:a,targetUdid:b})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'BUSY');
 await f.runtime.checkIdle();assert.equal(f.devices[0].state,'Booted');await assert.rejects(f.runtime.request('rename_device',{udid:a,name:'Name'}),e=>e.code==='BUSY');
 release();assert.equal((await finish(f)).state,'done');assert.equal(f.calls.filter(c=>c.method==='boot').length,1);
});
test('a failed boot preserves devices and reports no running target',async t=>{
 const f=await fixture(t);f.fail('boot');await f.runtime.request('viewer_switch',{udid:a,targetUdid:b});const job=await finish(f);
 assert.equal(job.state,'failed');assert.equal(job.activeUdid,null);assert.ok(f.devices.every(d=>d.state==='Shutdown'));assert.equal(f.devices.length,2);
});
