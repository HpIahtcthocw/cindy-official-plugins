import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const pluginDir = path.join(root, 'cindy-web-search');
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'ghost.json'), 'utf8'));
const source = fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8');
const settingsSource = fs.readFileSync(path.join(pluginDir, 'settings.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(pluginDir, 'settings.html'), 'utf8');
const locales = ['zh-CN', 'en', 'ja', 'ko'].map((locale) =>
  JSON.parse(fs.readFileSync(path.join(pluginDir, 'locales', `${locale}.json`), 'utf8')),
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function createHarness(options = {}) {
  const kv = options.kv ?? {};
  const networkCalls = [];
  const cindyRequests = [];
  const toolResults = [];
  let handler = null;

  const cindy = {
    onHostMessage(fn) {
      handler = fn;
    },
    async fetch(request) {
      networkCalls.push(request);
      if (options.networkResult) return options.networkResult(request);
      throw new Error('unexpected network request');
    },
    async send(message) {
      if (message.type === 'cindy-request') {
        cindyRequests.push(message);
        if (options.cindyError) throw options.cindyError;
        return options.cindyResult ?? {
          ok: true,
          provider: 'cindy',
          results: [
            {
              title: 'Cindy',
              url: 'https://example.test/cindy',
              snippet: 'Managed result',
            },
          ],
        };
      }
      if (message.type === 'tool-result') {
        toolResults.push(message);
        return { ok: true };
      }
      throw new Error(`unexpected cindy.send type ${message.type}`);
    },
  };

  vm.runInNewContext(source, {
    cindy,
    fetch: async (url, init) => {
      if (options.kvFetch) return options.kvFetch(url, init);
      if (url === '/secrets') {
        return {
          ok: true,
          async json() {
            return options.secrets ?? [];
          },
        };
      }
      assert.equal(url, '/kv');
      return {
        ok: true,
        async json() {
          return kv;
        },
      };
    },
    encodeURIComponent,
    isFinite,
    JSON,
    String,
    Error,
  });
  assert.equal(typeof handler, 'function');

  return {
    networkCalls,
    cindyRequests,
    toolResults,
    async search(args = {}) {
      await handler({
        type: 'tool-call',
        tool: 'search_web',
        callId: 'call-1',
        args: { query: 'Cindy', ...args },
      });
      return toolResults.at(-1);
    },
  };
}

function createSettingsHarness(options = {}) {
  function control(initial = {}) {
    const listeners = new Map();
    return {
      checked: initial.checked ?? false,
      value: initial.value ?? '',
      disabled: initial.disabled ?? false,
      textContent: '',
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      emit(type) {
        const listener = listeners.get(type);
        assert.ok(listener, `missing ${type} listener`);
        return listener();
      },
    };
  }

  const cindyAiEnabled = control({ checked: true, disabled: true });
  const byoDefaultProvider = control({ value: 'brave', disabled: true });
  const status = control();
  const elements = new Map([
    ['cindy-ai-enabled', cindyAiEnabled],
    ['byo-default-provider', byoDefaultProvider],
    ['status', status],
  ]);
  const fetchCalls = [];
  const document = {
    getElementById(id) {
      return elements.get(id);
    },
    querySelectorAll(selector) {
      assert.equal(selector, '.secret');
      return [];
    },
  };

  vm.runInNewContext(settingsSource, {
    document,
    fetch: async (url, init = {}) => {
      fetchCalls.push({ url, init });
      if (url === '/secrets') {
        return {
          ok: true,
          async json() {
            return [];
          },
        };
      }
      assert.equal(url, '/kv');
      if (init.method === 'PUT') {
        return options.writeKv ? options.writeKv(init) : { ok: true };
      }
      return options.readKv
        ? options.readKv()
        : {
            ok: true,
            async json() {
              return {};
            },
          };
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    JSON,
    Error,
  });

  return {
    cindyAiEnabled,
    byoDefaultProvider,
    status,
    fetchCalls,
  };
}

test('manifest declares Cindy Web Search and keeps BYO providers explicit', () => {
  assert.equal(manifest.version, '1.5.0');
  assert.equal(manifest.minCindyVersion, '0.1.64');
  assert.equal(manifest.schemaVersion, 3);
  assert.deepEqual(manifest.cindy, { search: ['web'] });
  assert.equal(Object.hasOwn(manifest, 'slots'), false);
  assert.deepEqual(manifest.network.hosts, ['api.search.brave.com', 'api.tavily.com', 'api.deepseek.com', 'api.anysearch.com']);
  assert.deepEqual(manifest.setup, { requires: [] });
  const provider = manifest.tools[0].parameters.properties.provider;
  assert.deepEqual(provider.enum, ['cindy', 'brave', 'tavily', 'deepseek', 'anysearch']);
  assert.equal(provider.enum.includes('auto'), false);
  const query = manifest.tools[0].parameters.properties.query;
  assert.equal(query.maxLength, 2000);
  assert.match(manifest.tools[0].description, /2000/);
  assert.match(query.description, /2000/);
  for (const locale of locales) {
    assert.match(locale.tools.search_web.description, /2000/);
  }
});

test('missing provider uses Cindy AI by default and does not touch BYO network', async () => {
  const harness = createHarness();
  const result = await harness.search();

  assert.equal(harness.networkCalls.length, 0);
  assert.equal(harness.cindyRequests.length, 1);
  const request = harness.cindyRequests[0];
  assert.equal(request.type, 'cindy-request');
  assert.equal(request.kind, 'search_web');
  assert.equal(request.query, 'Cindy');
  assert.equal(request.limit, 5);
  assert.equal(request.provider, 'cindy');
  assert.equal(request.callId, 'call-1');
  assert.equal(request.callerTool, 'search_web');
  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'cindy');
});

test('disabled Cindy AI uses the configured BYO default only', async () => {
  const harness = createHarness({
    kv: { cindyAiEnabled: false, byoDefaultProvider: 'tavily' },
    networkResult(request) {
      assert.equal(request.url, 'https://api.tavily.com/search');
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({
          results: [
            {
              title: 'Tavily',
              url: 'https://example.test/tavily',
              content: 'BYO result',
            },
          ],
        }),
      };
    },
  });
  const result = await harness.search();

  assert.equal(harness.cindyRequests.length, 0);
  assert.equal(harness.networkCalls.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'tavily');
});

test('missing provider fails closed when preferences cannot be read', async () => {
  const harness = createHarness({
    kvFetch: async () => {
      throw new Error('kv unavailable');
    },
  });
  const result = await harness.search();

  assert.equal(harness.cindyRequests.length, 0);
  assert.equal(harness.networkCalls.length, 0);
  assert.equal(result.ok, false);
  assert.match(result.message, /搜索偏好读取失败/);
});

test('Cindy transport failures return an actionable service error', async () => {
  const harness = createHarness({
    cindyError: new Error('Failed to fetch'),
  });
  const result = await harness.search({ provider: 'cindy' });

  assert.equal(harness.cindyRequests.length, 1);
  assert.equal(harness.networkCalls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.message, 'Cindy AI 搜索服务暂时不可用，请稍后再试');
  assert.equal(result.errorCode, 'INTERNAL');
  assert.doesNotMatch(result.message, /Failed to fetch/);
});

test('explicit provider wins over settings and provider failures never fall back', async () => {
  const brave = createHarness({
    kvFetch: async () => {
      throw new Error('explicit provider must not read kv');
    },
    networkResult(request) {
      assert.match(request.url, /^https:\/\/api\.search\.brave\.com\//);
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({
          web: {
            results: [
              {
                title: 'Brave',
                url: 'https://example.test/brave',
                description: 'BYO result',
              },
            ],
          },
        }),
      };
    },
  });
  const braveResult = await brave.search({ provider: 'brave' });
  assert.equal(brave.cindyRequests.length, 0);
  assert.equal(brave.networkCalls.length, 1);
  assert.equal(braveResult.result.provider, 'brave');

  const failedCindy = createHarness({
    cindyResult: {
      ok: false,
      errorCode: 'QUOTA_EXHAUSTED',
      message: 'Cindy AI quota exhausted',
    },
  });
  const failedResult = await failedCindy.search({ provider: 'cindy' });
  assert.equal(failedCindy.cindyRequests.length, 1);
  assert.equal(failedCindy.networkCalls.length, 0);
  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.message, 'Cindy AI quota exhausted');
  assert.equal(failedResult.errorCode, 'QUOTA_EXHAUSTED');
});

for (const provider of ['cindy', 'brave', 'tavily']) {
  for (const errorCode of ['RATE_LIMITED', 'QUOTA_EXHAUSTED', 'INVALID_INPUT', 'PERMISSION_DENIED']) {
    test(`${provider} preserves Host error ${errorCode} without retry or fallback`, async () => {
      const failure = { ok: false, errorCode, message: 'Host failure details' };
      const harness = createHarness({ cindyResult: failure, networkResult: () => failure });
      const result = await harness.search({ provider });

      assert.equal(result.ok, false);
      assert.equal(result.errorCode, errorCode);
      assert.equal(result.message, failure.message);
      assert.equal(result.callId, 'call-1');
      assert.equal(harness.toolResults.length, 1);
      assert.equal(harness.cindyRequests.length, provider === 'cindy' ? 1 : 0);
      assert.equal(harness.networkCalls.length, provider === 'cindy' ? 0 : 1);
    });
  }

  test(`${provider} preserves structured exceptions`, async () => {
    const failure = Object.assign(new Error('Search quota exhausted; check your balance'), {
      errorCode: 'QUOTA_EXHAUSTED',
    });
    const harness = createHarness({
      cindyError: failure,
      networkResult: () => { throw failure; },
    });
    const result = await harness.search({ provider });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'QUOTA_EXHAUSTED');
    assert.ok(result.message.includes(failure.message));
    assert.equal(harness.toolResults.length, 1);
    assert.equal(harness.cindyRequests.length, provider === 'cindy' ? 1 : 0);
    assert.equal(harness.networkCalls.length, provider === 'cindy' ? 0 : 1);
  });

  test(`${provider} classifies unstructured exceptions as INTERNAL`, async () => {
    const failure = new Error('Unexpected failure');
    const harness = createHarness({
      cindyError: failure,
      networkResult: () => { throw failure; },
    });
    const result = await harness.search({ provider });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'INTERNAL');
    assert.equal(harness.toolResults.length, 1);
  });
}

