import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source=await fs.readFile(new URL('../my-browser/extension/library.js',import.meta.url),'utf8');
const content=await fs.readFile(new URL('../my-browser/extension/content.js',import.meta.url),'utf8');
const pdf=await fs.readFile(new URL('../my-browser/extension/reader-pdf.js',import.meta.url),'utf8');
const bridge=await fs.readFile(new URL('../my-browser/node/bridge.cjs',import.meta.url),'utf8');
const background=await fs.readFile(new URL('../my-browser/extension/background.js',import.meta.url),'utf8');

test('text reader bounds total translation work before sending model requests',()=>{
  assert.match(source,/MAX_TEXT_TRANSLATION_PARTS=100/);
  assert.match(source,/MAX_TEXT_TRANSLATION_CHARS=200000/);
  assert.match(source,/parts\.some\(part=>part\.length>MAX_TEXT_TRANSLATION_PART\)\)throw Error\('IMPORT_TOO_LARGE'\)/);
});

test('content script listens for cross-tab preference changes',()=>{
  assert.match(content,/storage\?\.onChanged\?\.addListener\(onPreferencesChanged\)/);
  assert.match(content,/api\.storage\.local\.get\('cindyReadingPreferences'\)/);
  assert.match(content,/const merged=\{\.\.\.stored,\.\.\.changes\}/);
  assert.match(content,/Object\.assign\(prefs,merged\)/);
  assert.match(content,/autoSites:\{\[location\.origin\]:value\?true:undefined\}/);
  assert.match(content,/const videoWasEnabled=previous\.autoVideo!==false,videoIsEnabled=stored\.autoVideo!==false/);
  assert.match(content,/const relevantEnable=youtube\?!videoWasEnabled&&videoIsEnabled:!siteWasEnabled&&siteIsEnabled/);
  assert.match(content,/if\(relevantEnable\)\{nextAutoAttempt=0;if\(!videoSession\)autoOpen\(\);\}/);
  assert.match(content,/const videoTargetChanged=nextVideoTarget!==prefs\.videoTarget/);
  assert.match(content,/if\(videoTargetChanged&&videoSession\)\{resetSubtitleTranslation\(\);videoSession\.overlay\?\.update\(\);\}/);
  assert.match(content,/if\(!youtube&&\(translated\|\|translations\.size\)\)return;/);
  assert.match(content,/removeListener\(onPreferencesChanged\)/);
});

test('PDF reader bounds page translation before sending model requests',()=>{
  assert.match(pdf,/MAX_TRANSLATION_BATCHES=20/);
  assert.match(pdf,/MAX_TRANSLATION_CHARS=200000/);
  assert.match(pdf,/batches\.length>MAX_TRANSLATION_BATCHES\|\|totalCharacters>MAX_TRANSLATION_CHARS\)throw Error\('IMPORT_TOO_LARGE'\)/);
});

test('bridge learning access requires the paired extension challenge key and stays in the legacy port range',()=>{
  assert.match(bridge,/const pairedCredential\s*=/);
  assert.match(bridge,/const verifyProof\s*=/);
  assert.match(bridge,/const authRequired=client\.version===manifest\.version/);
  assert.match(bridge,/req\.url\.startsWith\('\/learning\/'\)/);
  assert.match(bridge,/Array\.from\(\{length:10\},\(_,i\)=>18810\+i\)/);
  assert.match(background,/crypto\.subtle\.generateKey\(\{name:'ECDSA',namedCurve:'P-256'\}/);
  assert.match(background,/X-My-Browser-Key/);
  assert.match(background,/X-My-Browser-Proof/);
});
