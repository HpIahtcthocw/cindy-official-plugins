'use strict';
const api=globalThis.browser||globalThis.chrome,U=globalThis.CindyUI;
let locale='en',t=U.copy(locale);
const style=document.createElement('style');style.textContent=U.css+'body{width:296px;margin:0;padding:16px;background:var(--surface)}header{margin-bottom:12px}.status{margin:12px 0}main button{width:100%;text-align:left}';document.head.append(style);
const status=document.querySelector('#status');
function labels(){for(const [id,label]of Object.entries({open:t.open,page:t.page,video:t.video,library:t.library,refresh:t.refresh}))document.getElementById(id).textContent=label;}
async function refresh(){try{const r=await api.runtime.sendMessage({type:'connection-status'});status.textContent=r?.connection?.connected?t.ready:t.disconnected;if(r?.connection?.connected){const c=await api.runtime.sendMessage({type:'cindy-learning',id:crypto.randomUUID(),request:{op:'config'}});if(c?.ok){locale=c.locale||'en';t=U.copy(locale);labels();status.textContent=t.ready;}}}catch{status.textContent=t.disconnected;}}
async function action(action){try{const [tab]=await api.tabs.query({active:true,currentWindow:true});if(!tab?.id)throw Error();const r=await api.tabs.sendMessage(tab.id,{type:'cindy-ui',action});if(!r?.ok)throw Error(r?.error);window.close();}catch(e){status.textContent=U.error(e.message,locale);}}
document.querySelector('#open').onclick=()=>action('open');document.querySelector('#page').onclick=()=>action('translate-page');document.querySelector('#video').onclick=()=>action('video');document.querySelector('#library').onclick=()=>api.runtime.sendMessage({type:'cindy-open-library'});document.querySelector('#refresh').onclick=refresh;labels();refresh();