test('legacy failures without errorCode remain failures without guessing their category', async () => {
  const harness = createHarness({ cindyResult: { ok: false, message: 'Legacy failure' } });
  const result = await harness.search({ provider: 'cindy' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.message, 'Legacy failure');
});

test('settings controls stay disabled until initial preferences load', async () => {
  const pendingKv = deferred();
  const harness = createSettingsHarness({
    readKv: () => pendingKv.promise,
  });

  assert.equal(harness.cindyAiEnabled.disabled, true);
  assert.equal(harness.byoDefaultProvider.disabled, true);

  pendingKv.resolve({
    ok: true,
    async json() {
      return { cindyAiEnabled: false, byoDefaultProvider: 'tavily' };
    },
  });
  await flushAsync();

  assert.equal(harness.cindyAiEnabled.checked, false);
  assert.equal(harness.byoDefaultProvider.value, 'tavily');
  assert.equal(harness.cindyAiEnabled.disabled, false);
  assert.equal(harness.byoDefaultProvider.disabled, false);
});

test('settings remain disabled when initial preferences fail to load', async () => {
  const harness = createSettingsHarness({
    readKv: async () => {
      throw new Error('kv unavailable');
    },
  });
  await flushAsync();

  assert.equal(harness.cindyAiEnabled.disabled, true);
  assert.equal(harness.byoDefaultProvider.disabled, true);
  assert.match(harness.status.textContent, /搜索偏好加载失败/);
  assert.match(settingsHtml, /id="cindy-ai-enabled"[^>]*disabled/);
  assert.match(settingsHtml, /id="byo-default-provider"[^>]*disabled/);
});

test('settings save failure restores the last successfully loaded preferences', async () => {
  const harness = createSettingsHarness({
    readKv: async () => ({
      ok: true,
      async json() {
        return { cindyAiEnabled: false, byoDefaultProvider: 'tavily' };
      },
    }),
    writeKv: async () => ({ ok: false }),
  });
  await flushAsync();

  harness.cindyAiEnabled.checked = true;
  harness.cindyAiEnabled.emit('change');
  await flushAsync();

  assert.equal(harness.cindyAiEnabled.checked, false);
  assert.equal(harness.byoDefaultProvider.value, 'tavily');
  assert.equal(harness.cindyAiEnabled.disabled, false);
  assert.equal(harness.byoDefaultProvider.disabled, false);
  assert.match(harness.status.textContent, /搜索偏好保存失败/);
});

function deepSeekResponse(results = []) {
  return { ok: true, status: 200, body: JSON.stringify({ results }) };
}

function deepSeekItem(overrides = {}) {
  return {
    title: 'Example page', url: 'https://example.test/page',
    summary: 'Long summary for the model', snippet: 'Short display snippet',
    content: '', ...overrides,
  };
}

test('DeepSeek uses the independent Search API with Host-only credential injection', async () => {
  const harness = createHarness({
    kvFetch: () => { throw new Error('explicit selection must not read preferences'); },
    networkResult: () => deepSeekResponse([
      deepSeekItem(), deepSeekItem({ summary: '', snippet: 'Fallback snippet' }),
      deepSeekItem({ title: 'Extra result' }),
    ]),
  });
  const result = await harness.search({ provider: 'deepseek', query: '  示例 site:example.test  ', limit: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'deepseek');
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.results)), [
    { title: 'Example page', url: 'https://example.test/page', snippet: 'Long summary for the model' },
    { title: 'Example page', url: 'https://example.test/page', snippet: 'Fallback snippet' },
  ]);
  assert.equal(harness.networkCalls.length, 1);
  assert.equal(harness.cindyRequests.length, 0);
  assert.equal(harness.toolResults.length, 1);
  const request = harness.networkCalls[0];
  assert.equal(request.url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(request.method, 'POST');
  assert.equal(request.callId, 'call-1');
  assert.deepEqual(JSON.parse(JSON.stringify(request.headers)), { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(request.body), { query: '示例 site:example.test', count: 2, need_content: false });
});

test('DeepSeek may be the BYO default while Cindy AI remains the initial default', async () => {
  const configured = { cindyAiEnabled: false, byoDefaultProvider: 'deepseek' };
  const harness = createHarness({ kv: configured, networkResult: () => deepSeekResponse() });
  const result = await harness.search();
  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'deepseek');
  assert.equal(result.result.results.length, 0);
  assert.equal(JSON.parse(harness.networkCalls[0].body).count, 5);
  assert.equal(harness.cindyRequests.length, 0);

  const enabled = createHarness({ kv: { ...configured, cindyAiEnabled: true } });
  assert.equal((await enabled.search()).result.provider, 'cindy');
  assert.equal(enabled.networkCalls.length, 0);
});

