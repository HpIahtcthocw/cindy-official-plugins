'use strict';
const {randomUUID}=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
// Device changes run through the same runtime lock as Agent tools and shutdown.
function createDeviceManager({dispatch,exclusive,assertEnabled,touch,contextFile,onSettled=async()=>{}}) {
 let job=null,apps=null;
 const fail=(code,message,execution='not_executed')=>Object.assign(Error(message),{code,execution});
 async function contexts(){
  if(apps)return apps;
  try{const value=JSON.parse(await fs.readFile(contextFile,'utf8'));apps ||= Object.fromEntries(Object.entries(value).filter(([id,bundle])=>/^[0-9a-f-]{36}$/i.test(id)&&typeof bundle==='string'&&/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(bundle)).map(([id,bundle])=>[id.toUpperCase(),bundle]));}
  catch{apps ||= {};}return apps;
 }
 async function remember(udid,bundleId){
  const values=await contexts(),id=udid.toUpperCase();
  if(bundleId)values[id]=bundleId;else delete values[id];
  if(!contextFile)return;
  const temporary=contextFile+'.'+randomUUID()+'.tmp';
  try{await fs.mkdir(path.dirname(contextFile),{recursive:true,mode:0o700});await fs.writeFile(temporary,JSON.stringify(values),{mode:0o600});await fs.rename(temporary,contextFile);}
  finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
 }
 const snapshot=()=>job?{...job}:null;
 async function currentApp(udid){return (await contexts())[udid.toUpperCase()]||null;}
 async function forget(udid,bundleId){
  const current=await currentApp(udid);
  if(!current||(bundleId&&current!==bundleId))return;
  try{await remember(udid,null);}
  catch{throw fail('APP_CONTEXT_UNSAVED','The App was removed, but its recent-app record could not be cleared. Check storage before switching devices.','executed');}
 }
 async function selection(p){
  const devices=(await dispatch('devices')).devices;
  const source=devices.find(d=>d.udid===p.udid),target=devices.find(d=>d.udid===p.targetUdid);
  if(!source||!target)throw fail('DEVICE_NOT_OWNED','Select a device from this plugin.');
  if(!target.isAvailable)throw fail('DEVICE_UNAVAILABLE','The selected runtime is unavailable.');
  if(devices.some(d=>d.udid!==source.udid&&d.udid!==target.udid&&d.state!=='Shutdown'))throw fail('OTHER_DEVICE_RUNNING','Shut down other Baguette devices before switching.');
  if(!['Booted','Shutdown'].includes(source.state)||!['Booted','Shutdown'].includes(target.state))throw fail('BUSY','Wait for the device state change to complete.');
  return {source,target};
 }
 async function start(p){
  if(job?.state==='running')throw fail('BUSY','A device switch is already in progress.');
  await assertEnabled();
  let {source,target}=await selection(p);
  // Reserve before yielding; two HTTP requests cannot both start a switch.
  if(job?.state==='running')throw fail('BUSY','A device switch is already in progress.');
  const entry={id:randomUUID(),sourceUdid:source.udid,targetUdid:target.udid,state:'running',phase:'preparing',execution:'not_executed'};job=entry;
  const failed=async error=>{
   entry.errorCode=error.code||'SWITCH_FAILED';entry.execution=entry.execution==='not_executed'?(error.execution||'not_executed'):'unknown';
   try{const actual=(await dispatch('devices')).devices;entry.activeUdid=actual.find(d=>d.udid===target.udid&&d.state==='Booted')?.udid||actual.find(d=>d.udid===source.udid&&d.state==='Booted')?.udid||null;}
   catch{entry.activeUdid=null;}
   await onSettled(entry,p).catch(()=>{});
   entry.state='failed';entry.phase='failed';touch();
  };
  const operation=exclusive(async()=>{
   try{
    await assertEnabled();
    ({source,target}=await selection(p));
    const bundleId=await currentApp(source.udid);entry.bundleId=bundleId;
    let appPath=null;
    if(bundleId&&source.state==='Booted'){
     // Only the application bundle is reused. No app data or credentials move.
     const app=await dispatch('app_bundle',{udid:source.udid,bundleId});appPath=app.appPath;
    }
    if(source.udid!==target.udid&&source.state!=='Shutdown'){
     entry.phase='stopping';entry.execution='unknown';await dispatch('shutdown',{udid:source.udid});
     if((await dispatch('devices')).devices.find(d=>d.udid===source.udid)?.state!=='Shutdown')throw fail('STOP_UNCONFIRMED','Previous device shutdown was not confirmed.','unknown');
     entry.execution='executed';
    }
    await assertEnabled();entry.phase='booting';entry.execution='unknown';await dispatch('boot',{udid:target.udid});entry.execution='executed';
    if(bundleId){
     if(appPath&&source.udid!==target.udid){entry.phase='installing';let job=await dispatch('install_app',{udid:target.udid,appPath});while(job?.state==='running')job=await dispatch('app_install_status',{udid:target.udid,job:job.job});}
     entry.phase='launching';await dispatch('launch_app',{udid:target.udid,bundleId,showViewer:false});
     await remember(target.udid,bundleId).catch(()=>{});
    }
    entry.phase='opening';const viewer=await dispatch('open_viewer',{udid:target.udid,_locale:p._locale});
    entry.activeUdid=target.udid;entry.url=viewer.url;
    await onSettled(entry,p);entry.state='done';entry.phase='done';touch();
   }catch(error){await failed(error);}
  });
  // Lock acquisition can reject before the operation starts. Once acquired,
  // failure reconciliation and task binding complete before releasing it.
  operation.catch(failed);
  return snapshot();
 }
 return {snapshot,currentApp,remember,forget,start};
}
module.exports={createDeviceManager};
