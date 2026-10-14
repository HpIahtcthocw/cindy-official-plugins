import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {publicAddress,create}=createRequire(import.meta.url)('../my-browser/extension/network-guard.js');
function fixture(frames=new Map()){
  const events={};const event=name=>({addListener:fn=>events[name]=fn});
  // No webRequest or stored IP evidence: use the actual browser frame contract.
  const chrome={webNavigation:{onBeforeNavigate:event('navigate'),onDOMContentLoaded:event('ready'),getFrame:async({tabId})=>frames.get(tabId)},tabs:{onRemoved:event('removed')}};
  return {guard:create(chrome),frames,emit:(name,extra={})=>events[name](name==='removed'?1:{tabId:1,frameId:0,...extra})};
}
test('actual peer address classification rejects private, mapped, reserved and absent IPs',()=>{
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(publicAddress(ip),true,ip);
  for(const ip of [undefined,'','example.test','127.0.0.1','10.0.0.1','172.16.2.3','192.168.2.3','100.64.0.1','169.254.1.1','0.0.0.0','224.0.0.1','198.18.0.1','192.0.2.1','203.0.113.1','::1','::ffff:8.8.8.8','fc00::1','fe80::1','64:ff9b::a00:1','2002:7f00:1::','2001:db8::1','999.1.1.1'])assert.equal(publicAddress(ip),false,String(ip));
});

test('proxy, cached, pre-install and restored pages use current browser document identity without peer evidence',async()=>{
  const frames=new Map([[1,{documentId:'doc1',url:'https://example.test/'}]]);
  const h=fixture(frames);assert.equal(await h.guard.document(1),'doc1');
  assert.equal(await fixture(frames).guard.document(1),'doc1');
  frames.set(1,{documentId:'doc2',url:'https://example.test/#section'});
  assert.equal(await h.guard.document(1),'doc2');
  frames.set(1,{documentId:'doc3',url:'https://other.test/'});
  assert.equal(await h.guard.document(1),'doc3');
});
test('local URLs and Chrome protected pages remain inaccessible regardless of proxy use',async()=>{
  const h=fixture();
  for(const url of ['http://localhost/','https://device.local/','http://corp.internal/','http://127.1/','http://10.0.0.1/','http://192.168.1.1/','http://[::1]/','http://198.18.0.1/','file:///tmp/page','https://user:secret@example.test/']){
    h.frames.set(1,{documentId:'doc',url});
    await assert.rejects(h.guard.document(1),{message:'ADDRESS_UNVERIFIED',reason:'LOCAL_ADDRESS'},url);
  }
  for(const host of ['chrome.google.com','chromewebstore.google.com','sub.chrome.google.com']){
    h.frames.set(1,{documentId:'doc',url:'https://'+host+'/'});
    await assert.rejects(h.guard.document(1),/BROWSER_PAGE_RESTRICTED/);
  }
});
test('missing, failed and inaccessible documents fail without leaking page data',async()=>{
  const h=fixture();
  for(const frame of [undefined,{url:'https://example.test/'},{documentId:'doc',url:'https://example.test/',errorOccurred:true}]){
    h.frames.set(1,frame);await assert.rejects(h.guard.document(1),{message:'ADDRESS_UNVERIFIED',reason:'DOCUMENT_UNAVAILABLE'});
  }
  const inaccessible=create({tabs:{},webNavigation:{onBeforeNavigate:{addListener(){}},getFrame:async()=>{throw Error('private url');}}});
  await assert.rejects(inaccessible.document(1),{message:'ADDRESS_UNVERIFIED',reason:'DOCUMENT_UNAVAILABLE'});
});
test('DOM readiness is bound to the current document, cleared on navigation/removal, and ignores subframes',async()=>{
  const h=fixture();h.frames.set(1,{documentId:'doc1',url:'https://example.test/'});
  assert.equal(await h.guard.isReady(1),false);
  h.emit('ready',{documentId:'doc1',frameId:2});assert.equal(await h.guard.isReady(1),false);
  h.emit('ready',{documentId:'doc1'});assert.equal(await h.guard.isReady(1),true);
  h.frames.set(1,{documentId:'doc2',url:'https://example.test/'});assert.equal(await h.guard.isReady(1),false);
  h.emit('ready',{documentId:'doc2'});assert.equal(await h.guard.isReady(1),true);
  h.emit('navigate');assert.equal(await h.guard.isReady(1),false);
  h.emit('ready',{documentId:'doc2'});h.emit('removed');assert.equal(await h.guard.isReady(1),false);
});
