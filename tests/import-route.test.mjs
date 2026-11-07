import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import { createPlugin } from '../lib/index.js';
import { importKey } from '../lib/import.mjs';

const ROUTE = '/tsinghua-paratera/api/keys/import';
const SECRET = 'sk-test-only-route-secret-0123456789';
const PREVIOUS = 'sk-test-only-route-previous-9876543210';
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
afterEach(() => mock.restoreAll());

function fixture(runKeyImport, { rejection = null, settings = {}, llm = {} } = {}) {
  const routes = new Map(), effects = [], settingDisposers = [], credentialWrites = [];
  mock.method(globalThis, 'fetch', () => { throw Error('ISOLATION: unexpected network'); });
  mock.method(fs, 'readFileSync', () => { throw Error('ISOLATION: unexpected real file read'); });
  const credentials = {
    async resolve() { return { value: PREVIOUS }; },
    async set(ref, value) { credentialWrites.push({ ref, value }); },
  };
  const settingsChild = { settings, effect(fn) { settingDisposers.push(fn()); } };
  const ctx = {
    credentials,
    connection: { requestRejection: () => rejection },
    webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path); } },
    inject(names, callback) {
      if (names[0] === 'llm') callback({ llm, effect(fn) { effects.push(fn()); } });
      else { assert.deepEqual(names, ['settings']); callback(settingsChild); }
    },
    effect(fn) { effects.push(fn()); },
  };
  createPlugin({ runKeyImport }).apply({ inject(names, callback) {
    assert.deepEqual(names, ['webServer', 'credentials', 'connection']); callback(ctx);
  } });
  return {
    credentials, settings, credentialWrites,
    disconnectSettings() { for (const dispose of settingDisposers.splice(0)) dispose(); },
    async request(body, { method = 'POST', raw, route = ROUTE } = {}) {
      const req = Readable.from([Buffer.from(raw ?? JSON.stringify(body))]);
      req.method = method; req.url = route;
      const response = { status: 0, headers: {}, body: null };
      const res = { writeHead(status, headers) { response.status = status; response.headers = headers; }, end(text) { response.body = JSON.parse(text); } };
      await routes.get(route)(req, res);
      return response;
    },
    dispose() { for (const dispose of [...effects, ...settingDisposers]) dispose(); },
  };
}

test('import route denies unauthorized and wrong-method requests before parsing/import', async () => {
  let calls = 0;
  const run = async () => { calls++; throw Error('must not run'); };
  const anonymous = fixture(run, { rejection: 401 });
  assert.equal((await anonymous.request({ uuid: 'uuid-1' })).status, 401);
  anonymous.dispose();
  const crossOrigin = fixture(run, { rejection: 403 });
  assert.equal((await crossOrigin.request({ uuid: 'uuid-1' })).status, 403);
  crossOrigin.dispose();
  const authorized = fixture(run);
  assert.equal((await authorized.request({}, { method: 'GET' })).status, 405);
  assert.equal(calls, 0);
  authorized.dispose();
});

test('import route rejects malformed JSON, primitives and oversized bodies', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { ok: true }; });
  for (const raw of ['{', 'null', '42', '[]', JSON.stringify({ name: 'x'.repeat(66000) })]) {
    const result = await f.request(null, { raw });
    assert.equal(result.status, 400);
    assert.equal(result.body.ok, false);
  }
  assert.equal(calls, 0);
  f.dispose();
});

test('host passes the injected credential/settings services and never caches import replies', async () => {
  let dependency;
  const f = fixture(async (body, services) => { dependency = services; return { ok: true, uuid: body.uuid, credentialImported: true }; });
  const result = await f.request({ uuid: 'uuid-1' });
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(dependency.credentials, f.credentials);
  assert.equal(dependency.settings, f.settings);
  assert.equal(result.body.credentialImported, true);
  assert.equal(result.body.uuid, undefined);
  f.disconnectSettings();
  await f.request({ uuid: 'uuid-1' });
  assert.equal(dependency.settings, null);
  f.dispose();
});

