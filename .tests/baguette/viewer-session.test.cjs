const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {createClipboard}=require('../../baguette-simulator/node/clipboard.cjs');
const {createRuntime}=require('../../baguette-simulator/node/runtime.cjs');
const udid='00000000-0000-4000-8000-000000000001';
const control={port:1,status:async()=>({ready:true})};
const freePort=()=>new Promise(r=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});

test('a restarted viewer reuses the saved address and capability, so an open tab keeps working',async()=>{
 const first=await createClipboard('http://127.0.0.1:1',async()=>{},control);
 const saved=first.session;first.close();
 const again=await createClipboard('http://127.0.0.1:1',async()=>{},control,saved);again.devices.add(udid);
 try{
  assert.deepEqual(again.session,saved);
  const r=await fetch(again.base+'/control-api',{method:'POST',headers:{Origin:again.base,'X-Cindy-Clipboard':saved.token},body:JSON.stringify({action:'status',udid})});
  assert.equal(r.status,200,'the capability from before the restart is accepted');
 }finally{again.close();}
});

test('a taken port falls back to a new one; a malformed saved capability is never used',async()=>{
 const port=await freePort();const squatter=net.createServer();await new Promise(r=>squatter.listen(port,'127.0.0.1',r));
 const token='a'.repeat(64);
 const moved=await createClipboard('http://127.0.0.1:1',async()=>{},control,{port,token});
 try{assert.notEqual(moved.session.port,port);assert.equal(moved.session.token,token);}finally{moved.close();squatter.close();}
 const fresh=await createClipboard('http://127.0.0.1:1',async()=>{},control,{port:80,token:'short'});
 try{assert.notEqual(fresh.session.token,'short');assert.match(fresh.session.token,/^[0-9a-f]{64}$/);assert.notEqual(fresh.session.port,80);}finally{fresh.close();}
});

test('turning simulators off retires the saved viewer address',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'baguette-session-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let forgotten=0,state='Booted';
 const runtime=createRuntime({settingsFile:path.join(dir,'s.json'),forgetViewer:()=>forgotten++,
  dispatch:async(method)=>{if(method==='devices')return {devices:[{udid,state}]};if(method==='shutdown')state='Shutdown';return {ok:true};}});
 await runtime.request('settings_save',{enabled:true,idleMinutes:15});assert.equal(forgotten,0);
 await runtime.request('settings_save',{enabled:false,idleMinutes:15});assert.equal(forgotten,1);assert.equal(state,'Shutdown');
});
