import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listKeys, createKey, renameKey, setKeyStatus, deleteKey, refreshSupportedModels } from '../lib/keys.mjs';
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
  for (const operation of [() => createKey(' '), () => createKey(null), () => renameKey('', 'new'), () => renameKey({}, 'new'), () => renameKey('id', ''), () => setKeyStatus('id', 'deleted'), () => setKeyStatus({}, 'valid'), () => deleteKey(''), () => deleteKey({})]) {
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
    return new Response('{"code":200,"data":null}');
  });
  for (const operation of [() => createKey(' test '), () => renameKey('uuid', ' renamed '), () => setKeyStatus('uuid', 'invalid'), () => deleteKey('uuid'), () => refreshSupportedModels()]) {
    assert.deepEqual(await operation(), { ok: true });
  }
  assert.deepEqual(requests, [
    ['/lms/api/key/create', 'POST', { tokenName: 'test', billingType: 'PostPaid' }],
    ['/lms/api/key/update', 'POST', { tokenUuid: 'uuid', tokenName: 'renamed' }],
    ['/lms/api/key/update', 'POST', { tokenUuid: 'uuid', tokenStatus: 'invalid' }],
    ['/lms/api/key/delete', 'DELETE', { tokenUuid: 'uuid' }],
    ['/lms/api/key/open', 'POST', { keyModels: 'all' }],
  ]);
});

test('opaque base64 token ids from the console are accepted', async () => {
  const uuid = 'AbC+dEf/GhI=';
  const result = await listKeys({ request: async () => ({ ok: true, data: { rows: [row(uuid, 'work-key')], total: 1 } }) });
  assert.equal(result.ok, true);
  assert.equal(result.keys[0].uuid, uuid);
});

test('token ids with unsafe characters are still rejected', async () => {
  for (const uuid of ['a b', 'a<b', 'a\nb', 'a"b', 'sk-live-plaintext', 'x'.repeat(513)]) {
    const result = await listKeys({ request: async () => ({ ok: true, data: { rows: [row(uuid, 'name')] } }) });
    assert.deepEqual(result, { ok: false, error: 'keys-invalid-response' }, uuid);
  }
});

test('a console 500 on delete is reported as a platform rejection', async () => {
  mock.method(fs, 'readFileSync', () => JSON.stringify({ token: 'TEST_TOKEN_NEVER_REAL' }));
  mock.method(globalThis, 'fetch', async () => new Response('{"code":100011,"message":"解析数据失败"}', { status: 500 }));
  const result = await deleteKey('AAAA+BBBB/CCCC==');
  assert.deepEqual(result, { ok: false, error: 'key-delete-rejected' });
});
