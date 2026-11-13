// Authenticated HTTP contracts with fake platform, credentials, Settings and LLM.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import { createPlugin } from '../lib/index.js';

const BASE = '/tsinghua-paratera/api/';
const FLOW = 'keys/create-import/';
const ID = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const SECRET = 'sk-test-only-route-secret-0123456789';
const PREVIOUS = 'sk-test-only-route-previous-9876543210';
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
afterEach(() => mock.restoreAll());

function fixture({ rejection = null, controllerDeps = {}, controllerFactory, settings, llm } = {}) {
  const routes = new Map(), effects = [], settingDisposers = [], events = [];
  const calls = { create: [], writes: [], remove: [], rename: [], toggle: [], refresh: 0 };
  const rows = [{ uuid: 'old-id', name: 'existing', status: 'valid', secret: SECRET, raw: SECRET }];
  const stored = new Map([['PARATERA_API_KEY', PREVIOUS]]);
  let patch;
  mock.method(globalThis, 'fetch', () => assert.fail('unexpected network'));
  mock.method(fs, 'readFileSync', () => assert.fail('unexpected real file read'));
  mock.method(globalThis, 'setInterval', () => ({ unref() {} }));
  mock.method(globalThis, 'clearInterval', () => {});
  const credentials = {
    resolve: async (ref) => stored.has(ref) ? { value: stored.get(ref) } : null,
    async set(ref, value) { calls.writes.push(ref); stored.set(ref, value); },
  };
  settings ??= {
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: {} } }],
    async update(_ns, value) { patch = value; },
  };
  llm ??= { listProviders: () => patch ? [{ id: 'paratera' }] : [], listModels: () => patch?.providers.paratera.models ?? [] };
  const ctx = {
    credentials,
    connection: { requestRejection() { events.push('authorize'); return rejection; } },
    webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path); } },
    inject(names, callback) {
      if (names[0] === 'llm') callback({ llm, effect(fn) { effects.push(fn()); } });
      else callback({ settings, effect(fn) { settingDisposers.push(fn()); } });
    },
    effect(fn) { effects.push(fn()); },
  };
  createPlugin({ controllerFactory, controllerDeps: {
    async create(name) { calls.create.push(name); rows.push({ uuid: 'created-id', name, status: 'valid' }); return { ok: true, secret: SECRET }; },
    async verify() { return { ok: true, modelIds: ['model-a', 'model-b'], models: 2 }; },
    ...controllerDeps,
  }, keyDeps: {
    async list() { return { ok: true, keys: structuredClone(rows), total: rows.length, raw: SECRET }; },
    async remove(uuid) { calls.remove.push(uuid); const index = rows.findIndex((row) => row.uuid === uuid); if (index >= 0) rows.splice(index, 1); return { ok: true, raw: SECRET }; },
    async rename(uuid, name) { calls.rename.push([uuid, name]); return { ok: true, secret: SECRET, raw: SECRET }; },
    async setStatus(uuid, status) { calls.toggle.push([uuid, status]); return { ok: true, token: SECRET }; },
    async refreshModels() { calls.refresh++; return { ok: true, raw: SECRET }; },
  } }).apply({ inject(_names, callback) { callback(ctx); } });
  return {
    calls, stored, rows, routes, events, credentials, settings,
    disconnectSettings() { for (const dispose of settingDisposers.splice(0)) dispose(); },
    async request(action = 'status', body, { method = action === 'status' ? 'GET' : 'POST', raw, path = FLOW + action, forbidParse = false } = {}) {
      const req = Readable.from([Buffer.from(raw ?? (body === undefined ? '' : JSON.stringify(body)))]);
      req.method = method; req.url = BASE + path;
      const originalOn = req.on;
      req.on = function (name, listener) {
        if (['data', 'end', 'error'].includes(name)) { events.push('parse'); if (forbidParse) assert.fail('parsed before rejection'); }
        return originalOn.call(this, name, listener);
      };
      const response = { status: 0, headers: {}, body: null };
      await routes.get(BASE + path)(req, { writeHead(status, headers) { response.status = status; response.headers = headers; }, end(text) { response.body = JSON.parse(text); } });
      assert.equal(JSON.stringify(response).includes(SECRET), false); assert.equal(JSON.stringify(response).includes(PREVIOUS), false);
      return response;
    },
    dispose() { for (const dispose of [...effects, ...settingDisposers]) dispose(); },
  };
}

