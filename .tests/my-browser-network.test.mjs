import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {publicAddress,create}=createRequire(import.meta.url)('../my-browser/extension/network-guard.js');
function fixture(){
  const events={},frames=new Map();
  const event=name=>({addListener:fn=>events[name]=fn});
  const chrome={webRequest:{onBeforeRequest:event('request'),onCompleted:event('response'),onErrorOccurred:event('error')},webNavigation:{onBeforeNavigate:event('navigate'),onCommitted:event('commit'),getFrame:async({tabId})=>frames.get(tabId)},tabs:{onRemoved:event('removed')}};
  const guard=create(chrome);
  const emit=(name,extra={})=>events[name]({tabId:1,frameId:0,url:'https://example.test/',requestId:'request1',...extra});
  const commit=(id='doc1',timeStamp=3)=>{frames.set(1,{documentId:id,url:'https://example.test/'});emit('commit',{documentId:id,timeStamp});};
  return {guard,emit,commit,frames};
}
test('actual peer address classification rejects private, mapped, reserved and absent IPs',()=>{
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(publicAddress(ip),true,ip);
  for(const ip of [undefined,'','example.test','127.0.0.1','10.0.0.1','172.16.2.3','192.168.2.3','100.64.0.1','169.254.1.1','0.0.0.0','224.0.0.1','198.18.0.1','192.0.2.1','203.0.113.1','::1','::ffff:8.8.8.8','fc00::1','fe80::1','64:ff9b::a00:1','2002:7f00:1::','2001:db8::1','999.1.1.1'])assert.equal(publicAddress(ip),false,String(ip));
});
test('public-looking domains served by private IPs never authorize a document',async()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1',undefined]){
    const h=fixture();h.emit('navigate',{timeStamp:1});h.emit('request',{timeStamp:2});h.commit();h.emit('response',{ip,timeStamp:4});
    await assert.rejects(h.guard.document(1),/ADDRESS_UNVERIFIED/);
  }
});
test('a public response authorizes only its current committed document, in either completion ordering',async()=>{
  for(const responseFirst of [true,false]){
    const h=fixture();h.emit('navigate',{timeStamp:1});h.emit('request',{timeStamp:2});
    if(responseFirst)h.emit('response',{ip:'8.8.8.8',timeStamp:3});
    h.commit();if(!responseFirst)h.emit('response',{ip:'8.8.8.8',timeStamp:4});
    assert.equal(await h.guard.document(1),'doc1');
    h.frames.set(1,{documentId:'other',url:'https://example.test/'});await assert.rejects(h.guard.document(1));
  }
});
test('same-URL reload, late responses and redirects cannot reuse earlier public evidence',async()=>{
  const h=fixture();h.emit('navigate',{timeStamp:1});h.emit('request',{timeStamp:2});h.commit();
  h.emit('navigate',{timeStamp:10});h.commit('doc2',11);
  h.emit('request',{timeStamp:12}); // Same request id is a redirect of the OLD navigation.
  h.emit('response',{timeStamp:13,ip:'8.8.8.8'});await assert.rejects(h.guard.document(1));
  h.emit('request',{requestId:'request2',timeStamp:14});h.emit('response',{requestId:'request2',timeStamp:15,ip:'127.0.0.1'});
  await assert.rejects(h.guard.document(1));
});
test('unobserved, cached without IP, unsupported and restored documents fail closed',async()=>{
  const h=fixture();h.frames.set(1,{documentId:'existing',url:'https://example.test/'});await assert.rejects(h.guard.document(1));
  h.emit('navigate',{timeStamp:1});h.emit('request',{timeStamp:2});h.commit();h.emit('response',{timeStamp:4,fromCache:true});await assert.rejects(h.guard.document(1));
  const unsupported=create({tabs:{}});await assert.rejects(unsupported.document(1));
});

test('network completion delivered before navigation events retains correctly timed evidence',async()=>{
  const h=fixture();h.emit('request',{timeStamp:2});h.emit('response',{timeStamp:3,ip:'8.8.8.8'});h.emit('navigate',{timeStamp:1});h.commit('doc1',4);assert.equal(await h.guard.document(1),'doc1');
});

test('URL fragments do not change the verified network document',async()=>{
  const h=fixture();h.emit('navigate',{timeStamp:1});h.emit('request',{timeStamp:2});h.emit('response',{ip:'8.8.8.8',timeStamp:3});h.emit('commit',{documentId:'hash-doc',timeStamp:4,url:'https://example.test/#section'});h.frames.set(1,{documentId:'hash-doc',url:'https://example.test/#section'});assert.equal(await h.guard.document(1),'hash-doc');
});

