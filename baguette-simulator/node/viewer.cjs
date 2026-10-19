'use strict';
const {spawn}=require('node:child_process');
const net=require('node:net');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {createClipboard}=require('./clipboard.cjs');
// The viewer address (port + capability) survives worker restarts so open tabs
// can reconnect. It is forgotten when the user turns simulators off.
const sessionFile=deviceSet=>path.join(path.dirname(deviceSet),'viewer-session.json');
function readSession(deviceSet){try{return JSON.parse(fs.readFileSync(sessionFile(deviceSet),'utf8'));}catch{return {};}}
function writeSession(deviceSet,session){
 const file=sessionFile(deviceSet),temporary=file+'.'+process.pid+'.tmp';
 try{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(temporary,JSON.stringify(session),{mode:0o600});fs.renameSync(temporary,file);}catch{try{fs.rmSync(temporary,{force:true});}catch{}}
}
function forgetSession(deviceSet){try{fs.rmSync(sessionFile(deviceSet),{force:true});}catch{}}
let active=null;
let controls=null;
// A window counts as open while its live stream is connected, plus a short
// grace after opening (before the stream attaches) and after it disconnects.
const VIEWER_GRACE_MS=60000;
let lastViewerSeen=0;
function viewing(now=Date.now()){
 if((active?.clipboard?.viewers?.()||0)>0)lastViewerSeen=now;
 return now-lastViewerSeen<=VIEWER_GRACE_MS;
}
function configureControls(value){controls=value;}
function freePort(){return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});}
function probe(url){return new Promise((resolve,reject)=>{const request=http.get(url,{timeout:1500},response=>{response.resume();response.on('end',()=>response.statusCode===200?resolve():reject(Error('Viewer HTTP '+response.statusCode)));});request.once('timeout',()=>request.destroy(Error('Viewer timed out')));request.once('error',reject);});}
async function stopViewer(){
 const current=active;if(!current)return {stopped:false};active=null;current.stopped=true;clearTimeout(current.restartTimer);current.clipboard?.close();
 const child=current.child;
 if(!child||child.exitCode!==null||child.signalCode!==null)return {stopped:true};
 await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});
 return {stopped:true};
}
function launch(current){
 if(current.stopped)return;
 current.error=null;current.log='';current.generation=(current.generation||0)+1;
 const child=spawn(current.binary,['serve','--host','127.0.0.1','--port',String(current.port),'--device-set',current.deviceSet,'--no-plugins'],{stdio:['ignore','pipe','pipe'],shell:false});
 current.child=child;current.children.add(child);
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{current.log=(current.log+chunk.toString()).slice(-4000);});
 child.once('error',error=>{current.error=error;});
 child.once('close',(code,signal)=>{
  current.children.delete(child);
  if(current.stopped||current.retiring===child||active!==current)return;
  current.lastExit={code,signal,at:new Date().toISOString()};
  current.crashes=current.crashes.filter(t=>Date.now()-t<60000);current.crashes.push(Date.now());
  process.stderr.write('[baguette-viewer] '+JSON.stringify(current.lastExit)+'\n');
  if(current.crashes.length>5){current.parked=true;current.error=Error('Viewer crashed repeatedly. Call open_viewer explicitly to retry.');return;}
  current.restartTimer=setTimeout(()=>launch(current),500);
 });
}
async function ready(current){
 const deadline=Date.now()+12000;
 while(Date.now()<deadline){
  if(current.stopped)throw Error('Viewer stopped');
  if(current.parked)throw current.error;
  if(current.child&&current.child.exitCode===null&&current.child.signalCode===null&&current.log.includes('listening')){
   try{await probe(current.base+'/simulators');return current;}catch{}
  }
  await new Promise(resolve=>setTimeout(resolve,150));
 }
 throw Error('Viewer startup timed out: '+(current.error?.message||current.log));
}
async function startViewer(binary,deviceSet,children){
 if(active&&!active.stopped){if(active.parked)await restartNative(active);return ready(active);}
 const previousPort=active?.port;
 if(active)await stopViewer();
 const port=previousPort||await freePort();
 const current={binary,deviceSet,children,port,base:'http://127.0.0.1:'+port,child:null,log:'',error:null,stopped:false,parked:false,crashes:[],lastExit:null,restartTimer:null};active=current;
 launch(current);
 try{return await ready(current);}catch(error){if(active===current)await stopViewer();throw error;}
}
async function restartNative(current){
 if(current.restartPromise)return current.restartPromise;
 current.restartPromise=(async()=>{
  clearTimeout(current.restartTimer);
  try{
   const child=current.child;current.retiring=child;
   if(child&&child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});
   current.parked=false;current.crashes=[];launch(current);await ready(current);
   return {ready:true,generation:current.generation};
  }finally{current.retiring=null;current.restartPromise=null;}
 })();return current.restartPromise;
}
async function viewerStatus(server){
 let available=false;try{await probe(server.base+'/simulators');available=true;}catch{}
 return {ready:available,parked:server.parked,generation:server.generation};
}
async function openViewer(binary,deviceSet,children,udid,clipboardAction,locale){
 const server=await startViewer(binary,deviceSet,children);
 const page=server.base+'/simulators/'+encodeURIComponent(udid);await probe(page);
 if(!server.clipboard){
 const preferred=readSession(deviceSet);
 server.clipboard=await createClipboard(server.base,clipboardAction,{
  port:server.port,
  status:async p=>{const state=controls?await controls.status():null;return {...await viewerStatus(server),device:state?.devices.find(d=>d.udid===p.udid),devices:state?.devices,deviceJob:state?.deviceJob,currentApp:await controls?.currentApp?.(p.udid),settings:state?.settings,idleDeadline:state?.idleDeadline};},
  catalog:()=>controls.request('viewer_catalog'),
  create:async p=>{const created=await controls.request('create_device',{name:p.name,deviceType:p.deviceType,runtime:p.runtime});return {ok:true,created,devices:(await controls.status()).devices};},
  rename:async p=>{await controls.request('rename_device',{udid:p.targetUdid,name:p.name});return {ok:true,devices:(await controls.status()).devices};},
  switch:async p=>{const job=await controls.request('viewer_switch',{udid:p.udid,targetUdid:p.targetUdid,_locale:p.locale});server.clipboard.devices.add(job.targetUdid);return {ok:true,job};},
  restart:()=>controls?controls.exclusive(async()=>{await controls.assertEnabled();return restartNative(server);}):restartNative(server),
  release:p=>controls?controls.exclusive(async()=>{await controls.assertEnabled();await clipboardAction({udid:p.udid,action:'release'});controls.touch();return {ok:true};}):clipboardAction({udid:p.udid,action:'release'}),
  shutdown:p=>controls.request('settings_shutdown',{udid:p.udid}),
  // Both run under the runtime lock and the user's run switch, like Agent tools.
  boot:p=>controls.request('settings_boot',{udid:p.udid}),
  screenshot:p=>controls.request('screenshot',{udid:p.udid}),
  activity:async()=>{await controls?.assertEnabled();controls?.touch();return {ok:true};},
  guard:()=>controls?.assertEnabled(),
  run:fn=>controls?controls.exclusive(fn):fn(),
  touch:()=>controls?.touch()
 },preferred);
 const session=server.clipboard.session;
 if(session.port!==preferred.port||session.token!==preferred.token)writeSession(deviceSet,session);
 }
 server.clipboard.devices.add(udid);
 lastViewerSeen=Date.now();
 const url=server.clipboard.base+'/control?udid='+encodeURIComponent(udid)+'&lang='+(locale==='zh-CN'?'zh-CN':'en')+'#'+server.clipboard.fragment;
 return {url,ready:true,recentRestarts:server.crashes.length,lastExit:server.lastExit,note:'Live viewer ready with zoom and device shutdown controls. Simulator data is preserved. Devices are not shut down for idleness while a viewer window is open or another tool or script is operating them; otherwise idle shutdown follows plugin settings (15 minutes by default). close_viewer only stops streaming. Use shutdown when finished.'};
}
module.exports={openViewer,stopViewer,configureControls,viewing,VIEWER_GRACE_MS,forgetSession};
