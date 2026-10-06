'use strict';
// Shared, deterministic input and subtitle handling. No network or host access.
(function(root) {
  const languages = {auto:'Auto',en:'English','zh-CN':'简体中文','zh-TW':'繁體中文',ja:'日本語',ko:'한국어',fr:'Français',de:'Deutsch',es:'Español',it:'Italiano',pt:'Português',ru:'Русский',ar:'العربية',hi:'हिन्दी',th:'ไทย',vi:'Tiếng Việt'};
  const operations = new Set(['translate','explain','summary','conversation','save','list','remove','review','import','preferences','config','task']);
  function string(value,max,required=false) {
    if (typeof value !== 'string' || value.length>max || (required && !value.trim())) throw Error('INVALID_INPUT');
    return value;
  }
  function source(value) {
    if (!value) return {url:'',title:''};
    const url=string(value.url || '',8192), title=string(value.title || '',500);
    if (url && !/^https?:$/.test(new URL(url).protocol)) throw Error('INVALID_SOURCE');
    const time=value.time;
    if (time!==undefined && (!Number.isFinite(time) || time<0 || time>864000)) throw Error('INVALID_TIME');
    return {url:url ? new URL(url).href : '',title,...(time===undefined?{}:{time})};
  }
  function validate(input) {
    if (!input || !operations.has(input.op)) throw Error('INVALID_OPERATION');
    const out={op:input.op,source:source(input.source)};
    if (input.target!==undefined) {
      if (!Object.hasOwn(languages,input.target) || input.target==='auto') throw Error('INVALID_LANGUAGE');
      out.target=input.target;
    }
    if (input.language!==undefined) {
      if (!Object.hasOwn(languages,input.language)) throw Error('INVALID_LANGUAGE');
      out.language=input.language;
    }
    for (const [key,max] of [['text',20000],['translation',20000],['context',4000],['query',200],['scenario',1000],['instruction',4000]]) if(input[key]!==undefined) out[key]=string(input[key],max);
    if (['translate','explain','summary','conversation','save','task'].includes(out.op) && !out.text?.trim() && !input.texts) throw Error('EMPTY_TEXT');
    if (input.texts!==undefined) {
      if(out.op!=='translate' || !Array.isArray(input.texts) || !input.texts.length || input.texts.length>24) throw Error('INVALID_BATCH');
      out.texts=input.texts.map(x=>string(x,4000,true));
      if(out.texts.join('').length>20000) throw Error('BATCH_TOO_LARGE');
    }
    if (input.id!==undefined) out.id=string(input.id,100,true);
    if (['remove','review','task'].includes(out.op) && !out.id) throw Error('INVALID_ID');
    if(out.op==='task'&&!/^[a-f0-9-]{36}$/.test(out.id))throw Error('INVALID_ID');
    if(out.op==='review') {if(!['again','hard','good','easy'].includes(input.rating)) throw Error('INVALID_RATING');out.rating=input.rating;}
    if(out.op==='import') {
      if(!Array.isArray(input.entries) || input.entries.length>500) throw Error('IMPORT_TOO_LARGE');
      out.entries=input.entries.map(e=>validate({...e,op:'save'}));
    }
    if(out.op==='list') {
      out.offset=Number.isInteger(input.offset)&&input.offset>=0?input.offset:0;
      out.limit=Number.isInteger(input.limit)?Math.min(100,Math.max(1,input.limit)):50;
      out.due=input.due===true;
    }
    return out;
  }
  function timestamp(text) {
    const values=text.replace(',','.').split(':').map(Number);
    if(values.length<2 || values.length>3 || values.some(x=>!Number.isFinite(x)||x<0)) return NaN;
    return values.reduce((v,n)=>v*60+n,0);
  }
  function parseSubtitles(text) {
    if(typeof text!=='string' || text.length>2000000) throw Error('SUBTITLE_TOO_LARGE');
    const cues=[];
    for(const block of text.replace(/\r/g,'').split(/\n\s*\n/)) {
      const lines=block.split('\n'), i=lines.findIndex(l=>l.includes('-->'));
      if(i<0)continue;
      const [a,b]=lines[i].split('-->'),start=timestamp(a.trim()),end=timestamp(b.trim().split(/\s/)[0]);
      const content=lines.slice(i+1).join(' ').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
      if(Number.isFinite(start)&&Number.isFinite(end)&&end>start&&content) cues.push({start,end,text:content.slice(0,4000)});
      if(cues.length>10000)throw Error('SUBTITLE_TOO_LARGE');
    }
    return cues.sort((a,b)=>a.start-b.start);
  }
  function clock(seconds) {
    const ms=Math.max(0,Math.round(seconds*1000)), sec=Math.floor(ms/1000);
    return [Math.floor(sec/3600),Math.floor(sec/60)%60,sec%60].map(n=>String(n).padStart(2,'0')).join(':')+','+String(ms%1000).padStart(3,'0');
  }
  function exportSubtitles(cues) {return cues.map((c,i)=>`${i+1}\n${clock(c.start)} --> ${clock(c.end)}\n${c.text}${c.translation?'\n'+c.translation:''}\n`).join('\n');}
  function schedule(entry,rating,now=Date.now()) {
    const previous=Number(entry.interval)||0;
    const days=rating==='again'?0:rating==='hard'?Math.max(1,previous*1.2):rating==='easy'?Math.max(4,previous*3):Math.max(1,previous*2.2);
    return {...entry,interval:days,due:now+(days?days*86400000:600000),reviews:(entry.reviews||0)+1,updated:now};
  }
  function uuid(){if(globalThis.crypto.randomUUID)return globalThis.crypto.randomUUID();const bytes=globalThis.crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;return Array.from(bytes,(v,i)=>([4,6,8,10].includes(i)?'-':'')+v.toString(16).padStart(2,'0')).join('');}
  const api={uuid,languages,validate,parseSubtitles,exportSubtitles,schedule,source};
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.CindyLearning=api;
})(globalThis);
