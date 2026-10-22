const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), syncFs = require('node:fs');
const os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {execFile} = require('node:child_process');
const exec = require('node:util').promisify(execFile);
const dir = path.resolve('baguette-simulator/node');
const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
class Failure extends Error { constructor(code,message,execution='not_executed') {super(message);Object.assign(this,{code,execution});} }
async function temporary(t) {const root=await fs.mkdtemp(path.join(os.tmpdir(),'bag-review-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('bundle comparison detects equal-size equal-time resource changes; registration changes use installd', async t => {
  const root=await temporary(t), source=path.join(root,'Build.app'), installed=path.join(root,'Installed.app');
  const info={CFBundleIdentifier:'test.example.game',CFBundleExecutable:'Game',CFBundleVersion:'1'};
  for(const folder of [source,installed]) {
    await fs.mkdir(folder);await fs.writeFile(path.join(folder,'Info.plist'),JSON.stringify(info));
    await fs.writeFile(path.join(folder,'Game'),'executable');await fs.writeFile(path.join(folder,'asset'),'old');
  }
  const stamp=new Date('2026-01-01T00:00:00Z');
  await fs.writeFile(path.join(source,'asset'),'new');
  for(const folder of [source,installed]) await fs.utimes(path.join(folder,'asset'),stamp,stamp);
  let full=0, terminateError=null, syncWrites=0;
  const apps=require(path.join(dir,'apps.cjs')).createApps({Failure,
    sim:async args=>{if(args[0]==='get_app_container')return {stdout:installed};if(args[0]==='install'){full++;await fs.cp(source,installed,{recursive:true});}return {stdout:''};},
    run:async(file,args)=>{
      if(file.endsWith('plutil'))return {stdout:await fs.readFile(args.at(-1),'utf8')};
      if(!args.includes('--dry-run'))syncWrites++;
      return exec(file,args);
    }});
  const device={udid:A}, terminate=async()=>{if(terminateError)throw terminateError;};
  assert.equal((await apps.info(device,{appPath:source})).matchesLocal,false);
  terminateError=new Failure('COMMAND_FAILED','device is unresponsive','unknown');
  await assert.rejects(apps.install(device,{appPath:source},{terminate}),e=>e.execution==='unknown');
  assert.equal(syncWrites,0);assert.equal(await fs.readFile(path.join(installed,'asset'),'utf8'),'old');
  // Confirmed "not running" is the only termination failure that permits sync.
  terminateError=new Failure('COMMAND_FAILED','No matching processes','unknown');
  assert.equal((await apps.install(device,{appPath:source},{terminate})).mode,'sync');
  assert.equal((await apps.info(device,{appPath:source})).matchesLocal,true);
  assert.equal(await fs.readFile(path.join(installed,'asset'),'utf8'),'new');
  assert.equal(full,0);
  await fs.mkdir(path.join(source,'PlugIns','Extension.appex'),{recursive:true});
  await fs.writeFile(path.join(source,'PlugIns','Extension.appex','Info.plist'),JSON.stringify({CFBundleIdentifier:'test.example.extension'}));
  assert.equal((await apps.install(device,{appPath:source},{terminate})).mode,'full');assert.equal(full,1);
  await fs.writeFile(path.join(source,'Info.plist'),JSON.stringify({...info,CFBundleURLTypes:[{CFBundleURLSchemes:['testgame']}]}));
  const job=await apps.install(device,{appPath:source},{terminate});assert.equal(job.mode,'full');assert.equal(full,2);
  await assert.rejects(apps.status({udid:A,job:'expired',wait:0}),e=>e.code==='JOB_NOT_FOUND');
  await assert.rejects(apps.status({udid:B,job:job.job,wait:0}),e=>e.code==='JOB_NOT_FOUND');
  assert.equal((await apps.status({udid:A,wait:0})).job,job.job);
});

test('background install retains the device lock through success and failure, while reads and other devices proceed', async t => {
  const {createRuntime}=require(path.join(dir,'runtime.cjs'));
  for(const fail of [false,true]) {
    const job=deferred(), calls=[];let writing=false;
    const runtime=createRuntime({settingsFile:path.join(await temporary(t),'settings.json'),
      pendingOperation:udid=>writing&&(!udid||udid===A)?job.promise:null,
      dispatch:async(method,p={})=>{calls.push(method);if(method==='app_install'){writing=true;return {state:'running'};}if(method==='devices')return {devices:[]};return {ok:true};}});
    await runtime.request('app',{action:'install',udid:A});
    for(const [method,p] of [['shutdown',{udid:A}],['erase_device',{udid:A}],['delete_device',{udid:A}],['settings_shutdown',{udid:A}],['settings_stop_all',{}],['settings_save',{enabled:false,idleMinutes:15}],['viewer_switch',{udid:A,targetUdid:B}]]) {
      await assert.rejects(runtime.request(method,p),e=>['BUSY','DEVICE_NOT_OWNED'].includes(e.code));
    }
    assert.ok(!calls.includes('shutdown')&&!calls.includes('erase_device')&&!calls.includes('delete_device'));
    assert.deepEqual(await runtime.request('tap',{udid:B}),{ok:true});
    assert.deepEqual(await runtime.request('app',{action:'install_status',udid:A}),{ok:true});
    writing=false;if(fail)job.reject(new Failure('INSTALL_FAILED','write failed','unknown'));else job.resolve();
    await new Promise(resolve=>setImmediate(resolve));
    await runtime.request('shutdown',{udid:A});assert.ok(calls.includes('shutdown'));
  }
});

// One deterministic harness for read, mutate and capture outcomes. No simulator,
// image tool or real timers; each test exercises the production Agent methods.
function agentFixture({frames=[],streamError=false}={}) {
  const state={orientation:'portrait',calls:[],files:new Map(),failWord:null,missingApp:false,turnOnShot:false,failRender:false};
  const screen=()=>({width:402,height:874,orientation:state.orientation,target:{litPanel:'primary',screenId:1,pixelSize:{width:1206,height:2622}}});
  const run=async(file,args)=>{
    state.calls.push([file,args]);
    if(args[0]==='input'){if(JSON.parse(args[args.indexOf('--expected-screen')+1]).orientation!==state.orientation)throw Error('changed');return {stdout:''};}
    if(args[0]==='describe-ui')return {stdout:JSON.stringify({screen:screen(),children:[]})};
    if(args[0]==='screenshot') {state.files.set(args[args.indexOf('--output')+1],Buffer.from('raw'));if(state.turnOnShot)state.orientation='landscape-left';return {stdout:''};}
    if(args[0]===state.failWord)throw new Failure('COMMAND_FAILED','failed','not_executed');
    if(file.endsWith('plutil'))return {stdout:'测试 Game'};
    if(file.endsWith('osascript')) {
      if(state.failRender)throw new Failure('RENDER_FAILED','image conversion failed');
      const script=args[2];state.files.set(args[script.endsWith('image.jxa.js')?4:3],Buffer.from('jpeg'));
      return {stdout:JSON.stringify({width:402,height:874})};
    }
    return {stdout:''};
  };
  const sim=async args=>{state.calls.push(['sim',args]);if(args[0]==='get_app_container'){if(state.missingApp)throw Error('lookup failed');return {stdout:'/App.app'};}return {stdout:''};};
  const spawnImpl=()=>{
    const c=new EventEmitter();c.stdout=new EventEmitter();c.stdin=new EventEmitter();c.kill=()=>{};
    queueMicrotask(()=>{if(streamError)c.emit('error',Error('stream failed'));else for(const f of frames)c.stdout.emit('data',f);});return c;
  };
  const context={module:{exports:{}},__dirname:dir,Buffer,Date,
    setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms===2000?2000:0);if(ms===2000)timer.unref();return timer;},clearTimeout,
    require(name){if(name==='node:fs/promises')return {mkdir:async()=>{},readdir:async()=>[],rm:async p=>state.files.delete(p),writeFile:async(p,b)=>state.files.set(p,b),readFile:async p=>{if(!state.files.has(p))throw Error('missing');return state.files.get(p);}};
      return require(name.startsWith('./')?path.join(dir,name):name);}};
  vm.runInNewContext(syncFs.readFileSync(path.join(dir,'agent.cjs'),'utf8'),context);
  const agent=context.module.exports.createAgent({binary:'/bag',deviceSet:'/set',root:'/fixture',run,sim,Failure,spawnImpl});
  return {agent,state,device:{udid:A}};
}

