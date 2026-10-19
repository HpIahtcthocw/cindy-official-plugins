import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
const source = readFileSync(new URL('../google-gmail/main.js', import.meta.url), 'utf8');
function fixture(accounts = [{ id: 'a', email: 'a@example.com', status: 'connected' }]) {
  const calls = [];
  const part = (type, text) => ({ mimeType: type, body: { data: Buffer.from(text).toString('base64url') } });
  const msg = { id: '12345678', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: '中文主题' }, { name: 'From', value: 'sender@example.com' }], parts: [part('text/plain', '中文'), part('text/html', '<p>中文</p><img src="cid:photo">'),
    { partId: '2', mimeType: 'message/rfc822', filename: 'forward.eml', body: {}, parts: [part('text/plain', 'Do not append me')] },
    { partId: '3', mimeType: 'image/png', filename: 'image.png', headers: [{ name: 'Content-ID', value: '<photo>' }], body: { data: 'AQID', size: 3 } } ] } };
  const ctx = createContext({ URL, TextDecoder, Uint8Array, atob, cindy: { onHostMessage() {},
    fetch: async r => { calls.push(r); return { ok: true, status: 200, body: JSON.stringify(msg) }; },
    send: async r => { assert.equal(r.kind, 'deposit_media'); return { ok: true, url: 'cindy-media://blobs/' + 'a'.repeat(64) + '.png' }; },
  }});
  runInContext(source, ctx);
  ctx.listAccounts = async () => ({ ok: true, result: { accounts } });
  return { ctx, calls, msg, read: (url, options = {}) => ctx.readMailMessageLink({ url, ...options }) };
}
test('resolves a conversation link when the original draft message no longer exists', async () => {
  const f = fixture(), urls = [];
  f.ctx.cindy.fetch = async r => {
    urls.push(r.url); assert.equal(r.authAccount, 'a');
    if (urls.length === 1) return { ok: false, status: 404, body: '{}' };
    if (urls.length === 2) return { ok: true, status: 200, body: JSON.stringify({ messages: [
      { id: 'abcdef01', internalDate: '200', labelIds: ['SENT'] },
      { id: 'abcdef02', internalDate: '100', labelIds: ['INBOX'] },
      { id: 'abcdef03', internalDate: '300', labelIds: ['DRAFT'] },
    ] }) };
    return { ok: true, status: 200, body: JSON.stringify({ ...f.msg, id: 'abcdef01' }) };
  };
  const mail = await f.read('https://mail.google.com/mail/?authuser=a@example.com#all/12345678');
  assert.equal(mail.messageId, 'abcdef01'); assert.match(mail.bodyHtml, /cid:photo/);
  assert.deepEqual(urls, [
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/12345678?format=full',
    'https://gmail.googleapis.com/gmail/v1/users/me/threads/12345678?format=metadata',
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/abcdef01?format=full',
  ]);
});
test('does not reinterpret explicit message links or retry authorization failures as conversations', async () => {
  for (const [status, url] of [[401, 'https://mail.google.com/mail/#all/12345678'], [404, 'https://mail.google.com/mail/?permmsgid=12345678']]) {
    const f = fixture(); let calls = 0;
    f.ctx.cindy.fetch = async () => { calls++; return { ok: false, status, body: '{}' }; };
    await assert.rejects(f.read(url)); assert.equal(calls, 1);
  }
});
test('native reader preserves HTML/CID and UTF-8, excludes attached mail body, only reads Gmail', async () => {
  const f = fixture(), m = await f.read('https://mail.google.com/mail/?authuser=a@example.com#all/12345678');
  assert.equal(m.bodyText, '中文'); assert.match(m.bodyHtml, /cid:photo/);
  assert.equal(m.subject, '中文主题'); assert.equal(m.attachments.length, 2);
  assert.match(m.attachments[1].previewUrl, /^cindy-media:/);
  assert.equal(m.attachments[1].inlineData, undefined);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].authAccount, 'a');
  assert.equal(f.calls[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/12345678?format=full');
  assert.equal(f.calls[0].method, undefined);
});
// Reader regressions: MIME encodings belong to each body part; a failed image
// deposit must not discard a successfully fetched body (unit, synthetic bytes).
test('native reader decodes each declared body charset, including legacy encodings', async () => {
  const f = fixture();
  const text = f.msg.payload.parts[0], html = f.msg.payload.parts[1];
  text.headers = [{ name: 'Content-Type', value: 'text/plain; charset="ISO-8859-1"' }];
  text.body.data = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url');
  html.headers = [{ name: 'Content-Type', value: "text/html; charset='Shift_JIS'" }];
  html.body.data = Buffer.from([0x3c, 0x70, 0x3e, 0x93, 0xfa, 0x96, 0x7b, 0x3c, 0x2f, 0x70, 0x3e]).toString('base64url');
  const mail = await f.read('https://mail.google.com/mail/#all/12345678');
  assert.equal(mail.bodyText, 'café');
  assert.equal(mail.bodyHtml, '<p>日本</p>');
});
test('one failed inline image deposit preserves body, conversation and other previews', async () => {
  const f = fixture();
  f.msg.threadId = 'abcdef00';
  f.msg.messages = [{ id: f.msg.id }];
  const image = f.msg.payload.parts.at(-1);
  f.msg.payload.parts.push({ ...image, partId: '4', filename: 'other.png' });
  let deposits = 0;
  f.ctx.cindy.send = async () => {
    if (++deposits === 1) throw new Error('media unavailable');
    return { ok: true, url: 'cindy-media://blobs/' + 'b'.repeat(64) + '.png' };
  };
  const mail = await f.read('https://mail.google.com/mail/#all/12345678');
  assert.equal(mail.bodyText, '中文');
  assert.equal(mail.conversation.messages.length, 1);
  assert.equal(mail.attachments[1].previewUrl, undefined);
  assert.match(mail.attachments[2].previewUrl, /^cindy-media:/);
  assert.equal(deposits, 2);
});
test('ambiguous accounts and foreign URLs never trigger mailbox requests', async () => {
  const f = fixture([{ id: 'a', email: 'a@example.com', status: 'connected' }, { id: 'b', email: 'b@example.com', status: 'connected' }]);
  for (const url of ['https://evil.com/mail/#all/12345678', 'https://mail.google.com.evil.com/mail/#all/12345678', 'https://mail.google.com/mail/#all/12345678', 'https://mail.google.com/mail/?authuser=missing@example.com#all/12345678'])
    await assert.rejects(f.read(url));
  assert.equal(f.calls.length, 0);
  assert.equal((await f.read('https://mail.google.com/mail/?authuser=b@example.com#all/12345678')).accountId, 'b');
});

