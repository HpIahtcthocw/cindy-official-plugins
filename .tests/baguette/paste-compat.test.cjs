const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const udid='00000000-0000-4000-8000-000000000001';

function harness({simctlFails=false,readFails=false,stale=false,owned=true}={}) {
 const calls=[];let clipboard="";
 const context={module:{exports:{}},setTimeout,clearTimeout,__dirname:path.resolve('baguette-simulator/node'),process:{platform:'darwin',arch:'arm64'},require(name){
  if(name==='./viewer.cjs')return {};
  if(name==='./keys.cjs')return require('../../baguette-simulator/node/keys.cjs');
  if(name==='node:fs/promises')return {mkdir:async()=>{}};
  if(name==='node:child_process')return {execFile(file,args,options,callback){
   const call={file,args,options,input:undefined};calls.push(call);
   let output='',error=null;
   if(file==='/usr/bin/sw_vers')output='27.0';
   if(file==='/usr/bin/xcode-select')output='/Applications/Xcode.app/Contents/Developer';
   if(args.includes('--json'))output=JSON.stringify({devices:{runtime:owned?[{udid,state:'Booted'}]:[]}});
   if(args.includes('pbcopy')&&simctlFails)error=Error('unsupported command');
   queueMicrotask(()=>{
    if(args.includes('pbcopy')&&!error&&!stale)clipboard=call.input;
    if(args.includes('pbpaste')){output=clipboard;if(readFails)error=Error('read failed');}
    callback(error,output,'');
   });
   return {stdin:{on(){},end(input){call.input=input;}}};
  }};
  return require(name);
 }};
 vm.runInNewContext(fs.readFileSync(path.resolve('baguette-simulator/node/core.cjs'),'utf8'),context);
 return {calls,dispatch:context.module.exports.dispatch};
}

test('paste writes the private device set with simctl and keeps Unicode text out of command arguments',async()=>{
 // CoreDevice cannot see a private device set (devicectl: "device was not found"), so it is never tried.
 const h=harness();await h.dispatch('type_text',{udid,text:'你好 Duo 🥖',method:'paste'});
 assert.ok(!h.calls.some(c=>c.args[0]==='devicectl'));
 const write=h.calls.find(c=>c.args.includes('pbcopy'));
 assert.equal(write.args[0],'simctl');assert.equal(write.args[1],'--set');
 assert.ok(write.args[2].endsWith('/BaguetteCindy/devices'));
 assert.deepEqual(Array.from(write.args.slice(3)),['pbcopy',udid]);
 assert.equal(write.input,'你好 Duo 🥖');
 assert.equal(write.options.env.LC_ALL,'en_US.UTF-8');
 assert.ok(h.calls.at(-1).file.endsWith('/native/keyboard'));
 assert.ok(h.calls.every(c=>!c.args.includes('你好 Duo 🥖')));
});

test('failed clipboard writes never paste stale text, and foreign devices never mutate',async()=>{
 const h=harness({simctlFails:true});
 await assert.rejects(h.dispatch('type_text',{udid,text:'new',method:'paste'}),e=>e.execution==='unknown');
 // The only keyboard call is the existing key-release step, before any write.
 assert.equal(h.calls.filter(c=>c.file.endsWith('/native/keyboard')).length,1);
 const foreign=harness({owned:false});
 await assert.rejects(foreign.dispatch('type_text',{udid,text:'new',method:'paste'}),e=>e.code==='DEVICE_NOT_OWNED');
 assert.ok(!foreign.calls.some(c=>c.args[0]==='devicectl'||c.args.includes('pbcopy')||c.file.endsWith('/native/keyboard')));
});

for(const behavior of [{stale:true},{readFails:true}])test('an unconfirmed clipboard write never sends Command-V '+JSON.stringify(behavior),async()=>{
 const h=harness({...behavior});
 await assert.rejects(h.dispatch('type_text',{udid,text:'new',method:'paste'}),e=>e.code==='CLIPBOARD_UNVERIFIED'&&e.execution==='unknown');
 assert.equal(h.calls.filter(c=>c.file.endsWith('/native/keyboard')).length,1);
});
test('clipboard verification preserves leading/trailing whitespace and Unicode',async()=>{
 const h=harness();await h.dispatch('type_text',{udid,text:' 你好 🥖\n',method:'paste'});
 const read=h.calls.find(c=>c.args.includes('pbpaste'));
 assert.deepEqual(Array.from(read.args.slice(0,3)),Array.from(h.calls.find(c=>c.args.includes('pbcopy')).args.slice(0,3)));
 assert.ok(h.calls.at(-1).file.endsWith('/native/keyboard'));
});
