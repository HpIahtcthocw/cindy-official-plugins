const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), syncFs = require('node:fs');
const os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
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
function agentFixture({frames=[],streamError=false,streamEvents=[],onDelay,onCommand,clockStep=10}={}) {
  const state={orientation:'portrait',calls:[],files:new Map(),diagnostics:new Map(),inputs:[],imageBytes:4,failWord:null,missingApp:false,turnOnShot:false,failRender:false,failTree:false,treeChildren:[],ocr:null,logEntries:[]};
  state.target={litPanel:'primary',screenId:1,pixelSize:{width:1206,height:2622}};
  const screen=()=>({width:state.width||402,height:874,orientation:state.orientation,target:state.target});
  let clock=0;
  state.advance=ms=>{clock+=ms;};
  state.time=()=>clock;
  const run=async(file,args,options)=>{
    state.calls.push([file,args,options]);
    onCommand?.(file,args,options,state);
    if(args[0]==='input'){if(state.failConfirm||!require('node:util').isDeepStrictEqual(JSON.parse(args[args.indexOf('--expected-screen')+1]),screen()))throw Error('changed');return {stdout:''};}
    if(args[0]==='describe-ui'){if(state.failTree)throw Error('tree unavailable');return {stdout:JSON.stringify({screen:screen(),children:state.treeChildren})};}
    if(args[0]==='screenshot') {state.files.set(args[args.indexOf('--output')+1],Buffer.from('raw'));if(state.turnOnShot)state.orientation='landscape-left';return {stdout:''};}
    if(args[0]===state.failWord)throw new Failure('COMMAND_FAILED','failed','not_executed');
    if(file.endsWith('plutil'))return {stdout:'测试 Game'};
    if(file.endsWith('osascript')) {
      if(args[2].endsWith('ocr.jxa.js')) {if(state.ocr===null)throw Error('OCR unavailable');return {stdout:JSON.stringify(state.ocr)};}
      if(state.failRender)throw new Failure('RENDER_FAILED','image conversion failed');
      const script=args[2];state.files.set(args[script.endsWith('image.jxa.js')?4:3],Buffer.alloc(state.imageBytes,1));
      return {stdout:JSON.stringify({width:402,height:874})};
    }
    return {stdout:''};
  };
  const sim=async args=>{state.calls.push(['sim',args]);if(args[0]==='get_app_container'){if(state.missingApp)throw Error('lookup failed');return {stdout:'/App.app'};}return {stdout:args.includes('show')?state.logEntries.map(e=>JSON.stringify(e)).join('\n'):''};};
  const spawnImpl=(_file,args)=>{
    const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();c.kill=()=>{};
    if(args[0]==='input') {
      c.stdin.write=line=>{state.inputs.push(JSON.parse(line));queueMicrotask(()=>c.stdout.emit('data','{"ok":true}\n'));};
      c.stdin.end=()=>c.emit('exit',0);return c;
    }
    const streaming=args.includes('stream');
    if(streaming){c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>c.emit('close',null,'SIGKILL');}
    queueMicrotask(()=>{
      if(streamError)c.emit('error',Error('stream failed'));else for(const f of frames){if(streaming)c.stdout.write(f);else c.stdout.emit('data',f);}
      for(const {source,event,args:values} of streamEvents){
        if(streaming&&source&&event==='data')c[source].write(values[0]);else (source?c[source]:c).emit(event,...values);
      }
    });return c;
  };
  const context={module:{exports:{}},__dirname:dir,Buffer,Date,
    setTimeout:(fn,ms)=>{const timer=setTimeout(()=>{onDelay?.(ms,state);fn();},ms===2000?2000:0);if(ms===2000)timer.unref();return timer;},clearTimeout,
    require(name){if(name==='node:fs/promises')return {mkdir:async()=>{},readdir:async p=>p.endsWith('DiagnosticReports')?[...state.diagnostics.keys()]:[],stat:async p=>state.diagnostics.get(path.basename(p)),rm:async p=>state.files.delete(p),writeFile:async(p,b)=>state.files.set(p,b),readFile:async p=>{const report=state.diagnostics.get(path.basename(p));if(report)return report.text;if(!state.files.has(p))throw Error('missing');return state.files.get(p);}};
      return require(name.startsWith('./')?path.join(dir,name):name);}};
  vm.runInNewContext(syncFs.readFileSync(path.join(dir,'agent.cjs'),'utf8'),context);
  const agent=context.module.exports.createAgent({binary:'/bag',deviceSet:'/set',root:'/fixture',run,sim,Failure,spawnImpl,now:()=>{clock+=clockStep;return clock;}});
  return {agent,state,device:{udid:A}};
}

