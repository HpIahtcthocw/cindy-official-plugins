import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source=await fs.readFile(new URL('../my-browser/extension/library.js',import.meta.url),'utf8');
const content=await fs.readFile(new URL('../my-browser/extension/content.js',import.meta.url),'utf8');

test('text reader bounds total translation work before sending model requests',()=>{
  assert.match(source,/MAX_TEXT_TRANSLATION_PARTS=100/);
  assert.match(source,/MAX_TEXT_TRANSLATION_CHARS=200000/);
  assert.match(source,/parts\.some\(part=>part\.length>MAX_TEXT_TRANSLATION_PART\)\)throw Error\('IMPORT_TOO_LARGE'\)/);
});

test('content script listens for cross-tab preference changes',()=>{
  assert.match(content,/storage\?\.onChanged\?\.addListener\(onPreferencesChanged\)/);
  assert.match(content,/if\(prefs\.autoVideo\)\{nextAutoAttempt=0;if\(!videoSession\)autoOpen\(\);\}/);
  assert.match(content,/removeListener\(onPreferencesChanged\)/);
});
