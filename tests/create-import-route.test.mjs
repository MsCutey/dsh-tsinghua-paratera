// Host route for "create a per-device key and import it". The one-time
// plaintext must never cross the host boundary, even as an injected result.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import { createPlugin } from '../lib/index.js';

const ROUTE = '/tsinghua-paratera/api/keys/create-import';
const DEFAULTS = '/tsinghua-paratera/api/keys/defaults';
const SECRET = 'sk-test-only-route-secret-0123456789';
afterEach(() => mock.restoreAll());

function fixture(runNewKeyImport, { rejection = null } = {}) {
  const routes = new Map(), effects = [];
  mock.method(globalThis, 'fetch', () => { throw Error('ISOLATION: unexpected network'); });
  mock.method(fs, 'readFileSync', () => { throw Error('ISOLATION: unexpected real file read'); });
  const ctx = {
    credentials: { async resolve() { return null; }, async set() {} },
    connection: { requestRejection: () => rejection },
    webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path); } },
    inject(names, callback) {
      if (names[0] === 'llm') callback({ llm: {}, effect(fn) { effects.push(fn()); } });
      else callback({ settings: {}, effect(fn) { effects.push(fn()); } });
    },
    effect(fn) { effects.push(fn()); },
  };
  createPlugin({ runNewKeyImport }).apply({ inject(names, callback) {
    assert.deepEqual(names, ['webServer', 'credentials', 'connection']); callback(ctx);
  } });
  return {
    async request(body, { method = 'POST', raw, route = ROUTE } = {}) {
      const req = Readable.from([Buffer.from(raw ?? (body === undefined ? '' : JSON.stringify(body)))]);
      req.method = method; req.url = route;
      const response = { status: 0, headers: {}, body: null };
      const res = { writeHead(status, headers) { response.status = status; response.headers = headers; }, end(text) { response.body = JSON.parse(text); } };
      await routes.get(route)(req, res);
      return response;
    },
    dispose() { for (const dispose of effects) dispose(); },
  };
}

test('create-import requires authorization and POST before touching the console', async () => {
  let calls = 0;
  const run = async () => { calls++; return { ok: true }; };
  const anonymous = fixture(run, { rejection: 401 });
  assert.equal((await anonymous.request({ name: 'x' })).status, 401);
  anonymous.dispose();
  const crossOrigin = fixture(run, { rejection: 403 });
  assert.equal((await crossOrigin.request({ name: 'x' })).status, 403);
  crossOrigin.dispose();
  const authorized = fixture(run);
  assert.equal((await authorized.request({}, { method: 'GET' })).status, 405);
  assert.equal(calls, 0);
  authorized.dispose();
});

test('create-import defaults the name to this device and never returns the plaintext', async () => {
  const seen = [];
  const f = fixture(async (body) => {
    seen.push(body);
    return { ok: true, name: body.name, secret: SECRET, createdKeyName: body.name, credentialImported: true, fingerprint: 'sha256:0123456789ab', modelsAdded: ['model-a'], modelsSkipped: [] };
  });
  const response = await f.request({ autoModels: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, os.hostname());
  assert.equal(response.body.ok, true);
  assert.equal(response.body.createdKeyName, os.hostname());
  assert.equal(response.body.credentialImported, true);
  assert.deepEqual(response.body.modelsAdded, ['model-a']);
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes(SECRET), false);
  assert.doesNotMatch(serialized, /secret|sk-test/);
  f.dispose();
});

test('create-import honors an explicit name and rejects malformed bodies without creating', async () => {
  const seen = [];
  const f = fixture(async (body) => { seen.push(body); return { ok: true, name: body.name }; });
  assert.equal((await f.request({ name: 'DESKTOP-A', autoModels: true })).status, 200);
  assert.equal(seen[0].name, 'DESKTOP-A');
  for (const raw of ['{', 'null', '42', '[]']) {
    const response = await f.request(null, { raw });
    if (raw === 'null' || raw === '42' || raw === '[]') assert.equal(response.status, 400);
    else assert.equal(response.status, 400);
  }
  assert.equal(seen.length, 1);
  f.dispose();
});

test('create-import failures keep only bounded error codes and the cleanup name', async () => {
  const f = fixture(async () => ({ ok: false, error: 'key-create-secret-missing', createdKeyName: 'DESKTOP-A', secret: SECRET, raw: 'upstream text' }));
  const response = await f.request({ name: 'DESKTOP-A' });
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, 'key-create-secret-missing');
  assert.equal(response.body.createdKeyName, 'DESKTOP-A');
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes('upstream text'), false);
  f.dispose();
});

test('create-import refuses a second concurrent run instead of creating two keys', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(async () => { await gate; return { ok: true }; });
  const first = f.request({ name: 'DESKTOP-A' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await f.request({ name: 'DESKTOP-B' });
  assert.equal(second.status, 200);
  assert.equal(second.body.ok, false);
  assert.equal(second.body.error, 'key-import-busy');
  release();
  const done = await first;
  assert.equal(done.body.ok, true);
  f.dispose();
});

test('defaults exposes this device name for the editable form', async () => {
  const f = fixture(async () => ({ ok: true }));
  const response = await f.request(undefined, { method: 'GET', route: DEFAULTS });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.name, os.hostname());
  assert.equal((await f.request(undefined, { method: 'POST', route: DEFAULTS })).status, 405);
  f.dispose();
});