test('screenshots and captures share one inline budget and preserve files and execution when the image cannot attach',async()=>{
  const jpeg=Buffer.from([0xff,0xd8,1,2,0xff,0xd9]);
  for(const bytes of [0,130000,130001,700000])for(const enabled of [false,true])for(const execution of ['executed','unknown']) {
    const f=agentFixture({frames:[jpeg]});f.state.imageBytes=bytes;
    const shot=await f.agent.screenshot(f.device,{_inline:enabled,corners:false});
    const capture=await f.agent.capture(f.device,{_inline:enabled,seconds:0.5,action:{tool:'tap'}},async()=>{
      if(execution==='unknown')throw new Failure('ACTION_FAILED','ack lost','unknown');return {execution};
    });
    const attached=enabled&&bytes>0&&bytes<=130000;
    for(const result of [shot,capture]) {
      assert.equal(!!result._modelImages,attached);
      if(attached)assert.equal(Buffer.from(result._modelImages[0].data,'base64').length,bytes);
      assert.ok(f.state.files.has(result.path||result.sheet),'file survives the inline fallback');
      assert.match(result.note,attached?/attached/:/Open/);
    }
    assert.equal(capture.execution,execution);
    if(execution==='unknown')assert.equal(capture.actionError.execution,'unknown');
  }
});

test('tap, scroll and wait distinguish identifiers from same-named labels and never widen an id to OCR',async()=>{
  const f=agentFixture();
  f.state.treeChildren=[
    {role:'AXButton',identifier:'different',label:'checkout',frame:{x:10,y:100,width:80,height:40}},
    {role:'AXButton',identifier:'checkout',label:'Pay',frame:{x:110,y:200,width:80,height:40}},
  ];
  const tapped=await f.agent.tap(f.device,{id:'checkout',observe:'none'});
  assert.equal(tapped.element.id,'checkout');assert.equal(f.state.inputs[0].x,150);
  const scrolled=await f.agent.gesture(f.device,{kind:'scroll_to',id:'checkout',observe:'none'});
  assert.equal(scrolled.element.id,'checkout');assert.equal(scrolled.swipes,0);
  assert.equal((await f.agent.waitFor(f.device,{id:'checkout',timeout:1})).element.id,'checkout');
  f.state.treeChildren.pop();
  await assert.rejects(f.agent.tap(f.device,{id:'checkout',observe:'none'}),e=>e.code==='ELEMENT_NOT_FOUND');
  assert.equal((await f.agent.waitFor(f.device,{id:'checkout',timeout:1})).met,false);
  assert.equal((await f.agent.waitFor(f.device,{id:'checkout',gone:true,timeout:1})).met,true);
  f.state.treeChildren=[];f.state.ocr=[{text:'checkout',box:[0.1,0.1,0.2,0.1]}];
  await assert.rejects(f.agent.tap(f.device,{id:'checkout',text:'checkout',observe:'none'}),e=>e.code==='ELEMENT_NOT_FOUND');
  assert.equal((await f.agent.waitFor(f.device,{id:'checkout',text:'checkout',timeout:1})).met,false);
  assert.ok(!f.state.calls.some(c=>c[1][2]?.endsWith?.('ocr.jxa.js')),'explicit id never falls back to text recognition');
});

