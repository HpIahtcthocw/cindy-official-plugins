'use strict';
// Which device each Cindy task (session) uses. A task is bound when the AI or the
// user starts, opens or launches on a device from that task; several tasks may
// share one device. Stored next to the private device set, mode 0600.
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {deviceId}=require('./device-id.cjs');
const SESSION=/^[A-Za-z0-9-]{1,64}$/;
const UDID=/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const MAX_BINDINGS=500;
function validSession(value){return typeof value==='string'&&SESSION.test(value);}
function createTaskBindings(file){
 let cache=null,queue=Promise.resolve();
 async function read(){
  if(cache)return cache;
  try{
   const raw=JSON.parse(await fs.readFile(file,'utf8'));
   if(!raw||raw.version!==1||!raw.bindings||typeof raw.bindings!=='object'||Array.isArray(raw.bindings)||
    Object.entries(raw.bindings).some(([session,b])=>!validSession(session)||!b||typeof b.udid!=='string'||!UDID.test(b.udid)||!Number.isFinite(b.at)))throw Error('Invalid task bindings');
   cache=raw.bindings;
  }catch(error){
   // A failed read is not an empty store. Leave both disk and cache untouched
   // so every queued writer fails safely, and a restored file can be read.
   if(error.code!=='ENOENT')throw Object.assign(Error('Cannot read task bindings. Restore the bindings file before assigning a device.',{cause:error}),{code:'TASK_BINDINGS_UNREADABLE',execution:'not_executed'});
   cache={};
  }
  return cache;
 }
 async function write(next){
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,JSON.stringify({version:1,bindings:next}),{mode:0o600});await fs.rename(temporary,file);cache=next;}
  finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
 }
 // Serialize writes so concurrent binds never drop one another.
 const serial=fn=>{const run=queue.then(fn,fn);queue=run.catch(()=>{});return run;};
 return {
  async get(session){if(!validSession(session))return null;const b=(await read())[session];return b&&UDID.test(b.udid)?{...b,udid:deviceId(b.udid)}:null;},
  bind(session,udid,now=Date.now()){
   if(!validSession(session)||typeof udid!=='string'||!UDID.test(udid))return Promise.resolve(false);
   udid=deviceId(udid);
   return serial(async()=>{
    const current=await read();
    if(deviceId(current[session]?.udid)===udid)return true;
    const next={...current,[session]:{udid,at:now}};
    // Keep the most recent bindings only; old tasks fall back to "no device yet".
    const keys=Object.keys(next);
    if(keys.length>MAX_BINDINGS)for(const key of keys.sort((a,b)=>next[a].at-next[b].at).slice(0,keys.length-MAX_BINDINGS))delete next[key];
    await write(next);return true;
   });
  },
  // A deleted device: tasks that used it go back to "no device yet".
  forgetDevice(udid){
   return serial(async()=>{
    const current=await read(),next={...current};let changed=false;
    for(const [session,b] of Object.entries(current))if(typeof b?.udid==='string'&&deviceId(b.udid)===deviceId(udid)){delete next[session];changed=true;}
    if(changed)await write(next);return changed;
   });
  },
  async counts(){const out={};for(const b of Object.values(await read()))if(b&&UDID.test(b.udid)){const id=deviceId(b.udid);out[id]=(out[id]||0)+1;}return out;},
 };
}
module.exports={createTaskBindings,validSession};
