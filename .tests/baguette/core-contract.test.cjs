const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const dir=path.resolve('baguette-simulator/node');
const udid='00000000-0000-4000-8000-000000000001';
function core(output,failAt=Infinity,macOS="15.0",catalog=[]){
 let polls=0,mutations=0;const commands=[],budgets=[];
 const context={module:{exports:{}},__dirname:dir,process:{platform:'darwin',arch:'arm64'},setTimeout:fn=>fn(),require(name){
  if(name==='./viewer.cjs')return {};
  if(name==='node:fs/promises')return {mkdir:async()=>{}};
  if(name==='node:child_process')return {execFile(file,args,opts,cb){
   commands.push(file);budgets.push(opts.timeout);let data='',error=null;
   if(file==='/usr/bin/sw_vers')data=macOS;
   else if(args.includes('--json'))data=JSON.stringify(args.includes('runtimes')?{runtimes:catalog}:{devices:{runtime:[{udid,state:'Booted'}]}});
   else if(args[0]==='describe-ui')data=output;
   else if(args.includes('list')){polls++;if(polls===failAt)error=Error('simctl timeout');data=(polls===1?'100':'200')+' 0 com.apple.SpringBoard';}
   else mutations++;
   queueMicrotask(()=>cb(error,data,''));return {stdin:{on(){},end(){}}};
  }};
  return require(name);
 }};
 vm.runInNewContext(fs.readFileSync(path.join(dir,'core.cjs'),'utf8'),context);
 return {dispatch:context.module.exports.dispatch,mutations:()=>mutations,commands,budgets};
}
test('describe_ui rejects empty/malformed trees and accepts observable descendants',async()=>{
 for(const value of ['[]','null','{}','{"children":[]}','{"role":"AXUnknown"}','invalid']) {
  await assert.rejects(core(value).dispatch('describe_ui',{udid}),e=>e.code===(value==='invalid'?'INVALID_OUTPUT':'EMPTY_UI'));
 }
 const tree={children:[{role:'AXButton',label:'Google',children:[]}]};
 assert.equal((await core(JSON.stringify(tree)).dispatch('describe_ui',{udid})).tree.children[0].label,'Google');
});
test('heal distinguishes preflight failure from post-restart polling failure',async()=>{
 const before=core('',1);await assert.rejects(before.dispatch('heal',{udid}),e=>e.execution==='not_executed');assert.equal(before.mutations(),0);
 const after=core('',2);await assert.rejects(after.dispatch('heal',{udid}),e=>e.execution==='unknown');assert.equal(after.mutations(),2);
 assert.equal((await core('').dispatch('heal',{udid})).execution,'executed');
});

test('macOS minimum is checked before any simulator or bundled binary runs',async()=>{
 for(const version of ['14.7.6','13.6','unknown','']){
  const c=core('',Infinity,version);
  await assert.rejects(c.dispatch('devices'),e=>e.code==='UNSUPPORTED_OS'&&e.execution==='not_executed');
  assert.deepEqual(c.commands,['/usr/bin/sw_vers']);
 }
 for(const version of ['15.0','15.7.1','26.0','27.0']){
  const c=core('',Infinity,version);await c.dispatch('devices');
  assert.deepEqual(c.commands,['/usr/bin/sw_vers','/usr/bin/xcrun']);
 }
});

test('invalid paste text never reaches key release or clipboard mutation',async()=>{
 for(const text of ['', 'a'.repeat(8001), 'before\0after']) {
  const c=core('');await assert.rejects(c.dispatch('type_text',{udid,text}),e=>e.code==='INVALID_ARGUMENT'&&e.execution==='not_executed');
  assert.equal(c.mutations(),0);
  assert.ok(c.commands.every(file=>file==='/usr/bin/sw_vers'||file==='/usr/bin/xcrun'));
 }
});

