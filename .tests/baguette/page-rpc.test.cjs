const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

function fixture(page){
  const buses=new Map(),intervals=new Map(),timers=new Map(),messages=[],calls=[];
  let serial=0,finish;
  const result=new Promise(resolve=>{finish=resolve;});
  class BroadcastChannel{
    constructor(name){this.name=name;if(!buses.has(name))buses.set(name,[]);buses.get(name).push(this);}
    postMessage(data){messages.push(data);for(const p of buses.get(this.name))if(p!==this)queueMicrotask(()=>p.onmessage?.({data}));}
  }
  const clock={setInterval:(fn,ms)=>{const id=++serial;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),
    setTimeout:fn=>{const id=++serial;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)};
  const elements=new Map();
  const context={...clock,BroadcastChannel,crypto:require('node:crypto').webcrypto,AbortSignal,
    document:{documentElement:{},getElementById:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);}},
    CindySimModel:{},fetch:async url=>url==='/app-context'?new Promise(()=>{}):{ok:true,json:async()=>({state:'on'})}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(`baguette-simulator/${page}.js`,'utf8'),context);
  return {messages,calls,finish,intervals,timers,
    rpc:action=>page==='pages'?context.CindySimPages.rpc(action,{sessionId:'task-1',udid:'device-1'}):vm.runInContext(`rpc(${JSON.stringify(action)})`,context),
    tick:()=>{for(const {fn,ms} of [...intervals.values()])if(ms===500)fn();},
    ready:id=>{for(const p of buses.get(page==='pages'?'baguette-pages':'baguette-settings'))queueMicrotask(()=>p.onmessage?.({data:{type:'ready',id}}));},
    start:()=>vm.runInNewContext(fs.readFileSync('baguette-simulator/main.js','utf8'),{...clock,BroadcastChannel,
      cindy:{onHostMessage(){},request:async()=>({context:{locale:'en'}}),node:{request:async r=>{
        if(r.method==='device_hold')return {ok:true,result:{running:false}};
        calls.push(r);return {ok:true,result:await result};
      }}}})};
}

test('startup probes never replay slow page or settings operations, on success or failure',async()=>{
  for(const [page,actions] of [['pages',['catalog','manage_state','task_state','boot']],['settings',['status','catalog','boot']]])for(const action of actions)for(const ok of [true,false]){
    const f=fixture(page),pending=f.rpc(action);await flush();
    f.tick();await flush();assert.equal(f.calls.length,0,'listener not started');
    f.start();f.tick();await flush();assert.equal(f.calls.length,1,`${page}/${action}`);
    const id=f.messages.find(m=>m.type==='request').id;
    for(let i=0;i<4;i++){f.tick();f.ready(id);await flush();}
    assert.equal(f.calls.length,1,'slow operations and duplicate readiness never replay');
    f.finish({ok,errorCode:ok?undefined:'READ_FAILED'});
    assert.equal((await pending).ok,ok);
    f.ready(id);f.tick();await flush();assert.equal(f.calls.length,1,'late readiness is ignored');
    assert.equal(f.timers.size,0);assert.equal(f.intervals.size,0);
  }
});

test('expired startup and in-flight requests ignore late readiness and results',async()=>{
  for(const page of ['pages','settings'])for(const running of [false,true]){
    const f=fixture(page),pending=f.rpc('catalog');const rejected=assert.rejects(pending);
    await flush();if(running){f.start();f.tick();await flush();}
    const id=f.messages.find(m=>m.type==='ping').id;
    for(const timer of f.timers.values())timer();f.timers.clear();await rejected;
    if(!running)f.start();
    f.ready(id);f.finish({ok:true});f.tick();await flush();
    assert.equal(f.calls.length,running?1:0);assert.equal(f.intervals.size,0);
  }
});