test('explicit log scope is shared by history and waits and never widens after lookup or validation failure', async()=>{
  const {agent,state,device}=agentFixture();state.missingApp=true;
  for(const call of [()=>agent.logs(device,{bundleId:'test.example.missing',crashes:false}),()=>agent.waitFor(device,{bundleId:'test.example.missing',log:'ready',timeout:1})]) {
    await assert.rejects(call(),e=>e.code==='APP_NOT_INSTALLED');
  }
  assert.ok(!state.calls.some(c=>c[1].includes('show')||c[1].includes('stream')));
  for(const process of ['',42,'bad\nprocess','a'.repeat(101)])await assert.rejects(agent.logs(device,{process,crashes:false}),e=>e.code==='INVALID_ARGUMENT');
  await agent.logs(device,{process:'测试 "Game"',crashes:false});
  const args=state.calls.find(c=>c[1].includes('show'))[1];assert.equal(args[args.indexOf('--predicate')+1],'process == '+JSON.stringify('测试 "Game"'));
});

test('compound state requests validate all fields before mutating and preserve partial execution on command failure', async()=>{
  const {agent,state,device}=agentFixture();
  for(const invalid of [{network:{}},{location:{}},{network:{latency:null}},{privacy:{action:'grant',service:'camera'}},{contrast:'yes'},{status_bar:'invalid'}]) {
    await assert.rejects(agent.setState(device,{orientation:'landscape-left',...invalid}),e=>e.code==='INVALID_ARGUMENT'&&e.execution==='not_executed');
  }
  assert.equal(state.calls.length,0);
  state.failWord='network';
  await assert.rejects(agent.setState(device,{orientation:'landscape-left',network:'wifi'}),e=>e.execution==='unknown');
  assert.deepEqual(state.calls.map(c=>c[1][0]),['orientation','network']);
});

