// Deprecated eye/one-shot routes must never reveal, create, or parse a body.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPlugin } from '../lib/index.js';
import { importKey } from '../lib/import.mjs';

const BASE = '/tsinghua-paratera/api/';
afterEach(() => mock.restoreAll());
function fixture(rejection = null) {
  const routes = new Map(), effects = [];
  mock.method(globalThis, 'fetch', () => assert.fail('deprecated route accessed network'));
  mock.method(fs, 'readFileSync', () => assert.fail('deprecated route read real state'));
  mock.method(globalThis, 'setInterval', () => ({ unref() {} }));
  mock.method(globalThis, 'clearInterval', () => {});
  createPlugin().apply({ inject(_names, cb) { cb({
    connection: { requestRejection: () => rejection },
    credentials: { resolve() { assert.fail('deprecated route read credentials'); }, set() { assert.fail('deprecated route wrote credentials'); } },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    effect(fn) { effects.push(fn()); },
  }); } });
  return {
    async request(path, method = 'POST') {
      const response = {};
      await routes.get(BASE + path)({ method, on() { assert.fail('deprecated route parsed body'); } }, {
        writeHead(status, headers) { response.status = status; response.headers = headers; }, end(value) { response.body = JSON.parse(value); },
      });
      return response;
    },
    dispose() { for (const dispose of effects) dispose(); },
  };
}

test('old import and one-shot creation return 410 without browser reveal/create or JSON parsing', async () => {
  const f = fixture();
  try {
    for (const path of ['keys/import', 'keys/create-import']) {
      const result = await f.request(path); assert.equal(result.status, 410); assert.equal(result.headers['Cache-Control'], 'no-store');
      assert.deepEqual(result.body, { ok: false, error: 'key-import-deprecated' });
      assert.equal((await f.request(path, 'GET')).status, 405);
    }
    assert.deepEqual((await f.request('keys/import/status', 'GET')).body, { ok: true, session: null });
  } finally { f.dispose(); }
});

for (const rejection of [401, 403]) test(`legacy routes still enforce authentication ${rejection} before deprecation`, async () => {
  const f = fixture(rejection);
  try {
    for (const path of ['keys/import', 'keys/create-import', 'keys/import/status']) assert.equal((await f.request(path)).status, rejection);
  } finally { f.dispose(); }
});

test('pure legacy import without an explicit offline reveal dependency is disabled', async () => {
  assert.deepEqual(await importKey({ uuid: 'fake-id' }), { ok: false, error: 'key-import-deprecated' });
});
