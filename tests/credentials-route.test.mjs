import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import { createPlugin } from '../lib/index.js';

const ROUTE = '/tsinghua-paratera/api/credentials';
const SECRET = 'TEST_ONLY_PASSWORD_TOKEN_DO_NOT_ECHO';
afterEach(() => mock.restoreAll());

// Entirely in-memory host, request, filesystem and removal capability. No DSH,
// credential helper, file deletion, browser or real network is used.
function fixture(removeCredentials, { rejection = null } = {}) {
  const routes = new Map(), effects = [], events = [];
  mock.method(globalThis, 'fetch', () => assert.fail('unexpected real network'));
  mock.method(fs, 'readFileSync', () => assert.fail('unexpected real file read'));
  mock.method(fs, 'unlinkSync', () => assert.fail('unexpected real file deletion'));
  mock.method(fs, 'statSync', () => ({ isFile: () => true, size: 123 }));
  mock.method(globalThis, 'setInterval', () => ({ unref() {} }));
  mock.method(globalThis, 'clearInterval', () => {});
  const ctx = {
    credentials: {},
    connection: { requestRejection(req) { events.push('authorize'); assert.ok(req); return rejection; } },
    webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path); } },
    effect(fn) { effects.push(fn()); },
  };
  createPlugin({ removeCredentials }).apply({ inject(names, callback) {
    assert.deepEqual(names, ['webServer', 'credentials', 'connection']); callback(ctx);
  } });
  return {
    events,
    async request(body, { method = 'DELETE', raw, route = ROUTE, forbidParse = false } = {}) {
      const req = Readable.from([Buffer.from(raw ?? JSON.stringify(body))]);
      req.method = method; req.url = route;
      const originalOn = req.on;
      req.on = function (name, listener) {
        if (['data', 'end', 'error'].includes(name)) {
          events.push('parse');
          if (forbidParse) assert.fail('request body parsed before authorization/method rejection');
        }
        return originalOn.call(this, name, listener);
      };
      const result = { status: null, headers: {}, body: null };
      await routes.get(route)(req, {
        writeHead(status, headers) { result.status = status; result.headers = headers; },
        end(text) { result.body = JSON.parse(text); },
      });
      return result;
    },
    dispose() { for (const dispose of effects) dispose(); },
  };
}

for (const rejection of [401, 403]) {
  test(`credential DELETE rejects ${rejection} before JSON parsing or removal`, async () => {
    const f = fixture(() => assert.fail('unauthorized removal'), { rejection });
    try {
      const result = await f.request(null, { raw: '{invalid', forbidParse: true });
      assert.equal(result.status, rejection);
      assert.equal(result.body.ok, false);
      assert.deepEqual(f.events, ['authorize']);
    } finally { f.dispose(); }
  });
}

test('credential removal requires exact boolean confirmation and valid bounded JSON', async () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; return { ok: true }; });
  try {
    for (const raw of ['{}', 'null', '[]', '42', '{', '{"confirm":false}', '{"confirm":"true"}', '{"confirm":1}',
      JSON.stringify({ confirm: true, padding: 'x'.repeat(66000) })]) {
      const result = await f.request(null, { raw });
      assert.equal(result.status, 400);
      assert.equal(result.body.ok, false);
    }
    assert.equal(calls, 0);
    assert.equal(f.events[0], 'authorize');
  } finally { f.dispose(); }
});

test('credential removal rejects unsupported HTTP methods without parsing or removing', async () => {
  const f = fixture(() => assert.fail('wrong-method removal'));
  try {
    for (const method of ['GET', 'PUT', 'PATCH']) {
      assert.equal((await f.request({}, { method, forbidParse: true })).status, 405);
    }
  } finally { f.dispose(); }
});

test('confirmed credential removal calls only injected removal and projects a non-revocation response', async () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; return { ok: true, password: SECRET, token: SECRET, raw: SECRET }; });
  try {
    const result = await f.request({ confirm: true });
    assert.equal(calls, 1);
    assert.equal(result.status, 200);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.equal(result.body.ok, true);
    assert.deepEqual(Object.keys(result.body).sort(), ['hint', 'ok']);
    assert.match(result.body.hint, /仅删除本机保存的登录密码.*不会退出平台会话或撤销 API 密钥/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  } finally { f.dispose(); }
});

for (const mode of ['returned-error', 'rejected-promise', 'synchronous-throw']) {
  test(`credential removal ${mode} never leaks raw errors or credential data`, async () => {
    const f = fixture(mode === 'synchronous-throw' ? () => { throw Error(SECRET); } : async () => {
      if (mode === 'rejected-promise') throw Error(SECRET);
      return { ok: false, error: SECRET, raw: SECRET, password: SECRET };
    });
    try {
      const result = await f.request({ confirm: true });
      assert.equal(result.body.ok, false);
      assert.ok([200, 500].includes(result.status));
      assert.equal(typeof result.body.error, 'string');
      assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
    } finally { f.dispose(); }
  });
}

test('credential status exposes removal capability only for Windows without reading saved bytes', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const f = fixture(() => assert.fail('status must never remove credentials'));
  try {
    for (const platform of ['win32', 'linux']) {
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
      const result = await f.request({}, { method: 'GET', route: ROUTE + '/status', forbidParse: true });
      assert.equal(result.body.canRemove, platform === 'win32');
      assert.equal(result.body.saved, platform === 'win32');
      assert.doesNotMatch(JSON.stringify(result), /password|TEST_ONLY/);
    }
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    f.dispose();
  }
});