test('screenshots reject a rotation during capture and refresh a rotation inside the former cache window', async()=>{
  const {agent,state,device}=agentFixture();await agent.describe(device,{});
  state.orientation='landscape-left';
  const shot=await agent.screenshot(device,{corners:false});assert.equal(shot.screen.width,874);assert.equal(shot.screen.orientation,'landscape-left');
  state.orientation='portrait';state.turnOnShot=true;
  await assert.rejects(agent.screenshot(device,{corners:false}),e=>e.code==='SCREEN_CHANGED');
});

test('a log wait timeout includes the current screenshot without a separate request',async()=>{
  const {agent,device}=agentFixture();
  const result=await agent.waitFor(device,{log:'never printed',timeout:1});
  assert.equal(result.met,false);assert.ok(result.screenshot.path);
});

test('capture keeps same-length different frames and carries action execution through every result path', async()=>{
  const a=Buffer.from([0xff,0xd8,1,2,0xff,0xd9]),b=Buffer.from([0xff,0xd8,3,4,0xff,0xd9]);
  for(const frames of [[],[a,a,b]]) for(const execution of ['not_executed','executed','unknown']) {
    const {agent,device}=agentFixture({frames});
    const capture=agent.capture(device,{action:{tool:'tap'},seconds:0.5},async()=>{throw new Failure('ACTION_FAILED','action failed',execution);});
    if(!frames.length)await assert.rejects(capture,e=>e.code==='CAPTURE_EMPTY'&&e.execution===execution);
    else {const result=await capture;assert.equal(result.execution,execution);assert.equal(result.actionError.execution,execution);assert.equal(result.distinct,2);}
  }
  const f=agentFixture({frames:[a]});f.state.failRender=true;
  await assert.rejects(f.agent.capture(f.device,{action:{tool:'tap'},seconds:0.5},async()=>({execution:'executed'})),e=>e.execution==='executed');
  const broken=agentFixture({streamError:true});
  await assert.rejects(broken.agent.capture(broken.device,{action:{tool:'tap'},seconds:0.5},async()=>({execution:'executed'})),e=>e.code==='CAPTURE_EMPTY'&&e.execution==='executed');
});

test('hidden subtrees and unreachable centres never become text tap targets; 3D zoom stays relative to fit',()=>{
  const G=require(path.join(dir,'geometry.cjs')),M=require(path.join(dir,'control-model.js'));
  const frame={x:0,y:0,width:50,height:40},child={role:'AXButton',label:'Wrong',frame};
  const result=G.compactTree({children:[{hidden:true,children:[child]},{children:[{...child,label:'Right'}]}]},{width:100,height:100,orientation:'portrait'});
  assert.deepEqual(result.elements.map(e=>e.label),['Right']);
  assert.equal(G.findElement([{role:'button',label:'Wrong',center:[-1,10]}],{text:'Wrong',view:{width:100,height:100}}).element,null);
  assert.equal(M.zoomFactor({mode:'pct',pct:150},0),1.5);
});