// Conversation support: one selected body + chronological metadata, never eagerly read other bodies.
test('keeps the selected mail and exposes account-bound links for the whole conversation', async () => {
  const f = fixture(), calls = [];
  const members = ['abcdef03', '12345678', 'abcdef01'].map((id, i) => ({
    id, internalDate: String(300 - i * 100), snippet: 'Snippet ' + id,
    payload: { headers: [{ name: 'From', value: id + '@example.test' }] },
  }));
  f.ctx.cindy.fetch = async r => {
    calls.push(r); assert.equal(r.authAccount, 'a');
    return { ok: true, status: 200, body: JSON.stringify(r.url.includes('/threads/')
      ? { id: 'abcdef00', messages: [...members, { id: 'abcdef04', labelIds: ['DRAFT'] }] }
      : { ...f.msg, threadId: 'abcdef00' }) };
  };
  const mail = await f.read('https://mail.google.com/mail/?authuser=a@example.com#all/12345678');
  assert.equal(mail.messageId, '12345678');
  assert.deepEqual(Array.from(mail.conversation.messages, m => m.messageId), ['abcdef01', '12345678', 'abcdef03']);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /threads\/abcdef00\?format=metadata$/);
  for (const member of mail.conversation.messages) {
    const url = new URL(member.url);
    assert.equal(url.searchParams.get('authuser'), 'a@example.com');
    assert.equal(url.searchParams.get('permmsgid'), member.messageId);
  }
});
test('a conversation failure retains the selected body and reports incomplete history', async () => {
  const f = fixture();
  f.ctx.cindy.fetch = async r => r.url.includes('/threads/')
    ? { ok: false, status: 503, body: '{}' }
    : { ok: true, status: 200, body: JSON.stringify({ ...f.msg, threadId: 'abcdef00' }) };
  const mail = await f.read('https://mail.google.com/mail/#all/12345678');
  assert.equal(mail.bodyText, '中文');
  assert.equal(mail.conversationUnavailable, true);
  assert.equal(mail.conversation, undefined);
});

// User opening is the only automatic write. Exercise the real adapter to ensure
// background reads never remove UNREAD, and failure never hides readable mail.
test('marks only the selected unread message in its resolved account on explicit opening', async () => {
  const f = fixture(); f.msg.labelIds = ['INBOX', 'UNREAD'];
  await f.read('https://mail.google.com/mail/#all/12345678');
  assert.equal(f.calls.filter(r => r.method === 'POST').length, 0);
  await f.read('https://mail.google.com/mail/#all/12345678', { markRead: true });
  const writes = f.calls.filter(r => r.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/12345678/modify');
  assert.equal(writes[0].authAccount, 'a');
  assert.deepEqual(JSON.parse(writes[0].body), { removeLabelIds: ['UNREAD'] });
  for (const labels of [['INBOX'], ['DRAFT', 'UNREAD']]) {
    f.msg.labelIds = labels;
    await f.read('https://mail.google.com/mail/#all/12345678', { markRead: true });
  }
  assert.equal(f.calls.filter(r => r.method === 'POST').length, 1);
});
test('mark-read errors preserve the body and expose a partial failure without retrying', async () => {
  for (const transportFailure of [false, true]) {
    const f = fixture(); let writes = 0;
    f.ctx.cindy.fetch = async r => {
      if (r.method === 'POST') { writes++; if (transportFailure) throw new Error('offline'); return { ok: false, status: 403 }; }
      return { ok: true, status: 200, body: JSON.stringify({ ...f.msg, labelIds: ['UNREAD'] }) };
    };
    const mail = await f.read('https://mail.google.com/mail/#all/12345678', { markRead: true });
    assert.equal(mail.bodyText, '中文'); assert.equal(mail.markReadFailed, true); assert.equal(writes, 1);
  }
});
test('an explicit conversation opening marks the resolved member, never the thread or replaced draft', async () => {
  const f = fixture(), writes = [];
  f.ctx.cindy.fetch = async r => {
    if (r.method === 'POST') { writes.push(r); return { ok: true, status: 200 }; }
    if (r.url.includes('/messages/12345678')) return { ok: false, status: 404 };
    if (r.url.includes('/threads/')) return { ok: true, status: 200, body: JSON.stringify({ messages: [{ id: 'abcdef01', internalDate: '200', labelIds: ['UNREAD'] }] }) };
    return { ok: true, status: 200, body: JSON.stringify({ ...f.msg, id: 'abcdef01', labelIds: ['UNREAD'] }) };
  };
  await f.read('https://mail.google.com/mail/#all/12345678', { markRead: true });
  assert.equal(writes.length, 1); assert.match(writes[0].url, /messages\/abcdef01\/modify$/);
});
