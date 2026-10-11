import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
const source=await fs.readFile(new URL('../my-browser/extension/content.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(send=async()=>({enabled:false})){
  const timers=new Map(),sent=[],listeners=new Set();let sequence=0;
  const document=new EventTarget();document.querySelector=()=>null;document.title='Fixture';
  const chrome={runtime:{id:'fixture',getURL:p=>'chrome-extension://fixture/'+p,sendMessage:m=>{sent.push(m);return send(m);},onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}},storage:{local:{get:async()=>({})}}};
  const context={chrome,document,window:new EventTarget(),location:{href:'https://example.test/start',hostname:'example.test',origin:'https://example.test'},AbortController,CindyLearning:{uuid:()=> 'fixture-request'},CindyUI:{copy:()=>({})},speechSynthesis:{cancel(){}},setInterval:fn=>{timers.set(++sequence,fn);return sequence;},clearInterval:id=>timers.delete(id),clearTimeout(){},setTimeout};
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
