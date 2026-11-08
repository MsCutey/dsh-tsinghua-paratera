import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listKeys, createKey, renameKey, deleteKey, refreshSupportedModels } from '../lib/keys.mjs';
import { CONSOLE_SESSION_FILE } from '../lib/console.mjs';

afterEach(() => mock.restoreAll());
const row = (uuid, name = uuid) => ({ tokenUuid: uuid, tokenName: name, tokenStatus: 'valid', secretKey: 'sk-****', modelScale: ['mock-model'] });

test('listKeys aggregates every page and preserves normalized UUID metadata', async () => {
  const calls = [];
  const result = await listKeys({
    pageSize: 2,
    request: async (url, options) => {
      calls.push([url, options]);
      return { ok: true, data: { total: '3', rows: options.body.pageNum === 1 ? [row('id1'), row('id2')] : [row('id3', 'selected')] } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.total, 3);
  assert.deepEqual(result.keys.map((key) => key.uuid), ['id1', 'id2', 'id3']);
  assert.equal(result.keys[2].name, 'selected');
  assert.equal(result.keys[0].masked, '****');
  assert.deepEqual(result.keys[0].models, ['mock-model']);
  assert.deepEqual(calls.map(([, options]) => options.body.pageNum), [1, 2]);
  assert.ok(calls.every(([url, options]) => url === '/lms/api/key/llmSk' && options.method === 'POST'));
});

test('list response never forwards upstream plaintext or partially-masked secretKey fields', async () => {
  const secrets = ['sk-TEST_UPSTREAM_PLAINTEXT_0123456789', 'sk-****TEST_SENSITIVE_SUFFIX', 'tiny'];
  const result = await listKeys({ request: async () => ({ ok: true, data: { rows: secrets.map((secretKey, index) => ({ ...row(String(index)), secretKey })) } }) });
  assert.equal(result.ok, true);
  for (const value of secrets) assert.equal(JSON.stringify(result).includes(value), false);
  assert.deepEqual(result.keys.map((item) => item.masked), ['****', '****', '****']);
});

test('unknown total supports full pages followed by short/empty final page', async () => {
  const result = await listKeys({ pageSize: 1, request: async (_, { body }) => ({ ok: true, data: { rows: body.pageNum === 1 ? [row('id1')] : [] } }) });
  assert.equal(result.total, 1);
  assert.equal(result.keys[0].uuid, 'id1');
});

test('malformed API list payloads are errors rather than empty successful lists', async () => {
  for (const data of [null, {}, { rows: {} }, { rows: [null] }, { rows: [row('')] }, { rows: [row(' ')] }, { rows: [row('id', ' ')] }, { rows: [42] }, { rows: [row('id')], total: 'bad' }, { rows: [row('id')], total: true }, { rows: [row('id')], total: [] }, { rows: [row('id')], total: 0 }]) {
    assert.deepEqual(await listKeys({ request: async () => ({ ok: true, data }) }), { ok: false, error: 'keys-invalid-response' });
  }
});

test('pagination stalls, bound exhaustion, and intermediate request failures never return partial success', async () => {
  const repeat = await listKeys({ pageSize: 1, request: async () => ({ ok: true, data: { rows: [row('same')], total: 5 } }) });
  assert.deepEqual(repeat, { ok: false, error: 'keys-pagination-stalled' });
  const empty = await listKeys({ request: async () => ({ ok: true, data: { rows: [], total: 5 } }) });
  assert.deepEqual(empty, { ok: false, error: 'keys-pagination-stalled' });
  const limit = await listKeys({ pageSize: 1, maxPages: 1, request: async () => ({ ok: true, data: { rows: [row('id')], total: 5 } }) });
  assert.deepEqual(limit, { ok: false, error: 'keys-pagination-limit' });
  const failed = await listKeys({ pageSize: 1, request: async (_, { body }) => body.pageNum === 1 ? { ok: true, data: { rows: [row('id')], total: 2 } } : { ok: false, error: 'console-timeout' } });
  assert.deepEqual(failed, { ok: false, error: 'console-timeout' });
});

test('key mutation validation prevents requests before any session read', async () => {
  mock.method(fs, 'readFileSync', () => assert.fail('invalid mutation must not read session'));
  for (const operation of [() => createKey(' '), () => createKey(null), () => renameKey('', 'new'), () => renameKey({}, 'new'), () => renameKey('id', ''), () => deleteKey(''), () => deleteKey({})]) {
    assert.equal((await operation()).ok, false);
  }
});

test('key mutations use expected endpoint, body and UUID with mock transport only', async () => {
  mock.method(fs, 'readFileSync', (file) => {
    assert.equal(file, CONSOLE_SESSION_FILE);
    return JSON.stringify({ token: 'TEST_TOKEN_NEVER_REAL' });
  });
  const requests = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([new URL(url).pathname, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify({ code: 200, data: url.endsWith('/llmSk') ? { rows: [], total: 0 } : null }));
  });
  for (const operation of [() => createKey(' test '), () => renameKey('uuid', ' renamed '), () => deleteKey('uuid'), () => refreshSupportedModels()]) {
    assert.deepEqual(await operation(), { ok: true });
  }
  assert.deepEqual(requests, [
    ['/lms/api/key/create', 'POST', { tokenName: 'test', billingType: 'PostPaid' }],
    ['/lms/api/key/update', 'POST', { tokenUuid: 'uuid', tokenName: 'renamed' }],
    ['/lms/api/key/delete', 'DELETE', { tokenUuid: 'uuid' }],
    ['/lms/api/key/llmSk', 'POST', { pageNum: 1, pageSize: 100 }],
    ['/lms/api/key/open', 'POST', { keyModels: 'all' }],
  ]);
});

test('create uncertainty is explicit, redacted and never retried', async () => {
  for (const failure of ['console-timeout', 'console-network-error', 'console-invalid-response', 'console-http-500', 'console-api-error', 'throw', 'malformed']) {
    let count = 0;
    const result = await createKey('test-only-name', { request: async () => {
      count++;
      if (failure === 'throw') throw Error('TEST_SECRET');
      return failure === 'malformed' ? { raw: 'TEST_SECRET' } : { ok: false, error: failure, raw: 'TEST_SECRET' };
    } });
    assert.deepEqual(result, { ok: false, error: 'key-create-unconfirmed' });
    assert.equal(count, 1);
    assert.doesNotMatch(JSON.stringify(result), /TEST_SECRET/);
  }
  for (const error of ['console-session-missing', 'console-session-expired', 'key-quota-exceeded', 'console-http-400']) {
    assert.deepEqual(await createKey('test-only-name', { request: async () => ({ ok: false, error, raw: 'TEST_SECRET' }) }), { ok: false, error });
  }
});

test('opaque base64 token ids from the console are accepted', async () => {
  const uuid = 'AbC+dEf/GhI=';
  const result = await listKeys({ request: async () => ({ ok: true, data: { rows: [row(uuid, 'work-key')], total: 1 } }) });
  assert.equal(result.ok, true);
  assert.equal(result.keys[0].uuid, uuid);
});

test('token ids with unsafe characters are still rejected', async () => {
  for (const uuid of ['a b', 'a<b', 'a\nb', 'a"b', 'sk-live-plaintext', 'x'.repeat(513),
    ...[0, 10, 13, 0x2028, 0x2029].map((code) => 'id' + String.fromCharCode(code))]) {
    const result = await listKeys({ request: async () => ({ ok: true, data: { rows: [row(uuid, 'name')] } }) });
    assert.deepEqual(result, { ok: false, error: 'keys-invalid-response' }, uuid);
  }
});

test('delete preserves opaque IDs in one DELETE JSON request, then verifies the complete list', async () => {
  const uuid = 'AAAA+BBBB/CCCC==';
  const calls = [];
  const result = await deleteKey(uuid, {
    request: async (url, options) => {
      calls.push([url, options]);
      if (options.method === 'DELETE') return { ok: true, raw: { message: 'TEST_SECRET' } };
      const page = options.body.pageNum;
      return { ok: true, data: { total: 101, rows: page === 1
        ? Array.from({ length: 100 }, (_, i) => row(`other-${i}`)) : [row(uuid)] } };
    },
  });
  assert.deepEqual(result, { ok: false, error: 'key-delete-not-deleted' });
  assert.deepEqual(calls[0], ['/lms/api/key/delete', { method: 'DELETE', body: { tokenUuid: uuid } }]);
  assert.deepEqual(calls.slice(1).map(([url, { method, body }]) => [url, method, body.pageNum]), [
    ['/lms/api/key/llmSk', 'POST', 1], ['/lms/api/key/llmSk', 'POST', 2],
  ]);
  assert.equal(calls.filter(([, options]) => options.method === 'DELETE').length, 1);
  assert.doesNotMatch(JSON.stringify(result), /TEST_SECRET|AAAA/);
});

test('delete acknowledges success only when a complete list confirms absence, including ambiguous failures', async () => {
  const responses = [
    { ok: true },
    { ok: false, error: 'console-http-500' },
    { ok: false, error: 'console-http-502' },
    { ok: false, error: 'console-network-error' },
    { ok: false, error: 'console-timeout' },
    { ok: false, error: 'console-invalid-response' },
    { ok: false, error: 'console-api-error' },
    null,
  ];
  for (const response of responses) {
    let deletes = 0;
    let reads = 0;
    assert.deepEqual(await deleteKey('id', {
      request: async () => { deletes += 1; return response; },
      list: async () => { reads += 1; return { ok: true, keys: [{ uuid: 'another-id' }] }; },
    }), { ok: true });
    assert.equal(deletes, 1);
    assert.equal(reads, 1);
  }
  assert.deepEqual(await deleteKey('id', {
    request: async () => { throw Error('TEST_SECRET'); },
    list: async () => ({ ok: true, keys: [] }),
  }), { ok: true });
});

test('delete uncertainty never triggers another destructive request or leaks upstream data', async () => {
  for (const outcome of [{ ok: true }, { ok: false, error: 'console-http-500' }, { ok: false, error: 'console-timeout' }]) {
    for (const verification of [
      { ok: false, error: 'keys-pagination-stalled', raw: 'TEST_SECRET' },
      { ok: false, error: 'console-session-expired' },
      { ok: true }, { ok: true, keys: null }, { ok: true, keys: [null] },
      { ok: true, keys: [{ uuid: 'sk-TEST_PLAINTEXT' }] },
    ]) {
      let requests = 0;
      const result = await deleteKey('id', {
        request: async () => { requests += 1; return outcome; },
        list: async () => verification,
      });
      assert.deepEqual(result, { ok: false, error: 'key-delete-unconfirmed' });
      assert.equal(requests, 1);
      assert.doesNotMatch(JSON.stringify(result), /TEST_SECRET|TEST_PLAINTEXT/);
    }
  }
  assert.deepEqual(await deleteKey('id', {
    request: async () => { throw Error('TEST_SECRET'); },
    list: async () => { throw Error('TEST_SECRET'); },
  }), { ok: false, error: 'key-delete-unconfirmed' });
});

test('delete verifies list pagination failures instead of treating partial data as absence', async () => {
  const calls = [];
  const result = await deleteKey('target', { request: async (url, { method, body }) => {
    calls.push([url, method]);
    if (method === 'DELETE') return { ok: false, error: 'console-http-500' };
    if (body.pageNum === 1) return { ok: true, data: { total: 101, rows: Array.from({ length: 100 }, (_, i) => row(`other-${i}`)) } };
    return { ok: false, error: 'console-timeout' };
  } });
  assert.deepEqual(result, { ok: false, error: 'key-delete-unconfirmed' });
  assert.deepEqual(calls.map(([, method]) => method), ['DELETE', 'POST', 'POST']);
});

test('real consoleFetch and listKeys reconcile a mock HTTP 500 without trusting or exposing its message', async () => {
  mock.method(fs, 'readFileSync', (file) => {
    assert.equal(file, CONSOLE_SESSION_FILE);
    return JSON.stringify({ token: 'TEST_TOKEN_NEVER_REAL' });
  });
  for (const present of [false, true]) {
    const calls = [];
    mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push([new URL(url).pathname, options.method]);
      if (options.method === 'DELETE') {
        return new Response('{"code":100011,"message":"TEST_SECRET"}', { status: 500 });
      }
      const rows = present ? [row('opaque+id/==')] : [];
      return new Response(JSON.stringify({ code: 200, data: { rows, total: rows.length } }));
    });
    const result = await deleteKey('opaque+id/==');
    assert.deepEqual(result, present ? { ok: false, error: 'key-delete-not-deleted' } : { ok: true });
    assert.deepEqual(calls, [['/lms/api/key/delete', 'DELETE'], ['/lms/api/key/llmSk', 'POST']]);
    assert.doesNotMatch(JSON.stringify(result), /TEST_SECRET|opaque/);
  }
});