test('host rejects concurrent imports and releases the guard after failure', async () => {
  const pending = deferred(); let calls = 0;
  const f = fixture(async () => { calls++; if (calls === 1) return pending.promise; return { ok: true }; });
  const first = f.request({ uuid: 'uuid-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.request({ uuid: 'uuid-2' })).body.error, 'key-import-busy');
  pending.resolve({ ok: false, error: 'verify-failed' });
  assert.equal((await first).body.error, 'verify-failed');
  assert.equal((await f.request({ uuid: 'uuid-1' })).body.ok, true);
  assert.equal(calls, 2);
  f.dispose();
});

test('a thrown import clears the busy guard without leaking error details', async () => {
  let calls = 0;
  const f = fixture(async () => { if (++calls === 1) throw Error(SECRET); return { ok: true }; });
  const result = await f.request({ uuid: 'uuid-1' });
  assert.equal(result.status, 500);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.equal((await f.request({ uuid: 'uuid-1' })).body.ok, true);
  f.dispose();
});

test('route to import orchestration writes fake credentials/models and exposes only safe metadata', async () => {
  let patch;
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 9, value: { providers: {} } }],
    async update(ns, value, revision) { assert.equal(ns, 'llm-pi-ai'); assert.equal(revision, 9); patch = value; },
  };
  const run = (body, services) => importKey(body, {
    ...services,
    list: async () => ({ ok: true, keys: [{ uuid: 'uuid-1', name: 'test-key', status: 'valid' }] }),
    reveal: async () => ({ ok: true, secret: SECRET }),
    verify: async () => ({ ok: true, models: 1, modelIds: ['test-model'] }),
  });
  const f = fixture(run, { settings, llm: {
    listProviders: () => patch ? [{ id: 'paratera', name: 'Paratera' }] : [],
    listModels: async () => patch?.providers.paratera.models ?? [],
  } });
  const preview = await f.request({ uuid: 'uuid-1', dryRun: true });
  assert.equal(preview.body.credentialImported, false);
  assert.equal(f.credentialWrites.length, 0);
  const result = await f.request({ uuid: 'uuid-1', models: ['test-model'] });
  assert.equal(result.body.ok, true);
  assert.equal(result.body.credentialImported, true);
  assert.deepEqual(f.credentialWrites.map((entry) => entry.ref), ['PARATERA_API_KEY_BACKUP', 'PARATERA_API_KEY']);
  assert.equal(patch.providers.paratera.models[0].id, 'test-model');
  assert.equal(patch.providers.paratera.apiKeyEnv, 'PARATERA_API_KEY');
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!JSON.stringify(result).includes(PREVIOUS));
  f.dispose();
});

test('authenticated status exposes live stages and a recoverable redacted terminal result', async () => {
  const gate = deferred();
  const f = fixture(async (_body, { onProgress }) => {
    onProgress('revealing');
    await gate.promise;
    onProgress('verifying');
    return { ok: true, credentialImported: true, secret: SECRET, name: SECRET, modelsAdded: ['test-model'], providerRegistered: true, modelsAvailable: true };
  });
  const first = f.request({ uuid: 'uuid-1' });
  await new Promise((resolve) => setImmediate(resolve));
  const active = await f.request({}, { method: 'GET', route: ROUTE + '/status' });
  assert.equal(active.status, 200);
  assert.equal(active.headers['Cache-Control'], 'no-store');
  assert.equal(active.body.running, true);
  assert.equal(active.body.stage, 'revealing');
  assert.ok(active.body.operationId);
  gate.resolve();
  const completed = await first;
  assert.ok(!JSON.stringify(completed).includes(SECRET));
  const status = await f.request({}, { method: 'GET', route: ROUTE + '/status' });
  assert.equal(status.body.operationId, completed.body.operationId);
  assert.equal(status.body.stage, 'completed');
  assert.equal(status.body.result.modelsAddedCount, 1);
  assert.ok(!JSON.stringify(status).includes(SECRET));
  assert.equal((await f.request({}, { method: 'POST', route: ROUTE + '/status' })).status, 405);
  f.dispose();
});

test('import status is protected by the same authorization boundary', async () => {
  for (const rejection of [401, 403]) {
    const f = fixture(async () => ({ ok: true }), { rejection });
    assert.equal((await f.request({}, { method: 'GET', route: ROUTE + '/status' })).status, rejection);
    f.dispose();
  }
});
