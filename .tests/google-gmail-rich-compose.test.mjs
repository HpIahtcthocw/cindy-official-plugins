import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { updateRichDraft, keyFor } = require('../google-gmail/node/mailMime.cjs');
const source = fs.readFileSync(new URL('../google-gmail/node/gog.cjs', import.meta.url), 'utf8');
function fixture(t, inline = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-rich-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = createContext({ Buffer, __dirname: '/fixture', require: name => name === '../vendor/gog/binaries.json' ? {} : name === './mailMime.cjs' ? require('../google-gmail/node/mailMime.cjs') : require(name) });
  runInContext(source.split('const input = readline.createInterface')[0], ctx);
  const image = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  const part = { partId: '1', filename: '图.png', mimeType: 'image/png', headers: inline ? [{ name: 'Content-ID', value: '<photo@example.test>' }] : [], body: { size: image.length, data: image.toString('base64url') } };
  const payload = { mimeType: 'multipart/mixed', headers: [
    ['From', 'Self <self@example.test>'], ['To', 'Person <person@example.test>'], ['Subject', 'Hello'], ['In-Reply-To', '<original@example.test>'], ['References', '<original@example.test>'],
  ].map(([name, value]) => ({ name, value })), parts: [
    { mimeType: 'text/plain', body: { data: Buffer.from('Original').toString('base64url') } },
    { mimeType: 'text/html', body: { data: Buffer.from('<p>Original</p>' + (inline ? '<img src="cid:photo@example.test">' : '')).toString('base64url') } }, part,
  ] };
  const draft = { id: 'draft-test', message: { id: 'message-test', threadId: 'thread-test', payload } };
  const before = ctx.draftReadBack({ draft }, draft.id);
  const fields = { to: before.headers.to, cc: '', bcc: '', subject: '中文 subject', body: 'Edited\nMore', quote: '',
    bodyHtml: '<p><strong>Edited</strong></p><p>More</p><img src="cid:photo@example.test">', quoteHtml: '',
    attachmentItems: JSON.stringify([{ key: keyFor(part), filename: part.filename }]) };
  const p = { draftId: draft.id, fields, attachments: [] };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify(draft), { headers: { 'Content-Type': 'application/json' } });
  });
  return { ctx, before, draft, fields, p, calls, dir, image,
    run: (execution = {}) => updateRichDraft(p, 'fixture-token', before, ctx, execution) };
}
test('HTML, existing CID bytes, new attachment and reply context survive a single draft PUT', async t => {
  const f = fixture(t), file = path.join(f.dir, '方案.pdf');
  fs.writeFileSync(file, 'synthetic-pdf');
  f.p.attachments.push({ path: file, filename: '方案.pdf', bytes: 13, sha256: createHash('sha256').update('synthetic-pdf').digest('hex') });
  const result = await f.run();
  assert.equal(result.ok, true);
  const writes = f.calls.filter(c => c.init.method === 'PUT');
  assert.equal(writes.length, 1);
  const sent = JSON.parse(writes[0].init.body);
  assert.equal(sent.message.threadId, 'thread-test');
  const raw = Buffer.from(sent.message.raw, 'base64url').toString();
  assert.match(raw, /Content-ID: <photo@example.test>/);
  assert.match(raw, /In-Reply-To: <original@example.test>/i);
  assert.match(raw, /filename\*=UTF-8''%E6%96%B9%E6%A1%88.pdf/);
  const decoded = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n(?:[^\r]*\r\n)*?\r\n([A-Za-z0-9+/=\r\n]+?)(?=\r\n--)/g)].map(m => Buffer.from(m[1], 'base64'));
  assert.ok(decoded.some(b => b.toString() === f.fields.bodyHtml));
  assert.ok(decoded.some(b => b.equals(f.image)));
  assert.ok(decoded.some(b => b.toString() === 'synthetic-pdf'));
  assert.equal(f.calls.some(c => /send/.test(c.url)), false);
});
test('removing an attachment preserves the body and removes its bytes', async t => {
  const f = fixture(t); f.fields.bodyHtml = '<p>Only text</p>'; f.fields.attachmentItems = '[]';
  assert.equal((await f.run()).files.length, 0);
  const raw = Buffer.from(JSON.parse(f.calls.at(-1).init.body).message.raw, 'base64url').toString();
  assert.doesNotMatch(raw, /Content-ID:/);
});
// A preview URL is not a draft edit. Empty-recipient preview drafts must also
// be saveable, without weakening the recipient check at send time (unit).
test('preview metadata and empty recipients do not rewrite an unchanged draft', async t => {
  const f = workerFixture(t);
  f.draft.message.payload.headers.find(h => h.name === 'To').value = '';
  const before = f.ctx.draftReadBack({ draft: f.draft }, f.draft.id);
  const fields = { to: '', cc: '', bcc: '', subject: before.headers.subject, body: before.editor.body, quote: before.editor.quote,
    bodyHtml: before.editor.bodyHtml, quoteHtml: before.editor.quoteHtml,
    attachmentItems: JSON.stringify(before.attachments.map(a => ({ ...a, previewUrl: `cindy-media://blobs/${'a'.repeat(64)}.png` }))) };
  const message = { method: 'compose', cindy: { secrets: { gog_access_token: 'fixture-token' } },
    params: { draftId: f.draft.id, fingerprint: before.fingerprint, fields, send: false } };
  assert.equal((await f.ctx.handle(message, {})).ok, true);
  assert.equal(f.calls.length, 0);
  message.params.send = true;
  assert.equal((await f.ctx.handle(message, {})).execution, 'not_executed');
  assert.equal(f.calls.length, 0);
});
test('a stale server draft is not overwritten', async t => {
  const f = fixture(t); f.before.fingerprint = 'stale';
  assert.equal((await f.run()).execution, 'not_executed');
  assert.equal(f.calls.length, 1);
});
test('a dangling CID is rejected before any write', async t => {
  const f = fixture(t); f.fields.attachmentItems = '[]';
  await assert.rejects(f.run(), /已移除/);
  assert.equal(f.calls.length, 1);
});
test('changed or symlinked local files are never uploaded', async t => {
  const f = fixture(t); const file = path.join(f.dir, 'file'); fs.writeFileSync(file, 'changed');
  f.p.attachments = [{ path: file, filename: 'file', bytes: 7, sha256: '0'.repeat(64) }];
  await assert.rejects(f.run(), /已变化/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(file, file + '-link'); f.p.attachments[0].path = file + '-link';
    await assert.rejects(f.run());
  }
  assert.ok(f.calls.every(c => c.init.method !== 'PUT'));
});
test('network failure after PUT leaves execution unknown and does not retry', async t => {
  const f = fixture(t), original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => { if (init.method === 'PUT') throw new Error('network'); return original(url, init); });
  const execution = {};
  await assert.rejects(f.run(execution), /network/);
  assert.equal(execution.started, true);
});