test('identifier representation survives the raw AX tree through tap, scroll and present/gone waits',async()=>{
  for(const node of [
    {role:'AXButton',identifier:'checkout',label:'checkout'},
    {role:'AXGroup',identifier:'checkout'},
    {role:'AXGenericElement',identifier:'checkout'},
    {role:'AXButton',identifier:' checkout ',label:'Pay'},
  ]) {
    const f=agentFixture(),id=node.identifier;
    f.state.treeChildren=[
      {role:'AXButton',label:id,frame:{x:10,y:100,width:80,height:40}},
      {...node,frame:{x:110,y:200,width:80,height:40}},
    ];
    assert.equal((await f.agent.describe(f.device,{})).elements[1].id,id);
    assert.equal((await f.agent.tap(f.device,{id,observe:'none'})).element.id,id);
    assert.equal(f.state.inputs[0].x,150,'only the true identifier is tapped');
    assert.equal((await f.agent.gesture(f.device,{kind:'scroll_to',id,observe:'none'})).swipes,0);
    assert.equal((await f.agent.waitFor(f.device,{id,timeout:1})).met,true);
    assert.equal((await f.agent.waitFor(f.device,{id,gone:true,timeout:1})).met,false);
    f.state.treeChildren.pop();
    assert.equal((await f.agent.waitFor(f.device,{id,gone:true,timeout:1})).met,true);
  }
});

test('explicit invalid selectors fail before AX/OCR reads, coordinate input or scrolling',async()=>{
  const f=agentFixture();
  f.state.treeChildren=[{role:'AXButton',label:'Unrelated',frame:{x:10,y:100,width:80,height:40}}];
  for(const key of ['text','id','role'])for(const value of ['', ' \t\n ',null,42]) {
    const selector={text:'Unrelated',[key]:value};
    for(const operation of [
      ()=>f.agent.tap(f.device,{...selector,x:50,y:120,observe:'none'}),
      ()=>f.agent.gesture(f.device,{...selector,kind:'scroll_to'}),
      ()=>f.agent.waitFor(f.device,{...selector,timeout:1}),
      ()=>f.agent.waitFor(f.device,{...selector,gone:true,timeout:1}),
    ])await assert.rejects(operation(),e=>e.code==='INVALID_ARGUMENT'&&e.execution==='not_executed');
  }
  assert.equal(f.state.calls.length,0);assert.equal(f.state.inputs.length,0);
});

test('crash summaries take the latest five from all matching reports regardless of directory order',async()=>{
  const f=agentFixture();
  const report=(minute,device=A)=>({mtimeMs:1000,size:200,text:JSON.stringify({timestamp:`2026-10-22T10:${String(minute).padStart(2,'0')}:00Z`,app_name:'Game'})+'\n'+JSON.stringify({device,procName:'Game'})});
  for(const minute of [2,1,4,3,0,9,8,7,6,5])f.state.diagnostics.set(`Game-${minute}.ips`,report(minute));
  f.state.diagnostics.set('Game-foreign.ips',report(59,B));
  f.state.diagnostics.set('Game-bad.ips',{mtimeMs:1000,size:100,text:'invalid '+A});
  f.state.diagnostics.set('Other-null.ips',{mtimeMs:1000,size:100,text:'null\n'+JSON.stringify({device:A,procName:'Game'})});
  f.state.diagnostics.set('Game-old.ips',{...report(58),mtimeMs:-10000000});
  f.state.diagnostics.set('Game-not-report.txt',report(57));
  for(const minute of [56,55,54,53,52,51]) {
    const helper=report(minute);helper.text=helper.text.replace('"procName":"Game"','"procName":"GameHelper"');
    f.state.diagnostics.set(`GameHelper-${minute}.ips`,helper);
  }
  f.state.diagnostics.set('unrelated-filename.ips',report(10));
  const headerOnly=report(11);headerOnly.text=headerOnly.text.replace(',"procName":"Game"','');
  f.state.diagnostics.set('another-filename.ips',headerOnly);
  const result=await f.agent.logs(f.device,{process:'Game'});
  assert.deepEqual(Array.from(result.crashes,r=>path.basename(r.file)),['another-filename.ips','unrelated-filename.ips',... [9,8,7].map(n=>`Game-${n}.ips`)]);
});

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

