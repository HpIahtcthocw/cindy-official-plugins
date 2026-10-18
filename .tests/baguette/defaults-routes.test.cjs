const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {blockedRoute}=require('../../baguette-simulator/node/viewer-proxy.cjs');
const {createClipboard}=require('../../baguette-simulator/node/clipboard.cjs');
const udid='00000000-0000-4000-8000-000000000001';

test('Defaults, app list and relaunch routes are blocked in every spelling; other routes pass',()=>{
 for(const route of ['defaults.json?bundleId=com.example.app','defaults','defaults/','DEFAULTS','apps.json','defaults-groups.json?bundleId=x','relaunch?bundleId=x','%64efaults','defaults%2Ejson'])
  for(const prefix of [`/simulators/${udid}/`,`//simulators//${udid}/`])assert.equal(blockedRoute(prefix+route),true,prefix+route);
 assert.equal(blockedRoute('/simulators/%E0%A4%A/defaults'),true,'malformed encoding fails closed');
 for(const route of [`/simulators/${udid}`,`/simulators/${udid}/stream`,`/simulators/${udid}/logs`,'/simulators.json','/defaults/preference-rows.js','/sim-defaults.js'])
  assert.equal(blockedRoute(route),false,route);
});

test('blocked routes never reach the native server, even with a valid viewer session',async()=>{
 const seen=[];
 const upstream=http.createServer((req,res)=>{seen.push(req.method+' '+req.url);res.end('ok');});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const port=upstream.address().port;
 const bridge=await createClipboard('http://127.0.0.1:'+port,async()=>{}, {port,status:async()=>({ready:true})});bridge.devices.add(udid);
 try{
  const token=bridge.fragment.split('.')[1];
  const auth=await fetch(bridge.base+'/control-api',{method:'POST',headers:{Origin:bridge.base,'X-Cindy-Clipboard':token},body:JSON.stringify({action:'status',udid})});
  const cookie=auth.headers.get('set-cookie').split(';')[0];
  for(const [method,path] of [['GET','defaults.json?bundleId=com.example.app'],['POST','defaults'],['DELETE','defaults?bundleId=x&key=y'],['POST','relaunch?bundleId=x'],['GET','apps.json']]){
   const res=await fetch(`${bridge.base}/simulators/${udid}/${path}`,{method,headers:{Cookie:cookie,Origin:bridge.base},body:method==='POST'?'{}':undefined});
   assert.equal(res.status,404,method+' '+path);
  }
  assert.deepEqual(seen,[]);
  assert.equal((await fetch(`${bridge.base}/simulators/${udid}`,{headers:{Cookie:cookie}})).status,200);
  assert.deepEqual(seen,[`GET /simulators/${udid}`]);
 }finally{bridge.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
});
