'use strict';
const {execFile} = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline');
const {openViewer,stopViewer,configureControls}=require('./viewer.cjs');
const BINARY = path.join(__dirname, '../vendor/baguette/Baguette');
const ROOT = path.join(os.homedir(), 'Library/Application Support/BaguetteCindy');
const DEVICE_SET = path.join(ROOT, 'devices');
const children = new Set();
const methods = new Set(['environment','devices','create_device','rename_device','app_bundle','boot','shutdown','describe_ui','tap','swipe','gesture','type_text','press','screenshot','install_app','launch_app','heal','open_viewer','close_viewer','delete_device','erase_device','reveal_screenshot',
  'wait_for','capture','set_state','logs','app_install','app_install_status','app_info','app_terminate','app_uninstall','open_url']);
// Agent operations that only read the device; they never change what is on screen.
const READ_ONLY = new Set(['describe_ui','screenshot','wait_for','logs','app_info','app_install_status']);
class Failure extends Error {
  constructor(code, message, execution = 'not_executed') { super(message); this.code=code; this.execution=execution; }
}
function string(value,name,max=256) {
  if(typeof value!=='string'||!value.length||value.length>max||value.includes('\0')) throw new Failure('INVALID_ARGUMENT',`Invalid ${name}`);
  return value;
}
function deviceName(value){
  const name=string(value,'name',80).trim();
  if(!name||name.startsWith('-')||/[\x00-\x1f\x7f]/.test(name))throw new Failure('INVALID_ARGUMENT','Use a device name of 1–80 characters without control characters or a leading dash.');
  return name;
}
function number(value,name,min,max) {
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max) throw new Failure('INVALID_ARGUMENT',`${name} must be ${min}..${max}`);
  return value;
}
function run(file,args,{timeout=30000,mutation=false,input,env,trimOutput=true,encoding='utf8',maxBuffer=4*1024*1024}={}) {
  return new Promise((resolve,reject)=>{
    const child=execFile(file,args,{timeout,maxBuffer,encoding,killSignal:'SIGKILL',shell:false,env},(err,stdout,stderr)=>{
      children.delete(child);
      stderr=String(stderr||'');
      if(err) return reject(new Failure('COMMAND_FAILED',`${path.basename(file)}: ${(stderr||err.message).slice(-5000)}`,mutation?'unknown':'not_executed'));
      resolve({stdout:trimOutput&&typeof stdout==='string'?stdout.trim():stdout,warnings:stderr.trim().slice(-3000)});
    });
    children.add(child);
    child.stdin.on('error',()=>{});
    child.stdin.end(input);
  });
}
async function sim(args, options) { return run('/usr/bin/xcrun',['simctl','--set',DEVICE_SET,...args],options); }
async function jsonRun(file,args) { const {stdout}=await run(file,args); try{return JSON.parse(stdout);}catch{throw new Failure('INVALID_OUTPUT','Command did not return JSON');} }
async function listDevices() {
  await fs.mkdir(DEVICE_SET,{recursive:true,mode:0o700});
  const data=await sim(['list','devices','--json'],{timeout:5000});
  return Object.entries(JSON.parse(data.stdout).devices).flatMap(([runtime,devices])=>devices.map(d=>({name:d.name,udid:d.udid,state:d.state,isAvailable:d.isAvailable,runtime,deviceType:d.deviceTypeIdentifier})));
}
async function target(p, booted=true) {
  const udid=string(p.udid,'udid',36);
  if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(udid)) throw new Failure('INVALID_DEVICE','Use an exact UDID returned by this plugin');
  const device=(await listDevices()).find(d=>d.udid.toLowerCase()===udid.toLowerCase());
  if(!device) throw new Failure('DEVICE_NOT_OWNED','Device is not in the Baguette plugin device set. Create a dedicated device first.');
  if(booted&&device.state!=='Booted') throw new Failure('DEVICE_NOT_BOOTED','Boot this device first');
  return device;
}
function deviceArgs(device) {return ['--udid',device.udid,'--device-set',DEVICE_SET];}
// "iPhone 18 Pro", then "iPhone 18 Pro 2", "iPhone 18 Pro 3"… so devices stay tellable apart.
function uniqueName(name,taken){
  const used=new Set(taken.filter(n=>typeof n==='string').map(n=>n.toLowerCase()));
  if(!used.has(name.toLowerCase()))return name;
  for(let i=2;i<1000;i++){const next=`${name} ${i}`;if(!used.has(next.toLowerCase()))return next;}
  return `${name} ${Date.now()}`;
}
const desktopShots=new Set();
async function desktopFile(deviceLabel){
  const dir=path.join(os.homedir(),'Desktop');await fs.mkdir(dir,{recursive:true});
  const d=new Date(),pad=n=>String(n).padStart(2,'0');
  const stamp=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  const base=`${deviceLabel.replace(/[\/:]/g,'-')} ${stamp}`;
  for(let i=1;i<100;i++){const file=path.join(dir,`${base}${i>1?` (${i})`:''}.png`);try{await fs.access(file);}catch{return file;}}
  throw new Failure('SCREENSHOT_NAME','Could not name the screenshot');
}
async function baguette(command,device,args=[],options={}) {
  const result=await run(BINARY,[command,...deviceArgs(device),...args],options);
  return {udid:device.udid,execution:options.mutation?'executed':'not_applicable',...result};
}
let agentImpl=null,appsImpl=null;
function agent(){return agentImpl||(agentImpl=require('./agent.cjs').createAgent({binary:BINARY,deviceSet:DEVICE_SET,root:ROOT,run,sim,Failure}));}
function apps(){return appsImpl||(appsImpl=require('./apps.cjs').createApps({sim,run,Failure}));}
const BUNDLE_ID=/^[A-Za-z0-9][A-Za-z0-9.-]+$/;
function bundleId(value){const id=string(value,'bundleId');if(!BUNDLE_ID.test(id))throw new Failure('INVALID_ARGUMENT','Invalid bundle identifier');return id;}
let keyboardBusy=false;
async function nativeKey(device,code,modifiers=[]) {
 const [key,mask]=code?require('./keys.cjs').chord(code,modifiers):[0,0];
 const dev=(await run('/usr/bin/xcode-select',['-p'],{timeout:5000})).stdout;
 return run(path.join(__dirname,'../native/keyboard'),[DEVICE_SET,device.udid,dev,String(key),String(mask)],{mutation:true,timeout:15000});
}
async function clipboardAction(p) {
 if(keyboardBusy)throw new Failure('INPUT_BUSY','Another keyboard operation is running; retry after it finishes');
 keyboardBusy=true;
 try{
  const device=await target(p);
  if(p.action==='release')return await nativeKey(device,null);
  if(p.action==='key')return await nativeKey(device,p.code,p.modifiers);
  if(p.action==='paste') {
    const text=string(p.text,'text',8000);
    // First release any existing repeat before replacing its clipboard payload.
    await nativeKey(device,null);
    // CoreDevice (devicectl) cannot see a private device set, so write with
    // simctl --set. Xcode 27 pbcopy has been seen to exit 0 without changing the
    // guest clipboard: compare exact UTF-8 text (whitespace kept) before pasting.
    await sim(['pbcopy',device.udid],{input:text,mutation:true,env:{...process.env,LC_ALL:'en_US.UTF-8',LANG:'en_US.UTF-8'}});
    let actual;
    try {
      actual=await sim(['pbpaste',device.udid],{trimOutput:false,env:{...process.env,LC_ALL:'en_US.UTF-8',LANG:'en_US.UTF-8'}});
    } catch {
      throw new Failure('CLIPBOARD_UNVERIFIED','Could not confirm guest clipboard contents; paste was not sent','unknown');
    }
    if(actual.stdout!==text)throw new Failure('CLIPBOARD_UNVERIFIED','Guest clipboard did not match requested text; paste was not sent','unknown');
    await nativeKey(device,'KeyV',['command']);
  } else if(p.action==='copy') {
    await nativeKey(device,'KeyC',['command']);
    await new Promise(resolve=>setTimeout(resolve,250));
    await sim(['pbsync',device.udid,'host'],{mutation:true});
  } else throw new Failure('INVALID_ARGUMENT','Unknown input action');
 }finally{keyboardBusy=false;}
}
async function dispatch(method,p={}) {
  if(!methods.has(method)) throw new Failure('UNKNOWN_TOOL','Unknown Baguette operation');
  if(process.platform!=='darwin'||process.arch!=='arm64') throw new Failure('UNSUPPORTED_PLATFORM','This package requires an Apple Silicon Mac');
  const macOS=(await run('/usr/bin/sw_vers',['-productVersion'],{timeout:3000})).stdout;
  if(!/^\d+\.\d+(?:\.\d+)?$/.test(macOS)||Number(macOS.split('.')[0])<15)throw new Failure('UNSUPPORTED_OS',`Requires macOS 15.0 or newer; detected ${macOS || 'unknown'}. Upgrade macOS before using this plugin.`);
  if(method==='environment') {
    const [version,xcode,runtimes,types]=await Promise.all([
      run(BINARY,['--version']),run('/usr/bin/xcodebuild',['-version']),
      jsonRun('/usr/bin/xcrun',['simctl','list','runtimes','--json']),jsonRun('/usr/bin/xcrun',['simctl','list','devicetypes','--json'])]);
    return {macOS,baguette:version.stdout,xcode:xcode.stdout,deviceSet:DEVICE_SET,runtimes:runtimes.runtimes.filter(x=>x.isAvailable&&x.identifier.includes('.iOS-')).map(x=>({name:x.name,identifier:x.identifier,version:x.version,...(Array.isArray(x.supportedDeviceTypes)?{supportedDeviceTypes:x.supportedDeviceTypes.map(d=>d.identifier)}:{})})),deviceTypes:types.devicetypes.filter(x=>x.productFamily==='iPhone'||x.productFamily==='iPad').map(x=>({name:x.name,identifier:x.identifier,minRuntimeVersion:x.minRuntimeVersionString,maxRuntimeVersion:x.maxRuntimeVersionString})),note:'Baguette 0.2.7 supports Xcode 26/27; iPhone Duo requires Xcode 27.1 and iOS 27.1. Use dedicated devices, observe UI before acting, and verify actions afterwards.'};
  }
  if(method==='close_viewer') return {...await stopViewer(),execution:'executed',note:'Viewer server stopped; simulator and App remain running.'};
  if(method==='devices') return {deviceSet:DEVICE_SET,devices:await listDevices()};
  if(method==='create_device') {
    const name=deviceName(p.name), runtime=string(p.runtime,'runtime'), deviceType=string(p.deviceType,'deviceType');
    if(!/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]+$/.test(runtime)||!/^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9-]+$/.test(deviceType)) throw new Failure('INVALID_ARGUMENT','Use runtime and deviceType identifiers from environment');
    const installed=(await jsonRun('/usr/bin/xcrun',['simctl','list','runtimes','--json'])).runtimes.find(r=>r.identifier===runtime&&r.isAvailable);
    if(!installed)throw new Failure('RUNTIME_UNAVAILABLE','Select an available installed iOS runtime.');
    if(Array.isArray(installed.supportedDeviceTypes)&&!installed.supportedDeviceTypes.some(d=>d.identifier===deviceType))throw new Failure('DEVICE_RUNTIME_MISMATCH','This runtime does not support the selected model. Refresh the model and iOS options.');
    await fs.mkdir(DEVICE_SET,{recursive:true,mode:0o700});
    const unique=uniqueName(name,(await listDevices()).map(d=>d.name));
    const result=await sim(['create',unique,deviceType,runtime],{mutation:true});
    return {udid:result.stdout,name:unique,runtime,deviceSet:DEVICE_SET,execution:'executed'};
  }
  if(method==='app_install_status') return apps().status(p);
  if(method==='reveal_screenshot') {
    // Only a screenshot this worker just saved; never an arbitrary path.
    const file=string(p.path,'path',1024);
    if(!desktopShots.has(file))throw new Failure('INVALID_ARGUMENT','Unknown screenshot');
    await run('/usr/bin/open',['-R',file],{timeout:10000});
    return {execution:'executed'};
  }
  const device=await target(p,!['boot','shutdown','rename_device','delete_device','erase_device'].includes(method));
  if(method==='delete_device'||method==='erase_device') {
    // simctl refuses to erase a booted device; delete would stop it mid-write.
    if(device.state!=='Shutdown')await baguette('shutdown',device,[],{timeout:60000,mutation:true});
    await sim([method==='delete_device'?'delete':'erase',device.udid],{timeout:120000,mutation:true});
    return {udid:device.udid,execution:'executed'};
  }
  if(method==='rename_device') {
    const name=deviceName(p.name);
    await sim(['rename',device.udid,name],{mutation:true});
    return {udid:device.udid,name,execution:'executed'};
  }
  if(method==='app_bundle') {
    const bundleId=string(p.bundleId,'bundleId');
    if(!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(bundleId))throw new Failure('INVALID_ARGUMENT','Invalid bundle identifier');
    const value=(await sim(['get_app_container',device.udid,bundleId,'app'],{timeout:10000})).stdout;
    const real=await fs.realpath(value),root=await fs.realpath(path.join(DEVICE_SET,device.udid,'data'));
    if(!real.endsWith('.app')||!(await fs.stat(real)).isDirectory())throw new Failure('INVALID_APP_PATH','Only this private simulator application bundle may be reused.');
    // System apps live in the runtime, outside the device data directory.
    // Never copy any host/runtime path; launch its bundle ID on the target.
    if(!real.startsWith(root+path.sep))return {bundleId,appPath:null};
    return {bundleId,appPath:real};
  }
  if(method==='open_viewer') return {udid:device.udid,...await openViewer(BINARY,DEVICE_SET,children,device.udid,clipboardAction,p._locale),execution:'executed'};
  if(method==='boot') {
    // Upstream 0.1.98's automatic heal omits --set in its internal simctl calls.
    // Wait for this exact custom-set device ourselves; do not silently restart apps.
    const started=device.state==='Booted'?null:await baguette('boot',device,['--no-heal'],{timeout:15000,mutation:true});
    const ready=await sim(['bootstatus',device.udid,'-b'],{timeout:90000,mutation:true});
    // Baguette always warns about Simulator.app's lifetime setting; it does not apply to these headless devices.
    const warnings=(started?.warnings||ready.warnings||'').split('\n').filter(l=>l.trim()&&!/lifetime|^\[baguette\] Booted /.test(l)).join('\n');
    return {udid:device.udid,state:'Booted',execution:started?'executed':'not_executed',...(warnings?{warnings}:{}),note:'Boot completed. If Device Hub has shadowed input, explicitly use heal (terminates running apps).'};
  }
  if(method==='shutdown') {
    if(device.state==='Shutdown') return {udid:device.udid,state:'Shutdown',execution:'not_executed'};
    return baguette('shutdown',device,[],{timeout:60000,mutation:true});
  }
  if(method==='describe_ui') return agent().describe(device,p);
  if(method==='tap') return agent().tap(device,p);
  if(method==='gesture') return agent().gesture(device,p);
  if(method==='swipe') return agent().gesture(device,{kind:'swipe',from:[p.startX,p.startY],to:[p.endX,p.endY],duration:p.duration,observe:'none'});
  if(method==='wait_for') return agent().waitFor(device,p);
  if(method==='set_state') return agent().setState(device,p);
  if(method==='logs') return agent().logs(device,p);
  if(method==='capture') {
    // The action runs inside the capture, through the same operations as its own tool.
    const allowed=['tap','gesture','press','type_text','open_url','app_launch'];
    return agent().capture(device,p,async action=>{
      if(!action||!allowed.includes(action.tool))throw new Failure('INVALID_ARGUMENT',`capture action.tool must be one of ${allowed.join(', ')}`);
      const args={...(action.args||{}),udid:device.udid,observe:'none'};
      return dispatch(action.tool==='app_launch'?'launch_app':action.tool,{...args,showViewer:false});
    });
  }
  if(method==='type_text') {
    if(p.text===undefined&&p.keys===undefined&&p.clear!==true)throw new Failure('INVALID_ARGUMENT','Pass text, keys or clear');
    if(p.clear===true){await clipboardAction({udid:device.udid,action:'key',code:'KeyA',modifiers:['command']});await clipboardAction({udid:device.udid,action:'key',code:'Backspace',modifiers:[]});}
    if(p.text!==undefined)await clipboardAction({udid:device.udid,action:'paste',text:p.text});
    const keys=p.keys===undefined?[]:Array.isArray(p.keys)?p.keys:[p.keys];
    if(keys.length>40)throw new Failure('INVALID_ARGUMENT','At most 40 keys per call','not_executed');
    for(const key of keys){
      const [code,...mods]=String(key).split('+').reverse();
      await clipboardAction({udid:device.udid,action:'key',code,modifiers:mods.map(m=>({cmd:'command',ctrl:'control',alt:'option',opt:'option'})[m.toLowerCase()]||m.toLowerCase())});
    }
    return {udid:device.udid,execution:'executed',note:'Keyboard events acknowledged by the simulator input transport; observe the UI to confirm the result.'};
  }
  if(method==='press'&&p.button==='release-input') {
    await clipboardAction({udid:device.udid,action:'release'});
    return {udid:device.udid,execution:'executed',note:'Stuck keys released; nothing restarted.'};
  }
  if(method==='press') {
    const allowed=['home','lock','power','volume-up','volume-down','action','app-switcher','swipe-to-app-switcher','swipe-to-home','pull-down-to-notification-center','pull-down-to-lock-screen'];
    if(!allowed.includes(p.button)) throw new Failure('INVALID_ARGUMENT',`button must be one of ${allowed.join(', ')} or release-input`);
    const args=['--button',p.button];
    if(p.duration!==undefined)args.push('--duration',String(number(p.duration,'duration',0,10)));
    const pressed=await baguette('press',device,args,{mutation:true});
    agent().forget(device.udid);
    return {udid:device.udid,execution:pressed.execution};
  }
  if(method==='screenshot'&&p.destination==='desktop') {
    // The viewer's screenshot button: a PNG on the Desktop, named like Simulator's.
    const file=await desktopFile(device.name);
    const result=await baguette('screenshot',device,['--format','png','--output',file]);
    const stat=await fs.stat(file); if(!stat.size) throw new Failure('EMPTY_SCREENSHOT','No image produced');
    desktopShots.add(file); if(desktopShots.size>50)desktopShots.delete(desktopShots.values().next().value);
    return {...result,path:file,name:path.basename(file),mimeType:'image/png',bytes:stat.size};
  }
  if(method==='screenshot'&&p.destination==='clipboard') {
    // The viewer's screenshot button set to Clipboard: PNG onto the Mac pasteboard, no file kept.
    const dir=path.join(ROOT,'screenshots');await fs.mkdir(dir,{recursive:true,mode:0o700});
    const file=path.join(dir,crypto.randomUUID()+'.png');
    try {
      const result=await baguette('screenshot',device,['--format','png','--output',file]);
      const stat=await fs.stat(file); if(!stat.size) throw new Failure('EMPTY_SCREENSHOT','No image produced');
      await run('/usr/bin/osascript',['-e','on run argv','-e','set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)','-e','end run',file],{timeout:15000});
      return {...result,copied:true,mimeType:'image/png',bytes:stat.size};
    } finally { await fs.rm(file,{force:true}); }
  }
  if(method==='screenshot') return agent().screenshot(device,p);
  if(method==='app_info') return apps().info(device,p);
  if(method==='app_install') return apps().install(device,p,{terminate:id=>sim(['terminate',device.udid,id],{mutation:true})});
  if(method==='app_terminate') {
    const id=bundleId(p.bundleId);
    try{await sim(['terminate',device.udid,id],{mutation:true,timeout:15000});}
    catch(error){if(/not running|found nothing|No matching processes/i.test(error.message))return {udid:device.udid,bundleId:id,execution:'not_executed',note:'The App was not running.'};throw error;}
    return {udid:device.udid,bundleId:id,execution:'executed'};
  }
  if(method==='app_uninstall') {
    const id=bundleId(p.bundleId);
    if(apps().runningFor(device.udid))throw new Failure('INSTALL_RUNNING','An install is running on this device; wait for it first.');
    await sim(['uninstall',device.udid,id],{mutation:true,timeout:60000});
    return {udid:device.udid,bundleId:id,execution:'executed',note:'Uninstalled; the App and its data are gone from this device.'};
  }
  if(method==='open_url') {
    const url=string(p.url,'url',4096);
    if(!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url))throw new Failure('INVALID_ARGUMENT','url needs a scheme, e.g. myapp://path or https://…');
    await run(BINARY,['openurl',...deviceArgs(device),url],{mutation:true,timeout:20000});
    agent().forget(device.udid);
    return {udid:device.udid,execution:'executed',note:'Opened. iOS may ask whether to open another App; take a screenshot and tap the system prompt if one appears.'};
  }
  if(method==='install_app') return apps().install(device,p,{terminate:id=>sim(['terminate',device.udid,id],{mutation:true})});
  if(method==='launch_app') {
    const id=bundleId(p.bundleId);
    if(apps().runningFor(device.udid))throw new Failure('INSTALL_RUNNING','An install is still running on this device. Wait with app action=install_status first.');
    const args=['launch'];
    if(p.relaunch!==false)args.push('--terminate-running-process');
    args.push(device.udid,id);
    if(p.arguments!==undefined){
      if(!Array.isArray(p.arguments)||p.arguments.length>50||!p.arguments.every(a=>typeof a==='string'&&a.length<=1000&&!a.includes('\0')))throw new Failure('INVALID_ARGUMENT','arguments must be up to 50 strings');
      args.push(...p.arguments);
    }
    const env={...process.env};
    if(p.env!==undefined){
      if(!p.env||typeof p.env!=='object'||Array.isArray(p.env)||Object.keys(p.env).length>30)throw new Failure('INVALID_ARGUMENT','env must be an object of up to 30 strings');
      for(const [k,v] of Object.entries(p.env)){if(!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(k)||typeof v!=='string'||v.length>4000)throw new Failure('INVALID_ARGUMENT','env names must be identifiers and values strings');env['SIMCTL_CHILD_'+k]=v;}
    }
    agent().forget(device.udid);
    const launched={udid:device.udid,bundleId:id,...await sim(args,{mutation:true,env}),execution:'executed'};
    if(p.showViewer===false)return launched;
    try{return {...launched,viewer:await openViewer(BINARY,DEVICE_SET,children,device.udid,clipboardAction,p._locale)};}
    catch(error){return {...launched,viewer:{previewOpened:false,error:error.message},note:'App launched, but viewer failed. Retry open_viewer, not launch_app.'};}
  }
  if(method==='heal') {
    // Baguette's documented repair sequence, scoped to our private device set.
    const jobs=await sim(['spawn',device.udid,'launchctl','list']);
    const pid=text=>text.split('\n').find(l=>l.trim().endsWith('com.apple.SpringBoard'))?.trim().split(/\s+/)[0];
    const before=pid(jobs.stdout);
    await sim(['spawn',device.udid,'notifyutil','-s','com.apple.coredevice.dtuhidd.active','0'],{timeout:10000,mutation:true});
    await sim(['spawn',device.udid,'launchctl','kickstart','-k','system/com.apple.backboardd'],{timeout:10000,mutation:true});
    const deadline=Date.now()+25000;
    while(Date.now()<deadline) {
      await new Promise(r=>setTimeout(r,500));
      const now=pid((await sim(['spawn',device.udid,'launchctl','list'],{timeout:5000,mutation:true})).stdout);
      if(now&&/^\d+$/.test(now)&&now!==before) return {udid:device.udid,execution:'executed',note:'SpringBoard restarted. Observe UI before continuing.'};
    }
    throw new Failure('HEAL_TIMEOUT','Restart requested but SpringBoard readiness not confirmed','unknown');
  }
}
function reply(value){process.stdout.write(JSON.stringify(value)+'\n');}
function shutdown(){ for(const child of children) child.kill('SIGKILL'); process.exit(0); }
function startWorker() {
  require('./viewer.cjs').reapOrphans(BINARY,DEVICE_SET);
  // In use = a viewer window is open, or another process names a running device.
  const inUse=async()=>{
    if(require('./viewer.cjs').viewing())return true;
    if(appsImpl?.installing())return true;
    const running=(await dispatch('devices')).devices.filter(d=>d.state!=='Shutdown').map(d=>d.udid);
    return (await require('./activity.cjs').externalUse(running)).length>0;
  };
  const runtime=require('./runtime.cjs').createRuntime({dispatch,settingsFile:path.join(ROOT,'runtime-settings.json'),inUse,viewing:()=>require('./viewer.cjs').viewing(),forgetViewer:()=>require('./viewer.cjs').forgetSession(DEVICE_SET),
    tasks:require('./tasks.cjs').createTaskBindings(path.join(ROOT,'task-bindings.json')),
    existingViewerUrl:(udid,locale)=>require('./viewer.cjs').existingViewerUrl(udid,locale)});
  configureControls(runtime);
  const timer=setInterval(()=>runtime.checkIdle().catch(error=>process.stderr.write('[baguette-idle] '+(error.code||'FAILED')+'\n')),15000);
  timer.unref();
  const recycle=setInterval(()=>require('./viewer.cjs').recycleIfBloated().catch(()=>{}),60000);
  recycle.unref();
  let stopping=false;
  const stop=async()=>{
    if(stopping)return;stopping=true;clearInterval(timer);clearInterval(recycle);
    // Host may force termination before this completes. User-facing stop
    // controls await and verify shutdown instead of relying on process exit.
    require('./viewer.cjs').abandonViewer();
    try{await runtime.close();}catch{process.stderr.write('[baguette-exit] Device shutdown not confirmed\n');}
    shutdown();
  };
  const input=readline.createInterface({input:process.stdin});
  input.on('line',async line=>{
    let request;try{request=JSON.parse(line);}catch{return reply({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}});}
    if(request.id===undefined)return;
      try {reply({jsonrpc:'2.0',id:request.id,result:{ok:true,...await runtime.request(request.method,request.params)}});}
      catch(e){reply({jsonrpc:'2.0',id:request.id,result:{ok:false,errorCode:e.code||'FAILED',message:e.message,execution:e.execution||'not_executed'}});}
  });
  input.on('close',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
module.exports={dispatch,DEVICE_SET,BINARY,startWorker,uniqueName};