// Production worker regression: AI edits to a CID draft used to be refused (or
// lose Content-ID through CLI). Exercise run -> compose -> raw PUT -> read-back
// with synthetic Gmail responses; no real provider or sending (unit tier).
function workerFixture(t, inline = true) {
  const f = fixture(t, inline);
  f.ctx.schema = async () => ({ subcommands: [{ name: 'drafts', subcommands: ['get', 'update'].map(name => ({ name, subcommands: [], flags: [] })) }] });
  f.ctx.execute = async argv => {
    assert.deepEqual(Array.from(argv.slice(0, 3)), ['gmail', 'drafts', 'get']);
    return { ok: true, data: { draft: f.draft } };
  };
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init.method === 'PUT') {
      const raw = Buffer.from(JSON.parse(init.body).message.raw, 'base64url').toString();
      const to = /^To: (.*)\r?$/m.exec(raw)?.[1]?.trim();
      if (to) f.draft.message.payload.headers.find(h => h.name === 'To').value = to;
      for (const part of f.draft.message.payload.parts.filter(p => /^text\//.test(p.mimeType))) {
        const mime = part.mimeType.replace('/', '\/');
        const match = raw.match(new RegExp('Content-Type: ' + mime + '; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+?)(?=\\r\\n--)'));
        assert.ok(match, part.mimeType);
        part.body.data = Buffer.from(match[1], 'base64').toString('base64url');
      }
      const files = [...raw.matchAll(/Content-Type: ([^\r\n]+)\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: (?:inline|attachment); filename\*=UTF-8''([^\r\n]+)\r\n(?:Content-ID: <([^>]+)>\r\n)?\r\n([A-Za-z0-9+/=\r\n]+?)(?=\r\n--)/g)].map((m, index) => {
        const data = Buffer.from(m[4], 'base64');
        return { partId: String(index + 1), filename: decodeURIComponent(m[2]), mimeType: m[1],
          headers: m[3] ? [{ name: 'Content-ID', value: '<' + m[3] + '>' }] : [],
          body: { size: data.length, data: data.toString('base64url') } };
      });
      f.draft.message.payload.parts = f.draft.message.payload.parts.filter(p => !p.filename).concat(files);
    }
    return original(url, init);
  });
  return f;
}
// The shared Host formatter supplies corrected names; the adapter must transport
// them even when HTML/CID/bytes are otherwise unchanged (unit, no real requests).
test('Host attachment rename is saved and read back without changing image bytes or CID', async t => {
  const f = workerFixture(t);
  const part = f.draft.message.payload.parts.find(p => p.filename);
  part.filename = 'image-1';
  const before = f.ctx.draftReadBack({ draft: f.draft }, f.draft.id);
  const fields = { to: before.headers.to, cc: '', bcc: '', subject: before.headers.subject,
    body: before.editor.body, quote: before.editor.quote, bodyHtml: before.editor.bodyHtml, quoteHtml: before.editor.quoteHtml,
    attachmentItems: JSON.stringify(before.attachments.map(a => ({ ...a, filename: 'image-1.png' }))) };
  const result = await f.ctx.handle({ method: 'compose', cindy: { secrets: { gog_access_token: 'fixture-token' } },
    params: { draftId: f.draft.id, fingerprint: before.fingerprint, fields, send: false } }, {});
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.readBack.attachments[0].filename, 'image-1.png');
  assert.equal(result.data.readBack.attachments[0].contentId, '<photo@example.test>');
  const writes = f.calls.filter(c => c.init.method === 'PUT');
  assert.equal(writes.length, 1);
  const raw = Buffer.from(JSON.parse(writes[0].init.body).message.raw, 'base64url').toString();
  assert.ok(raw.includes(f.image.toString('base64')));
});
test('a regular image attachment becomes a CID part in the same draft without uploading another file', async t => {
  const f = workerFixture(t, false);
  const before = f.ctx.draftReadBack({ draft: f.draft }, f.draft.id);
  const cid = 'image-1@cindy.local';
  const fields = { to: before.headers.to, cc: '', bcc: '', subject: before.headers.subject,
    body: before.editor.body, quote: '', bodyHtml: '<p>Original</p><img src="cid:' + cid + '" style="width:240px">', quoteHtml: '',
    attachmentItems: JSON.stringify(before.attachments.map(a => ({ key: a.key, filename: a.filename, contentId: cid }))) };
  const result = await f.ctx.handle({ method: 'compose', cindy: { secrets: { gog_access_token: 'fixture-token' } },
    params: { draftId: f.draft.id, fingerprint: before.fingerprint, fields, send: false } }, {});
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.readBack.attachments.length, 1);
  assert.equal(result.data.readBack.attachments[0].contentId, '<' + cid + '>');
  const writes = f.calls.filter(c => c.init.method === 'PUT');
  assert.equal(writes.length, 1);
  const raw = Buffer.from(JSON.parse(writes[0].init.body).message.raw, 'base64url').toString();
  assert.match(raw, /Content-Disposition: inline/);
  assert.equal(raw.split(f.image.toString('base64')).length - 1, 1);
  assert.equal(f.calls.some(c => /send/.test(c.url)), false);
});
test('forged image CID metadata cannot turn non-image bytes into an embedded image', async t => {
  const f = fixture(t, false), part = f.draft.message.payload.parts.find(p => p.filename);
  part.body.data = Buffer.from('not-an-image').toString('base64url'); part.body.size = 12;
  Object.assign(f.before, f.ctx.draftReadBack({ draft: f.draft }, f.draft.id));
  f.fields.attachmentItems = JSON.stringify([{ key: keyFor(part), contentId: 'image-1@cindy.local' }]);
  await assert.rejects(f.run(), /只能将图片/);
  assert.equal(f.calls.some(c => c.init.method === 'PUT'), false);
});
test('AI updates HTML through drafts update while preserving CID bytes and never sending', async t => {
  const f = workerFixture(t);
  const html = '<p><b>AI edited</b></p><img src="cid:photo@example.test">';
  const result = await f.ctx.handle({ method: 'run', cindy: { secrets: { gog_access_token: 'fixture-token' } },
    params: { command: ['drafts', 'update'], arguments: ['draft-test'], readOnly: false, options: { body: 'AI edited', 'body-html': html } } }, {});
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.readBack.editor.bodyHtml, html);
  assert.equal(result.data.readBack.editor.format, 'html');
  assert.equal(result.data.readBack.attachments[0].contentId, '<photo@example.test>');
  assert.equal(f.calls.filter(c => c.init.method === 'PUT').length, 1);
  assert.equal(f.calls.some(c => /send/.test(c.url)), false);
});
// Gmail rotates attachment download IDs between reads even when messageId and
// content are unchanged. Both AI update and the card writer must accept this.
test('rotating attachment fetch IDs do not create a draft conflict, while real edits still do', async t => {
  const f = workerFixture(t), part = f.draft.message.payload.parts.find(p => p.filename);
  let sequence = 0;
  const rotate = () => { part.body.attachmentId = 'download-' + ++sequence; };
  rotate();
  const first = f.ctx.draftReadBack({ draft: f.draft }, f.draft.id);
  rotate();
  const second = f.ctx.draftReadBack({ draft: f.draft }, f.draft.id);
  assert.notEqual(first.attachments[0].attachmentId, second.attachments[0].attachmentId);
  assert.equal(first.fingerprint, second.fingerprint);
  const execute = f.ctx.execute, fetch = globalThis.fetch;
  f.ctx.execute = async (...args) => { rotate(); return execute(...args); };
  t.mock.method(globalThis, 'fetch', async (...args) => { rotate(); return fetch(...args); });
  const result = await f.ctx.handle({ method: 'run', cindy: { secrets: { gog_access_token: 'fixture-token' } },
    params: { command: ['drafts', 'update'], arguments: [f.draft.id], readOnly: false, options: { to: 'self@example.test' } } }, {});
  assert.equal(result.ok, true, result.message);
  const writes = f.calls.filter(c => c.init.method === 'PUT');
  assert.equal(writes.length, 1);
  const raw = Buffer.from(JSON.parse(writes[0].init.body).message.raw, 'base64url').toString();
  assert.match(raw, /To: self@example.test/);
  assert.match(raw, /Content-ID: <photo@example.test>/);
  assert.equal(f.calls.some(c => /send/.test(c.url)), false);
  const baseline = f.ctx.draftReadBack({ draft: f.draft }, f.draft.id).fingerprint;
  for (const change of [
    draft => { draft.message.id = 'changed-message'; },
    draft => { draft.message.payload.headers.find(h => h.name === 'To').value = 'other@example.test'; },
    draft => { draft.message.payload.parts[1].body.data = Buffer.from('<p>Changed HTML</p>').toString('base64url'); },
    draft => { draft.message.payload.parts.at(-1).body.size++; },
  ]) {
    const changed = structuredClone(f.draft); change(changed);
    assert.notEqual(f.ctx.draftReadBack({ draft: changed }, changed.id).fingerprint, baseline);
  }
});
test('plain card edits regenerate the HTML alternative instead of sending stale text', async t => {
  const f = workerFixture(t);
  f.draft.message.payload.parts = f.draft.message.payload.parts.filter(p => /^text\//.test(p.mimeType));
  f.draft.message.payload.parts[1].body.data = Buffer.from(f.ctx.mailBodyHtml('Original')).toString('base64url');
  const before = f.ctx.draftReadBack({ draft: f.draft }, 'draft-test');
  assert.equal(before.editor.format, 'text');
  const fields = { to: before.headers.to, cc: '', bcc: '', subject: 'Hello', body: 'User edited', quote: '',
    bodyHtml: before.editor.bodyHtml, quoteHtml: '', attachmentItems: '[]' };
  const result = await f.ctx.handle({ method: 'compose', cindy: { secrets: { gog_access_token: 'fixture-token' } },
    params: { draftId: 'draft-test', fingerprint: before.fingerprint, fields, send: false } }, {});
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.readBack.bodyText, 'User edited');
  assert.equal(result.data.readBack.bodyHtml, f.ctx.mailBodyHtml('User edited'));
  assert.equal(result.data.readBack.editor.format, 'text');
});

