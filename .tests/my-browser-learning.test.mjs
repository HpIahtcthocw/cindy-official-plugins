import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createLearningService} from '../my-browser/learning-service.js';
const require=createRequire(import.meta.url),core=require('../my-browser/extension/learning-core.js');
const {createBridge,EXT_ID}=require('../my-browser/node/bridge.cjs');
const version=require('../my-browser/extension/manifest.json').version;

function service() {
  const files=new Map(),calls=[];let corrupt=false,denied=false;
  const api=createLearningService({core,now:()=>1000,model:async p=>{calls.push(p);return {ok:true,text:JSON.stringify({translations:['你好']})};},library:async p=>{
    if(denied)return {ok:false,errorCode:'PERMISSION_DENIED'};
    if(p.op==='open')return {ok:true};
    if(p.op==='read')return files.has(p.path)?{ok:true,content:corrupt?'bad':files.get(p.path)}:{ok:false,errorCode:'NOT_FOUND'};
    if(p.op==='write'){files.set(p.path,p.content);return {ok:true};}
  }});
  return {...api,files,calls,corrupt:()=>corrupt=true,deny:()=>denied=true};
}
test('translation cache is profile scoped and validates model result cardinality',async()=>{
  const s=service(),a=crypto.randomUUID(),b=crypto.randomUUID();
  assert.deepEqual((await s.handle(a,{op:'translate',text:'Hello'})).translations,['你好']);
  assert.equal((await s.handle(a,{op:'translate',text:'Hello'})).cached,true);
  await s.handle(b,{op:'translate',text:'Hello'});assert.equal(s.calls.length,2);
  await assert.rejects(s.handle(a,{op:'translate',texts:['Hello','World']}),/BAD_MODEL_OUTPUT/);
});
test('concurrent saves do not overwrite one another; review and profile separation persist',async()=>{
  const s=service(),a=crypto.randomUUID(),b=crypto.randomUUID();
  await Promise.all(['one','two'].map(text=>s.handle(a,{op:'save',text,source:{url:'https://example.test/video',time:5}})));
  let r=await s.handle(a,{op:'list'});assert.equal(r.total,2);assert.equal(r.entries[0].source.time,5);
  assert.equal((await s.handle(b,{op:'list'})).total,0);
  await s.handle(a,{op:'review',id:r.entries[0].id,rating:'good'});
  assert.equal((await s.handle(a,{op:'list',due:true})).total,1);
  await s.handle(a,{op:'save',text:'one',translation:'一',source:{url:'https://example.test/video',time:5}});
  assert.equal((await s.handle(a,{op:'list'})).total,2);
});
test('a missing library is initialized, but corruption, permission loss and cancelled work never overwrite it',async()=>{
  const s=service(),a=crypto.randomUUID();await s.handle(a,{op:'save',text:'keep'});const before=[...s.files.values()][0];s.corrupt();
  await assert.rejects(s.handle(a,{op:'save',text:'lose'}));assert.equal([...s.files.values()][0],before);
  const d=service();d.deny();await assert.rejects(d.handle(a,{op:'save',text:'denied'}),/PERMISSION_DENIED/);assert.equal(d.files.size,0);
  const c=service();await assert.rejects(c.handle(a,{op:'translate',text:'cancel'},async()=>false),/CANCELLED/);assert.equal(c.calls.length,0);
});
test('subtitle import keeps timing, strips markup and exports aligned bilingual SRT',()=>{
  const cues=core.parseSubtitles('WEBVTT\n\n00:00.200 --> 00:02.300\n<b>Hello</b> &amp; goodbye\n\n2\n00:04:00,000 --> 00:04:01,200\nNext');
  assert.equal(cues.length,2);assert.equal(cues[0].start,.2);assert.equal(cues[0].text,'Hello & goodbye');cues[0].translation='你好';
  assert.match(core.exportSubtitles(cues),/00:00:00,200 --> 00:00:02,300\nHello & goodbye\n你好/);
  assert.throws(()=>core.validate({op:'save',text:'x',source:{url:'javascript:alert(1)'}}));
  assert.throws(()=>core.validate({op:'translate',texts:Array(25).fill('x')}));
});
test('learning requests are authenticated, deduplicated, cancellable and revoked with site policy',async t=>{
  const notices=[],bridge=createBridge({ports:[0],notify:(method,params)=>notices.push({method,params})});t.after(()=>bridge.close());
  const {port}=await bridge.request('status'),id=crypto.randomUUID();let session;
  const request=async(path,body,extra={})=>{const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:body?'POST':'GET',headers:{'X-My-Browser-Extension':EXT_ID,'X-My-Browser-Client':id,'X-My-Browser-Version':version,...(session?{'X-My-Browser-Session':session}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,...await r.json()};};
  assert.equal((await request('/learning/start',{id:crypto.randomUUID(),request:{op:'config'}})).status,409);
  session=(await request('/health')).session;
  const job={id:crypto.randomUUID(),request:{op:'translate',text:'hello',source:{url:'https://example.test/'}}};
  assert.equal((await request('/learning/start',job,{Origin:'https://example.test'})).status,403);
  assert.equal((await request('/learning/start',job)).ok,true);await request('/learning/start',job);assert.equal(notices.length,1);
  assert.equal((await bridge.request('learningActive',{id:job.id})).active,true);
  await bridge.request('setPolicy',{policy:{read:{block:['example.test']},interact:{allow:[]}}});
  assert.equal((await bridge.request('learningActive',{id:job.id})).active,false);
  assert.equal((await request('/learning/result',{id:job.id})).status,403);
  const config={id:crypto.randomUUID(),request:{op:'config'}};await request('/learning/start',config);await request('/learning/cancel',{id:config.id});
  assert.equal((await bridge.request('learningResult',{id:config.id,result:{ok:true}})).ok,false);
});
test('task handoff recovers an uncertain send with the same durable keys and does not duplicate a successful run',async()=>{
 const files=new Map(),creates=[],sends=[],profile=crypto.randomUUID(),id=crypto.randomUUID();let failOnce=true;
 const service=createLearningService({core,library:async p=>p.op==='open'?{ok:true}:p.op==='read'?(files.has(p.path)?{ok:true,content:files.get(p.path)}:{ok:false,errorCode:'NOT_FOUND'}):(files.set(p.path,p.content),{ok:true}),tasks:{
  capabilities:async()=>({operations:['create','send']}),
  create:async p=>{creates.push(p);return {taskId:'owned-task',revision:1};},
  send:async p=>{sends.push(p);if(failOnce){failOnce=false;throw Error('connection lost after dispatch');}return {runId:'owned-run'};}
 }});
 const request={op:'task',id,text:'Quoted page',instruction:'Summarize',source:{url:'https://example.test/',title:'Example'}};
 await assert.rejects(service.handle(profile,request),/TASK_OUTCOME_UNKNOWN/);
 const recovered=await service.handle(profile,request);assert.equal(recovered.taskId,'owned-task');assert.equal(recovered.runId,'owned-run');
 await service.handle(profile,request);assert.equal(creates.length,1);assert.equal(sends.length,2);assert.equal(sends[0].requestKey,sends[1].requestKey);assert.match(sends[0].text,/quoted webpage material/);
 await assert.rejects(service.handle(profile,{...request,instruction:'Different request'}),/REQUEST_CONFLICT/);
});
for(const previousVersion of ['0.3.48','0.4.0','0.4.1','0.4.2','0.4.3','0.4.4','0.4.5','0.4.6','0.4.7'])test('new bridge preserves extension '+previousVersion,async t=>{
 const bridge=createBridge({ports:[0]});t.after(()=>bridge.close());const {port}=await bridge.request('status');const id=crypto.randomUUID();
 const headers={'X-My-Browser-Extension':EXT_ID,'X-My-Browser-Client':id,'X-My-Browser-Version':previousVersion};
 const health=await (await fetch(`http://127.0.0.1:${port}/health`,{headers})).json();assert.equal(health.version,previousVersion);assert.equal(health.installedVersion,version);assert.ok(health.session);
 const status=await bridge.request('status');assert.equal(status.extension_connected,true);assert.equal(status.clients[0].id,id);
});

for(const first of [{ok:false,errorCode:'BAD_MODEL_OUTPUT'},{ok:true,text:'{"translations":["少了一句"]}'},{ok:true,text:'not JSON'},{ok:true,text:'{"translations":["",""]}'}])test('translation repairs malformed output once without losing alignment: '+JSON.stringify(first),async()=>{
 const calls=[];const s=createLearningService({core,model:async p=>{calls.push(p);return calls.length===1?first:{ok:true,text:'```json\n{"translations":["困惑","笑声"]}\n```'};}});
 const result=await s.handle(crypto.randomUUID(),{op:'translate',texts:['confused.','[laughter]']});
 assert.deepEqual(result.translations,['困惑','笑声']);assert.equal(calls.length,2);assert.match(calls[1].prompt,/never merge or omit/);
});
test('failed translation repair is bounded and cancellation prevents the extra model call',async()=>{
 let count=0;const s=createLearningService({core,model:async()=>{count++;return {ok:true,text:'{"translations":[]}'};}});
 await assert.rejects(s.handle(crypto.randomUUID(),{op:'translate',text:'Hello'}),/BAD_MODEL_OUTPUT/);assert.equal(count,2);
 count=0;await assert.rejects(s.handle(crypto.randomUUID(),{op:'translate',text:'Hello'},async()=>count===0),/REQUEST_CANCELLED/);assert.equal(count,1);
});

test('installed extension version is independent from compatibility negotiation',async t=>{
 const bridge=createBridge({ports:[0]});t.after(()=>bridge.close());const {port}=await bridge.request('status');
 const headers={'X-My-Browser-Extension':EXT_ID,'X-My-Browser-Client':crypto.randomUUID(),'X-My-Browser-Version':'0.4.2','X-My-Browser-Installed-Version':'0.4.4'};
 await fetch(`http://127.0.0.1:${port}/health`,{headers});
 let status=await bridge.request('status');assert.equal(status.clients[0].version,'0.4.4');assert.equal(status.clients[0].protocolVersion,'0.4.2');assert.equal(status.clients[0].connected,true);
 delete headers['X-My-Browser-Installed-Version'];await fetch(`http://127.0.0.1:${port}/health`,{headers});
 status=await bridge.request('status');assert.equal(status.clients[0].version,null);assert.equal(status.clients[0].protocolVersion,'0.4.2');
});
