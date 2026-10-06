'use strict';
(() => {
  const browser=globalThis.browser||globalThis.chrome,isExtension=!!browser?.runtime?.id,U=globalThis.CindyUI,L=globalThis.CindyLearning;
  let disposeReader,expandedLanguages=false;
  let locale='en',t=U.copy(locale),clientId='',target='zh-CN',requestGeneration=0;
  const channel=isExtension?null:new BroadcastChannel('my-browser'),pending=new Map();
  if(channel)channel.onmessage=e=>{const p=pending.get(e.data?.id);if(p){pending.delete(e.data.id);clearTimeout(p.timer);p.resolve(e.data.result);}};
  function hostMessage(type,data={}){return new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Error('TIMEOUT'));},300000);pending.set(id,{resolve,timer});channel.postMessage({type,id,...data});});}
  async function call(request){const r=isExtension?await browser.runtime.sendMessage({type:'cindy-learning',id:crypto.randomUUID(),request}):await hostMessage('learning-panel',{clientId,request});if(!r?.ok)throw Error(r?.error||r?.errorCode||'CINDY_DISCONNECTED');return r;}
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,fn,cls)=>{const b=el('button',text,cls);b.type='button';b.onclick=()=>Promise.resolve(fn()).catch(error);return b;};
  const app=document.querySelector('#app'),status=el('div','','status'),content=el('main',undefined,'stack');status.setAttribute('role','status');
  function error(e){status.textContent=U.error(e.message,locale);status.className='status error';}
  const style=el('style',U.css+'body{margin:0;background:var(--surface)}#app{max-width:860px;margin:auto;padding:24px}#app.reader-wide{max-width:1200px}.reader-wide .reader-text{max-width:none;width:100%}header{border-bottom:1px solid var(--board);padding-bottom:16px;margin-bottom:24px}main{min-height:240px}.entry{padding:16px 0;border-bottom:1px solid var(--board)}.entry p{font-size:15px;line-height:24px}.entry .translation{margin:8px 0;color:var(--muted)}footer{margin-top:16px}.reader-text p{white-space:pre-wrap}.reader-text{max-width:720px;margin:auto}');document.head.append(style);
  function renderHeader(profiles=[]){app.replaceChildren();const header=el('header',undefined,'stack'),row=el('div',undefined,'row');row.append(el('h1','Cindy','grow'));
    const picker=U.languagePicker({locale,value:target,expanded:expandedLanguages,onchange:async value=>{target=value;try{await call({op:'preferences',target});if(isExtension){const stored=(await browser.storage.local.get('cindyReadingPreferences')).cindyReadingPreferences||{};await browser.storage.local.set({cindyReadingPreferences:{...stored,webTarget:target}});}}catch(e){error(e)}}});row.append(picker);
    if(!isExtension&&profiles.length){const p=el('select');p.setAttribute('aria-label',t.profiles);profiles.forEach((item,i)=>{const o=el('option',`${item.browser||'Chrome'} ${i+1}`);o.value=item.id;p.append(o);});p.value=clientId;p.onchange=()=>{clientId=p.value;call({op:'preferences'}).then(r=>{target=r.target||target;renderHeader(profiles);return reader();}).catch(error);};row.append(p);}
    header.append(row);app.append(header,content,el('footer'));app.querySelector('footer').append(status);}
  function reader(){
    disposeReader?.();disposeReader=null;const readerGeneration=++requestGeneration;let fileRevision=0,translationRevision=0;
    const current=()=>readerGeneration===requestGeneration;
    content.replaceChildren();const file=el('input');file.type='file';file.accept='.txt,.md,.pdf';const input=el('textarea');input.placeholder=t.source;input.setAttribute('aria-label',t.source);const text=el('div',undefined,'reader-text stack');
    file.onchange=async()=>{
      const f=file.files[0];if(!f)return;if(f.size>30000000){error(Error('IMPORT_TOO_LARGE'));return;}
      const revision=++fileRevision;++translationRevision;disposeReader?.();disposeReader=null;text.replaceChildren();
      try{
        if(f.name.toLowerCase().endsWith('.pdf')){
          const module=await import('./reader-pdf.js');if(!current()||revision!==fileRevision)return;
          input.hidden=true;translateButton.hidden=true;app.classList.add('reader-wide');
          // Render into an owned container: a slower previous file cannot overwrite the new one.
          const container=el('div');text.replaceChildren(container);
          const dispose=await module.openPDF({file:f,container,call,target:()=>target,t,report:e=>{if(current()&&revision===fileRevision)error(e);}});
          if(!current()||revision!==fileRevision)dispose();else disposeReader=dispose;
        }else{
          const value=await f.text();if(!current()||revision!==fileRevision)return;
          input.hidden=false;translateButton.hidden=false;app.classList.remove('reader-wide');input.value=value;
        }
      }catch(e){if(current()&&revision===fileRevision)error(e);}
    };
    const actions=el('div',undefined,'row');const translateButton=button(t.translate,async()=>{
      const revision=++translationRevision,language=target,parts=input.value.split(/\n\s*\n/).filter(x=>x.trim());
      text.replaceChildren();status.textContent=t.working;
      for(const part of parts){
        if(!current()||revision!==translationRevision)return;if(part.length>20000)throw Error('BATCH_TOO_LARGE');
        const r=await call({op:'translate',text:part,target:language});if(!current()||revision!==translationRevision)return;
        const section=el('section',undefined,'stack divider');section.append(el('p',part),el('p',r.translations[0],'muted'));text.append(section);
      }
      status.textContent='';
    },'primary');actions.append(button(t.textFile,()=>file.click()),translateButton);
    content.append(input,actions,text);
  }
  async function start(){let profiles=[];
    try{if(isExtension){const c=await call({op:'config'});locale=c.locale||'en';expandedLanguages=c.features?.includes('language-target-v1')===true;}else{await fetch('/wake');const context=await fetch('/app-context').then(r=>r.json());locale=context.context?.locale||'en';const r=await hostMessage('status-request');profiles=[...new Map([...(r.learningProfiles||[]),...(r.clients||[]).filter(c=>c.trusted)].map(c=>[c.id,c])).values()];clientId=profiles[0]?.id||'';}
      t=U.copy(locale);if(isExtension||clientId){if(!isExtension){const config=await call({op:'config'});expandedLanguages=config.features?.includes('language-target-v1')===true;}const prefs=await call({op:'preferences'});target=prefs.target||target;if(isExtension){const stored=(await browser.storage.local.get('cindyReadingPreferences')).cindyReadingPreferences;if(L.validTarget(stored?.webTarget))target=stored.webTarget;}}renderHeader(profiles);if(!isExtension&&!clientId){status.textContent=t.disconnected;return;}reader();
    }catch(e){renderHeader(profiles);error(e);}
  }
  start();
})();