// Side-effect tri-state rule: a read failure after successful PUT is a saved,
// unsent draft, never a failed write to replay. Cover both read error shapes.
test('a successful rich save survives read-back failure without reporting not_executed or sending', async t => {
  for (const mode of ['not_executed', 'unknown', 'throw']) {
    const f = workerFixture(t), execute = f.ctx.execute;
    f.ctx.execute = async (...args) => {
      if (f.calls.some(c => c.init.method === 'PUT')) {
        if (mode === 'throw') throw new Error('read failed');
        return { ok: false, execution: mode, message: 'read failed' };
      }
      return execute(...args);
    };
    const result = await f.ctx.handle({ method: 'run', cindy: { secrets: { gog_access_token: 'fixture-token' } },
      params: { command: ['drafts', 'update'], arguments: ['draft-test'], readOnly: false, options: { body: 'Edited', 'body-html': '<p>Edited</p><img src="cid:photo@example.test">' } } }, {});
    assert.equal(result.ok, false);
    assert.equal(result.execution, 'executed');
    assert.match(result.message, /已保存.*未发送/);
    assert.equal(f.calls.filter(c => c.init.method === 'PUT').length, 1);
    assert.equal(f.calls.some(c => /send/.test(c.url)), false);
  }
});
test('AI attach replaces ordinary files while preserving only CID images still referenced by the body', async t => {
  const f = workerFixture(t), file = path.join(f.dir, 'new.pdf');
  fs.writeFileSync(file, 'new-file');
  f.draft.message.payload.parts.push({ partId: 'old', filename: 'old.pdf', mimeType: 'application/pdf', body: { size: 8, data: Buffer.from('old-file').toString('base64url') } });
  const result = await f.ctx.handle({ method: 'run', cindy: { secrets: { gog_access_token: 'fixture-token' } },
    params: { command: ['drafts', 'update'], arguments: [f.draft.id], workdir: f.dir, readOnly: false, options: { attach: ['new.pdf'] } } }, {});
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(Array.from(result.data.readBack.attachments, a => a.filename), ['图.png', 'new.pdf']);
  assert.equal(result.data.readBack.attachments[0].contentId, '<photo@example.test>');
  const raw = Buffer.from(JSON.parse(f.calls.find(c => c.init.method === 'PUT').init.body).message.raw, 'base64url').toString();
  assert.ok(raw.includes(f.image.toString('base64')));
  assert.equal(raw.includes(Buffer.from('old-file').toString('base64')), false);
});
test('same-length changed attachment bytes after PUT prevent sending or claiming verified sync', async t => {
  const f = workerFixture(t), execute = f.ctx.execute;
  f.ctx.execute = async (...args) => {
    if (f.calls.some(c => c.init.method === 'PUT')) {
      const part = f.draft.message.payload.parts.find(p => p.filename);
      const changed = Buffer.from(f.image); changed[changed.length - 1] ^= 1;
      part.body.data = changed.toString('base64url');
    }
    return execute(...args);
  };
  const before = f.ctx.draftReadBack({ draft: f.draft }, f.draft.id);
  const result = await f.ctx.handle({ method: 'compose', cindy: { secrets: { gog_access_token: 'fixture-token' } }, params: {
    draftId: f.draft.id, fingerprint: before.fingerprint, fields: { ...f.fields, subject: 'Hello' }, send: true,
  } }, {});
  assert.equal(result.ok, false);
  assert.equal(result.execution, 'executed');
  assert.match(result.message, /附件/);
  assert.equal(f.calls.some(c => /send/.test(c.url)), false);
});
test('attachment read-back downloads server-only bytes and treats missing or changed bytes as saved but unverified', async t => {
  for (const mode of ['matching', 'changed', 'offline']) {
    const f = workerFixture(t), execute = f.ctx.execute, fetch = globalThis.fetch;
    let downloads = 0;
    f.ctx.execute = async (...args) => {
      if (f.calls.some(c => c.init.method === 'PUT')) {
        const part = f.draft.message.payload.parts.find(p => p.filename);
        delete part.body.data;
        part.body.attachmentId = 'stored-part';
      }
      return execute(...args);
    };
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      if (url.endsWith('/attachments/stored-part')) {
        downloads++;
        assert.equal(init.headers.Authorization, 'Bearer fixture-token');
        if (mode === 'offline') throw new Error('offline');
        const data = Buffer.from(f.image);
        if (mode === 'changed') data[data.length - 1] ^= 1;
        return new Response(JSON.stringify({ data: data.toString('base64url') }));
      }
      return fetch(url, init);
    });
    const result = await f.ctx.handle({ method: 'run', cindy: { secrets: { gog_access_token: 'fixture-token' } },
      params: { command: ['drafts', 'update'], arguments: ['draft-test'], readOnly: false,
        options: { body: 'Edited', 'body-html': '<p>Edited</p><img src="cid:photo@example.test">' } } }, {});
    assert.equal(downloads, 1);
    assert.equal(result.ok, mode === 'matching', result.message);
    assert.equal(result.execution, 'executed');
    if (mode !== 'matching') assert.match(result.message, /已保存.*未发送/);
    assert.equal(f.calls.filter(c => c.init.method === 'PUT').length, 1);
    assert.equal(f.calls.some(c => /send/.test(c.url)), false);
  }
});
test('draft read-back decodes the declared charset before editing either body alternative', t => {
  const f = fixture(t), text = f.draft.message.payload.parts[0], html = f.draft.message.payload.parts[1];
  text.headers = [{ name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' }];
  text.body.data = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url');
  html.headers = [{ name: 'Content-Type', value: 'text/html; charset="Shift_JIS"' }];
  html.body.data = Buffer.from([0x3c, 0x70, 0x3e, 0x93, 0xfa, 0x96, 0x7b, 0x3c, 0x2f, 0x70, 0x3e]).toString('base64url');
  const saved = f.ctx.draftReadBack({ draft: f.draft }, f.draft.id);
  assert.equal(saved.bodyText, 'café');
  assert.equal(saved.editor.bodyHtml, '<p>日本</p>');
});