for (const rejection of [401, 403]) test(`every flow and dangerous key route rejects ${rejection} BEFORE parsing or platform operations`, async () => {
  const f = fixture({ rejection });
  try {
    for (const path of [FLOW + 'status', FLOW + 'prepare', FLOW + 'commit', FLOW + 'cancel', 'keys', 'keys/update', 'keys/delete', 'keys/refresh-models', 'models']) {
      const result = await f.request('', null, { path, raw: '{', forbidParse: true }); assert.equal(result.status, rejection);
    }
    assert.equal(f.events.includes('parse'), false); assert.deepEqual(f.calls.create, []); assert.deepEqual(f.calls.writes, []);
  } finally { f.dispose(); }
});

test('flow methods are checked before parsing; bounded malformed JSON never creates', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('status', {}, { method: 'POST', forbidParse: true })).status, 405);
    for (const action of ['prepare', 'commit', 'cancel']) {
      assert.equal((await f.request(action, {}, { method: 'GET', forbidParse: true })).status, 405);
      for (const raw of ['{', 'null', '42', '[]', JSON.stringify({ padding: 'x'.repeat(66000) })]) assert.equal((await f.request(action, null, { raw })).status, 400);
    }
    assert.deepEqual(f.calls.create, []);
  } finally { f.dispose(); }
});

test('prepare/status restore exact session contract and commit writes only selected offered models', async () => {
  const f = fixture();
  try {
    assert.deepEqual((await f.request()).body, { ok: true, session: null });
    const prepared = await f.request('prepare', { requestId: ID });
    assert.equal(prepared.status, 200); assert.equal(prepared.headers['Cache-Control'], 'no-store');
    assert.equal(prepared.body.ok, true); assert.deepEqual(f.calls.create, [os.hostname()]);
    const session = prepared.body.session;
    assert.deepEqual(Object.keys(session).sort(), ['operationId', 'requestId', 'name', 'stage', 'models', 'selectedModels', 'expiresAt', 'fingerprint', 'canCommit', 'canCancel', 'canRetryVerification', 'cleanupRequired'].sort());
    assert.equal(session.stage, 'awaiting-selection'); assert.equal(session.canCommit, true);
    assert.deepEqual(session.models, ['model-a', 'model-b']); assert.equal(f.calls.writes.length, 0);
    assert.deepEqual((await f.request()).body.session, session);
    assert.deepEqual((await f.request('prepare', { requestId: ID })).body.session, session); assert.equal(f.calls.create.length, 1);
    const invalid = await f.request('commit', { operationId: session.operationId, models: ['unknown'] });
    assert.equal(invalid.body.ok, false); assert.equal(invalid.body.session.canCommit, true);
    const saved = await f.request('commit', { operationId: session.operationId, models: ['model-b'] });
    assert.equal(saved.body.ok, true); assert.equal(saved.body.session.stage, 'completed');
    assert.deepEqual(saved.body.result.modelsAdded, ['model-b']); assert.deepEqual(f.calls.writes, ['PARATERA_API_KEY_BACKUP', 'PARATERA_API_KEY']);
    assert.equal(f.stored.get('PARATERA_API_KEY_BACKUP'), PREVIOUS);
    assert.deepEqual((await f.request('commit', { operationId: session.operationId, models: ['model-b'] })).body, saved.body);
    assert.equal(f.calls.writes.length, 2);
  } finally { f.dispose(); }
});

test('pending flow blocks all dangerous ordinary mutations but allows redacted key list', async () => {
  const f = fixture();
  try {
    await f.request('prepare', { requestId: ID, name: 'explicit-device' });
    assert.equal(f.calls.create[0], 'explicit-device');
    const list = await f.request('', {}, { path: 'keys', method: 'GET' }); assert.equal(list.body.keys.length, 2);
    assert.equal(list.body.keys[0].secret, undefined); assert.equal(list.body.raw, undefined);
    for (const [path, body] of [
      ['keys/update', { uuid: 'old-id', name: 'new' }], ['keys/update', { uuid: 'old-id', status: 'invalid' }],
      ['keys/delete', { uuid: 'old-id' }], ['keys/refresh-models', {}], ['models', { models: [] }],
    ]) assert.equal((await f.request('', body, { path })).body.error, 'key-import-busy');
    assert.equal((await f.request('prepare', { requestId: SECOND })).body.error, 'key-import-busy');
    assert.deepEqual(f.calls.rename, []); assert.deepEqual(f.calls.toggle, []); assert.deepEqual(f.calls.remove, []); assert.equal(f.calls.refresh, 0);
  } finally { f.dispose(); }
});