test('boot and heal complete command budgets fit the Host bridge ceiling',async()=>{
 const boot=core('');await boot.dispatch('boot',{udid});
 // Booted fixture skips the optional 15-second cold boot command.
 assert.equal(boot.budgets.reduce((a,b)=>a+b,0)+15000,113000);
 const heal=core('');await heal.dispatch('heal',{udid});
 // The polling window permits up to 25s plus one last 5s command.
 assert.ok(heal.budgets.slice(0,-1).reduce((a,b)=>a+b,0)+30500<120000);
});

test('rename only accepts an owned device and a bounded non-option name',async()=>{
 for(const name of ['', '  ', '-option', 'name\nline', 'a'.repeat(81)]){
  const c=core('');await assert.rejects(c.dispatch('rename_device',{udid,name}),e=>e.code==='INVALID_ARGUMENT');assert.equal(c.mutations(),0);
 }
 const c=core('');await assert.rejects(c.dispatch('rename_device',{udid:'00000000-0000-4000-8000-000000000002',name:'Phone'}),e=>e.code==='DEVICE_NOT_OWNED');assert.equal(c.mutations(),0);
 assert.equal((await c.dispatch('rename_device',{udid,name:'测试 Phone'})).execution,'executed');assert.equal(c.mutations(),1);
});

test('app reuse obtains only an owned app container, never a data container or runtime copy',async()=>{
 const set=path.join(require('node:os').homedir(),'Library/Application Support/BaguetteCindy/devices');
 for(const appPath of [path.join(set,udid,'data/Containers/Bundle/Application/test/App.app'),'/RuntimeRoot/Applications/Settings.app']){
  const calls=[];
  const context={module:{exports:{}},__dirname:dir,process:{platform:'darwin',arch:'arm64'},require(name){
   if(name==='./viewer.cjs')return {};
   if(name==='node:fs/promises')return {mkdir:async()=>{},realpath:async p=>p,stat:async()=>({isDirectory:()=>true})};
   if(name==='node:child_process')return {execFile(file,args,opts,cb){calls.push(args);let data='';if(file==='/usr/bin/sw_vers')data='27.0';else if(args.includes('--json'))data=JSON.stringify({devices:{runtime:[{udid,state:'Booted'}]}});else if(args.includes('get_app_container'))data=appPath;queueMicrotask(()=>cb(null,data,''));return {stdin:{on(){},end(){}}};}};
   return require(name);
  }};
  vm.runInNewContext(fs.readFileSync(path.join(dir,'core.cjs'),'utf8'),context);
  const result=await context.module.exports.dispatch('app_bundle',{udid,bundleId:'test.example.app'});
  assert.equal(result.appPath,appPath.startsWith(set)?appPath:null);
  const request=calls.find(args=>args.includes('get_app_container'));assert.deepEqual(Array.from(request),['simctl','--set',set,'get_app_container',udid,'test.example.app','app']);
 }
});


test('create rejects a runtime/model mismatch before mutation even when version ranges would allow it',async()=>{
 const runtime='com.apple.CoreSimulator.SimRuntime.iOS-27-1',deviceType='com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro';
 const catalog=[{identifier:runtime,isAvailable:true,supportedDeviceTypes:[{identifier:'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo'}]}];
 const mismatch=core('',Infinity,'27.0',catalog);await assert.rejects(mismatch.dispatch('create_device',{name:'Phone',runtime,deviceType}),e=>e.code==='DEVICE_RUNTIME_MISMATCH'&&e.execution==='not_executed');assert.equal(mismatch.mutations(),0);
 const missing=core('');await assert.rejects(missing.dispatch('create_device',{name:'Phone',runtime,deviceType}),e=>e.code==='RUNTIME_UNAVAILABLE');assert.equal(missing.mutations(),0);
 const supported=core('',Infinity,'27.0',[{identifier:runtime,isAvailable:true,supportedDeviceTypes:[{identifier:deviceType}]}]);assert.equal((await supported.dispatch('create_device',{name:'Phone',runtime,deviceType})).execution,'executed');assert.equal(supported.mutations(),1);
});
