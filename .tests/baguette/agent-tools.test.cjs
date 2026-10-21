const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs');const os=require('node:os');
const node=path.join(__dirname,'../../baguette-simulator/node');
const G=require(path.join(node,'geometry.cjs'));const input=require(path.join(node,'input.cjs'));

test('view points round-trip through every orientation, and frames turn with the screen',()=>{
 const W=402,H=874;
 for(const orientation of Object.keys(G.ROTATION)){
  const screen={width:W,height:H,orientation},view=G.viewSize(screen);
  assert.deepEqual(view,G.ROTATION[orientation]%180?{width:H,height:W}:{width:W,height:H});
  for(const [x,y] of [[0,0],[10,20],[view.width-1,view.height-5]]){
   const n=G.toNative(screen,x,y);assert.ok(n.x>=0&&n.x<=W&&n.y>=0&&n.y<=H,orientation);
   assert.deepEqual(G.toView(screen,n.x,n.y),{x,y},orientation);
  }
 }
 // landscape-left is the viewer's rotate(90deg): native top edge becomes the view's right edge.
 const ll={width:W,height:H,orientation:'landscape-left'};
 assert.deepEqual(G.toView(ll,201,0),{x:874,y:201});
 // Measured on iOS 27 Safari: the first paragraph's native frame sits near the view's top.
 assert.deepEqual(G.frameToView(ll,{x:119,y:230,width:46,height:414}),{x:230,y:119,width:414,height:46});
});

test('compact tree keeps actionable and readable elements in reading order, drops rotated status-bar sweep items',()=>{
 const screen={width:402,height:874,orientation:'portrait'};
 const tree={role:'AXApplication',frame:{x:0,y:0,width:402,height:874},children:[
  {role:'AXGroup',frame:{x:0,y:0,width:402,height:874},children:[
   {role:'AXButton',label:'Continue',frame:{x:150,y:600,width:100,height:44}},
   {role:'AXStaticText',label:'Welcome',frame:{x:20,y:100,width:200,height:30}},
   {role:'AXButton',label:'Hidden',hidden:true,frame:{x:0,y:0,width:10,height:10}},
   {role:'AXButton',label:'Offscreen',frame:{x:0,y:2000,width:10,height:10}},
   {role:'AXTextField',identifier:'email',value:'a@example.test',frame:{x:20,y:300,width:360,height:44}},
   {role:'AXGenericElement',label:'Dynamic Island',frame:{x:138,y:14,width:125,height:37}},
  ]}]};
 const {elements}=G.compactTree(tree,screen);
 assert.deepEqual(elements.map(e=>e.label||e.id),['Dynamic Island','Welcome','email','Continue']);
 assert.deepEqual(elements.find(e=>e.label==='Continue').center,[200,622]);
 const rotated=G.compactTree(tree,{...screen,orientation:'landscape-left'}).elements;
 assert.ok(!rotated.some(e=>e.label==='Dynamic Island'));
 assert.deepEqual(G.compactTree(tree,screen,{query:'cont'}).elements.map(e=>e.label),['Continue']);
});

test('element lookup prefers exact, then actionable, then reading order and nth',()=>{
 const els=[{role:'text',label:'Sign in to continue',center:[1,1]},{role:'button',label:'Sign in',center:[2,2]},{role:'button',label:'Sign in',center:[3,3]},{role:'text',label:'Sign in',center:[4,4]}];
 assert.deepEqual(G.findElement(els,{text:'sign in'}).element.center,[2,2]);
 assert.equal(G.findElement(els,{text:'sign in'}).matches,2);
 assert.deepEqual(G.findElement(els,{text:'sign in',nth:1}).element.center,[3,3]);
 assert.deepEqual(G.findElement(els,{text:'continue'}).element.center,[1,1]);
 assert.equal(G.findElement(els,{text:'nothing'}).element,null);
});

