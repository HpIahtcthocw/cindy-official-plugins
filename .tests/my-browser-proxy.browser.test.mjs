// Real MV3, signed local bridge and loopback proxy. Only model output is a fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {createLearningService} from '../my-browser/learning-service.js';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'../my-browser');
const {createBridge}=require('../my-browser/node/bridge.cjs'),core=require('../my-browser/extension/learning-core.js');
test('proxy translation renders visible Chinese and restores original text without peer-IP shims',{skip:!process.env.PLAYWRIGHT_CORE,timeout:30000},async t=>{
  const {chromium}=require(process.env.PLAYWRIGHT_CORE),profile=await fs.mkdtemp(path.join(os.tmpdir(),'cindy-proxy-reading-'));
  let context,bridge;const files=new Map(),modelCalls=[];
  t.after(async()=>{await context?.close();await bridge?.close();await fs.rm(profile,{recursive:true,force:true,maxRetries:3});});
  const extension=path.join(profile,'extension');await fs.cp(path.join(root,'extension'),extension,{recursive:true});
  const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'der'}});
  const extensionId=createHash('sha256').update(publicKey).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
  const manifest=JSON.parse(await fs.readFile(path.join(extension,'manifest.json'),'utf8'));manifest.key=publicKey.toString('base64');await fs.writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  const service=createLearningService({core,locale:()=> 'zh-CN',model:async r=>{
    modelCalls.push(r);const material=JSON.parse(r.prompt.split('\n').at(-1));
    return {ok:true,text:JSON.stringify({translations:material.texts.map(x=>'中文译文：'+x)})};
  },library:async r=>r.op==='read'?(files.has(r.path)?{ok:true,content:files.get(r.path)}:{ok:false,errorCode:'NOT_FOUND'}):(files.set(r.path,r.content),{ok:true})});
  bridge=createBridge({ports:[18819],extensionId,notify:(_method,p)=>{
    service.handle(p.clientId,p.request,async()=> (await bridge.request('learningActive',{id:p.id})).active)
      .then(result=>bridge.request('learningResult',{id:p.id,result}),e=>bridge.request('learningResult',{id:p.id,result:{ok:false,error:e.message}}));
  }});await bridge.request('status');
  const proxy=http.createServer((req,res)=>{
    let url;try{url=new URL(req.url);}catch{res.writeHead(403);return res.end();}
    if(url.hostname==='reading.test'){
      res.setHeader('content-type','text/html');return res.end('<title>Proxy translation</title><style>body{font:20px/1.8 sans-serif;padding:40px}main{max-width:650px}reading-post{display:block}</style><main><reading-post><p id="original" slot="body">Reading through the configured proxy works.</p></reading-post></main><script>customElements.define("reading-post",class extends HTMLElement{constructor(){super();this.attachShadow({mode:"open"}).innerHTML="<slot name=body></slot>";}});</script>');
    }
    // Prevent test extension discovery from reaching any production bridge.
    if(url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.port!=='18819'){res.writeHead(403);return res.end();}
    const upstream=http.request({hostname:'127.0.0.1',port:18819,path:url.pathname,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
    res.on('close',()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
  });
  proxy.on('connect',(_r,s)=>{s.on('error',()=>{});s.end('HTTP/1.1 403 Forbidden\r\n\r\n');});
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));t.after(()=>{proxy.closeAllConnections();proxy.close();});
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--proxy-server=http://127.0.0.1:'+proxy.address().port,'--proxy-bypass-list=<-loopback>','--disable-extensions-except='+extension,'--load-extension='+extension]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  for(let i=0;i<60;i++){
    const status=await bridge.request('status');if(status.extension_connected)break;
    const pending=status.clients?.find(c=>c.publicKey);if(pending)await bridge.request('setTrustedClients',{clients:[pending]});
    await new Promise(r=>setTimeout(r,100));
  }
  assert.equal((await bridge.request('status')).extension_connected,true);
  const page=await context.newPage();await page.goto('http://reading.test/');
  const tabId=await worker.evaluate(async()=> (await chrome.tabs.query({url:'http://reading.test/*'}))[0].id);
  const toggle=()=>worker.evaluate(id=>chrome.tabs.sendMessage(id,{type:'cindy-ui',action:'translate-page'}),tabId);
  await toggle();await page.waitForFunction(()=>!!document.querySelector('#original')?.nextElementSibling,{timeout:15000});
  const result=await page.locator('#original').evaluate(n=>{const el=n.nextElementSibling,r=el.getBoundingClientRect();return {height:r.height,width:r.width,slot:el.assignedSlot?.name};});
  assert.ok(modelCalls.length);assert.ok(result.height>0&&result.width>0);assert.equal(result.slot,'body');
  const cdp=await context.newCDPSession(page);const {root:dom}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});
  assert.match(JSON.stringify(dom),/中文译文：Reading through the configured proxy works/);
  if(process.env.CINDY_SCREENSHOTS){await fs.mkdir(process.env.CINDY_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.CINDY_SCREENSHOTS,'proxy-translation.png')});}
  await toggle();assert.equal(await page.locator('#original + span').count(),0);assert.equal(await page.locator('#original').innerText(),'Reading through the configured proxy works.');
});
