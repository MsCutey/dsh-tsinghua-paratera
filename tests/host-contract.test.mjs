// Host-contract boundaries: the authentication fence must fail closed, and the
// diagnostics surface must report which contract shape the host actually has.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import { createPlugin } from '../lib/index.js';

afterEach(() => mock.restoreAll());

function fixture(connection) {
  const routes = new Map(), effects = [];
  mock.method(globalThis, 'fetch', () => { throw Error('ISOLATION: unexpected network'); });
  mock.method(fs, 'readFileSync', () => { throw Error('ISOLATION: unexpected real file read'); });
  const ctx = {
    credentials: { async resolve() { return null; }, async set() {} },
    connection,
    webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path); } },
    inject(names, callback) {
      if (names[0] === 'llm') callback({ llm: {}, effect(fn) { effects.push(fn()); } });
      else callback({ settings: {}, effect(fn) { effects.push(fn()); } });
    },
    effect(fn) { effects.push(fn()); },
  };
  createPlugin().apply({ inject(names, callback) {
    assert.deepEqual(names, ['webServer', 'credentials', 'connection']); callback(ctx);
  } });
  return {
    async request(path, method = 'GET') {
      const req = Readable.from([Buffer.from('')]);
      req.method = method; req.url = '/tsinghua-paratera/api/' + path;
      const response = { status: 0, headers: {}, body: null };
      const res = { writeHead(status, headers) { response.status = status; response.headers = headers; }, end(text) { response.body = text ? JSON.parse(text) : null; } };
      await routes.get('/tsinghua-paratera/api/' + path)(req, res);
      return response;
    },
    dispose() { for (const dispose of effects) dispose(); },
  };
}

test('the auth fence fails closed when the host exposes neither method', async () => {
  const f = fixture({});
  for (const path of ['status', 'keys', 'diagnostics']) {
    assert.equal((await f.request(path)).status, 503, path);
  }
  f.dispose();
});

test('a thrown fence or malformed admission is a server failure, never an open route', async () => {
  for (const connection of [
    { admit() { throw Error('boom'); } },
    { admit() { return null; } },
    { admit() { return 'peer'; } },
    { requestRejection() { throw Error('boom'); } },
  ]) {
    const f = fixture(connection);
    assert.equal((await f.request('status')).status, 503);
    f.dispose();
  }
});

test('admit() is preferred and its rejection status is preserved', async () => {
  const seen = [];
  const f = fixture({
    admit(req) { seen.push(req.url); return { rejection: 401 }; },
    requestRejection() { throw Error('must not be called when admit exists'); },
  });
  assert.equal((await f.request('keys')).status, 401);
  assert.equal(seen.length, 1);
  f.dispose();
});

test('an admitted peer passes, and the undocumented wrapper still works as a fallback', async () => {
  const admitted = fixture({ admit() { return { peer: { id: 'fake' } }; } });
  assert.equal((await admitted.request('diagnostics')).status, 200);
  admitted.dispose();
  const legacy = fixture({ requestRejection() { return null; } });
  assert.equal((await legacy.request('diagnostics')).status, 200);
  legacy.dispose();
  const legacyDenied = fixture({ requestRejection() { return 403; } });
  assert.equal((await legacyDenied.request('diagnostics')).status, 403);
  legacyDenied.dispose();
});

test('diagnostics reports the contract shape so an upgrade regression is visible', async () => {
  const f = fixture({ admit() { return { peer: {} }; } });
  const body = (await f.request('diagnostics')).body;
  assert.equal(body.contract.authFence, 'admit');
  assert.equal(body.contract.credentials, true);
  assert.equal(body.contract.settings, false, 'empty settings mock has no describe/update');
  assert.equal(body.contract.llmDirectory, false, 'empty llm mock has no directory methods');
  f.dispose();
  const legacy = fixture({ requestRejection() { return null; } });
  assert.equal((await legacy.request('diagnostics')).body.contract.authFence, 'requestRejection');
  legacy.dispose();
});