test('parallel viewer startup shares native process and bridge; stop owns both exactly once',async()=>{
  let launches=0,bridges=0,closed=0;const children=new Set();
  const context={module:{exports:{}},__dirname:dir,process:{stderr:{write(){}}},setTimeout,clearTimeout,
    require(name){
      if(name==='node:fs')return {readFileSync:()=>{throw Error('no saved session');},mkdirSync(){},writeFileSync(){},renameSync(){}};
      if(name==='./clipboard.cjs')return {createClipboard:async()=>{bridges++;await new Promise(r=>setImmediate(r));return {devices:new Set(),base:'http://127.0.0.1:1',fragment:'capability',session:{port:1,token:'test'},close:()=>closed++};}};
      if(name==='node:child_process')return {spawn(){launches++;const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.exitCode=null;child.signalCode=null;child.kill=signal=>{child.signalCode=signal;queueMicrotask(()=>child.emit('close',null,signal));};queueMicrotask(()=>child.stdout.emit('data',Buffer.from('listening')));return child;}};
      if(name==='node:http')return {get(url,opts,callback){const request=new EventEmitter(),response=new EventEmitter();response.statusCode=200;response.resume=()=>{};queueMicrotask(()=>{callback(response);response.emit('end');});return request;}};
      return require(name);
    }};
  vm.runInNewContext(syncFs.readFileSync(path.join(dir,'viewer.cjs'),'utf8'),context);
  const viewer=context.module.exports;
  const result=await Promise.all([viewer.openViewer('/bag','/set',children,A,async()=>{}),viewer.openViewer('/bag','/set',children,B,async()=>{})]);
  assert.equal(launches,1);assert.equal(bridges,1);assert.equal(children.size,1);assert.equal(result.length,2);
  await viewer.stopViewer();assert.equal(closed,1);assert.equal(children.size,0);
});

test('management view ignores late viewer successes and failures, including returning to the same device',async()=>{
  for(const lateFails of [false,true]) {
    const nodes=new Map(),requests=[];
    const get=id=>{if(!nodes.has(id))nodes.set(id,{replaceChildren(){}});return nodes.get(id);};
    const context={document:{getElementById:get,addEventListener(){}},localStorage:{getItem:()=>null},
      CindySimPages:{locale:()=>new Promise(()=>{}),rpc:()=>{const d=deferred();requests.push(d);return d.promise;},h:()=>({}),GLYPH:{}},CindySimModel:{}};
    vm.runInNewContext(syncFs.readFileSync(path.resolve('baguette-simulator/manage.js'),'utf8')+'\nglobalThis.page={showScreen,hero};',context);
    const old=context.page.showScreen({udid:A});
    const current=context.page.showScreen({udid:B});requests[1].resolve({ok:true,url:'http://127.0.0.1:1/control?udid=B'});await current;
    if(lateFails)requests[0].reject(Error('late error'));else requests[0].resolve({ok:true,url:'http://127.0.0.1:1/control?udid=A'});
    await old;assert.match(get('screen').src,/udid=B/);assert.equal(get('screen').hidden,false);
    // A -> B -> A: device id alone is insufficient to identify an in-flight request.
    const firstA=context.page.showScreen({udid:A}),middle=context.page.showScreen({udid:B}),lastA=context.page.showScreen({udid:A});
    requests[4].resolve({ok:true,url:'http://127.0.0.1:1/control?udid=A&new=1'});await lastA;
    requests[2].reject(Error('obsolete A'));requests[3].reject(Error('obsolete B'));await Promise.all([firstA,middle]);
    assert.match(get('screen').src,/new=1/);assert.equal(get('screen').hidden,false);
    const pending=context.page.showScreen({udid:B});context.page.hero(null);
    requests[5].resolve({ok:true,url:'http://127.0.0.1:1/control?udid=B'});await pending;
    assert.equal(get('screen').hidden,true,'off/empty selection retires pending requests too');
  }
});
