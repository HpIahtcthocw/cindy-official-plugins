'use strict';
// Docked panel: shows the live controller when a viewer is up, otherwise a
// device chooser. Device actions go to main.js over the panel channel.
const text = {
  en:{emptyTitle:'No simulators yet',emptyBody:'Create one and Cindy can run iOS apps right here.',createFirst:'Create your first iPhone',open:'Open',starting:'Starting…',opening:'Opening…',creating:'Creating…',
    paused:'Simulators are turned off. Turn them on in Plugins → iOS Simulator.',checking:'Checking devices…',failed:'Not completed. Check the device in plugin settings.',busy:'Another operation is running. Try again in a moment.',disabled:'Simulators are off. Turn them on in plugin settings first.',needXcode:'Needs full Xcode with an iOS runtime installed.',timeout:'No response from the simulator service. Reopen the panel.',panelClosed:'The view could not be shown here.'},
  'zh-CN':{emptyTitle:'还没有模拟器',emptyBody:'创建一台，Cindy 就能在这里运行 iOS App。',createFirst:'创建第一台 iPhone',open:'打开',starting:'正在启动…',opening:'正在打开…',creating:'正在创建…',
    paused:'模拟器已关闭。在「插件 → iOS 模拟器」里打开后即可使用。',checking:'正在检查设备…',failed:'操作没有完成，请到插件设置核对设备。',busy:'有其他操作正在进行，稍后再试。',disabled:'模拟器已关闭，请先在插件设置里打开。',needXcode:'需要先安装完整的 Xcode 和一个 iOS 运行时。',timeout:'模拟器服务没有响应，请重新打开面板。',panelClosed:'画面没能在这里显示。'},
};
const M=globalThis.CindySimModel;
const GLYPH={iphone:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2.5"/><path d="M12 18h.01"/></svg>',ipad:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M12 18h.01"/></svg>',empty:'<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2.5"/><path d="M12 18h.01"/></svg>'};
let T=text.en,state=null,busy=null,viewerUrl=null,catalog=null;
const $=id=>document.getElementById(id),channel=new BroadcastChannel('baguette-panel'),pending=new Map();
function h(tag,attrs={},children=[]){const n=document.createElement(tag);for(const [k,v] of Object.entries(attrs)){if(v==null||v===false)continue;if(k==='class')n.className=v;else if(k==='text')n.textContent=v;else if(k==='html')n.innerHTML=v;else if(k.startsWith('on'))n.addEventListener(k.slice(2),v);else n.setAttribute(k,v===true?'':v);}for(const c of [].concat(children))if(c)n.append(c);return n;}
function message(value,error=false){$('message').textContent=value;$('message').classList.toggle('error',error);}
async function rpc(action,params={}){
  const wake=await fetch('/wake',{signal:AbortSignal.timeout(15000)});
  if(!wake.ok)throw Error(T.timeout);
  const id=crypto.randomUUID();
  return new Promise((resolve,reject)=>{
    const send=()=>channel.postMessage({type:'request',id,action,...params});
    // Read-only queries may retry while the logic page wakes; mutations never replay.
    const retry=['current','catalog'].includes(action)?setInterval(send,500):null;
    const timer=setTimeout(()=>{clearInterval(retry);pending.delete(id);reject(Error(T.timeout));},['current','catalog'].includes(action)?20000:125000);
    pending.set(id,{resolve,timer,retry});send();
  });
}
channel.onmessage=({data:m})=>{
  if(m?.type==='viewer'&&typeof m.url==='string'){show(m.url);channel.postMessage({type:'viewer-ack',id:m.id});return;}
  if(m?.type!=='response')return;const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);clearInterval(p.retry);p.resolve(m.result);
};
const errorText=r=>({BUSY:T.busy,RUNTIME_DISABLED:T.disabled,PANEL_CLOSED:T.panelClosed})[r?.errorCode]||T.failed;
function show(url){
  if(url&&url!==viewerUrl){viewerUrl=url;$('screen').src=url;}
  if(!url&&viewerUrl){viewerUrl=null;$('screen').src='about:blank';}
  $('screen').hidden=!viewerUrl;$('home').hidden=!!viewerUrl;
}
function render(){
  if(viewerUrl||!state)return;
  const enabled=state.settings?.enabled===true&&!state.settingsError;
  const list=$('list');list.replaceChildren();
  if(!enabled)list.append(h('p',{class:'notice',text:T.paused}));
  if(!state.devices?.length){
    list.append(h('div',{class:'empty'},[h('div',{class:'glyph',html:GLYPH.empty}),h('h4',{text:T.emptyTitle}),h('p',{text:T.emptyBody}),
      h('button',{class:'btn cta',text:T.createFirst,disabled:!!busy||!enabled,onclick:createDefault})]));
    return;
  }
  for(const row of M.deviceRows(state.devices,null,document.documentElement.lang)){
    const working=busy===row.udid;
    list.append(h('div',{class:'device'},[
      h('span',{class:'glyph',html:GLYPH[row.family]}),
      h('div',{class:'text'},[h('div',{class:'name',text:row.name}),h('div',{class:'meta'},[h('span',{class:'dot','data-tone':working?'busy':row.tone}),h('span',{text:row.meta})])]),
      working?h('span',{class:'spinner'}):h('button',{class:'btn',text:T.open,disabled:!!busy||!enabled||!row.available,onclick:()=>open(row.udid,row.tone!=='on')}),
    ]));
  }
}
async function refresh(){
  try{const r=await rpc('current');if(!r.ok)throw Error(errorText(r));state=r;if($('message').textContent===T.checking)message('');show(r.viewer?.url||null);render();}
  catch(e){message(e.message,true);}
}
async function open(udid,needsBoot){
  if(busy)return;busy=udid;render();message(needsBoot?T.starting:T.opening);
  try{
    if(needsBoot){const booted=await rpc('boot',{udid});if(!booted.ok)throw Error(errorText(booted));message(T.opening);}
    const r=await rpc('viewer',{udid});if(!r.ok)throw Error(errorText(r));
    message('');
  }catch(e){message(e.message,true);}
  finally{busy=null;await refresh();}
}
async function createDefault(){
  if(busy)return;busy='create';render();message(T.creating);
  try{
    catalog=catalog||await rpc('catalog');if(!catalog.ok)throw Error(errorText(catalog));
    const choice=M.defaultChoice(catalog);if(!choice)throw Error(T.needXcode);
    const r=await rpc('create',{name:choice.name,deviceType:choice.deviceType,runtime:choice.runtime});if(!r.ok)throw Error(errorText(r));
    message('');
  }catch(e){message(e.message,true);}
  finally{busy=null;await refresh();}
}
(async()=>{
  try{const r=await(await fetch('/app-context')).json();T=text[r.context?.locale]||text.en;}catch{}
  document.documentElement.lang=T===text['zh-CN']?'zh-CN':'en';
  $('screen').title=document.documentElement.lang==='zh-CN'?'iOS 模拟器':'iOS Simulator';
  message(T.checking);await refresh();
  setInterval(()=>{if(!document.hidden&&!busy)refresh();},viewerUrl?15000:5000);
})();
