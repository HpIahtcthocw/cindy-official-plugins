import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
const source=await fs.readFile(new URL('../my-browser/extension/content.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(send=async()=>({enabled:false})){
  const timers=new Map(),sent=[],listeners=new Set();let sequence=0;
  class Node extends EventTarget {
    constructor(){super();this.style={props:Object.create(null),setProperty(k,v){this.props[k]=v;},getPropertyValue(k){return this.props[k]||'';},removeProperty(k){delete this.props[k];}};}
    dataset={};textContent='';
    append(){} setAttribute(){} remove(){} attachShadow(){return new Node();}
    querySelector(){return {disabled:false};} querySelectorAll(){return [];}
    replaceChildren(){} closest(){return null;} getClientRects(){return [];}
    getBoundingClientRect(){return {top:0,bottom:0,left:0,right:0,width:0,height:0};}
  }
  const document=new EventTarget();document.querySelector=()=>null;document.title='Fixture';
  document.createElement=document.createElementNS=()=>new Node();document.documentElement=new Node();document.body=new Node();
  const chrome={runtime:{id:'fixture',getURL:p=>'chrome-extension://fixture/'+p,sendMessage:m=>{sent.push(m);return send(m);},onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}},storage:{local:{get:async()=>({})}}};
  const context={chrome,document,window:new EventTarget(),location:{href:'https://example.test/start',hostname:'example.test',origin:'https://example.test'},AbortController,getComputedStyle:()=>({backgroundColor:'rgb(255,255,255)'}),CindyLearning:{uuid:()=> 'fixture-request',validTarget:()=>false,languageName:v=>v},CindyUI:{copy:()=>({}),css:'',languagePicker:()=>new Node(),error:()=>'err'},speechSynthesis:{cancel(){}},MutationObserver:class{observe(){} disconnect(){}},setInterval:fn=>{timers.set(++sequence,fn);return sequence;},clearInterval:id=>timers.delete(id),clearTimeout(){},setTimeout};
  vm.runInNewContext(source,context);
  return {chrome,context,timers,sent,listeners};
}
test('a reloaded extension leaves no URL polling or page listeners after runtime disappears',async()=>{
  const f=fixture();await settle();const tick=[...f.timers.values()][0];
  f.chrome.runtime=undefined;f.context.location.href+='?photo=1';
  assert.doesNotThrow(tick);assert.equal(f.timers.size,0);
  const count=f.sent.length;f.context.document.dispatchEvent(new Event('yt-navigate-finish'));tick();await settle();
  assert.equal(f.sent.length,count,'invalidated script never sends again');
});
test('synchronous invalidation during video-state send is caught and disposes the old script',async()=>{
  let invalidate=false;const f=fixture(()=>{if(invalidate)throw Error('Extension context invalidated.');return Promise.resolve({enabled:false});});await settle();
  const tick=[...f.timers.values()][0];invalidate=true;f.context.location.href+='?photo=2';
  assert.doesNotThrow(tick);await settle();assert.equal(f.timers.size,0);assert.equal(f.listeners.size,0);
});
test('a temporary message failure does not disable a valid extension context',async()=>{
  let unavailable=true;const f=fixture(()=>{if(unavailable)throw Error('Could not establish connection. Receiving end does not exist.');return Promise.resolve({enabled:false});});await settle();
  assert.equal(f.timers.size,1);assert.equal(f.listeners.size,1);
  unavailable=false;f.context.location.href+='?photo=3';[...f.timers.values()][0]();await settle();
  assert.ok(f.sent.some(m=>m.type==='cindy-video-state'));assert.equal(f.timers.size,1);
});
test('a late startup reply after invalidation cannot reopen UI or restart polling',async()=>{
  let resolve;const f=fixture(()=>new Promise(r=>{resolve=r;}));await settle();
  f.chrome.runtime=undefined;[...f.timers.values()][0]();resolve({enabled:true});await settle();assert.equal(f.timers.size,0);
});

