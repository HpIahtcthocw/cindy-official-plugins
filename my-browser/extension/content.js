'use strict';
(() => {
  if(globalThis.__cindyReading)return;
  globalThis.__cindyReading=true;
  const api=globalThis.browser||globalThis.chrome,L=globalThis.CindyLearning,U=globalThis.CindyUI;
  let locale='en',t=U.copy(locale),target='zh-CN',host,shadow,body,status,footer,cancelButton,nav,selected='',selectedContext='',lastResult='',taskKey='',taskPayload='',generation=0,translated=false;
  let cueMedia,cueMediaSource='',video,cues=[],activeCue=-1,repeat=false,autoPause=false,previousCue=-1,videoHandler,recognition,videoSession,videoTimer;
  const requests=new Set(),translations=new Map();let observer,translateRunning=false;
  function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
  function button(text,fn,cls=''){const b=el('button',text,cls);b.type='button';b.addEventListener('click',e=>{if(e.isTrusted)Promise.resolve(fn()).catch(report);});return b;}
  function report(e){if(status){status.textContent=U.error(e?.message||e,locale);status.className='status error';updateFooter();}}
  function note(text){if(!status)return;status.textContent=text;status.className='status';updateFooter();}
  function updateFooter(){if(!footer)return;cancelButton.hidden=!requests.size;footer.hidden=!requests.size&&!status.textContent;}
  function pageTheme(){for(const node of [document.body,document.documentElement]){if(!node)continue;const c=getComputedStyle(node).backgroundColor.match(/[\d.]+/g)?.map(Number);if(c&&c.length>=3&&(c.length===3||c[3]>=0.5))return (c[0]*.2126+c[1]*.7152+c[2]*.0722)<128?'dark':'light';}return getComputedStyle(document.documentElement).colorScheme==='dark'?'dark':'light';}
  function isolateHost(node,layout){node.style.setProperty('all','initial','important');for(const [key,value]of Object.entries(layout))node.style.setProperty(key,value,'important');}
  function iconButton(label,path,fn){const b=button('',fn,'quiet icon');b.setAttribute('aria-label',label);b.title=label;const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');const shape=document.createElementNS(svg.namespaceURI,'path');shape.setAttribute('d',path);svg.append(shape);b.append(svg);return b;}
  function source(){return {url:location.href,title:document.title.slice(0,500),...(video?{time:video.currentTime}:{})};}
  async function request(req){
    const id=L.uuid(),url=location.href;requests.add(id);updateFooter();
    try{const r=await api.runtime.sendMessage({type:'cindy-learning',id,request:{target,...req,source:req.source||source()}});if(location.href!==url)throw Error('PAGE_CHANGED');if(!r?.ok)throw Error(r?.error||'MODEL_UNAVAILABLE');return r;}
    finally{requests.delete(id);updateFooter();}
  }
  function cancel(){generation++;for(const id of requests)api.runtime.sendMessage({type:'cindy-cancel',id}).catch(()=>{});requests.clear();updateFooter();}
  function speak(text,language){speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.lang=language||target;u.rate=0.9;speechSynthesis.speak(u);}
  async function configure(){const r=await request({op:'config'});locale=r.locale||'en';t=U.copy(locale);const prefs=await request({op:'preferences'});target=prefs.target||target;}
  function stopPage(){translated=false;observer?.disconnect();observer=null;clearTimeout(translateTimer);}
  function rememberVideo(enabled){api.runtime.sendMessage({type:'cindy-video-state',enabled}).catch(()=>{});}
  function close(){rememberVideo(false);cancel();stopPage();stopVideo();recognition?.stop();recognition=null;speechSynthesis.cancel();host?.remove();host=null;shadow=null;footer=null;status=null;}
  function makePanel(){
    if(host)return;
    host=el('div');isolateHost(host,{position:'fixed',display:'block','z-index':'2147483646',top:'16px',right:'16px',width:'min(384px,calc(100vw - 32px))','max-height':'calc(100vh - 32px)'});
    shadow=host.attachShadow({mode:'closed'});
    const style=el('style',U.css+`.panel{display:flex;flex-direction:column;max-height:calc(100vh - 32px);background:var(--surface);border:1px solid var(--board);border-radius:12px;overflow:hidden}header{padding:12px;border-bottom:1px solid var(--board)}.heading{flex-wrap:nowrap;gap:4px}.heading h1{padding-left:4px}main{padding:16px;overflow:auto;min-height:0}footer{display:flex;align-items:center;gap:8px;padding:8px 16px;border-top:1px solid var(--board)}footer .status{flex:1}nav{display:flex;gap:2px;margin-top:12px}nav button{flex:1;white-space:nowrap;padding:4px 8px;font-size:12px}nav button[aria-pressed=true]{background:var(--hover);font-weight:600}button.quiet:hover{background:var(--hover)}select{max-width:116px;font-size:12px}.icon{width:32px;padding:6px;display:grid;place-items:center;flex-shrink:0}.icon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.cue{white-space:pre-wrap}.cue small{display:block;margin-top:4px}.toolbar{margin-top:10px}.video-list{max-height:42vh;overflow:auto}.selection{max-height:180px;overflow:auto}.page-actions{align-self:flex-start}.result:empty{display:none}details{border-top:1px solid var(--board);padding-top:12px}summary{cursor:pointer;color:var(--muted);font-size:12px}details .stack{margin-top:12px}`);shadow.append(style);
    const panel=el('section',undefined,'panel cindy-root');panel.dataset.theme=pageTheme();panel.setAttribute('aria-label','Cindy');const header=el('header'),row=el('div',undefined,'row heading');
    row.append(el('h1','Cindy','grow'));
    const language=el('select');language.setAttribute('aria-label',t.target);
    for(const [value,label]of Object.entries(L.languages)){if(value==='auto')continue;const o=el('option',label);o.value=value;language.append(o);}language.value=target;
    language.onchange=()=>{cancel();target=language.value;request({op:'preferences',target}).catch(report);for(const c of cues)delete c.translation;if(translated)restorePage();if(videoSession){videoSession.paused=false;videoSession.failed=false;cueList();videoHandler?.();translateCues();}};
    row.append(language,iconButton(t.theme,'M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9Z M12 3v18 M12 3a9 9 0 0 1 0 18Z',()=>{panel.dataset.theme=panel.dataset.theme==='dark'?'light':'dark';}),iconButton(t.close,'M6 6l12 12M18 6 6 18',close));header.append(row);
    nav=el('nav');for(const [mode,label,action]of [['selection',t.translate,showSelection],['page',t.page,togglePage],['video',t.video,showVideo],['practice',t.practice,showPractice],['library',t.library,()=>api.runtime.sendMessage({type:'cindy-open-library'})]]){const b=button(label,action,'quiet');b.dataset.mode=mode;b.setAttribute('aria-pressed','false');nav.append(b);}header.append(nav);
    body=el('main',undefined,'stack');status=el('div','', 'status');status.setAttribute('role','status');footer=el('footer');cancelButton=button(t.cancel,()=>{if(videoSession){videoSession.paused=true;videoSession.retryButton.hidden=false;}cancel();stopPage();note(t.cancel);},'quiet');footer.append(status,cancelButton);panel.append(header,body,footer);shadow.append(panel);document.documentElement.append(host);updateFooter();
  }
  function clear(mode){rememberVideo(mode==='video');cancel();recognition?.stop();recognition=null;stopVideo();body.onkeydown=null;body.replaceChildren();note('');for(const b of nav.children)b.setAttribute('aria-pressed',String(b.dataset.mode===mode));}
  function selection(){
    const s=window.getSelection();const node=s?.anchorNode?.parentElement;
    if(!s||!node||node.closest('input,textarea,[contenteditable]')){selected='';selectedContext='';return;}
    const value=s.toString().trim();if(value&&value.length<=20000){selected=value;selectedContext=(node.closest('p,li,article')?.innerText||node.innerText||'').slice(0,4000);lastResult='';}
  }
  async function open(action){
    selection();
    try{await configure();}catch(e){makePanel();report(e);return;}
    makePanel();
    if(action==='translate-page')return togglePage();
    if(action==='video')return showVideo();
    showSelection();if(action==='selection'&&selected)await translateSelection();
  }
  function showSelection(){clear('selection');const input=el('textarea');input.placeholder=t.empty;input.value=selected;input.setAttribute('aria-label',t.source);input.oninput=()=>{selected=input.value;lastResult='';};body.append(input);
    const actions=el('div',undefined,'row');actions.append(button(t.translate,translateSelection,'primary'),button(t.explain,()=>analyze('explain')),button(t.summary,()=>analyze('summary')));body.append(actions);const result=el('p',lastResult,'result');body.append(result);
    const save=el('div',undefined,'row');save.append(button(t.listen,()=>speak(lastResult||selected)),button(t.save,saveSelection));body.append(save);const instruction=el('textarea');instruction.placeholder=t.taskInstruction;instruction.setAttribute('aria-label',t.taskInstruction);const handoff=el('details'),handoffBody=el('div',undefined,'stack');handoff.append(el('summary',t.handoff),handoffBody);body.append(handoff);handoffBody.append(instruction,button(t.handoff,async()=>{if(!selected.trim())return;const payload=JSON.stringify([selected,selectedContext,instruction.value,source().url]);if(payload!==taskPayload){taskKey=L.uuid();taskPayload=payload;}note(t.working);const r=await request({op:'task',id:taskKey,text:selected,context:selectedContext,instruction:instruction.value});note(t.taskSent+' '+r.title);}));
  }
  async function translateSelection(){if(!selected.trim())return;const g=++generation;note(t.working);const r=await request({op:'translate',text:selected});if(g!==generation)return;lastResult=r.translations[0];body.querySelector('.result').textContent=lastResult;note('');}
  async function analyze(op){if(!selected.trim())return;const g=++generation;note(t.working);const r=await request({op,text:selected,context:selectedContext});if(g!==generation)return;lastResult=r.text;body.querySelector('.result').textContent=lastResult;note('');}
  async function saveSelection(){if(!selected.trim())return;await request({op:'save',text:selected,translation:lastResult,context:selectedContext});note(t.saved);}
  function restorePage(){cancel();translated=false;observer?.disconnect();observer=null;for(const [node,rec]of translations){rec.host.remove();}translations.clear();if(status)note(t.restore);}
  function candidates(){return [...(document.querySelector('article,main,[role=main]')||document.body).querySelectorAll('p,h1,h2,h3,li,blockquote,figcaption')].filter(n=>!translations.has(n)&&!n.closest('pre,code,nav,footer,header,textarea,[contenteditable],script,style')&&n.getClientRects().length&&n.innerText?.trim().length>2&&n.innerText.length<=4000&&!n.querySelector('p,li,blockquote')&&n.getBoundingClientRect().top<innerHeight*2&&n.getBoundingClientRect().bottom>0);}
  async function translateVisible(){
    if(!translated||translateRunning)return;translateRunning=true;
    const g=generation;
    try{
      const nodes=candidates().slice(0,12),texts=[];const accepted=[];
      for(const n of nodes){if(texts.join('').length+n.innerText.length>18000)break;texts.push(n.innerText);accepted.push(n);}
      if(!accepted.length)return;
      const r=await request({op:'translate',texts});if(g!==generation||!translated)return;
      accepted.forEach((node,i)=>{if(!node.isConnected||node.innerText!==texts[i])return;const h=el('span');const root=h.attachShadow({mode:'closed'});root.append(el('style',':host{display:block;margin:6px 0 12px;font:inherit;color:inherit;opacity:.8}'),el('span',r.translations[i]));node.after(h);translations.set(node,{host:h,text:texts[i]});});
      if(status)note(`${t.progress} ${translations.size}`);
    }catch(e){if(g===generation){translated=false;observer?.disconnect();report(e);}}
    finally{translateRunning=false;if(translated&&g===generation&&candidates().length)queueTranslate();}
  }
  async function togglePage(){if(translated||translations.size){restorePage();return;}clear('page');translated=true;body.append(el('h2',t.page),el('p',t.pageHint,'muted'),button(t.restore,restorePage,'page-actions'));note(t.working);
    observer=new MutationObserver(()=>{for(const [n,r]of translations)if(!n.isConnected||n.innerText!==r.text){r.host.remove();translations.delete(n);}queueTranslate();});observer.observe(document.body,{subtree:true,childList:true,characterData:true});await translateVisible();}
  let translateTimer;function queueTranslate(){clearTimeout(translateTimer);translateTimer=setTimeout(()=>translateVisible(),350);}
  window.addEventListener('scroll',()=>{if(translated)queueTranslate();},{passive:true});
  function stopVideo(){clearTimeout(videoTimer);videoSession=null;if(video&&videoHandler)video.removeEventListener('timeupdate',videoHandler);videoHandler=null;video=null;activeCue=-1;previousCue=-1;}
  function cueList(){const list=body.querySelector('.video-list');if(!list)return;list.replaceChildren();cues.forEach((c,i)=>{const b=button(c.text,()=>jump(i),'cue');b.dataset.index=String(i);if(c.translation)b.append(el('small',c.translation));list.append(b);});}
  function jump(i){if(!video||!cues[i])return;video.currentTime=cues[i].start;activeCue=i;previousCue=i;video.play().catch(report);}
  async function translateCues(){
    const session=videoSession;if(!session||session.running||session.paused||session.failed||!cues.some(c=>!c.translation))return;
    session.running=true;const g=generation;note(t.working);
    try {
      while(session===videoSession&&g===generation&&!session.paused){
        const index=cues.findIndex(c=>c.end>video.currentTime),start=index<0?0:index;
        const batch=[...cues.slice(start),...cues.slice(0,start)].filter(c=>!c.translation).slice(0,4);
        if(!batch.length)break;
        const r=await request({op:'translate',texts:batch.map(c=>c.text)});
        if(session!==videoSession||g!==generation)return;
        batch.forEach((c,i)=>c.translation=r.translations[i]);cueList();videoHandler?.();
        note(`${t.progress} ${cues.filter(c=>c.translation).length} / ${cues.length}`);
      }
    }catch(e){if(session===videoSession&&g===generation){session.failed=true;session.retryButton.hidden=false;report(e);}}
    finally{session.running=false;if(session===videoSession&&g!==generation&&!session.paused&&!session.failed)translateCues();}
  }
  function mergeCues(next){
    const key=c=>JSON.stringify([c.start,c.end,c.text]),previous=new Map(cues.map(c=>[key(c),c]));
    const changed=next.length!==cues.length||next.some((c,i)=>key(c)!==key(cues[i]||{}));
    if(!changed)return;
    cues=next.map(c=>previous.get(key(c))||c);cueList();videoHandler?.();
  }
  async function readCues(session){
    if(session!==videoSession)return;
    try {
      if(!video.isConnected||(video.currentSrc&&video.currentSrc!==session.src)){showVideo();return;}
      if(!session.imported){
        const tracks=[...video.textTracks],track=tracks.find(x=>x.mode==='showing')||tracks.find(x=>x.kind==='subtitles'||x.kind==='captions');
        if(track){if(track.mode==='disabled')track.mode='hidden';const next=[...(track.cues||[])].map(c=>({start:c.startTime,end:c.endTime,text:c.text.replace(/<[^>]*>/g,'').trim().slice(0,4000)})).filter(c=>c.text&&c.end>c.start);if(next.length)mergeCues(next);}
        if(!cues.length&&/(^|\.)youtube\.com$/.test(location.hostname)&&!session.readBlocked&&Date.now()>=session.nextRead){
          session.attempts++;session.nextRead=Date.now()+Math.min(30000,3000*session.attempts);
          const result=await api.runtime.sendMessage({type:'cindy-captions',language:'auto'});
          if(session!==videoSession)return;
          if(result?.ok)mergeCues(result.cues);else throw Error(result?.error||'SUBTITLE_UNAVAILABLE');
        }
      }
      if(cues.length)translateCues();else if(!session.readBlocked)note(t.waitSubtitles);
    }catch(e){if(session===videoSession){session.readBlocked=e.message!=='SUBTITLE_UNAVAILABLE';session.retryButton.hidden=false;report(e);}}
    finally{if(session===videoSession)videoTimer=setTimeout(()=>readCues(session),1200);}
  }
  async function showVideo(){
    clear('video');video=[...document.querySelectorAll('video,audio')].find(v=>v.getClientRects().length)||document.querySelector('video,audio');
    if(!video){body.append(el('p',t.noVideo));videoTimer=setTimeout(showVideo,1200);return;}
    const media=video;
    if(cueMedia!==media||media.currentSrc!==cueMediaSource){cues=[];cueMedia=media;cueMediaSource=media.currentSrc;}
    const session=videoSession={src:media.currentSrc,running:false,paused:false,failed:false,imported:false,attempts:0,nextRead:0};
    const tools=el('div',undefined,'row'),file=el('input');file.type='file';file.accept='.srt,.vtt';file.hidden=true;
    file.onchange=async()=>{try{const f=file.files[0];if(!f)return;if(f.size>2000000)throw Error('SUBTITLE_TOO_LARGE');const next=L.parseSubtitles(await f.text());if(session!==videoSession)return;cancel();session.imported=true;session.failed=false;session.paused=false;mergeCues(next);if(cues.length)translateCues();else if(!session.readBlocked)note(t.waitSubtitles);}catch(e){report(e);}};
    session.retryButton=button(t.retrySubtitles,()=>{session.retryButton.hidden=true;session.failed=false;session.paused=false;session.attempts=0;session.nextRead=0;session.readBlocked=false;clearTimeout(videoTimer);return readCues(session);});session.retryButton.hidden=true;tools.append(session.retryButton,button(t.subtitles,()=>file.click()),button(t.export,()=>download(L.exportSubtitles(cues),'subtitles.srt')),file);body.append(tools);
    const controls=el('div',undefined,'row');controls.append(button(t.previous,()=>jump(Math.max(0,activeCue-1))),button(t.replay,()=>jump(Math.max(0,activeCue))),button(t.next,()=>jump(Math.min(cues.length-1,activeCue+1))));
    const speed=el('select');speed.setAttribute('aria-label','Playback speed');for(const n of [.5,.75,1,1.25,1.5,2]){const o=el('option',n+'×');o.value=n;speed.append(o);}speed.value=media.playbackRate;speed.onchange=()=>media.playbackRate=Number(speed.value);controls.append(speed);body.append(controls);
    const options=el('div',undefined,'row');for(const [label,get,set]of [[t.repeat,()=>repeat,v=>repeat=v],[t.pause,()=>autoPause,v=>autoPause=v]]){const l=el('label'),c=el('input');c.type='checkbox';c.checked=get();c.onchange=()=>set(c.checked);l.append(c,el('span',label));options.append(l);}body.append(options);
    const current=el('p','', 'card');body.append(current,button(t.save,async()=>{const c=cues[activeCue];if(!c)return;await request({op:'save',text:c.text,translation:c.translation||'',source:{...source(),time:c.start}});note(t.saved);}));
    body.append(el('div',undefined,'list video-list'),el('small',t.subtitleHint));cueList();note(t.waitSubtitles);
    videoHandler=()=>{
      if(previousCue>=0&&cues[previousCue]&&media.currentTime>=cues[previousCue].end&&media.currentTime<cues[previousCue].end+1){if(repeat){media.currentTime=cues[previousCue].start;return;}if(autoPause){media.pause();previousCue=-1;}}
      const i=cues.findIndex(c=>media.currentTime>=c.start&&media.currentTime<c.end);activeCue=i;if(i>=0)previousCue=i;
      current.textContent=i<0?'':cues[i].text+(cues[i].translation?'\n'+cues[i].translation:'');
      for(const b of body.querySelectorAll('[data-index]'))b.classList.toggle('active',Number(b.dataset.index)===i);
    };media.addEventListener('timeupdate',videoHandler);videoHandler();readCues(session);
    body.onkeydown=e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;const actions={a:()=>jump(Math.max(0,activeCue-1)),s:()=>jump(Math.max(0,activeCue)),d:()=>jump(Math.min(cues.length-1,activeCue+1)),q:()=>autoPause=!autoPause,r:()=>repeat=!repeat};if(actions[e.key]&&e.isTrusted){e.preventDefault();actions[e.key]();}};
  }
  function showPractice(){stopVideo();clear('practice');const scenario=el('input');scenario.placeholder=t.scenarioHint;scenario.setAttribute('aria-label',t.scenario);const transcript=el('div',undefined,'stack'),input=el('textarea');input.placeholder=t.draft;
    const actions=el('div',undefined,'row');let history='';
    actions.append(button(t.send,async()=>{const value=input.value.trim();if(!value)return;note(t.working);input.value='';transcript.append(el('p',value,'card'));const r=await request({op:'conversation',text:value,context:history.slice(-4000),scenario:scenario.value});history+='\nLearner: '+value+'\nTutor: '+r.text;transcript.append(el('p',r.text));note('');},'primary'),button(t.speech,()=>{
      const Speech=globalThis.SpeechRecognition||globalThis.webkitSpeechRecognition;if(!Speech){note(t.speechHint);return;}recognition?.stop();recognition=new Speech();recognition.lang=target;recognition.interimResults=false;recognition.onresult=e=>input.value+=(input.value?' ':'')+e.results[0][0].transcript;recognition.onerror=()=>note(t.speechHint);recognition.start();note(t.speechHint);
    }),button(t.stop,()=>recognition?.stop()));body.append(scenario,transcript,input,actions,el('small',t.speechHint));
  }
  function download(text,name){const u=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})),a=el('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
  let selectionButton;
  document.addEventListener('mouseup',e=>{if(!e.isTrusted||e.composedPath().includes(host))return;selection();selectionButton?.remove();selectionButton=null;if(!window.getSelection()?.toString().trim()||!selected)return;
    const h=el('div');isolateHost(h,{position:'fixed',left:Math.min(e.clientX,innerWidth-90)+'px',top:Math.min(e.clientY+12,innerHeight-45)+'px','z-index':'2147483645'});const s=h.attachShadow({mode:'closed'}),root=el('div',undefined,'cindy-root');root.dataset.theme=pageTheme();root.append(button('Cindy',()=>{h.remove();return open('selection');},'primary'));s.append(el('style',U.css),root);document.documentElement.append(h);selectionButton=h;
  });
  api.runtime.onMessage.addListener((m,_sender,reply)=>{if(m?.type!=='cindy-ui')return;open(m.action).then(()=>reply({ok:true})).catch(e=>{report(e);reply({ok:false,error:e.message});});return true;});
  api.runtime.sendMessage({type:'cindy-video-resume'}).then(r=>{if(r?.enabled&&!host)open('video').catch(report);}).catch(()=>{});
  let lastURL=location.href;setInterval(()=>{if(lastURL!==location.href){lastURL=location.href;restorePage();close();selectionButton?.remove();selected='';cues=[];}},1000);
})();