test('DeepSeek limit respects the shared 1–10 result contract', async () => {
  for (const [limit, count] of [[0, 1], [2.9, 2], [50, 10]]) {
    const harness = createHarness({ networkResult: () => deepSeekResponse() });
    assert.equal((await harness.search({ provider: 'deepseek', limit })).ok, true);
    assert.equal(JSON.parse(harness.networkCalls[0].body).count, count);
  }
});

test('DeepSeek validates 128 Unicode code points without truncation for both routing paths', async () => {
  for (const unit of ['中', '😀']) {
    const query = unit.repeat(128);
    const harness = createHarness({ networkResult: () => deepSeekResponse() });
    assert.equal((await harness.search({ provider: 'deepseek', query })).ok, true);
    assert.equal(JSON.parse(harness.networkCalls[0].body).query, query);
    for (const provider of ['deepseek', undefined]) {
      const rejected = createHarness({ kv: { cindyAiEnabled: false, byoDefaultProvider: 'deepseek' } });
      const result = await rejected.search({ provider, query: query + unit });
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, 'INVALID_INPUT');
      assert.match(result.message, /128/);
      assert.equal(rejected.networkCalls.length, 0);
      assert.equal(rejected.cindyRequests.length, 0);
    }
  }
  const existing = createHarness();
  assert.equal((await existing.search({ provider: 'cindy', query: 'a'.repeat(2000) })).ok, true);
  assert.equal(existing.cindyRequests[0].query.length, 2000);
  const empty = createHarness();
  assert.equal((await empty.search({ provider: 'deepseek', query: ' \n ' })).ok, false);
  assert.equal(empty.networkCalls.length, 0);
});