function persistentFixture(storage,frames=new Map(),load){
  const events={};
  const event=name=>({addListener:fn=>events[name]=fn});
  const chrome={storage:{session:{get:async()=>load?load():structuredClone(storage),set:async data=>Object.assign(storage,structuredClone(data))}},webRequest:{onBeforeRequest:event('request'),onCompleted:event('response'),onErrorOccurred:event('error')},webNavigation:{onBeforeNavigate:event('navigate'),onCommitted:event('commit'),getFrame:async({tabId})=>frames.get(tabId)},tabs:{onRemoved:event('removed')}};
  const guard=create(chrome);
  const emit=(name,extra={})=>events[name](name==='removed'?1:{tabId:1,frameId:0,url:'https://example.test/private?token=secret',requestId:'r1',...extra});
  const authorize=()=>{
    emit('navigate',{timeStamp:1});emit('request',{timeStamp:2});
    frames.set(1,{documentId:'doc1',url:'https://example.test/private?token=secret'});
    emit('commit',{timeStamp:3,documentId:'doc1'});emit('response',{timeStamp:4,ip:'8.8.8.8'});
  };
  return {guard,emit,authorize,frames};
}
const settled=()=>new Promise(resolve=>setImmediate(resolve));
test('worker restart restores only exact verified documents, without persisting page URLs or IPs',async()=>{
  const storage={},h=persistentFixture(storage);h.authorize();
  assert.equal(await h.guard.document(1),'doc1');await settled();
  const encoded=JSON.stringify(storage);
  assert.ok(!encoded.includes('secret') && !encoded.includes('/private') && !encoded.includes('8.8.8.8'));
  const restarted=persistentFixture(storage,h.frames);
  assert.equal(await restarted.guard.document(1),'doc1');
  h.frames.set(1,{documentId:'doc2',url:'https://example.test/private?token=secret'});
  await assert.rejects(restarted.guard.document(1),{message:'ADDRESS_UNVERIFIED',reason:'NAVIGATION_UNOBSERVED'});
  h.frames.set(1,{documentId:'doc1',url:'https://other.test/'});
  await assert.rejects(restarted.guard.document(1),/ADDRESS_UNVERIFIED/);
});
test('new navigation and tab removal revoke session evidence even while restoration is pending',async()=>{
  for(const event of ['navigate','removed']){
    const storage={},h=persistentFixture(storage);h.authorize();await settled();
    const snapshot=structuredClone(storage);let finish;
    const restarted=persistentFixture(storage,h.frames,()=>new Promise(r=>{finish=r;}));
    restarted.emit(event,{timeStamp:10});finish(snapshot);
    await assert.rejects(restarted.guard.document(1),/ADDRESS_UNVERIFIED/);await settled();
    assert.deepEqual(storage.verifiedNetworkDocuments,[]);
    await assert.rejects(persistentFixture(storage,h.frames).guard.document(1),/ADDRESS_UNVERIFIED/);
  }
});
test('a previously public same-URL document never grants a private or unobserved reload',async()=>{
  const storage={},h=persistentFixture(storage);h.authorize();await settled();
  const restarted=persistentFixture(storage,h.frames);await restarted.guard.document(1);
  restarted.emit('navigate',{timeStamp:10});restarted.emit('request',{requestId:'r2',timeStamp:11});
  h.frames.set(1,{documentId:'doc2',url:'https://example.test/private?token=secret'});
  restarted.emit('commit',{documentId:'doc2',timeStamp:12});restarted.emit('response',{requestId:'r2',timeStamp:13,ip:'127.0.0.1'});
  await assert.rejects(restarted.guard.document(1),{message:'ADDRESS_UNVERIFIED',reason:'PEER_NOT_PUBLIC'});
  await settled();assert.deepEqual(storage.verifiedNetworkDocuments,[]);
});
test('store domains report the Chrome restriction before asking for network evidence',async()=>{
  const h=fixture();
  for(const host of ['chrome.google.com','chromewebstore.google.com','sub.chrome.google.com']){
    const url='https://'+host+'/webstore/devconsole/example/edit';
    assert.throws(()=>h.guard.assertSupported(url),/BROWSER_PAGE_RESTRICTED/);
    h.frames.set(1,{documentId:'store-doc',url});
    await assert.rejects(h.guard.document(1),/BROWSER_PAGE_RESTRICTED/);
  }
  for(const url of ['https://example.test/','https://chrome.google.com.example.test/','https://chrome.google.com@other.test/'])assert.doesNotThrow(()=>h.guard.assertSupported(url));
});
test('missing browser IP is distinguished from a known non-public peer',async()=>{
  const h=fixture();h.emit('navigate',{timeStamp:1});h.emit('request',{timeStamp:2});h.commit();h.emit('response',{timeStamp:4,fromCache:true});
  await assert.rejects(h.guard.document(1),{message:'ADDRESS_UNVERIFIED',reason:'PEER_ADDRESS_MISSING'});
});