test('touch plans: double tap is two finger touches on one session, drag holds first, edges follow rotation, all in native points',()=>{
 const screen={width:402,height:874,orientation:'portrait'};
 const dbl=input.plan(screen,{kind:'tap',x:100,y:200,count:2}).map(s=>s.envelope.type);
 assert.deepEqual(dbl,['touch1-down','touch1-up','touch1-down','touch1-up']);
 const drag=input.plan(screen,{kind:'drag',from:[10,10],to:[100,100],hold:0.6});
 assert.equal(drag[0].envelope.type,'touch1-down');assert.equal(drag[0].waitMs,600);assert.equal(drag.at(-1).envelope.type,'touch1-up');
 assert.ok(drag.every(s=>s.envelope.width===402&&s.envelope.height===874));
 const ll={width:402,height:874,orientation:'landscape-left'};
 const tap=input.plan(ll,{kind:'tap',x:874,y:201})[0].envelope;
 assert.deepEqual([tap.x,tap.y],[201,0]);
 assert.equal(input.nativeEdgeOf(ll,'bottom'),'right');assert.equal(input.nativeEdgeOf({orientation:'landscape-right'},'bottom'),'left');
 assert.equal(input.nativeEdgeOf({orientation:'portrait-upside-down'},'bottom'),'top');
 const edge=input.plan(screen,{kind:'edge',edge:'bottom',view:{width:402,height:874}});
 assert.ok(edge.every(s=>s.envelope.edge==='bottom'));
 const pinch=input.plan(screen,{kind:'pinch',center:[200,400],from:60,to:240,duration:0.2}).map(s=>s.envelope.type);
 assert.equal(pinch[0],'touch2-down');assert.equal(pinch.at(-1),'touch2-up');
});

test('a rejected touch releases the finger and reports whether anything was delivered',async()=>{
 const sent=[];
 const session={send:async e=>{sent.push(e.type);return e.type==='touch1-move'?{ok:false,error:'screen target changed'}:{ok:true};}};
 const steps=input.plan({width:402,height:874,orientation:'portrait'},{kind:'drag',from:[10,10],to:[50,50],hold:0,duration:0.05});
 await assert.rejects(input.perform(session,steps),e=>e.code==='INPUT_FAILED'&&e.execution==='unknown');
 assert.deepEqual(sent.slice(0,3),['touch1-down','touch1-move','touch1-up']);
});

function fakeApps({installed,changed=0}){
 const calls=[];
 const plists={'/build/Game.app':{CFBundleIdentifier:'com.example.game',CFBundleExecutable:'Game',CFBundleShortVersionString:'1.0',CFBundleVersion:'7'},
  '/sim/Game.app':installed&&{CFBundleIdentifier:'com.example.game',CFBundleExecutable:'Game',CFBundleShortVersionString:'1.0',CFBundleVersion:installed.build||'7'}};
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'apps-'));
 for(const [dir,content] of [['build','new'],['sim',installed?.same?'new':'old']]){fs.mkdirSync(path.join(tmp,dir,'Game.app'),{recursive:true});fs.writeFileSync(path.join(tmp,dir,'Game.app','Game'),content);}
 const real=p=>p.replace(/^\/(build|sim)/,m=>path.join(tmp,m.slice(1)));
 class Failure extends Error{constructor(c,m,e){super(m);this.code=c;this.execution=e;}}
 const run=async(file,args)=>{calls.push([path.basename(file),...args]);
  if(file.endsWith('plutil')){const app=path.dirname(args.at(-1));const key=Object.keys(plists).find(k=>fs.realpathSync(real(k))===fs.realpathSync(app));return {stdout:JSON.stringify(plists[key])};}
  if(file.endsWith('rsync'))return {stdout:args.includes('--dry-run')?Array.from({length:changed},(_,i)=>`>f.st.... f${i}`).join('\n'):''};
  return {stdout:''};};
 const sim=async args=>{calls.push(['simctl',...args]);if(args[0]==='get_app_container'){if(!installed)throw new Failure('COMMAND_FAILED','not installed');return {stdout:fs.realpathSync(real('/sim/Game.app'))};}return {stdout:''};};
 const apps=require(path.join(node,'apps.cjs')).createApps({sim,run,Failure});
 return {apps,calls,app:real('/build/Game.app')};
}