for (const [status, code, guidance] of [
  [400, 'INVALID_INPUT', /查询/], [401, 'AUTH_REJECTED', /更新 Key/],
  [402, 'QUOTA_EXHAUSTED', /充值/], [403, 'PERMISSION_DENIED', /权限/],
  [404, 'UPSTREAM_REJECTED', /账号权限/], [408, 'UPSTREAM_UNAVAILABLE', /稍后重试/],
  [413, 'INVALID_INPUT', /查询/], [429, 'RATE_LIMITED', /稍后重试/],
  [500, 'UPSTREAM_UNAVAILABLE', /稍后重试/], [504, 'UPSTREAM_UNAVAILABLE', /稍后重试/],
  [302, 'UPSTREAM_REJECTED', /账号权限/], [422, 'UPSTREAM_REJECTED', /账号权限/],
]) {
  test(`DeepSeek HTTP ${status} gives actionable ${code} without retry, fallback or body disclosure`, async () => {
    const harness = createHarness({ networkResult: () => ({ ok: true, status, body: 'upstream-private-detail' }) });
    const result = await harness.search({ provider: 'deepseek' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, code);
    assert.match(result.message, guidance);
    assert.doesNotMatch(result.message, /upstream-private-detail|HTTP|\b[345]\d\d\b/);
    assert.equal(harness.networkCalls.length, 1);
    assert.equal(harness.cindyRequests.length, 0);
    assert.equal(harness.toolResults.length, 1);
  });
}

test('DeepSeek preserves structured Host error codes with safe, actionable messages', async () => {
  for (const [errorCode, guidance] of [
    ['NOT_CONFIGURED', /配置 DeepSeek API Key/], ['AUTH_REJECTED', /更新 Key/],
    ['PERMISSION_DENIED', /授权/], ['QUOTA_EXHAUSTED', /充值/],
    ['RATE_LIMITED', /稍后重试/], ['INVALID_INPUT', /128/], ['HOST_NETWORK_FAILURE', /网络连接/],
  ]) {
    for (const throws of [false, true]) {
      const harness = createHarness({ networkResult: () => {
        if (throws) throw Object.assign(new Error('private-host-detail'), { errorCode });
        return { ok: false, errorCode, message: 'private-host-detail' };
      } });
      const result = await harness.search({ provider: 'deepseek' });
      assert.equal(result.errorCode, errorCode);
      assert.match(result.message, guidance);
      assert.doesNotMatch(result.message, /private-host-detail/);
      assert.equal(harness.networkCalls.length, 1);
      assert.equal(harness.cindyRequests.length, 0);
      assert.equal(harness.toolResults.length, 1);
    }
  }
});

test('DeepSeek handles legacy Host failures and exceptions without exposing diagnostics', async () => {
  for (const failure of [null, { ok: false, message: 'private-host-detail' }, new Error('private-host-detail')]) {
    const harness = createHarness({ networkResult: () => {
      if (failure instanceof Error) throw failure;
      return failure;
    } });
    const result = await harness.search({ provider: 'deepseek' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'INTERNAL');
    assert.match(result.message, /网络连接/);
    assert.match(result.message, /DeepSeek API Key/);
    assert.doesNotMatch(result.message, /private-host-detail/);
    assert.equal(harness.networkCalls.length, 1);
  }
});

test('DeepSeek rejects malformed, truncated and oversized results instead of returning empty success', async () => {
  const bodies = ['invalid-json', 'null', '{}', '{"results":{}}', '{"results":[null]}',
    JSON.stringify({ results: [deepSeekItem({ title: null })] }),
    JSON.stringify({ results: [deepSeekItem({ summary: null })] }),
    JSON.stringify({ results: [deepSeekItem({ url: 42 })] }),
    JSON.stringify({ results: [deepSeekItem({ snippet: null })] }),
    ' '.repeat(1000001), null,
  ];
  for (const response of [
    ...bodies.map(body => ({ ok: true, status: 200, body })),
    { ...deepSeekResponse(), truncated: true },
  ]) {
    const harness = createHarness({ networkResult: () => response });
    const result = await harness.search({ provider: 'deepseek' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'RESPONSE_INVALID');
    assert.equal(harness.networkCalls.length, 1);
    assert.equal(harness.cindyRequests.length, 0);
  }
});

test('DeepSeek credentials are declared only for the API host and have a settings row', () => {
  const secret = manifest.network.secrets.find(item => item.key === 'deepseek_api_key');
  assert.deepEqual(secret.inject, {
    header: 'Authorization', format: 'Bearer {value}', hosts: ['api.deepseek.com'],
  });
  assert.equal(secret.url, 'https://platform.deepseek.com/api_keys');
  assert.equal(manifest.network.hosts.includes('platform.deepseek.com'), false);
  assert.match(settingsHtml, /data-key="deepseek_api_key"/);
  assert.match(settingsHtml, /href="https:\/\/platform\.deepseek\.com\/api_keys"/);
  assert.match(settingsHtml, /<option value="deepseek">DeepSeek<\/option>/);
  for (const locale of locales) {
    assert.match(locale.description, /DeepSeek/);
    assert.match(locale.whenToUse, /DeepSeek/);
    assert.match(locale.tools.search_web.description, /128/);
  }
});

test('settings load and persist DeepSeek as the BYO default without losing other preferences', async () => {
  const original = { cindyAiEnabled: false, byoDefaultProvider: 'deepseek', unrelated: 'keep' };
  const harness = createSettingsHarness({ readKv: async () => ({ ok: true, json: async () => original }) });
  await flushAsync();
  assert.equal(harness.byoDefaultProvider.value, 'deepseek');
  harness.byoDefaultProvider.emit('change');
  await flushAsync();
  const write = harness.fetchCalls.find(call => call.init.method === 'PUT');
  assert.deepEqual(JSON.parse(write.init.body), original);
  assert.match(harness.status.textContent, /已保存/);
});

function anySearchResponse(results = []) {
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      code: 0,
      message: 'success',
      request_id: 'test-request-id',
      data: { results, metadata: { total_results: results.length, search_time_ms: 12 } },
    }),
  };
}

