'use strict';
(function(root) {
  function publicAddress(ip) {
    if (typeof ip !== 'string') return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      const [a,b,c,d]=ip.split('.').map(Number);
      return [a,b,c,d].every(n=>n<=255) && a!==0 && a!==10 && a!==127 && a<224 &&
        !(a===100 && b>=64 && b<=127) && !(a===169 && b===254) && !(a===172 && b>=16 && b<=31) &&
        !(a===192 && (b===168 || (b===0 && [0,2].includes(c)) || (b===88 && c===99))) &&
        !(a===198 && ([18,19].includes(b) || (b===51 && c===100))) && !(a===203 && b===0 && c===113);
    }
    // Accept global IPv6 unicast only; mapped/translation, link-local, ULA,
    // multicast, documentation and transition ranges never become public evidence.
    try {
      const host=new URL('http://['+ip+']/').hostname.slice(1,-1);
      const [first,second]=host.split(':').map(x=>parseInt(x || '0',16));
      return first>=0x2000 && first<=0x3fff && first!==0x2002 && first!==0x3fff &&
        !(first===0x2001 && (second<0x200 || second===0xdb8));
    } catch {return false;}
  }
  const networkURL=value=>{const u=new URL(value);u.hash='';return u.href;};
  const STORAGE_KEY='verifiedNetworkDocuments';
  function assertSupported(value) {
    const host=new URL(value).hostname.toLowerCase().replace(/\.$/,'');
    // Chrome's IsWebstoreDomain denies scripting for both store domains,
    // including the legacy developer console. A store install cannot override it.
    if(['chrome.google.com','chromewebstore.google.com'].some(h=>host===h || host.endsWith('.'+h)))
      throw new Error('BROWSER_PAGE_RESTRICTED');
  }
  const unverified=reason=>Object.assign(new Error('ADDRESS_UNVERIFIED'),{reason});
  function create(chrome) {
    const states=new Map(),requests=new Map(),responses=new Map(),verified=new Map(),touched=new Set();
    const session=chrome.storage?.session;
    let restored=false;
    // Session storage survives worker suspension, but not browser restart or an
    // extension reload. Store only document identity + origin, never page URLs,
    // query strings, IPs, titles or content; content scripts have no session access.
    const ready=session ? session.get(STORAGE_KEY).then(data=>{
      for(const [tabId,record] of (Array.isArray(data[STORAGE_KEY])?data[STORAGE_KEY]:[]).slice(-1024)) {
        if(touched.has(tabId) || !Number.isInteger(tabId) || !record || typeof record.id!=='string' || record.id.length>128 || typeof record.origin!=='string')continue;
        try {const u=new URL(record.origin);if(['https:','http:'].includes(u.protocol) && u.origin===record.origin)verified.set(tabId,record);}catch {}
      }
    }).catch(()=>{}).finally(()=>{restored=true;touched.clear();}) : Promise.resolve();
    let writes=ready;
    const persist=()=>{
      if(session)writes=writes.then(()=>session.set({[STORAGE_KEY]:[...verified].slice(-1024)})).catch(()=>{});
    };
    const forget=tabId=>{if(!restored)touched.add(tabId);verified.delete(tabId);persist();};
    const matches=tabId=>{
      const s=states.get(tabId);
      return (responses.get(tabId)||[]).filter(r=>s?.document && r.start>=s.start && r.start<=s.document.time && networkURL(r.url)===networkURL(s.document.url));
    };
    const remember=tabId=>{
      const doc=states.get(tabId)?.document,rs=matches(tabId);
      if(!doc?.id)return;
      if(rs.length!==1 || !rs[0].public){forget(tabId);return;}
      if(!restored)touched.add(tabId);
      verified.set(tabId,{id:doc.id,origin:new URL(doc.url).origin});
      if(verified.size>1024)verified.delete(verified.keys().next().value);
      persist();
    };
    const filter={urls:['http://*/*','https://*/*'],types:['main_frame']};
    const invalidate=tabId=>{forget(tabId);states.delete(tabId);responses.delete(tabId);for(const [id,r] of requests)if(r.tabId===tabId)requests.delete(id);};
    if (chrome.webRequest && chrome.webNavigation) {
      chrome.webNavigation.onBeforeNavigate.addListener(d=>{
        if(d.frameId!==0)return;
        const prev=states.get(d.tabId);
        if(prev && prev.start>d.timeStamp)return;
        forget(d.tabId);
        states.set(d.tabId,{start:d.timeStamp,document:null});
        // Delivery between the two APIs is not ordered. Compare event times;
        // never attach a late response from an older navigation to the new document.
      });
      chrome.webRequest.onBeforeRequest.addListener(d=>{
        const previous=requests.get(d.requestId);
        if(requests.size>=1024){requests.clear();states.clear();responses.clear();verified.clear();persist();return;}
        const r={tabId:d.tabId,start:previous?.start ?? d.timeStamp,url:d.url};
        requests.set(d.requestId,r);
      },filter);
      chrome.webRequest.onCompleted.addListener(d=>{
        const r=requests.get(d.requestId);requests.delete(d.requestId);
        if(!r || r.tabId!==d.tabId || r.url!==d.url)return;
        const list=responses.get(d.tabId) || [];
        list.push({start:r.start,url:d.url,public:publicAddress(d.ip),hasAddress:typeof d.ip==='string' && !!d.ip});
        responses.set(d.tabId,list.slice(-4));remember(d.tabId);
      },filter);
      chrome.webRequest.onErrorOccurred.addListener(d=>{requests.delete(d.requestId);responses.delete(d.tabId);forget(d.tabId);},filter);
      chrome.webNavigation.onCommitted.addListener(d=>{
        if(d.frameId!==0)return;
        const s=states.get(d.tabId);
        if(s && d.timeStamp>=s.start){s.document={id:d.documentId,url:d.url,time:d.timeStamp};remember(d.tabId);}
      });
      chrome.tabs.onRemoved.addListener(invalidate);
    }
    async function document(tabId) {
      await ready;
      const frame=await chrome.webNavigation?.getFrame({tabId,frameId:0});
      if(frame?.url)assertSupported(frame.url);
      if(!frame?.documentId)throw unverified('DOCUMENT_UNAVAILABLE');
      const saved=verified.get(tabId);
      if(saved?.id===frame.documentId && saved.origin===new URL(frame.url).origin)return frame.documentId;
      const s=states.get(tabId),rs=matches(tabId);
      if(!s?.document)throw unverified('NAVIGATION_UNOBSERVED');
      if(s.document.id!==frame.documentId)throw unverified('DOCUMENT_CHANGED');
      if(rs.length!==1)throw unverified('RESPONSE_UNOBSERVED');
      if(!rs[0].public)throw unverified(rs[0].hasAddress?'PEER_NOT_PUBLIC':'PEER_ADDRESS_MISSING');
      if(new URL(frame.url).origin!==new URL(rs[0].url).origin)throw unverified('DOCUMENT_CHANGED');
      return frame.documentId;
    }
    return {document,assertSupported};
  }
  const api={publicAddress,create,assertSupported};
  if(typeof module!=='undefined' && module.exports)module.exports=api;else root.MyBrowserNetwork=api;
})(globalThis);