test('all wait outcomes retain their result when slow optional images exhaust the shared host budget',async()=>{
  for(const mode of ['log-timeout','log-match','id-timeout','stable-timeout','ocr-timeout']) {
    const f=agentFixture({clockStep:0,frames:mode==='log-match'?[JSON.stringify({eventMessage:'ready'})+'\n']:[],
      onDelay:(ms,s)=>s.advance(ms),
      onCommand:(file,args,options,s)=>{
        // Model commands honoring their supplied timeout; screenshots retry,
        // geometry and OCR compete for the same finite remaining budget.
        const cost=mode==='ocr-timeout'?file.endsWith('osascript')&&args[2].endsWith('ocr.jxa.js')?40000:1000:mode==='log-match'?20000:args[0]==='describe-ui'?16000:20000;
        s.advance(Math.min(cost,options.timeout));
        if(cost>=options.timeout)throw new Failure('COMMAND_TIMEOUT','slow command');
      }});
    const p=mode.startsWith('log')?{log:'ready'}:mode==='stable-timeout'?{stable:1}:mode==='ocr-timeout'?{text:'ready'}:{id:'ready'};
    const result=await f.agent.waitFor(f.device,{...p,timeout:90,screenshot:true,_inline:true});
    assert.equal(result.met,mode==='log-match',mode);
    assert.ok(mode==='ocr-timeout'?result.screenshot.path:result.screenshot.error,mode);
    assert.ok(f.state.time()<=100500,`${mode}: ${f.state.time()}ms`);
    assert.ok(!result.reason?.includes('is attached'));
    assert.ok(f.state.calls.every(([, ,o])=>o.timeout>0&&o.timeout<=40000));
    if(mode==='ocr-timeout')assert.ok(f.state.calls.some(([,args])=>args[2]?.endsWith?.('ocr.jxa.js')));
  }
});

test('supplemental capture retries and inline renders never renew a wait deadline',async()=>{
  for(const phase of ['capture','render','inline']) {
    let captures=0,renders=0;
    const f=agentFixture({clockStep:0,onDelay:(ms,s)=>s.advance(ms),
      onCommand:(file,args,options,s)=>{
        if(args[0]==='screenshot'){
          captures++;
          if(phase==='capture') {s.advance(options.timeout);throw new Failure('COMMAND_TIMEOUT','slow capture');}
        }
        if(file.endsWith('osascript')&&args[2].endsWith('image.jxa.js')){
          renders++;
          if(phase==='inline'&&renders===1)return;
          s.advance(options.timeout);throw new Failure('COMMAND_TIMEOUT','slow render');
        }
      }});
    f.state.imageBytes=130001;
    const result=await f.agent.waitFor(f.device,{log:'never',timeout:90,_inline:true});
    assert.equal(result.met,false);assert.ok(result.screenshot.error);
    assert.ok(f.state.time()<=100300);
    assert.equal(captures,1,'exhausted budget does not start a second capture');
    assert.equal(renders,phase==='capture'?0:phase==='render'?1:2);
    const direct=agentFixture({clockStep:0});
    assert.ok((await direct.agent.screenshot(direct.device,{corners:false})).path);
  }
});

test('live log waits and history use the same message field with eventMessage taking precedence',async()=>{
  for(const entry of [{composedMessage:'ready'},{eventMessage:'',composedMessage:'ready'},{eventMessage:'ready',composedMessage:'ignored'}]) {
    const line=JSON.stringify(entry)+'\n';
    // NDJSON fields can arrive across arbitrary stream chunks.
    const f=agentFixture({frames:[line.slice(0,9),line.slice(9)]});
    f.state.logEntries=[entry];
    const history=await f.agent.logs(f.device,{match:'ready',crashes:false});
    const wait=await f.agent.waitFor(f.device,{log:'ready',timeout:1});
    assert.equal(wait.met,true);assert.equal(wait.line,history.lines[0]);
  }
});