function anySearchItem(overrides = {}) {
  return {
    title: 'Example page', url: 'https://example.test/page',
    snippet: 'Short snippet', content: 'Cleaned content', ...overrides,
  };
}

test('AnySearch posts a trimmed query with the shared 1–10 limit and maps snippet/content', async () => {
  const harness = createHarness({
    kv: { byoDefaultProvider: 'anysearch' },
    networkResult: () => anySearchResponse([
      anySearchItem(), anySearchItem({ snippet: '', content: 'Content fallback' }),
      anySearchItem({ title: 'Extra result' }),
    ]),
  });
  const result = await harness.search({ provider: 'anysearch', query: '  Go 1.26 release notes  ', limit: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'anysearch');
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.results)), [
    { title: 'Example page', url: 'https://example.test/page', snippet: 'Short snippet' },
    { title: 'Example page', url: 'https://example.test/page', snippet: 'Content fallback' },
  ]);
  assert.equal(harness.networkCalls.length, 1);
  assert.equal(harness.cindyRequests.length, 0);
  assert.equal(harness.toolResults.length, 1);
  const request = harness.networkCalls[0];
  assert.equal(request.url, 'https://api.anysearch.com/v1/search');
  assert.equal(request.method, 'POST');
  assert.equal(request.callId, 'call-1');
  assert.deepEqual(JSON.parse(JSON.stringify(request.headers)), { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(request.body), { query: 'Go 1.26 release notes', max_results: 2 });
});

