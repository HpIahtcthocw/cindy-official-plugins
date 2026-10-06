import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createLearningService} from '../my-browser/learning-service.js';
const require=createRequire(import.meta.url),core=require('../my-browser/extension/learning-core.js'),playback=require('../my-browser/extension/subtitle-playback.js');
class Media extends EventTarget {
 constructor(paused=false){super();this.paused=paused;this.plays=0;}
 pause(){if(this.paused)return;this.paused=true;this.dispatchEvent(new Event('pause'));}
 async play(){if(!this.paused)return;this.paused=false;this.plays++;this.dispatchEvent(new Event('play'));}
}
const chunk=(start,end,done)=>({start,end,words:[{text:'speech',start,end}],nextStart:end,done});
test('coverage measures prepared passages, includes silence and stops at the first unfinished passage',()=>{
 const chunks=[chunk(0,60,true),chunk(60,120,false),chunk(120,180,true)];
 assert.deepEqual(core.subtitleBuffer(chunks,10),{ahead:50,ready:true,complete:false});
 assert.equal(core.subtitleBuffer(chunks,10,2).ready,false);
 assert.equal(core.subtitleBuffer(chunks,55).ahead,5);
 assert.equal(core.subtitleBuffer(chunks,130).complete,true);
 chunks[0].done=false;assert.equal(core.subtitleBuffer(chunks,0).ahead,0);
});
test('playback waits for a long initial buffer, resumes owned pauses and buffers before exhaustion',()=>{
 const media=new Media();let buffer={ahead:0,ready:false};const controller=playback.create(media,{state:()=>buffer});
 controller.update();assert.equal(media.paused,true);
 media.play();assert.equal(media.paused,true,'trying play cannot run past an empty subtitle buffer');
 buffer={ahead:50,ready:true};controller.update();assert.equal(media.paused,false);
 buffer={ahead:10,ready:false};controller.update();assert.equal(media.paused,false);
 buffer={ahead:2,ready:false};controller.update();assert.equal(media.paused,true);
 controller.pauseByUser();buffer={ahead:100,ready:true};controller.update();assert.equal(media.paused,true,'explicit pause is never auto-resumed');controller.dispose();assert.equal(media.paused,true);
});
test('seeking rechecks the buffer, closing restores only playback stopped by buffering',()=>{
 const media=new Media();let buffer={ahead:80,ready:true};const controller=playback.create(media,{state:()=>buffer});controller.update();
 buffer={ahead:20,ready:false};media.dispatchEvent(new Event('seeked'));assert.equal(media.paused,true);controller.dispose();assert.equal(media.paused,false);
 const paused=new Media(true),other=playback.create(paused,{state:()=>({ahead:0,ready:false})});other.update();other.dispose();assert.equal(paused.paused,true);
});
test('full transcript preparation consumes every page and supports long editorial windows',()=>{
 const words=core.subtitleWords(Array.from({length:1200},(_,i)=>({start:i*.5,end:(i+1)*.5,text:'sourceword'+i})),true);
 const pages=core.transcriptPages(words);assert.ok(pages.length>1);assert.equal(pages.join(' '),core.joinWords(words));
 const windows=core.subtitleChunks(words,true);assert.ok(windows[0].words.length>180);assert.deepEqual(windows.flatMap(c=>c.words),words);
 assert.doesNotThrow(()=>core.validate({op:'subtitles',editorial:true,words:windows[0].words}));
});
test('editorial captions clean source prose, retain timing anchors and join short display gaps',()=>{
 const words=core.subtitleWords([{start:0,end:1,text:'>> Um, I I agree.'},{start:1.4,end:2.4,text:'It works.'}],true);
 const split=words.findIndex(w=>w.start===1.4);
 const cues=core.subtitleSegments(words,[{end:split-1,text:'I agree.',translation:'我同意。'},{end:words.length-1,text:'It works.',translation:'这可行。',paragraphEnd:true}],undefined,true);
 assert.equal(cues[0].text,'I agree.');assert.ok(words.every(w=>w.text!=='>>'));assert.match(cues[0].sourceText,/Um, I I/);assert.equal(cues[0].end,1.4);
 assert.deepEqual(core.subtitleDocument(cues),[{text:'I agree. It works.',translation:'我同意。这可行。'}]);
});
test('document brief and editorial requests use bounded prompts and keep separate cache entries',async()=>{
 const calls=[];const service=createLearningService({core,model:async r=>{calls.push(r);assert.ok(r.prompt.length<=32768);const input=JSON.parse(r.prompt.split('\n').at(-1));if(input.transcript)return {ok:true,text:'Consistent names and argument flow.'};return {ok:true,text:JSON.stringify({segments:input.words.map((w,i)=>({end:i,text:w.text,translation:'译文',paragraphEnd:i===input.words.length-1}))})};}});
 const client=crypto.randomUUID();const guide=await service.handle(client,{op:'subtitle-document',text:'Entire source transcript.'});assert.match(guide.guide,/Consistent/);
 const words=Array.from({length:360},(_,i)=>({text:'fairlylongsourceword',start:i,end:i+.5}));
 const result=await service.handle(client,{op:'subtitles',editorial:true,words,context:'context '.repeat(1000)});assert.equal(result.cues.length,360);assert.match(calls[1].prompt,/Reconstruct polished, faithful prose first/);assert.match(calls[1].prompt,/not English fragment boundaries/);
});
