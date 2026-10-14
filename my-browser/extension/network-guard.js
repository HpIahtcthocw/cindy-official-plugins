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
  const unverified=reason=>Object.assign(new Error('ADDRESS_UNVERIFIED'),{reason});
  function assertSupported(value) {
    let u;try{u=new URL(value);}catch{throw unverified('DOCUMENT_UNAVAILABLE');}
    const host=u.hostname.toLowerCase().replace(/\.$/,'');
    if(!['https:','http:'].includes(u.protocol) || u.username || u.password ||
       host.includes(':') || host==='localhost' || host.endsWith('.localhost') ||
       host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') ||
       (/^\d+\.\d+\.\d+\.\d+$/.test(host) && !publicAddress(host)))throw unverified('LOCAL_ADDRESS');
    if(['chrome.google.com','chromewebstore.google.com'].some(h=>host===h || host.endsWith('.'+h)))
      throw new Error('BROWSER_PAGE_RESTRICTED');
  }
  function create(chrome) {
    const readyDocuments=new Map();
    chrome.webNavigation?.onBeforeNavigate.addListener(d=>{if(d.frameId===0)readyDocuments.delete(d.tabId);});
    chrome.webNavigation?.onDOMContentLoaded?.addListener(d=>{
      if(d.frameId!==0 || !d.documentId)return;
      readyDocuments.set(d.tabId,d.documentId);
      if(readyDocuments.size>1024)readyDocuments.delete(readyDocuments.keys().next().value);
    });
    chrome.tabs.onRemoved?.addListener(id=>readyDocuments.delete(id));
    async function document(tabId) {
      // Browser-owned document identity is the authority. Connection IP is the
      // proxy's endpoint for proxied traffic, and can be absent on cache hits.
      // Do not turn either into a refusal to use a page the browser has loaded.
      // We do not attest the destination IP behind a domain or browser proxy.
      let frame;try{frame=await chrome.webNavigation?.getFrame({tabId,frameId:0});}catch{}
      if(!frame?.documentId || !frame.url || frame.errorOccurred)throw unverified('DOCUMENT_UNAVAILABLE');
      assertSupported(frame.url);
      return frame.documentId;
    }
    async function isReady(tabId) {
      try{return readyDocuments.get(tabId)===await document(tabId);}catch{return false;}
    }
    return {document,isReady,assertSupported};
  }
  const api={publicAddress,create,assertSupported};
  if(typeof module!=='undefined' && module.exports)module.exports=api;else root.MyBrowserNetwork=api;
})(globalThis);