test('install skips an identical build, syncs a few changed files, installs whole otherwise',async()=>{
 const device={udid:'00000000-0000-4000-8000-000000000001'},terminate=async()=>{};
 let f=fakeApps({installed:{same:true}});
 assert.equal((await f.apps.install(device,{appPath:f.app},{terminate})).mode,'unchanged');
 assert.ok(!f.calls.some(c=>c[0]==='simctl'&&c[1]==='install'));
 f=fakeApps({installed:{same:false},changed:3});
 const synced=await f.apps.install(device,{appPath:f.app},{terminate:async()=>{}}).catch(e=>e);
 // The fake rsync does not copy, so the synced executable cannot match: that must fail loudly, not pass.
 assert.equal(synced.code,'INSTALL_UNVERIFIED');
 assert.ok(f.calls.some(c=>c[0]==='rsync'&&!c.includes('--dry-run')));
 f=fakeApps({installed:{same:false},changed:5000});
 assert.equal((await f.apps.install(device,{appPath:f.app},{terminate})).mode,'full');
 assert.ok(f.calls.some(c=>c[0]==='simctl'&&c[1]==='install'));
 f=fakeApps({installed:null});
 assert.equal((await f.apps.install(device,{appPath:f.app},{terminate})).mode,'full');
 f=fakeApps({installed:{same:false,build:'6'}});
 const info=await f.apps.info(device,{appPath:f.app});
 assert.equal(info.matchesLocal,false);assert.equal(info.build,'6');assert.equal(info.local.build,'7');
});

test('grouped tools route to worker operations; one device busy does not block another',async()=>{
 const {createRuntime}=require(path.join(node,'runtime.cjs'));
 const seen=[];let release;const gate=new Promise(r=>release=r);
 const dispatch=async(method,params)=>{seen.push([method,params.udid]);if(method==='devices')return {devices:[]};if(method==='tap'&&params.udid==='A')await gate;return {ok:true};};
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'rt-')),'settings.json');
 const rt=createRuntime({dispatch,settingsFile:file});
 await rt.request('device',{action:'boot',udid:'A'});
 await rt.request('viewer',{action:'close'});
 await rt.request('app',{action:'terminate',udid:'A',bundleId:'com.example.a'});
 assert.deepEqual(seen.map(s=>s[0]),['boot','close_viewer','app_terminate']);
 await assert.rejects(rt.request('device',{action:'explode'}),e=>e.code==='INVALID_ARGUMENT');
 const slow=rt.request('tap',{udid:'A',x:1,y:1});
 await assert.rejects(rt.request('tap',{udid:'A',x:1,y:1}),e=>e.code==='BUSY');
 assert.deepEqual(await rt.request('tap',{udid:'B',x:1,y:1}),{ok:true});
 // Reading never waits for input on the same device.
 assert.deepEqual(await rt.request('describe_ui',{udid:'A'}),{ok:true});
 release();await slow;
});

test('iPhone Duo unfolded: SpringBoard frames are turned a quarter, app frames are not (measured on iOS 27.1)',()=>{
 const screen={width:669,height:951,orientation:'landscape-left',target:{litPanel:'secondary'}};
 // SpringBoard: blank root label, frames past the native width. The Settings icon is at the top centre on screen.
 const springboard={role:'AXApplication',label:' ',frame:{x:0,y:485,width:678,height:466},children:[
  {role:'AXButton',label:'Settings',frame:{x:376.33,y:812.33,width:64,height:86.67}},
  {role:'AXButton',label:'Battery',frame:{x:730.25,y:714.33,width:162,height:184.67}}]};
 assert.equal(G.axTurned(springboard,screen),true);
 const icon=G.compactTree(springboard,screen).elements.find(e=>e.label==='Settings');
 assert.deepEqual(icon.frame.map(Math.round),[511,52,64,87]);
 // Safari: a normal app root; its back button is at the top left on screen.
 const safari={role:'AXApplication',label:'Safari',frame:{x:0,y:282,width:951,height:669},children:[{role:'AXButton',label:'Back',frame:{x:26,y:891,width:44,height:44}}]};
 assert.equal(G.axTurned(safari,screen),false);
 assert.deepEqual(G.compactTree(safari,screen).elements[0].frame,[16,26,44,44]);
 // Hit tests address the same turned space.
 assert.deepEqual(G.nativeToAx(screen,90,410,true),{x:410,y:861});
 assert.equal(G.axTurned(springboard,{...screen,target:{litPanel:'primary'}}),false);
});
