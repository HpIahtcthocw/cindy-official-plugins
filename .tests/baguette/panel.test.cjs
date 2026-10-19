const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const root=path.join(__dirname,'../../baguette-simulator');
const udid='00000000-0000-4000-8000-000000000001';
// Minimal DOM for panel.js: id lookup, element creation, class/hidden flags, click dispatch.
function fakeDocument(){
 const byId={};
 function el(tag){
  const n={tag,children:[],listeners:{},textContent:'',innerHTML:'',className:'',hidden:false,disabled:false,parent:null,
   append(...kids){for(const k of kids){if(k==null)continue;if(typeof k==='string'){n.textContent+=k;continue;}k.parent=n;n.children.push(k);}},
   replaceChildren(...kids){n.children=[];n.append(...kids);},
   setAttribute(k,v){if(k==='disabled'||k==='hidden')n[k]=true;n[k]=n[k]??v;},
   addEventListener(name,fn){(n.listeners[name]=n.listeners[name]||[]).push(fn);},
   click(){for(const fn of n.listeners.click||[])fn({});},
   classList:{toggle(c,on){const set=new Set(n.className.split(' ').filter(Boolean));on?set.add(c):set.delete(c);n.className=[...set].join(' ');},contains(c){return n.className.split(' ').includes(c);}},
  };
  return n;
 }
 for(const id of ['home','list','message'])byId[id]=el('div');
 const screen=el('iframe');let src='about:blank';screen.loads=[];Object.defineProperty(screen,'src',{get:()=>src,set:v=>{src=v;screen.loads.push(v);}});byId.screen=screen;
 const all=n=>n.children.flatMap(c=>[c,...all(c)]);
 return {byId,document:{documentElement:{lang:'en'},hidden:false,getElementById:id=>byId[id]||null,createElement:el},
  buttons:()=>all(byId.list).filter(c=>c.tag==='button'),text:()=>all(byId.list).map(c=>c.textContent).filter(Boolean).join(' | ')};
}
function fakeChannels(){
 const buses=new Map();
 return class BroadcastChannel{
  constructor(name){this.name=name;this.onmessage=null;(buses.get(name)||buses.set(name,new Set()).get(name)).add(this);}
  postMessage(data){for(const peer of buses.get(this.name)){if(peer!==this)queueMicrotask(()=>peer.onmessage?.({data}));}}
 };
}
const settle=(ms=5)=>new Promise(r=>setTimeout(r,ms));
// `serve` plays main.js's panel channel; `wake` is the /wake reply.
async function boot({serve,wake={state:'running'}}){
 const dom=fakeDocument();const BroadcastChannel=fakeChannels();const requests=[];
 const context={document:dom.document,BroadcastChannel,crypto,AbortSignal,Error,Object,JSON,Promise,Map,Date,String,Array,setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){},console,
  fetch:async url=>({ok:true,json:async()=>url==='/wake'?wake:{context:{locale:'zh-CN'}}})};
 context.globalThis=context;vm.createContext(context);
 vm.runInContext(fs.readFileSync(path.join(root,'node/control-model.js'),'utf8'),context);
 const main=new BroadcastChannel('baguette-panel');const pushed=[];
 main.onmessage=({data})=>{if(data.type==='viewer-ack'){pushed.push(data);return;}if(data.type!=='request')return;requests.push(data);const result=serve(data);if(result)main.postMessage({type:'response',id:data.id,result});};
 vm.runInContext(fs.readFileSync(path.join(root,'panel.js'),'utf8'),context);
 await settle(20);
 return {dom,requests,pushed,main};
}
const devices=[{udid,name:'iPhone 17 Pro',state:'Shutdown',runtime:'iOS 27.1',deviceType:'x.iPhone-17-Pro'}];
const current=(viewer=null,state='Shutdown')=>({ok:true,devices:devices.map(d=>({...d,state})),settings:{enabled:true,idleMinutes:15},viewer});

test('the panel lists devices, boots and opens one, then shows the live controller in place',async()=>{
 let viewer=null,state='Shutdown';
 const {dom,requests}=await boot({serve:m=>{
  if(m.action==='current')return current(viewer,state);
  if(m.action==='boot'){state='Booted';return {ok:true};}
  if(m.action==='viewer'){viewer={udid,url:'http://127.0.0.1:1234/control?udid='+udid};return {ok:true,url:viewer.url,previewOpened:true};}
 }});
 assert.equal(dom.byId.home.hidden,false);assert.equal(dom.byId.screen.hidden,true);
 assert.match(dom.text(),/iPhone 17 Pro/);assert.equal(dom.byId.message.textContent,'');
 const open=dom.buttons().find(b=>b.textContent==='打开');assert.ok(open);
 open.click();await settle(30);
 assert.deepEqual(requests.map(r=>r.action),['current','boot','viewer','current']);
 assert.equal(dom.byId.screen.loads.at(-1),viewer.url);assert.equal(dom.byId.screen.hidden,false);assert.equal(dom.byId.home.hidden,true);
});

test('a viewer pushed by main.js is shown and acknowledged; a disabled plugin is explained, not a timeout',async()=>{
 const shown=await boot({serve:m=>m.action==='current'?current():null});
 shown.main.postMessage({type:'viewer',id:'p1',url:'http://127.0.0.1:1234/control?udid='+udid,udid});await settle(10);
 assert.deepEqual(JSON.parse(JSON.stringify(shown.pushed)),[{type:'viewer-ack',id:'p1'}]);assert.equal(shown.dom.byId.screen.hidden,false);
 const off=await boot({serve:()=>null,wake:{state:'off'}});
 assert.equal(off.requests.length,0,'no request is sent when the plugin is off');
 assert.match(off.dom.byId.message.textContent,/模拟器已关闭/);assert.ok(off.dom.byId.message.classList.contains('error'));
 assert.equal(off.dom.byId.home.hidden,false);
});