test('delete invalid IDs are rejected before session reads, network requests or verification', async () => {
  mock.method(fs, 'readFileSync', () => assert.fail('invalid id must not read session'));
  mock.method(globalThis, 'fetch', () => assert.fail('invalid id must not use network'));
  for (const uuid of ['', ' ', null, {}, ' a', 'a ', 'a\\nb', 'a?b', 'a&b', 'a"b', 'sk-TEST_PLAINTEXT', 'x'.repeat(513),
    ...[0, 10, 13, 0x2028, 0x2029].map((code) => 'id' + String.fromCharCode(code))]) {
    assert.deepEqual(await deleteKey(uuid, { list: () => assert.fail('invalid id must not verify') }), { ok: false, error: 'invalid-arguments' });
  }
});

test('delete preserves clear preflight/authentication/4xx failures without verification or retries', async () => {
  for (const error of ['invalid-console-path', 'console-session-missing', 'console-session-expired', 'console-http-400', 'console-http-404', 'console-http-429']) {
    let requests = 0;
    assert.deepEqual(await deleteKey('id', {
      request: async () => { requests += 1; return { ok: false, error, raw: 'TEST_SECRET' }; },
      list: () => assert.fail('clear rejection must not trigger list'),
    }), { ok: false, error });
    assert.equal(requests, 1);
  }
});
