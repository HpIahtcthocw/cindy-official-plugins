const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),net=require('node:net');
const {createClipboard}=require('../../baguette-simulator/node/clipboard.cjs');
const udid='00000000-0000-4000-8000-000000000001';
test('viewer HTTP and WebSocket require authenticated capability session',async()=>{
 let reads=0,upgrades=0;
 const upstream=http.createServer((req,res)=>{reads++;assert.equal(req.headers.cookie,undefined);res.end('viewer');});
 upstream.on('upgrade',(req,socket)=>{upgrades++;socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const bridge=await createClipboard('http://127.0.0.1:'+upstream.address().port,async()=>{}, {port:upstream.address().port,status:async()=>({ready:true})});bridge.devices.add(udid);
 try {
  assert.equal((await fetch(bridge.base+'/simulators/'+udid)).status,403);assert.equal(reads,0);
  const token=bridge.fragment.split('.')[1];
  const auth=await fetch(bridge.base+'/control-api',{method:'POST',headers:{Origin:bridge.base,'X-Cindy-Clipboard':token},body:JSON.stringify({action:'status',udid})});
  const cookie=auth.headers.get('set-cookie').split(';')[0];assert.match(auth.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(bridge.base+'/simulators/'+udid,{headers:{Cookie:cookie}})).status,200);assert.equal(reads,1);
  async function ws(cookie){return new Promise((resolve,reject)=>{const url=new URL(bridge.base);const s=net.connect(Number(url.port),'127.0.0.1');let data='';s.on('connect',()=>s.write(`GET /stream HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${bridge.base}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${cookie?'Cookie: '+cookie+'\r\n':''}\r\n`));s.on('data',d=>{data+=d;s.destroy();});s.on('error',reject);s.on('close',()=>resolve(data));});}
  assert.equal(await ws(''), '');assert.equal(upgrades,0);
  assert.match(await ws(cookie),/101/);assert.equal(upgrades,1);
 } finally {bridge.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
});

test('shutdown requires the viewer origin, capability and an opened device; failure is not a success response',async()=>{
 let stops=0;
 const bridge=await createClipboard('http://127.0.0.1:1',async()=>{}, {port:1,shutdown:async()=>{stops++;return {ok:false,errorCode:'STOP_INCOMPLETE',execution:'unknown'};}});
 bridge.devices.add(udid);
 const token=bridge.fragment.split('.')[1];
 const request=(origin,key,device)=>fetch(bridge.base+'/control-api',{method:'POST',headers:{Origin:origin,'X-Cindy-Clipboard':key},body:JSON.stringify({action:'shutdown',udid:device})});
 try {
  assert.equal((await request('https://example.test',token,udid)).status,403);
  assert.equal((await request(bridge.base,'wrong',udid)).status,403);
  assert.equal((await request(bridge.base,token,'00000000-0000-4000-8000-000000000002')).status,400);
  assert.equal(stops,0);
  const result=await request(bridge.base,token,udid);assert.equal(result.status,409);assert.equal((await result.json()).execution,'unknown');assert.equal(stops,1);
 }finally{bridge.close();}
});
