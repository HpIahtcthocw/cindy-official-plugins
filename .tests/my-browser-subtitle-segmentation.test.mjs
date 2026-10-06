import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createLearningService} from '../my-browser/learning-service.js';
const core=createRequire(import.meta.url)('../my-browser/extension/learning-core.js');

test('full JSON3 transcript retains word offsets instead of just event timing',()=>{
 const raw=core.youtubeSubtitles({events:[{tStartMs:1000,dDurationMs:3000,segs:[{utf8:'I '},{utf8:'think ',tOffsetMs:200},{utf8:'you understand.',tOffsetMs:1000}]}]});
 const words=core.subtitleWords(raw);assert.equal(words[1].start,1.2);assert.equal(words[2].start,2);assert.equal(core.joinWords(words),'I think you understand.');
});
test('rolling-caption prefixes are deduplicated but spoken repetitions are preserved',()=>{
 const words=core.subtitleWords([{start:0,end:3,text:'hello world'},{start:2,end:5,text:'hello world again'},{start:6,end:8,text:'hello world again'}]);
 assert.equal(core.joinWords(words),'hello world again hello world again');
 assert.ok(words.every((w,i)=>w.end>w.start&&(!i||w.start>=words[i-1].end)));
});
test('semantic groups cross original cue cuts and create nonoverlapping readable durations',()=>{
 const words=core.subtitleWords([{start:0,end:.5,text:'and I think'},{start:.5,end:1.4,text:'you can relate'},{start:1.4,end:2.2,text:'to this,'},{start:3.5,end:4.5,text:'I agree.'}]);
 const split=words.findIndex(w=>w.start>=3.5);
 const cues=core.subtitleSegments(words,[{end:split-1,translation:'而且我觉得你也能对此产生共鸣，'},{end:words.length-1,translation:'我同意。'}]);
 assert.equal(cues.length,2);assert.equal(cues[0].text,'and I think you can relate to this,');assert.equal(cues[0].start,0);assert.ok(cues[0].end>2.2&&cues[0].end<=3.5);
 assert.throws(()=>core.subtitleSegments(words,[{end:words.length-1,translation:'不能跨停顿合并'}]),/BAD_MODEL_OUTPUT/);
});
test('long unpunctuated transcripts retain every word across bounded context windows',()=>{
 const raw=Array.from({length:500},(_,i)=>({start:i*.4,end:(i+1)*.4,text:'word'+i})),words=core.subtitleWords(raw),chunks=core.subtitleChunks(words);
 assert.equal(chunks.flatMap(c=>c.words).length,500);assert.ok(chunks.every(c=>c.words.length<=180));
 assert.equal(chunks[0].nextStart,chunks[1].words[0].start);
});
test('CJK does not gain spaces, and grouping cannot skip words or exceed duration limits',()=>{
 const words=core.subtitleWords([{start:0,end:3,text:'这是一个完整的句子。接着说。'}]);assert.equal(core.joinWords(words),'这是一个完整的句子。接着说。');
 assert.throws(()=>core.subtitleSegments(words,[{end:2,translation:'漏字'}]),/BAD_MODEL_OUTPUT/);
 const long=core.subtitleWords([{start:0,end:20,text:'one two three four five'}]);assert.throws(()=>core.subtitleSegments(long,[{end:4,translation:'太长'}]),/BAD_MODEL_OUTPUT/);
});
test('subtitle model grouping is validated, repaired once, cached and cancelled',async()=>{
 const words=core.subtitleWords([{start:0,end:2,text:'one complete sentence'}]);let calls=0;
 const s=createLearningService({core,model:async r=>{calls++;assert.match(r.prompt,/Do not return text rewrites or invented timestamps/);return {ok:true,text:JSON.stringify({segments:[{end:calls===1?0:2,translation:'一个完整句子'}]})};}});
 const client=crypto.randomUUID(),req={op:'subtitles',words,context:'full nearby transcript'};
 const result=await s.handle(client,req);assert.equal(calls,2);assert.equal(result.cues[0].text,'one complete sentence');
 assert.equal((await s.handle(client,req)).cached,true);assert.equal(calls,2);
 await assert.rejects(s.handle(client,req,async()=>false),/REQUEST_CANCELLED/);
 assert.throws(()=>core.validate({...req,words:[{text:'bad',start:2,end:1}]}),/INVALID_TIME/);
});

 test('speaker changes remain separate and long held captions cannot block the transcript',()=>{
  const words=core.subtitleWords([{start:0,end:1,text:'Hello.'},{start:1,end:2,text:'>> Hi.'}]);
  assert.throws(()=>core.subtitleSegments(words,[{end:words.length-1,translation:'跨说话人'}]),/BAD_MODEL_OUTPUT/);
  const held=core.subtitleWords([{start:3,end:30,text:'[Music]'}]);
  const cue=core.subtitleSegments(held,[{end:0,translation:'[音乐]'}])[0];
  assert.equal(cue.text,'[Music]');assert.ok(cue.end-cue.start<=8.5);
 });