test('live and historical log matching share formatted metadata, message normalization and partial-line parsing',async()=>{
  const entry={timestamp:'2026-10-22 10:00:00.123+0000',messageType:'Error',subsystem:'example.test',category:'network',eventMessage:'x'.repeat(700)+' ready\n now 测试 '};
  const raw=Buffer.from('not json\nnull\n{}\n'+JSON.stringify(entry)),cut=raw.indexOf(Buffer.from('测试'))+1;
  for(const match of ['10:00:00\\.123','\\[error\\]','example\\.test/network','ready now','测试']) {
    const f=agentFixture({frames:[raw.subarray(0,23),raw.subarray(23,cut),raw.subarray(cut)],streamEvents:[{event:'exit',args:[0]},{event:'close',args:[0]}]});
    f.state.logEntries=[null,{},entry];
    const history=await f.agent.logs(f.device,{match,crashes:false});
    const live=await f.agent.waitFor(f.device,{log:match,timeout:1});
    assert.equal(live.met,true);assert.equal(live.line,history.lines[0]);
    assert.ok(!live.line.includes('ready'),'full content is matched while the display remains shortened');
  }
});

test('log stream terminal events settle once, consume trailing output and distinguish failure from timeout',async()=>{
  const ready={source:'stdout',event:'data',args:[JSON.stringify({eventMessage:'ready'})+'\n']};
  const close={event:'close',args:[1]},error={event:'error',args:[Error('spawn failed')]};
  for(const terminal of [close,error]) {
    const success=agentFixture({streamEvents:[ready,terminal,close,ready]});
    assert.equal((await success.agent.waitFor(success.device,{log:'ready',timeout:1})).met,true);
    const failed=agentFixture({streamEvents:[{source:'stderr',event:'data',args:['x'.repeat(5000)+' device shut down']},terminal,ready,close]});
    await assert.rejects(failed.agent.waitFor(failed.device,{log:'ready',timeout:90}),e=>{
      assert.equal(e.code,'LOGS_UNAVAILABLE');
      if(terminal===close){assert.match(e.message,/device shut down/);assert.ok(e.message.length<4100);}
      return true;
    });
    assert.ok(!failed.state.calls.some(c=>c[1][0]==='screenshot'),'infrastructure failure is not a normal wait timeout');
  }
  // exit can precede the final stdout data; only close proves the pipes drained.
  const drained=agentFixture({streamEvents:[{event:'exit',args:[0]},{...ready,args:[JSON.stringify({eventMessage:'ready'})]}, {event:'close',args:[0]}]});
  assert.equal((await drained.agent.waitFor(drained.device,{log:'ready',timeout:1})).met,true);
  const ended=agentFixture({streamEvents:[{event:'close',args:[0]}]});
  await assert.rejects(ended.agent.waitFor(ended.device,{log:'ready',timeout:1}),e=>e.code==='LOGS_UNAVAILABLE');
  const waiting=agentFixture();
  assert.equal((await waiting.agent.waitFor(waiting.device,{log:'ready',timeout:1})).met,false,'timeout kills the stream without turning its own close into a failure');
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

test('capture refuses changed or unconfirmed geometry at action/end boundaries while preserving action execution',async()=>{
  const jpeg=Buffer.from([0xff,0xd8,1,2,0xff,0xd9]);
  const changes=[s=>{s.orientation='landscape-left';},s=>{s.width=800;},s=>{s.target.litPanel='secondary';},s=>{s.target.screenId=2;},s=>{s.target.pixelSize={width:2400,height:2622};},s=>{s.failTree=true;s.failConfirm=true;}];
  for(const change of changes)for(const when of ['action','end'])for(const execution of ['executed','unknown','not_executed']) {
    const f=agentFixture({frames:[jpeg],onDelay:(ms,state)=>{if(ms===500&&when==='end')change(state);}});
    await assert.rejects(f.agent.capture(f.device,{seconds:0.5,action:{tool:'tap'}},async()=>{
      if(when==='action')change(f.state);
      if(execution!=='executed')throw new Failure('ACTION_FAILED','ack lost',execution);
      return {execution};
    }),e=>['SCREEN_CHANGED','SCREEN_UNAVAILABLE'].includes(e.code)&&e.execution===execution);
    assert.ok(!f.state.calls.some(c=>c[1][2]?.endsWith?.('sheet.jxa.js')),'uncertain geometry never produces a misleading sheet');
  }
  const f=agentFixture({frames:[jpeg],onDelay:(ms,state)=>{if(ms===500)state.orientation='landscape-left';}});
  await assert.rejects(f.agent.capture(f.device,{seconds:0.5},()=>{}),e=>e.code==='SCREEN_CHANGED'&&e.execution==='not_executed');
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
    await context.page.showScreen({udid:A});await context.page.showScreen({udid:A});
    assert.equal(requests.length,1,'same-device pending render reuses its owner instead of causing BUSY');
    const current=context.page.showScreen({udid:B});requests[1].resolve({ok:true,url:'http://127.0.0.1:1/control?udid=B'});await current;
    if(lateFails)requests[0].reject(Error('late error'));else requests[0].resolve({ok:true,url:'http://127.0.0.1:1/control?udid=A'});
    await old;assert.match(get('screen').src,/udid=B/);assert.equal(get('screen').hidden,false);
    // A -> B -> A: device id alone is insufficient to identify an in-flight request.
    const firstA=context.page.showScreen({udid:A}),middle=context.page.showScreen({udid:B}),lastA=context.page.showScreen({udid:A});
    assert.equal(get('screen').src,'about:blank','a pending selection never leaves the previous device interactive');
    requests[4].resolve({ok:true,url:'http://127.0.0.1:1/control?udid=A&new=1'});await lastA;
    requests[2].reject(Error('obsolete A'));requests[3].reject(Error('obsolete B'));await Promise.all([firstA,middle]);
    assert.match(get('screen').src,/new=1/);assert.equal(get('screen').hidden,false);
    const pending=context.page.showScreen({udid:B});context.page.hero(null);
    requests[5].resolve({ok:true,url:'http://127.0.0.1:1/control?udid=B'});await pending;
    assert.equal(get('screen').hidden,true,'off/empty selection retires pending requests too');
  }
});

test('input acknowledgement loss is unknown, while a proven display bind rejection is not executed',async()=>{
  for(const mode of ['exit','error','stdin','timeout','malformed','null','bind']) {
    let child;
    const context={module:{exports:{}},setTimeout:(fn)=>setImmediate(fn),clearTimeout:clearImmediate,
      require:n=>require(n.startsWith('./')?path.join(dir,n):n)};
    vm.runInNewContext(syncFs.readFileSync(path.join(dir,'input.cjs'),'utf8'),context);
    const input=context.module.exports;
    const session=input.openSession('/bag',[],{spawnImpl:()=>{
      child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.kill=()=>{};
      child.stdin.write=()=>queueMicrotask(()=>{
        if(mode==='bind'){child.stderr.emit('data','display bind failed: changed');child.emit('exit',1);}
        if(mode==='exit')child.emit('exit',1);
        if(mode==='error')child.emit('error',Error('transport failed'));
        if(mode==='stdin')child.stdin.emit('error',Error('EPIPE'));
        if(mode==='malformed')child.stdout.emit('data','invalid json\n');
        if(mode==='null')child.stdout.emit('data','null\n');
      });return child;
    }});
    await assert.rejects(input.perform(session,[{envelope:{type:'tap'},waitMs:0}]),e=>e.execution===(mode==='bind'?'not_executed':'unknown'));
  }
});

test('fresh tree and OCR failures never prove that a button is present or text has disappeared',async()=>{
  const f=agentFixture();f.state.treeChildren=[{role:'AXButton',label:'OK',frame:{x:0,y:0,width:50,height:50}}];
  await f.agent.describe(f.device,{});f.state.failTree=true;
  await assert.rejects(f.agent.describe(f.device,{}),e=>e.code==='SCREEN_UNAVAILABLE');
  await assert.rejects(f.agent.tap(f.device,{text:'OK',observe:'none'}),e=>e.code==='SCREEN_UNAVAILABLE');
  assert.equal((await f.agent.waitFor(f.device,{text:'OK',gone:true,timeout:1})).met,false);
  const game=agentFixture();
  assert.equal((await game.agent.waitFor(game.device,{text:'Loading',gone:true,timeout:1})).met,false,'failed OCR is not evidence of absence');
  game.state.ocr=[];
  assert.equal((await game.agent.waitFor(game.device,{text:'Loading',gone:true,timeout:1})).met,true,'a successful empty read does prove absence');
});

test('explicit viewer close survives task polling and worker restart; an unexpected exit can reconnect',async t=>{
  const {createRuntime}=require(path.join(dir,'runtime.cjs'));let wanted=true,live=false,opens=0;
  const bindings=new Map([['task-1',{udid:A}]]),settingsFile=path.join(await temporary(t),'settings.json');
  const make=()=>createRuntime({settingsFile,viewerWanted:()=>wanted,forgetViewer:()=>{wanted=false;},
    existingViewerUrl:()=>live?'http://127.0.0.1:1/control?udid=A#token':null,
    tasks:{get:async s=>bindings.get(s),counts:async()=>({}),bind:async(s,udid)=>bindings.set(s,{udid})},
    dispatch:async(method)=>{if(method==='devices')return {devices:[{udid:A,state:'Booted'}]};if(method==='close_viewer')live=false;if(method==='open_viewer'){opens++;live=true;wanted=true;return {url:'http://127.0.0.1:1/control?udid=A#token'};}return {ok:true};}});
  let runtime=make();await runtime.request('task_state',{_task:'task-1'});assert.equal(opens,1);
  await runtime.request('viewer',{action:'close'});
  for(let i=0;i<2;i++){const state=await runtime.request('task_state',{_task:'task-1'});assert.equal(state.viewer,null);assert.equal(state.viewerClosed,true);}
  runtime=make();assert.equal((await runtime.request('task_state',{_task:'task-1'})).viewer,null);assert.equal(opens,1);
  const reopened=await runtime.request('task_bind',{_task:'task-1',udid:A});assert.equal(opens,2);assert.equal(reopened.viewerClosed,false);assert.ok(reopened.viewer);
  live=false;runtime=make();assert.ok((await runtime.request('task_state',{_task:'task-1'})).viewer);assert.equal(opens,3);
});

test('launches reuse the shared lock for app records without serializing unrelated device reads',async t=>{
  const {createRuntime}=require(path.join(dir,'runtime.cjs'));const root=await temporary(t),hold=deferred(),started=deferred();
  const settingsFile=path.join(root,'settings.json');
  const dispatch=async(method,p={})=>{if(method==='launch_app'&&p.udid===A){started.resolve();await hold.promise;}return {ok:true};};
  const runtime=createRuntime({settingsFile,dispatch});
  const first=runtime.request('launch_app',{udid:A,bundleId:'test.example.a'});await started.promise;
  await assert.rejects(runtime.request('launch_app',{udid:B,bundleId:'test.example.b'}),e=>e.code==='BUSY');
  for(const method of ['app_uninstall','erase_device','delete_device'])await assert.rejects(runtime.request(method,{udid:B,bundleId:'test.example.b'}),e=>e.code==='BUSY');
  assert.deepEqual(await runtime.request('logs',{udid:B}),{ok:true});
  hold.resolve();await first;await runtime.request('launch_app',{udid:B,bundleId:'test.example.b'});
  const reloaded=createRuntime({settingsFile,dispatch});
  assert.equal(await reloaded.currentApp(A),'test.example.a');assert.equal(await reloaded.currentApp(B),'test.example.b');
});

function pageFixture(kind) {
  const nodes=new Map(),requests=[];let push;
  const get=id=>{
    if(!nodes.has(id))nodes.set(id,{replaceChildren(){},append(){},querySelector(){return null;},classList:{contains:()=>false,toggle(){}}});
    return nodes.get(id);
  };
  const context={URLSearchParams,location:{search:'?session=task-1'},document:{getElementById:get,addEventListener(){},hidden:false},
    localStorage:{getItem:()=>null},clearTimeout(){},setTimeout:()=>0,
    CindySimPages:{locale:()=>new Promise(()=>{}),onPush:fn=>{push=fn;},createDevice:async()=>({udid:B}),
      rpc:(action,params)=>{const d=deferred();requests.push({...d,action,params});return d.promise;},
      h:()=>({}),GLYPH:{iphone:'',big:'',pause:''}},CindySimModel:{runtimeLabel:()=>'',deviceRows:()=>[]}};
  const expose=kind==='task'
    ? 'globalThis.page={refresh,act,createDevice,state:()=>state,note:()=>note,seed:r=>{state=r;show(r.viewer?.url);}};'
    : 'globalThis.page={refresh,act,showScreen,hero,state:()=>state,seed:r=>{state=r;selected=r.devices[0]?.udid;}};';
  vm.runInNewContext(syncFs.readFileSync(path.resolve(`baguette-simulator/${kind}.js`),'utf8')+'\n'+expose,context);
  return {page:context.page,get,requests,push:m=>push(m)};
}
const taskState=udid=>({ok:true,settings:{enabled:true},devices:[],device:{udid,state:'Booted'},viewer:{url:`http://127.0.0.1:1/control?udid=${udid}`}});

test('task RPC results have one owner across polling, binding, boot, creation and viewer pushes',async()=>{
  for(const lateFails of [false,true])for(const action of ['task_bind','task_boot','create']) {
    const f=pageFixture('task');f.page.seed(taskState(A));
    const old=f.page.refresh();
    const current=action==='create'?f.page.createDevice():f.page.act(action,{udid:B},B);
    await new Promise(r=>setImmediate(r));
    await f.page.refresh();assert.equal(f.requests.length,2,'polls do not overlap an action');
    f.requests[1].resolve(taskState(B));await current;
    if(lateFails)f.requests[0].reject(Error('old device unavailable'));else f.requests[0].resolve(taskState(A));
    await old;
    assert.equal(f.page.state().device.udid,B);assert.match(f.get('screen').src,new RegExp(B));assert.equal(f.page.note(),null);
  }
  for(const lateFails of [false,true]) {
    const f=pageFixture('task');f.page.seed(taskState(A));
    const first=f.page.refresh(),second=f.page.refresh();
    f.requests[1].resolve(taskState(B));await second;
    if(lateFails)f.requests[0].reject(Error('late poll'));else f.requests[0].resolve(taskState(A));
    await first;assert.match(f.get('screen').src,new RegExp(B));assert.equal(f.page.note(),null);
    const action=f.page.act('task_bind',{udid:A},A);
    f.push({type:'viewer',sessionId:'task-1',url:taskState(B).viewer.url});
    if(lateFails)f.requests[2].reject(Error('late bind'));else f.requests[2].resolve(taskState(A));
    await action;assert.match(f.get('screen').src,new RegExp(B));assert.equal(f.page.note(),null);
  }
});

test('management actions retire old refreshes and unload the iframe for shutdown, erase and delete',async()=>{
  for(const action of ['shutdown','erase','delete'])for(const fails of [false,true]) {
    const f=pageFixture('manage'),d={udid:A,name:'Phone',state:'Booted'};
    const state={ok:true,settings:{enabled:true},devices:[d]};f.page.seed(state);
    const opening=f.page.showScreen(d);f.requests[0].resolve({ok:true,url:taskState(A).viewer.url});await opening;
    const old=f.page.refresh(),operation=f.page.act(action,d);
    assert.equal(f.get('screen').src,'about:blank','starting the action unloads the real frame');
    assert.equal(f.get('screen').hidden,true);
    f.requests[1].resolve(state);await old;
    assert.equal(f.get('screen').src,'about:blank','old manage_state cannot reopen it');
    if(fails)f.requests[2].reject(Error('action failed'));else f.requests[2].resolve({ok:true});
    await new Promise(r=>setImmediate(r));
    const read=f.requests.at(-1);assert.equal(read.action,'manage_state');
    const devices=action==='delete'?[]:[{...d,state:'Shutdown'}];read.resolve({...state,devices});await operation;
    assert.equal(f.get('screen').src,'about:blank');assert.equal(f.get('screen').hidden,true);
  }
  // A new viewer request has no URL yet while an older iframe is still loaded.
  const f=pageFixture('manage');f.page.seed({ok:true,devices:[],settings:{enabled:true}});
  const first=f.page.showScreen({udid:A});f.requests[0].resolve({ok:true,url:taskState(A).viewer.url});await first;
  const pending=f.page.showScreen({udid:B});f.page.hero(null);
  assert.equal(f.get('screen').src,'about:blank');
  f.requests[1].resolve({ok:true,url:taskState(B).viewer.url});await pending;
  assert.equal(f.get('screen').src,'about:blank','late viewer cannot resurrect an unloaded page');
});