test('native cues share safe markup cleanup and disabled YouTube auto-open stops retry polling',()=>{
  assert.match(source,/text:L\.cleanSubtitleText\(c\.text\)\.slice\(0,4000\)/);
  assert.match(source,/if\(!enabled\)\{[\s\S]*?if\(youtube\)prefs\.autoVideo=false;[\s\S]*?nextAutoAttempt=Date\.now\(\)\+5000;[\s\S]*?return;/);
});

test('an interrupted panel open cannot recreate removed UI when its config reply arrives',async()=>{
  let resolveConfig;const f=fixture(m=>m.type==='cindy-learning'?new Promise(r=>{resolveConfig=r;}):Promise.resolve({enabled:false}));await settle();
  const replies=[];[...f.listeners][0]({type:'cindy-ui',action:'open'},{id:'fixture'},r=>replies.push(r));await settle();
  f.chrome.runtime=undefined;[...f.timers.values()][0]();resolveConfig({ok:true,locale:'en'});await settle();
  assert.equal(f.timers.size,0);assert.deepEqual(replies,[]);
});
test('translate-page issued while config is pending still runs after configure finishes',async()=>{
  let resolveConfig;const observed=[];
  const configReady=new Promise(r=>{resolveConfig=r;});
  const f=fixture(m=>{
    if(m.type==='cindy-learning'){
      if(m.request?.op==='config')return configReady;
      return Promise.resolve({ok:true,translations:['x']});
    }
    return Promise.resolve({enabled:false});
  });
  f.context.MutationObserver=class{observe(target){observed.push(target);}disconnect(){}};
  await settle();
  const replies=[];const listener=[...f.listeners][0];
  listener({type:'cindy-ui',action:'open'},{id:'fixture'},r=>replies.push(['open',r]));await settle();
  listener({type:'cindy-ui',action:'translate-page'},{id:'fixture'},r=>replies.push(['translate',r]));await settle();
  assert.equal(observed.length,0,'translate must wait for the in-flight config');
  resolveConfig({ok:true,locale:'en',features:[]});
  await settle();await settle();await settle();
  assert.equal(replies.length,2);
  assert.equal(replies[0][0],'open');assert.equal(replies[1][0],'translate');
  assert.equal(replies[1][1]?.ok,true);
  assert.ok(observed.includes(f.context.document.body),'queued translate-page must start page translation');
});
test('restore does not wait for an in-flight page translation request',async()=>{
  let resolveConfig,resolveTranslate;let translates=0;
  const configReady=new Promise(r=>{resolveConfig=r;});
  const f=fixture(m=>{
    if(m.type==='cindy-learning'){
      if(m.request?.op==='config')return configReady;
      if(m.request?.op==='translate'){translates++;return new Promise(r=>{resolveTranslate=r;});}
      return Promise.resolve({ok:true});
    }
    return Promise.resolve({enabled:false});
  });
  f.context.innerHeight=800;f.context.innerWidth=1200;
  f.context.MutationObserver=class{observe(){} disconnect(){}};
  const paragraph={innerText:'Hello from the fixture page',getClientRects:()=>[{}],getBoundingClientRect:()=>({top:10,bottom:40,left:0,right:100,width:100,height:30}),closest:()=>null,querySelector:()=>null,isConnected:true,hasAttribute:()=>false,after(){}};
  f.context.document.body.querySelectorAll=()=>[paragraph];
  await settle();
  const replies=[];const listener=[...f.listeners][0];
  resolveConfig({ok:true,locale:'en',features:[]});
  listener({type:'cindy-ui',action:'translate-page'},{id:'fixture'},r=>replies.push(['start',r]));
  await settle();await settle();
  assert.equal(translates,1);
  listener({type:'cindy-ui',action:'translate-page'},{id:'fixture'},r=>replies.push(['restore',r]));
  await settle();await settle();
  assert.equal(replies.some(r=>r[0]==='restore'&&r[1]?.ok),true,'restore must finish while translation is still pending');
  assert.equal(translates,1,'restore cancels rather than queueing behind the model');
  resolveTranslate({ok:true,translations:['x']});
  await settle();
});
test('hiding the panel while config is pending drops queued translate-page',async()=>{
  let resolveConfig;const observed=[];
  const configReady=new Promise(r=>{resolveConfig=r;});
  const f=fixture(m=>{
    if(m.type==='cindy-learning'){
      if(m.request?.op==='config')return configReady;
      return Promise.resolve({ok:true,translations:['x']});
    }
    return Promise.resolve({enabled:false});
  });
  f.context.MutationObserver=class{observe(target){observed.push(target);}disconnect(){}};
  await settle();
  const replies=[];const listener=[...f.listeners][0];
  listener({type:'cindy-ui',action:'open'},{id:'fixture'},r=>replies.push(['open',r]));await settle();
  listener({type:'cindy-ui',action:'translate-page'},{id:'fixture'},r=>replies.push(['translate',r]));await settle();
  const ev=new Event('keydown');ev.key='Escape';f.context.document.dispatchEvent(ev);
  resolveConfig({ok:true,locale:'en',features:[]});
  await settle();await settle();await settle();
  assert.equal(observed.length,0,'closed panel must not start queued translation');
});