test('AnySearch may be the BYO default while Cindy AI remains the initial default', async () => {
  const configured = { cindyAiEnabled: false, byoDefaultProvider: 'anysearch' };
  const harness = createHarness({ kv: configured, networkResult: () => anySearchResponse() });
  const result = await harness.search();
  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'anysearch');
  assert.equal(JSON.parse(harness.networkCalls[0].body).max_results, 5);
  assert.equal(harness.cindyRequests.length, 0);

  const enabled = createHarness({ kv: { ...configured, cindyAiEnabled: true } });
  assert.equal((await enabled.search()).result.provider, 'cindy');
  assert.equal(enabled.networkCalls.length, 0);
});

test('AnySearch limit respects the shared 1–10 result contract', async () => {
  for (const [limit, count] of [[0, 1], [2.9, 2], [50, 10]]) {
    const harness = createHarness({ kv: { byoDefaultProvider: 'anysearch' }, networkResult: () => anySearchResponse() });
    assert.equal((await harness.search({ provider: 'anysearch', limit })).ok, true);
    assert.equal(JSON.parse(harness.networkCalls[0].body).max_results, count);
  }
});

for (const [status, code, guidance] of [
  [400, 'INVALID_INPUT', /查询/], [401, 'AUTH_REJECTED', /更新 Key/],
  [402, 'QUOTA_EXHAUSTED', /Key/], [403, 'PERMISSION_DENIED', /授权/],
  [415, 'INVALID_INPUT', /参数/], [429, 'RATE_LIMITED', /稍后重试/],
  [500, 'UPSTREAM_UNAVAILABLE', /稍后重试/], [502, 'UPSTREAM_UNAVAILABLE', /稍后重试/],
  [301, 'UPSTREAM_REJECTED', /权限/], [418, 'UPSTREAM_REJECTED', /权限/],
]) {
  test(`AnySearch HTTP ${status} gives actionable ${code} without retry, fallback or body disclosure`, async () => {
    const harness = createHarness({ kv: { byoDefaultProvider: 'anysearch' }, networkResult: () => ({ ok: true, status, body: 'upstream-private-detail' }) });
    const result = await harness.search({ provider: 'anysearch' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, code);
    assert.match(result.message, guidance);
    assert.doesNotMatch(result.message, /upstream-private-detail|HTTP|\b[345]\d\d\b/);
    assert.equal(harness.networkCalls.length, 1);
    assert.equal(harness.cindyRequests.length, 0);
    assert.equal(harness.toolResults.length, 1);
  });
}

test('AnySearch 402 with auto-generated credentials never leaks them to the user', async () => {
  const harness = createHarness({
    kv: { byoDefaultProvider: 'anysearch' },
    networkResult: () => ({
      ok: true,
      status: 402,
      body: JSON.stringify({
        code: -1,
        message: 'Your account and API key have been automatically generated.\nusername=u123\npassword=p456\napi_key=as_sk_abcdef',
        request_id: 'r1',
      }),
    }),
  });
  const result = await harness.search({ provider: 'anysearch' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'QUOTA_EXHAUSTED');
  assert.doesNotMatch(result.message, /u123|p456|as_sk_abcdef|username|password|api_key/);
  assert.match(result.message, /Key/);
});

test('AnySearch preserves structured Host error codes with safe, actionable messages', async () => {
  for (const [errorCode, guidance] of [
    ['AUTH_REJECTED', /更新 Key/], ['PERMISSION_DENIED', /授权/],
    ['QUOTA_EXHAUSTED', /Key/], ['RATE_LIMITED', /稍后重试/],
    ['INVALID_INPUT', /查询/], ['UPSTREAM_UNAVAILABLE', /网络连接/],
  ]) {
    for (const throws of [false, true]) {
      const harness = createHarness({ kv: { byoDefaultProvider: 'anysearch' }, networkResult: () => {
        if (throws) throw Object.assign(new Error('private-host-detail'), { errorCode });
        return { ok: false, errorCode, message: 'private-host-detail' };
      } });
      const result = await harness.search({ provider: 'anysearch' });
      assert.equal(result.errorCode, errorCode);
      assert.match(result.message, guidance);
      assert.doesNotMatch(result.message, /private-host-detail/);
      assert.equal(harness.networkCalls.length, 1);
      assert.equal(harness.cindyRequests.length, 0);
      assert.equal(harness.toolResults.length, 1);
    }
  }
});

test('AnySearch handles legacy Host failures and exceptions without exposing diagnostics', async () => {
  for (const failure of [null, { ok: false, message: 'private-host-detail' }, new Error('private-host-detail')]) {
    const harness = createHarness({ kv: { byoDefaultProvider: 'anysearch' }, networkResult: () => {
      if (failure instanceof Error) throw failure;
      return failure;
    } });
    const result = await harness.search({ provider: 'anysearch' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'INTERNAL');
    assert.match(result.message, /网络连接/);
    assert.match(result.message, /AnySearch/);
    assert.doesNotMatch(result.message, /private-host-detail/);
    assert.equal(harness.networkCalls.length, 1);
  }
});

test('AnySearch rejects malformed, truncated and non-zero-code responses instead of returning empty success', async () => {
  const bodies = ['invalid-json', 'null', '{}',
    JSON.stringify({ code: 0, data: {} }),
    JSON.stringify({ code: 0, data: { results: {} } }),
    JSON.stringify({ code: -1, message: 'Query is required.', data: { results: [] } }),
    JSON.stringify({ code: 0, data: { results: [null] } }),
    JSON.stringify({ code: 0, data: { results: [{ title: null, url: 'u' }] } }),
    JSON.stringify({ code: 0, data: { results: [{ title: 't', url: 42 }] } }),
    ' '.repeat(1000001), null,
  ];
  for (const response of [
    ...bodies.map(body => ({ ok: true, status: 200, body })),
    { ...anySearchResponse(), truncated: true },
  ]) {
    const harness = createHarness({ kv: { byoDefaultProvider: 'anysearch' }, networkResult: () => response });
    const result = await harness.search({ provider: 'anysearch' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'RESPONSE_INVALID');
    assert.equal(harness.networkCalls.length, 1);
    assert.equal(harness.cindyRequests.length, 0);
  }
});

test('AnySearch credentials are declared only for the API host and have a settings row', () => {
  const secret = manifest.network.secrets.find(item => item.key === 'anysearch_api_key');
  assert.deepEqual(secret.inject, {
    header: 'Authorization', format: 'Bearer {value}', hosts: ['api.anysearch.com'],
  });
  assert.equal(secret.url, 'https://anysearch.com/console/api-keys');
  assert.equal(manifest.network.hosts.includes('api.anysearch.com'), true);
  assert.match(settingsHtml, /data-key="anysearch_api_key"/);
  assert.match(settingsHtml, /href="https:\/\/anysearch\.com\/console\/api-keys"/);
  assert.match(settingsHtml, /<option value="anysearch">AnySearch<\/option>/);
  for (const locale of locales) {
    assert.match(locale.description, /AnySearch/);
    assert.match(locale.whenToUse, /AnySearch/);
  }
});

test('settings load and persist AnySearch as the BYO default without losing other preferences', async () => {
  const original = { cindyAiEnabled: false, byoDefaultProvider: 'anysearch', unrelated: 'keep' };
  const harness = createSettingsHarness({ readKv: async () => ({ ok: true, json: async () => original }) });
  await flushAsync();
  assert.equal(harness.byoDefaultProvider.value, 'anysearch');
  harness.byoDefaultProvider.emit('change');
  await flushAsync();
  const write = harness.fetchCalls.find(call => call.init.method === 'PUT');
  assert.deepEqual(JSON.parse(write.init.body), original);
  assert.match(harness.status.textContent, /已保存/);
});

test('AnySearch anonymous calls fail closed with NOT_CONFIGURED until the user opts in', async () => {
  // No AnySearch preference, no saved key -> no network request at all.
  const neverOptedIn = createHarness({ kv: {}, networkResult: () => anySearchResponse() });
  const blocked = await neverOptedIn.search({ provider: 'anysearch' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorCode, 'NOT_CONFIGURED');
  assert.match(blocked.message, /AnySearch/);
  assert.equal(neverOptedIn.networkCalls.length, 0);
  assert.equal(neverOptedIn.cindyRequests.length, 0);
  assert.equal(neverOptedIn.toolResults.length, 1);

  // Explicit provider still requires the same opt-in.
  const stillBlocked = createHarness({ kv: { cindyAiEnabled: true }, networkResult: () => anySearchResponse() });
  const blockedAgain = await stillBlocked.search({ provider: 'anysearch' });
  assert.equal(blockedAgain.ok, false);
  assert.equal(blockedAgain.errorCode, 'NOT_CONFIGURED');
  assert.equal(stillBlocked.networkCalls.length, 0);

  // Saving an AnySearch API Key opts the user in even without the preference.
  const keyOnly = createHarness({
    kv: {},
    secrets: [{ key: 'anysearch_api_key', saved: true, tail: 'abcd' }],
    networkResult: () => anySearchResponse(),
  });
  const keyResult = await keyOnly.search({ provider: 'anysearch' });
  assert.equal(keyResult.ok, true);
  assert.equal(keyResult.result.provider, 'anysearch');
  assert.equal(keyOnly.networkCalls.length, 1);

  // An unrelated saved key does not opt in.
  const unrelatedKey = createHarness({
    kv: {},
    secrets: [{ key: 'tavily_api_key', saved: true }],
    networkResult: () => anySearchResponse(),
  });
  const unrelatedResult = await unrelatedKey.search({ provider: 'anysearch' });
  assert.equal(unrelatedResult.ok, false);
  assert.equal(unrelatedResult.errorCode, 'NOT_CONFIGURED');
  assert.equal(unrelatedKey.networkCalls.length, 0);

  // Preference read failures fail closed.
  const unreadable = createHarness({ kvFetch: async () => { throw new Error('kv unavailable'); } });
  const unreadableResult = await unreadable.search({ provider: 'anysearch' });
  assert.equal(unreadableResult.ok, false);
  assert.equal(unreadableResult.errorCode, 'NOT_CONFIGURED');
  assert.equal(unreadable.networkCalls.length, 0);
});
