// Isolated Chromium + actual MV3/bridge/learning code. The paid model and Cindy
// storage are explicit fixtures; this does not claim installed Cindy validation.
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
test('Chrome learning: selection, bilingual page, persistent review, PDF and local OCR',{skip:!process.env.PLAYWRIGHT_CORE,timeout:120000},async t=>{
 const {chromium}=require(process.env.PLAYWRIGHT_CORE),profile=await fs.mkdtemp(path.join(os.tmpdir(),'cindy-learning-'));let context,bridge;
 t.after(async()=>{await context?.close();await bridge?.close();await fs.rm(profile,{recursive:true,force:true,maxRetries:3});});
 const extension=path.join(profile,'extension');await fs.cp(path.join(root,'extension'),extension,{recursive:true});
 const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'der'}}),extensionId=createHash('sha256').update(publicKey).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 const manifest=JSON.parse(await fs.readFile(path.join(extension,'manifest.json'),'utf8'));manifest.key=publicKey.toString('base64');await fs.writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
 const bg=path.join(extension,'background.js');await fs.writeFile(bg,`const nativeCompleted=chrome.webRequest.onCompleted.addListener.bind(chrome.webRequest.onCompleted);chrome.webRequest.onCompleted.addListener=(fn,...a)=>nativeCompleted(d=>fn(['example.test','www.youtube.com'].includes(new URL(d.url).hostname)?{...d,ip:'8.8.8.8'}:d),...a);\n`+await fs.readFile(bg,'utf8'));
 const files=new Map(),modelCalls=[];let subtitleMismatch=false,allowBroken=false;
 const service=createLearningService({core,locale:()=> 'zh-CN',model:async r=>{
  modelCalls.push(r);const material=JSON.parse(r.prompt.split('\n').at(-1));
  if(material.text==='BrokenSubtitle'&&!allowBroken)return {ok:true,text:''};
  if(material.words){
    const text=core.joinWords(material.words);
    if(text.includes('BrokenSubtitle')&&!allowBroken)return {ok:true,text:'{"segments":[]}'};
    if(text.includes('and I think you can relate to this,')&&!subtitleMismatch){subtitleMismatch=true;return {ok:true,text:'{"segments":[]}'};}
    const segments=[];let start=0;
    for(let i=0;i<material.words.length;i++)if(material.words[i].text==='subtitle'||i===material.words.length-1){const text=core.joinWords(material.words.slice(start,i+1));segments.push({end:i,translation:text==='and I think you can relate to this,'?'而且我觉得你也能对此产生共鸣，':'译文：'+text});start=i+1;}
    return {ok:true,text:JSON.stringify({segments})};
  }
  return {ok:true,text:r.expectJson?JSON.stringify({translations:material.texts.map(x=>'译文：'+x)}):'这是结合上下文的解释。'};
 },library:async r=>r.op==='open'?{ok:true}:r.op==='read'?(files.has(r.path)?{ok:true,content:files.get(r.path)}:{ok:false,errorCode:'NOT_FOUND'}):(files.set(r.path,r.content),{ok:true})});

 bridge=createBridge({ports:[18819],extensionId,notify:(_method,p)=>{service.handle(p.clientId,p.request,async()=> (await bridge.request('learningActive',{id:p.id})).active).then(result=>bridge.request('learningResult',{id:p.id,result}),e=>bridge.request('learningResult',{id:p.id,result:{ok:false,error:e.message}}));}});await bridge.request('status');
 const fixture='<title>Reading fixture</title><main style="max-width:600px;padding:40px;font:20px/1.8 sans-serif"><h1>Learning with Cindy</h1><p>Hello world. Reading gives us new ideas.</p><p>Practice makes progress.</p><div id="movie_player" class="html5-video-player" style="position:relative;width:960px;height:540px;background:linear-gradient(125deg,#977c66,#293d3d)"><video controls style="width:100%;height:100%;display:block"></video><div class="ytp-caption-window-container" style="position:absolute;bottom:30px;left:25%;color:white">Original YouTube caption</div></div></main>';
 const proxy=http.createServer((req,res)=>{let url;try{url=new URL(req.url);}catch{res.writeHead(403);return res.end();}if(['example.test','www.youtube.com'].includes(url.hostname)){res.setHeader('content-type','text/html');return res.end(fixture);}if(url.hostname!=='127.0.0.1'||url.port!=='18819'){res.writeHead(403);return res.end();}const upstream=http.request({hostname:'127.0.0.1',port:18819,path:url.pathname,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);});
 proxy.on('connect',(_r,s)=>s.end('HTTP/1.1 403 Forbidden\r\n\r\n'));await new Promise(r=>proxy.listen(0,'127.0.0.1',r));t.after(()=>{proxy.closeAllConnections();proxy.close();});
 context=await chromium.launchPersistentContext(profile,{channel:'chromium',executablePath:process.env.CHROMIUM_PATH,headless:true,viewport:{width:1280,height:900},args:['--proxy-server=http://127.0.0.1:'+proxy.address().port,'--proxy-bypass-list=<-loopback>','--disable-extensions-except='+extension,'--load-extension='+extension]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const page=await context.newPage();
 for(let i=0;i<50;i++){if((await bridge.request('status')).extension_connected)break;await page.waitForTimeout(100);}
 await page.goto('http://example.test/');await page.waitForTimeout(200);
 const tabId=await worker.evaluate(async()=> (await chrome.tabs.query({url:'http://example.test/*'}))[0].id);
 const opened=await worker.evaluate(id=>chrome.tabs.sendMessage(id,{type:'cindy-ui',action:'open'}),tabId);assert.equal(opened.ok,true);
 // CDP can inspect closed roots without changing the production isolation boundary.
 const cdp=await context.newCDPSession(page);await cdp.send('DOM.enable');
 async function element(tag,text){const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});let found;function walk(n){if(n.nodeName===tag&&(!text||n.children?.some(c=>c.nodeValue===text)||n.attributes?.includes(text)))found=n;for(const c of [...(n.children||[]),...(n.shadowRoots||[])])walk(c);}walk(root);assert.ok(found,tag+' '+text+' '+JSON.stringify(root).slice(-3000));return (await cdp.send('DOM.resolveNode',{nodeId:found.nodeId})).object.objectId;}
 async function click(text){const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true}),matches=[];function walk(n){if(n.nodeName==='BUTTON'&&(n.children?.some(c=>c.nodeValue===text)||n.attributes?.includes(text)))matches.push(n);for(const c of [...(n.children||[]),...(n.shadowRoots||[])])walk(c);}walk(root);for(const n of matches.reverse()){const {object}=await cdp.send('DOM.resolveNode',{nodeId:n.nodeId});const r=await cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){const r=this.getBoundingClientRect();if(!r.width||!r.height)return null;this.scrollIntoView({block:"nearest"});const b=this.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}}',returnByValue:true});if(r.result.value){await page.mouse.click(r.result.value.x,r.result.value.y);return;}}assert.fail('No visible button '+text);}
 async function panelText(){const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});return JSON.stringify(root);}
 const input=await element('TEXTAREA','原文');const box=await cdp.send('Runtime.callFunctionOn',{objectId:input,functionDeclaration:'function(){const r=this.getBoundingClientRect();return {x:r.x+10,y:r.y+10}}',returnByValue:true});await page.mouse.click(box.result.value.x,box.result.value.y);await page.keyboard.type('Hello world');await click('翻译');
 for(let i=0;i<40&&!(await panelText()).includes('译文：Hello world');i++)await page.waitForTimeout(100);
 assert.match(await panelText(),/译文：Hello world/);await click('收藏');
 for(let i=0;i<30&&files.size===0;i++)await page.waitForTimeout(100);assert.equal(files.size,1);
 const screenshots=process.env.CINDY_SCREENSHOTS;if(screenshots)await fs.mkdir(screenshots,{recursive:true});
 async function appearance(){return (await cdp.send('Runtime.callFunctionOn',{objectId:await element('SECTION','Cindy'),functionDeclaration:`function(){const c=getComputedStyle(this),r=this.getBoundingClientRect();return {color:c.color,background:c.backgroundColor,font:c.fontSize,width:r.width,theme:this.dataset.theme,active:this.querySelector('nav [aria-pressed=true]')?.textContent,cancelHidden:this.querySelector('footer button').hidden}}`,returnByValue:true})).result.value;}
 function readable(a){const lum=c=>{const v=c.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return v[0]*.2126+v[1]*.7152+v[2]*.0722;};const x=lum(a.color),y=lum(a.background);assert.ok((Math.max(x,y)+.05)/(Math.min(x,y)+.05)>=4.5,JSON.stringify(a));assert.equal(a.font,'13px');assert.equal(a.width,384);}
 readable(await appearance());assert.equal((await appearance()).theme,'light');
 if(screenshots)await page.screenshot({path:path.join(screenshots,'web-light.png')});
 // A dark OS must not make an otherwise white web page's panel black.
 await page.emulateMedia({colorScheme:'dark'});readable(await appearance());assert.equal((await appearance()).theme,'light');
 // Host typography, CSS variables and !important rules cannot enter the closed panel.
 await page.addStyleTag({content:'html{--text:red;--surface:red;font:32px serif;color:red}html>div{font:40px serif!important;color:black!important;background:red!important;position:static!important;width:900px!important}'});
 readable(await appearance());
 await click('整页双语');for(let i=0;i<40&&!(await panelText()).includes('译文：Practice');i++)await page.waitForTimeout(100);assert.match(await panelText(),/译文：Practice/);
 assert.equal((await appearance()).active,'整页双语');assert.equal((await appearance()).cancelHidden,true);
 if(screenshots){await page.screenshot({path:path.join(screenshots,'page-light.png')});await page.screenshot({path:path.join(screenshots,'panel-light.png'),clip:{x:879,y:15,width:386,height:272}});}
 await click('切换明暗外观');readable(await appearance());assert.equal((await appearance()).theme,'dark');
 if(screenshots)await page.screenshot({path:path.join(screenshots,'page-dark.png')});
 await click('恢复原文');assert.doesNotMatch(await panelText(),/译文：Practice/);
 // A genuinely dark page defaults to the readable dark panel on a fresh open.
 await click('关闭');await page.addStyleTag({content:'body{background:#181818;color:#eee}'});
 await worker.evaluate(id=>chrome.tabs.sendMessage(id,{type:'cindy-ui',action:'open'}),tabId);
 readable(await appearance());assert.equal((await appearance()).theme,'dark');
 if(screenshots)await page.screenshot({path:path.join(screenshots,'web-dark.png')});
 // Actual HTML5 media time/track integration with generated silence, no external fixture.
 const wav=Buffer.alloc(44+8000*2*3);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
 await page.evaluate(async data=>{const v=document.querySelector('video');v.src='data:audio/wav;base64,'+data;await new Promise(r=>v.onloadedmetadata=r);const track=v.addTextTrack('captions','English','en');track.mode='showing';v.currentTime=1.25;},wav.toString('base64'));
 await click('字幕');assert.match(await panelText(),/正在等待字幕/);await page.evaluate(()=>{const track=document.querySelector('video').textTracks[0];track.addCue(new VTTCue(0,.4,'First'));track.addCue(new VTTCue(.4,1,'subtitle'));track.addCue(new VTTCue(1,1.4,'and I think'));track.addCue(new VTTCue(1.4,1.7,'you can relate'));track.addCue(new VTTCue(1.7,2,'to this,'));});for(let i=0;i<40&&!(await panelText()).includes('而且我觉得你也能对此产生共鸣，');i++)await page.waitForTimeout(100);assert.match(await panelText(),/而且我觉得你也能对此产生共鸣，/);const captionCalls=modelCalls.map(r=>JSON.parse(r.prompt.split('\n').at(-1))).filter(m=>m.words&&core.joinWords(m.words).includes('and I think you can relate to this,'));assert.equal(captionCalls.length,2);assert.match(core.joinWords(captionCalls[0].words),/^First subtitle and I think you can relate to this,/);assert.match(captionCalls[0].context,/Surrounding transcript/);
 await page.evaluate(()=>{document.querySelector('video').currentTime=1.4;});await page.waitForTimeout(100);await click('字幕设置');await click('收藏');await click('字幕设置');for(let i=0;i<30&&!JSON.parse([...files.values()][0]).entries.some(e=>e.text==='and I think you can relate to this,');i++)await page.waitForTimeout(100);assert.equal(JSON.parse([...files.values()][0]).entries.find(e=>e.text==='and I think you can relate to this,').source.time,1);
 async function captions(){return (await cdp.send('Runtime.callFunctionOn',{objectId:await element('DIV','caption-box'),functionDeclaration:`function(){const root=this.getRootNode(),r=this.getBoundingClientRect();return {original:this.querySelector('.caption-original').textContent,translation:this.querySelector('.caption-translation').textContent,hidden:this.hidden,width:r.width,x:r.x,y:r.y,bottom:r.bottom,player:root.host.parentElement.id,settingsHidden:root.querySelector('.caption-settings').hidden}}`,returnByValue:true})).result.value;}
 assert.equal((await captions()).player,'movie_player');assert.equal((await captions()).settingsHidden,true);assert.equal((await captions()).original,'and I think you can relate to this,');assert.equal((await captions()).translation,'而且我觉得你也能对此产生共鸣，');
 assert.equal(await page.locator('.ytp-caption-window-container').evaluate(n=>getComputedStyle(n).visibility),'hidden');
 assert.equal(await page.locator('video').evaluate(n=>n.textTracks[0].mode),'hidden');
 const panelBox=await cdp.send('Runtime.callFunctionOn',{objectId:await element('SECTION','Cindy'),functionDeclaration:'function(){return this.getBoundingClientRect().width}',returnByValue:true});assert.equal(panelBox.result.value,0,'no right floating panel during subtitles');
 await page.evaluate(()=>{document.querySelector('video').currentTime=.4;});await page.waitForTimeout(100);assert.equal((await captions()).original,'First subtitle');
 await page.evaluate(()=>{document.querySelector('video').currentTime=1.4;});await page.waitForTimeout(100);
 await page.mouse.move(5,5);await page.waitForTimeout(2300);
 if(screenshots){await page.locator('#movie_player').screenshot({path:path.join(screenshots,'player-bilingual.png')});await page.screenshot({path:path.join(screenshots,'subtitles-dark.png')});}
 // A real fullscreen player owns the injected layer; it does not depend on a page-fixed panel.
 await page.locator('#movie_player').evaluate(n=>n.requestFullscreen());await page.waitForTimeout(200);
 assert.equal(await page.evaluate(()=>document.fullscreenElement?.id),'movie_player');assert.ok((await captions()).bottom<900);assert.equal((await captions()).player,'movie_player');
 if(screenshots)await page.screenshot({path:path.join(screenshots,'player-fullscreen.png')});
 await page.evaluate(()=>document.exitFullscreen());await page.waitForTimeout(150);
 await page.locator('#movie_player').evaluate(n=>{n.style.width='720px';n.style.height='405px';});await page.waitForTimeout(150);
 const mediaBox=await page.locator('video').boundingBox(),captionBox=await captions();assert.ok(captionBox.x>=mediaBox.x);assert.ok(captionBox.x+captionBox.width<=mediaBox.x+mediaBox.width+1);assert.ok(captionBox.bottom<=mediaBox.y+mediaBox.height);
 await page.evaluate(()=>{document.querySelector('video').currentTime=2.9;});await page.waitForTimeout(100);assert.equal((await captions()).hidden,true);assert.equal(await page.locator('.ytp-caption-window-container').evaluate(n=>getComputedStyle(n).visibility),'visible');
 await page.evaluate(()=>{document.querySelector('video').currentTime=1.4;});await page.waitForTimeout(100);

 // YouTube can replace its caption container; suppression and restoration survive that replacement.
 await page.evaluate(()=>{const old=document.querySelector('.ytp-caption-window-container'),next=old.cloneNode(true);next.style.removeProperty('visibility');old.replaceWith(next);});await page.waitForTimeout(100);
 assert.equal(await page.locator('.ytp-caption-window-container').evaluate(n=>getComputedStyle(n).visibility),'hidden');
 if(screenshots)await page.screenshot({path:path.join(screenshots,'subtitles-dark.png')});
 // Syntactically valid grouping that crosses a pause must recover automatically in smaller passages.
 await page.evaluate(()=>{const track=document.querySelector('video').textTracks[0];for(const c of [...track.cues])track.removeCue(c);track.addCue(new VTTCue(0,1,'Repairfirst phrase.'));track.addCue(new VTTCue(1.8,2.6,'Repairsecond phrase.'));document.querySelector('video').currentTime=2;});
 for(let i=0;i<60&&!(await panelText()).includes('译文：Repairsecond phrase.');i++)await page.waitForTimeout(100);
 assert.equal((await captions()).original,'Repairsecond phrase.');assert.equal((await captions()).translation,'译文：Repairsecond phrase.');
 const repairedCalls=modelCalls.map(r=>JSON.parse(r.prompt.split('\n').at(-1))).filter(m=>m.words&&core.joinWords(m.words).includes('Repair'));
 assert.equal(repairedCalls.length,3);assert.ok(repairedCalls[0].words.some(w=>w.breakBefore));
 // Persistent malformed output stops automatic model retries and exposes a local retry.
 await page.evaluate(()=>{const track=document.querySelector('video').textTracks[0];for(const c of [...track.cues])track.removeCue(c);track.addCue(new VTTCue(0,1,'BrokenSubtitle'));track.addCue(new VTTCue(1.8,2.6,'HealthySubtitle'));});
 for(let i=0;i<60&&!(await panelText()).includes('部分字幕译文为空或无法读取');i++)await page.waitForTimeout(100);
 assert.match(await panelText(),/部分字幕译文为空或无法读取/);
 const brokenCalls=()=>modelCalls.filter(r=>{const m=JSON.parse(r.prompt.split('\n').at(-1));return m.words&&core.joinWords(m.words).includes('BrokenSubtitle');}).length;
 for(let i=0;i<40&&(await captions()).translation!=='译文：HealthySubtitle';i++)await page.waitForTimeout(100);assert.equal((await captions()).translation,'译文：HealthySubtitle');assert.equal(brokenCalls(),4);await page.evaluate(()=>{document.querySelector('video').currentTime=.5;});await page.waitForTimeout(100);assert.equal((await captions()).original,'BrokenSubtitle');assert.equal((await captions()).translation,'');await page.waitForTimeout(1400);assert.equal(brokenCalls(),4);
 allowBroken=true;await click('字幕设置');await click('重试字幕翻译');await click('字幕设置');
 for(let i=0;i<40&&!(await panelText()).includes('译文：BrokenSubtitle');i++)await page.waitForTimeout(100);
 assert.match(await panelText(),/译文：BrokenSubtitle/);assert.equal(modelCalls.filter(r=>{const m=JSON.parse(r.prompt.split('\n').at(-1));return m.words&&core.joinWords(m.words)==='HealthySubtitle';}).length,1,'manual retry preserves already translated passages');
 await click('关闭');assert.equal(await page.locator('.ytp-caption-window-container').evaluate(n=>getComputedStyle(n).visibility),'visible');assert.equal(await page.locator('video').evaluate(n=>n.textTracks[0].mode),'showing');assert.equal(await page.locator('[data-cindy-captions]').count(),0);
 await worker.evaluate(id=>chrome.tabs.sendMessage(id,{type:'cindy-ui',action:'video'}),tabId);
 // Refresh restores the user's subtitle mode, but explicit close clears it.
 await page.reload();for(let i=0;i<50&&!(await panelText()).includes('正在等待字幕');i++)await page.waitForTimeout(100);
 assert.match(await panelText(),/正在等待字幕/);assert.equal((await captions()).settingsHidden,true);
 await click('关闭');await page.waitForTimeout(150);await page.reload();await page.waitForTimeout(500);assert.doesNotMatch(await panelText(),/cindy-root/);
 // Exercise the YouTube full-transcript path while a partial native track is already present.
 // Only the website and timedtext response are fixtures; extension extraction/bridge remain real.
 await worker.evaluate(()=>{const originalFetch=globalThis.fetch;globalThis.fixtureCaptionReads=0;globalThis.fetch=(input,init)=>{
  if(String(input).startsWith('https://www.youtube.com/api/timedtext?fixture=full')){globalThis.fixtureCaptionReads++;return Promise.resolve(new Response(JSON.stringify({events:[
   {tStartMs:0,dDurationMs:1000,segs:[{utf8:'Entire transcript ',tOffsetMs:0},{utf8:'from the beginning.',tOffsetMs:400}]},
   {tStartMs:1000,dDurationMs:1200,segs:[{utf8:'A complete phrase outside the native window.'}]}]}),{status:200}));}
  return originalFetch(input,init);
 };});
 await page.goto('http://www.youtube.com/watch?v=fixture');await page.waitForTimeout(200);
 await page.evaluate(async data=>{globalThis.ytInitialPlayerResponse={captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:'https://www.youtube.com/api/timedtext?fixture=full',languageCode:'en'}]}}};const v=document.querySelector('video');v.src='data:audio/wav;base64,'+data;await new Promise(r=>v.onloadedmetadata=r);const track=v.addTextTrack('captions','English','en');track.mode='showing';track.addCue(new VTTCue(1,2,'Partial native fragment'));v.currentTime=1.4;},wav.toString('base64'));
 await worker.evaluate(id=>chrome.tabs.sendMessage(id,{type:'cindy-ui',action:'video'}),tabId);
 for(let i=0;i<50&&!(await panelText()).includes('译文：Entire transcript');i++)await page.waitForTimeout(100);
 assert.match((await captions()).original,/Entire transcript from the beginning.*outside the native window/);
 assert.doesNotMatch((await captions()).original,/Partial native fragment/);
 const completeCalls=()=>modelCalls.filter(r=>r.prompt.includes('Entire transcript'));
 assert.equal(completeCalls().length,1);await page.waitForTimeout(1500);assert.equal(completeCalls().length,1);assert.equal(await worker.evaluate(()=>globalThis.fixtureCaptionReads),1);
 await click('关闭');
 const library=await context.newPage();await library.goto('chrome-extension://'+extensionId+'/library.html');await library.getByText('Hello world',{exact:true}).waitFor();await library.getByRole('button',{name:'复习',exact:true}).click();await library.getByRole('button',{name:'显示答案'}).click();await library.getByRole('button',{name:'记得',exact:true}).click();await library.getByRole('button',{name:'显示答案'}).click();await library.getByRole('button',{name:'记得',exact:true}).click();await library.getByText('本次待复习内容已完成。').waitFor();
 await library.getByRole('button',{name:'收藏',exact:true}).click();await library.getByText('Hello world',{exact:true}).waitFor();if(screenshots){await library.screenshot({path:path.join(screenshots,'library-light.png')});await library.emulateMedia({colorScheme:'dark'});await library.screenshot({path:path.join(screenshots,'library-dark.png')});}
 // Real bundled OCR/WASM with a synthetic local bitmap and no external network.
 const ocr=await library.evaluate(async()=>{const {createOCR}=await import('./ocr.js');const c=document.createElement('canvas');c.width=1000;c.height=180;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,c.width,c.height);x.fillStyle='black';x.font='60px Arial';x.fillText('CINDY READING TEST',25,100);const o=createOCR();try{return await o.recognize(c,'eng');}finally{o.close();}});assert.match(ocr,/CINDY READING TEST/);
 // Generate a small, valid PDF fixture through Chromium; no proprietary fixture assets.
 const printPage=await context.newPage();await printPage.setContent('<h1>Cindy PDF reading</h1><p>Hello from the PDF text layer.</p>');const pdf=await printPage.pdf();await printPage.close();
 await library.evaluate(async bytes=>{const {getDocument,GlobalWorkerOptions}=await import('./vendor/pdfjs/pdf.mjs');GlobalWorkerOptions.workerSrc=new URL('./vendor/pdfjs/pdf.worker.mjs',location.href).href;const p=await getDocument({data:new Uint8Array(bytes),isEvalSupported:false}).promise;await p.destroy();},Array.from(pdf));
 await library.getByRole('button',{name:'阅读',exact:true}).click();const choosing=library.waitForEvent('filechooser');await library.getByRole('button',{name:'打开 PDF / 文本 / Markdown'}).click();await(await choosing).setFiles({name:'cindy-fixture.pdf',mimeType:'application/pdf',buffer:pdf});await library.locator('canvas').waitFor();await library.getByText('1 / 1',{exact:true}).waitFor();await library.getByRole('button',{name:'翻译',exact:true}).last().click();await library.getByText('译文：Hello from the PDF text layer.',{exact:false}).waitFor();
 if(screenshots)await library.screenshot({path:path.join(screenshots,'pdf-dark.png'),fullPage:true});
 assert.ok(modelCalls.length>=3);assert.ok([...files.values()].some(x=>JSON.parse(x).entries[0].reviews===1));
});
