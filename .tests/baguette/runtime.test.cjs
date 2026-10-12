const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createRuntime}=require('../../baguette-simulator/node/runtime.cjs');
const udid='00000000-0000-4000-8000-000000000001';
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'baguette-runtime-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let clock=0,state='Booted',failStop=false,hold;
  const calls=[];
  const options={settingsFile:path.join(dir,'runtime-settings.json'),now:()=>clock,dispatch:async(method,p={})=>{
    calls.push({method,...p});if(hold&&method==='tap')await hold;
    if(method==='devices')return {devices:[{udid,name:'Test device',state}]};
    if(method==='shutdown'){assert.equal(p.udid,udid);if(failStop)throw Object.assign(Error('Shutdown timed out'),{execution:'unknown'});state='Shutdown';}
    if(method==='boot')state='Booted';
    return {ok:true};
  }};
  return {runtime:createRuntime(options),restart:()=>createRuntime(options),calls,file:options.settingsFile,advance:ms=>clock+=ms,state:()=>state,fail:()=>failStop=true,hold:p=>hold=p};
}
test('off stops exact devices, persists across restart, and rejects tool boot; enabling never boots',async t=>{
  const f=await fixture(t);
  assert.equal((await f.runtime.request('settings_save',{enabled:false,idleMinutes:15})).ok,true);
  assert.equal(f.state(),'Shutdown');assert.equal(JSON.parse(await fs.readFile(f.file)).enabled,false);
  const restored=f.restart();await assert.rejects(restored.request('boot',{udid}),e=>e.code==='RUNTIME_DISABLED');
  await restored.request('settings_save',{enabled:true,idleMinutes:15});assert.equal(f.state(),'Shutdown');
  assert.equal(f.calls.filter(c=>c.method==='boot').length,0);
});
test('status polling does not renew idle; real operations do, and manual mode stays running',async t=>{
  const f=await fixture(t);await f.runtime.request('devices');f.advance(14*60000);await f.runtime.request('settings_status');
  await f.runtime.checkIdle();assert.equal(f.state(),'Booted');f.advance(60000);await f.runtime.checkIdle();assert.equal(f.state(),'Shutdown');
  await f.runtime.request('boot',{udid});f.advance(14*60000);await f.runtime.request('tap',{udid});f.advance(60000);await f.runtime.checkIdle();assert.equal(f.state(),'Booted');
  await f.runtime.request('settings_save',{enabled:true,idleMinutes:0});f.advance(120*60000);await f.runtime.checkIdle();assert.equal(f.state(),'Booted');
});
test('failed stop keeps start disabled and reports remaining devices, not false success',async t=>{
  const f=await fixture(t);f.fail();const result=await f.runtime.request('settings_save',{enabled:false,idleMinutes:15});
  assert.equal(result.ok,false);assert.equal(result.errorCode,'STOP_INCOMPLETE');assert.deepEqual(result.remaining,[udid]);
  await assert.rejects(f.restart().request('boot',{udid}),e=>e.code==='RUNTIME_DISABLED');
});
test('idle cleanup cannot interrupt an in-flight operation and overlapping requests never queue mutations',async t=>{
  const f=await fixture(t);let release;f.hold(new Promise(r=>release=r));
  const operation=f.runtime.request('tap',{udid});await new Promise(r=>setImmediate(r));f.advance(30*60000);
  assert.equal((await f.runtime.request('settings_status')).devices[0].state,'Booted');
  await f.runtime.checkIdle();assert.equal(f.state(),'Booted');
  await assert.rejects(f.runtime.request('settings_save',{enabled:false,idleMinutes:15}),e=>e.code==='BUSY');
  release();await operation;await f.runtime.checkIdle();assert.equal(f.state(),'Booted');
});
test('invalid settings fail closed; a direct emergency shutdown still works',async t=>{
  const f=await fixture(t);await fs.writeFile(f.file,'invalid');
  await assert.rejects(f.runtime.request('boot',{udid}),e=>e.code==='SETTINGS_UNREADABLE');
  await f.runtime.request('shutdown',{udid});assert.equal(f.state(),'Shutdown');
});
test('normal worker exit attempts and verifies device shutdown',async t=>{
  const f=await fixture(t);assert.equal((await f.runtime.close()).ok,true);assert.equal(f.state(),'Shutdown');
  await assert.rejects(f.runtime.request('boot',{udid}),e=>e.code==='BUSY');
});
