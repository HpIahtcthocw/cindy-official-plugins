const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createRuntime}=require('../../baguette-simulator/node/runtime.cjs');
const udid='00000000-0000-4000-8000-000000000001';
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'baguette-runtime-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let clock=0,state='Booted',failStop=false,bootTimeout=false,hold;
  const calls=[];
  const options={settingsFile:path.join(dir,'runtime-settings.json'),now:()=>clock,dispatch:async(method,p={})=>{
    calls.push({method,...p});if(hold&&method==='tap')await hold;
    if(method==='devices')return {devices:[{udid,name:'Test device',state}]};
    if(method==='shutdown'){assert.equal(p.udid,udid);if(failStop)throw Object.assign(Error('Shutdown timed out'),{execution:'unknown'});state='Shutdown';}
    if(method==='boot'){
      state='Booted';
      if(bootTimeout)throw Object.assign(Error('bootstatus timed out'),{code:'TIMEOUT',execution:'unknown'});
    }
    return {ok:true};
  }};
  return {runtime:createRuntime(options),restart:()=>createRuntime(options),calls,file:options.settingsFile,advance:ms=>clock+=ms,state:()=>state,fail:()=>failStop=true,timeoutBoot:()=>bootTimeout=true,hold:p=>hold=p};
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
test('bootstatus timeout after successful boot re-arms idle after an empty idle cleanup',async t=>{
  const f=await fixture(t);await f.runtime.request('shutdown',{udid});
  f.advance(15*60000);await f.runtime.checkIdle();assert.equal(f.state(),'Shutdown');
  f.timeoutBoot();await assert.rejects(f.runtime.request('settings_boot',{udid}),e=>e.code==='TIMEOUT');
  assert.equal(f.state(),'Booted');
  f.advance(14*60000);await f.runtime.request('settings_status');await f.runtime.checkIdle();
  assert.equal(f.state(),'Booted');
  f.advance(60000);await f.runtime.request('devices');await f.runtime.checkIdle();
  assert.equal(f.state(),'Shutdown');
});
for(const damaged of ['invalid JSON','unreadable directory'])test(`${damaged}: status and user shutdown work, starts and writes stay blocked`,async t=>{
  for(const stop of ['settings_shutdown','settings_stop_all']){
    const f=await fixture(t);
    if(damaged==='invalid JSON')await fs.writeFile(f.file,'{broken');else await fs.mkdir(f.file);
    const status=await f.runtime.request('settings_status');
    assert.equal(status.settingsError.code,'SETTINGS_UNREADABLE');assert.equal(status.settings.enabled,false);
    assert.equal(status.idleDeadline,null);assert.equal(status.devices[0].state,'Booted');
    assert.equal((await f.runtime.request('devices')).devices[0].state,'Booted');
    for(const method of ['boot','settings_boot','settings_viewer'])await assert.rejects(f.runtime.request(method,{udid}),e=>e.code==='SETTINGS_UNREADABLE');
    await assert.rejects(f.runtime.request('settings_save',{enabled:true,idleMinutes:15}),e=>e.code==='SETTINGS_UNREADABLE');
    const result=await f.runtime.request(stop,{udid});assert.equal(result.ok,true);
    assert.equal(result.execution,'executed');assert.equal(result.devices[0].state,'Shutdown');
    assert.equal(result.settingsError.code,'SETTINGS_UNREADABLE');
    assert.equal(f.calls.filter(c=>c.method==='boot').length,0);
  }
});
test('damaged settings preserve incomplete shutdown evidence and recover after file repair',async t=>{
  const f=await fixture(t);await fs.writeFile(f.file,'{broken');f.fail();
  const result=await f.runtime.request('settings_stop_all');
  assert.equal(result.ok,false);assert.equal(result.errorCode,'STOP_INCOMPLETE');
  assert.deepEqual(result.remaining,[udid]);assert.equal(result.settingsError.code,'SETTINGS_UNREADABLE');
  await fs.writeFile(f.file,JSON.stringify({enabled:false,idleMinutes:30}));
  const status=await f.runtime.request('settings_status');assert.equal(status.settingsError,undefined);
  assert.deepEqual(status.settings,{enabled:false,idleMinutes:30});
});