test('cancel needs explicit confirmation, deletes only created UUID, and permits later ordinary mutations', async () => {
  const f = fixture();
  try {
    const { session } = (await f.request('prepare', { requestId: ID, name: 'existing' })).body;
    assert.equal((await f.request('cancel', { operationId: session.operationId })).body.error, 'delete-confirmation-required');
    const cancelled = await f.request('cancel', { operationId: session.operationId, confirmDelete: true });
    assert.equal(cancelled.body.ok, true); assert.equal(cancelled.body.removed, true); assert.deepEqual(f.calls.remove, ['created-id']);
    assert.equal(f.rows[0].uuid, 'old-id');
    assert.equal((await f.request('', { uuid: 'old-id', name: 'renamed' }, { path: 'keys/update' })).body.ok, true);
    assert.equal((await f.request('', { uuid: 'old-id', status: 'invalid' }, { path: 'keys/update' })).body.ok, true);
    assert.equal((await f.request('', {}, { path: 'keys/refresh-models' })).body.ok, true);
    assert.equal((await f.request('', { uuid: 'old-id' }, { path: 'keys/delete' })).body.ok, true);
    assert.deepEqual(f.calls.rename, [['old-id', 'renamed']]); assert.deepEqual(f.calls.toggle, [['old-id', 'invalid']]);
  } finally { f.dispose(); }
});

test('concurrent prepare sees creating in status; neither same-id nor new-id creates again', async () => {
  const pending = gate(); let creates = 0;
  const f = fixture({ controllerDeps: { create: async () => { creates++; return pending.promise; } } });
  try {
    const first = f.request('prepare', { requestId: ID }); await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await f.request()).body.session.stage, 'creating');
    assert.equal((await f.request('prepare', { requestId: ID })).body.session.stage, 'creating');
    assert.equal((await f.request('prepare', { requestId: SECOND })).body.error, 'key-import-busy');
    pending.resolve({ ok: true, secret: SECRET }); assert.equal((await first).body.ok, true); assert.equal(creates, 1);
  } finally { f.dispose(); }
});

test('late settings service removal yields partial success and forbids cancellation', async () => {
  const f = fixture();
  try {
    const { session } = (await f.request('prepare', { requestId: ID })).body;
    f.disconnectSettings();
    const failed = await f.request('commit', { operationId: session.operationId, models: ['model-a'] });
    assert.equal(failed.body.ok, false); assert.equal(failed.body.result.credentialImported, true);
    assert.equal(failed.body.result.modelError, 'settings-unavailable'); assert.equal(failed.body.session.canCancel, false);
    assert.equal((await f.request('cancel', { operationId: session.operationId, confirmDelete: true })).body.error, 'key-already-imported');
  } finally { f.dispose(); }
});

test('verification failure survives page reload with a safe same-request retry capability', async () => {
  let verifies = 0;
  const f = fixture({ controllerDeps: { verify: async () => ++verifies === 1 ? { ok: false, error: 'verify-failed' } : { ok: true, modelIds: ['model-a'] } } });
  try {
    const failed = await f.request('prepare', { requestId: ID }); assert.equal(failed.body.ok, false);
    const recovered = (await f.request()).body.session;
    assert.equal(recovered.requestId, ID); assert.equal(recovered.canRetryVerification, true);
    const retried = await f.request('prepare', { requestId: recovered.requestId });
    assert.equal(retried.body.ok, true); assert.equal(retried.body.session.canRetryVerification, false);
    assert.equal(f.calls.create.length, 1); assert.equal(verifies, 2);
  } finally { f.dispose(); }
});

test('HTTP boundary projects even injected controller replies and unknown result/error fields', async () => {
  const session = { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: SECRET, stage: 'awaiting-selection',
    models: ['model-a', SECRET], selectedModels: [], expiresAt: 1, fingerprint: 'sha256:0123456789ab', canCommit: true, canCancel: true,
    cleanupRequired: true, secret: SECRET, raw: SECRET, result: { ok: false, secret: SECRET, error: SECRET } };
  const f = fixture({ controllerFactory: () => ({
    status: () => ({ ok: true, session, raw: SECRET }),
    prepare: async () => ({ ok: false, session, error: SECRET, raw: SECRET, result: { ok: false, secret: SECRET, modelsAdded: ['model-a', SECRET] } }),
    dispose() {},
  }) });
  try {
    const status = await f.request(); assert.equal(status.body.session.name, '[redacted]'); assert.deepEqual(status.body.session.models, ['model-a']);
    const result = await f.request('prepare', { requestId: ID }); assert.equal(result.body.error, 'key-import-failed'); assert.deepEqual(result.body.result.modelsAdded, ['model-a']);
    assert.equal(result.body.raw, undefined); assert.equal(result.body.session.secret, undefined);
  } finally { f.dispose(); }
});

test('defaults exposes editable device name and refuses other methods', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('', undefined, { path: 'keys/defaults', method: 'GET' })).body.name, os.hostname());
    assert.equal((await f.request('', undefined, { path: 'keys/defaults' })).status, 405);
  } finally { f.dispose(); }
});
