import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { openPage } from '../lib/refresh.mjs';
import {
  CONSOLE_ORIGIN, CONSOLE_SESSION_FILE, readConsoleSession, consoleSessionFresh,
  ensureConsoleSession, authenticateConsolePage, consoleEvaluate, consoleFetch,
} from '../lib/console.mjs';

afterEach(() => mock.restoreAll());
const reply = (value) => ({ result: { result: { value } } });
const fakeToken = (exp = Date.now() + 3600000) => `test.${Buffer.from(JSON.stringify({ exp: exp / 1000 })).toString('base64url')}.fake`;
const session = { token: 'TEST_TOKEN_NEVER_REAL', exp: Date.now() + 3600000 };

test('console session path respects isolated DSH_HOME without reading any session', async () => {
  const original = process.env.DSH_HOME;
  const isolated = path.resolve('TEST_DSH_HOME_NO_DIRECTORY_CREATED');
  process.env.DSH_HOME = isolated;
  try {
    const module = await import('../lib/console.mjs?isolated-home-test');
    assert.equal(module.CONSOLE_SESSION_FILE, path.join(isolated, 'paratera-console-session.json'));
  } finally {
    if (original === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = original;
  }
});

// The default session reader is tested only against an in-memory fs stub.
test('console session parsing and freshness reject invalid caches', () => {
  mock.method(fs, 'readFileSync', (file) => { assert.equal(file, CONSOLE_SESSION_FILE); return '{broken'; });
  assert.equal(readConsoleSession(), null);
  fs.readFileSync.mock.mockImplementation(() => JSON.stringify({ token: '' }));
  assert.equal(readConsoleSession(), null);
  fs.readFileSync.mock.mockImplementation(() => JSON.stringify(session));
  assert.deepEqual(readConsoleSession(), session);
  assert.equal(consoleSessionFresh(session), true);
  assert.equal(consoleSessionFresh({ exp: Infinity }), false);
  assert.equal(consoleSessionFresh({ exp: String(session.exp) }), false);
  assert.equal(consoleSessionFresh({ exp: Date.now() }), false);
});

function lifecycle(overrides = {}) {
  const events = [];
  const deps = {
    read: () => null, pending: () => ({ pending: false }),
    acquire: () => { events.push('lock'); return () => events.push('release'); },
    open: async () => { events.push('open'); return { send() {} }; },
    close: async () => events.push('close'),
    authenticate: async () => { events.push('authenticate'); return { ok: true, exp: 123 }; },
    ...overrides,
  };
  return { deps, events };
}

test('fresh cached session does not lock or open a browser', async () => {
  const { deps, events } = lifecycle({ read: () => session });
  assert.deepEqual(await ensureConsoleSession(deps), { ok: true, exp: session.exp, reused: true });
  assert.deepEqual(events, []);
});

test('console authentication is serialized and closes before releasing the lock', async () => {
  const { deps, events } = lifecycle();
  assert.deepEqual(await ensureConsoleSession(deps), { ok: true, exp: 123, reused: false });
  assert.deepEqual(events, ['lock', 'open', 'authenticate', 'close', 'release']);
});

test('busy or parked second-factor browser is never driven', async () => {
  const busy = lifecycle({ acquire: () => null });
  assert.deepEqual(await ensureConsoleSession(busy.deps), { ok: false, error: 'refresh-busy' });
  assert.deepEqual(busy.events, []);
  const parked = lifecycle({ pending: () => ({ pending: true }) });
  assert.deepEqual(await ensureConsoleSession(parked.deps), { ok: false, error: 'second-factor-pending' });
  assert.deepEqual(parked.events, []);
});

test('open/authentication failures release lock; cleanup errors do not override results', async () => {
  const failed = lifecycle({ open: async () => ({ error: 'chrome-profile-in-use' }) });
  assert.deepEqual(await ensureConsoleSession(failed.deps), { ok: false, error: 'chrome-profile-in-use' });
  assert.deepEqual(failed.events, ['lock', 'release']);
  const disconnected = lifecycle({ authenticate: async () => { throw Error('cdp-closed'); } });
  assert.deepEqual(await ensureConsoleSession(disconnected.deps), { ok: false, error: 'cdp-closed' });
  assert.deepEqual(disconnected.events, ['lock', 'open', 'close', 'release']);
  const cleanup = lifecycle({ close: async () => { throw Error('test cleanup'); } });
  assert.equal((await ensureConsoleSession(cleanup.deps)).ok, true);
  assert.equal(cleanup.events.at(-1), 'release');
});

test('real shared helpers attach to mocked dynamic endpoint, settle disconnected calls and leave attached browser alive', async () => {
  const port = 49991;
  const browserPath = '/devtools/browser/MOCK-BROWSER';
  const pageSocket = `ws://127.0.0.1:${port}/devtools/page/MOCK-PAGE`;
  const events = [];
  const methods = [];
  mock.method(fs, 'mkdirSync', () => {});
  mock.method(fs, 'openSync', (file, mode) => { assert.match(file, /easycompute-refresh\.lock$/); assert.equal(mode, 'wx'); events.push('lock'); return 98765; });
  mock.method(fs, 'writeFileSync', (fd) => assert.equal(fd, 98765));
  mock.method(fs, 'closeSync', () => {});
  mock.method(fs, 'unlinkSync', (file) => { assert.match(file, /easycompute-refresh\.lock$/); events.push('release'); });
  mock.method(fs, 'readFileSync', (file) => { assert.match(file, /DevToolsActivePort$/); return `${port}\n${browserPath}\n`; });
  mock.method(fs, 'rmSync', () => assert.fail('attached browser must not be relaunched'));
  mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(url.startsWith(`http://127.0.0.1:${port}/json/`));
    events.push(new URL(url).pathname);
    return { ok: true, json: async () => url.endsWith('/version')
      ? { webSocketDebuggerUrl: `ws://127.0.0.1:${port}${browserPath}` }
      : [{ type: 'page', url: 'https://easycompute.cs.tsinghua.edu.cn/home', webSocketDebuggerUrl: pageSocket }] };
  });
  mock.method(globalThis, 'WebSocket', function (url) {
    assert.equal(url, pageSocket);
    const socket = {
      send(value) { methods.push(JSON.parse(value).method); queueMicrotask(() => socket.onclose?.()); },
      close() { events.push('socket-close'); socket.onclose?.(); },
    };
    queueMicrotask(() => socket.onopen?.());
    return socket;
  });
  const result = await ensureConsoleSession({
    read: () => null, pending: () => ({ pending: false }),
    open: (options) => openPage({ ...options, chrome: 'MOCK_CHROME_NEVER_SPAWNED' }),
    authenticate: async (send) => { await consoleEvaluate(send, 'MOCK_EXPRESSION_NOT_EXECUTED'); return { ok: true }; },
  });
  assert.deepEqual(result, { ok: false, error: 'cdp-closed' });
  assert.deepEqual(methods, ['Runtime.evaluate']); // Never Browser.close.
  assert.deepEqual(events, ['lock', '/json/version', '/json/list', 'socket-close', 'release']);
});

test('CDP close sentinel and protocol/evaluation errors terminate immediately', async () => {
  for (const value of [{ __cdpClosed: true }, { error: {} }, { result: { exceptionDetails: {} } }]) {
    await assert.rejects(consoleEvaluate(async () => value, 'test'));
  }
  assert.equal(await consoleEvaluate(async () => reply('mock-value'), 'test'), 'mock-value');
});

test('page authentication uses origin-guarded reads, encoded exchange and persists only after token arrival', async () => {
  const commands = [];
  const token = fakeToken();
  let saved;
  const send = async (method, params = {}) => {
    commands.push([method, params]);
    if (method !== 'Runtime.evaluate') return {};
    assert.match(params.expression, /location\.origin ===/);
    return reply(params.expression.includes('accessCode') ? 'TEST CODE&x' : token);
  };
  const result = await authenticateConsolePage(send, { pause: async () => {}, save: async (value) => { saved = value; return { exp: 456 }; } });
  assert.deepEqual(result, { ok: true, exp: 456 });
  assert.equal(saved, token);
  assert.match(commands.find(([, p]) => p.url?.startsWith(CONSOLE_ORIGIN))[1].url, /qh_access_code=TEST%20CODE%26x&target=%2Flms%2Fapi$/);
});

test('stale page token is polled past and missing access code never persists', async () => {
  let reads = 0;
  let saved;
  const current = fakeToken();
  const result = await authenticateConsolePage(async (method, params) => {
    if (method !== 'Runtime.evaluate') return {};
    if (params.expression.includes('accessCode')) return reply('TEST_CODE');
    return reply(++reads === 1 ? fakeToken(Date.now() - 1000) : current);
  }, { pause: async () => {}, save: (value) => { saved = value; return { exp: 1 }; } });
  assert.equal(result.ok, true);
  assert.equal(reads, 2);
  assert.equal(saved, current);
  const missing = await authenticateConsolePage(async () => reply(''), { pause: async () => {}, save: () => assert.fail('must not persist') });
  assert.deepEqual(missing, { ok: false, error: 'easycompute-login-required' });
});

test('page enable/navigation disconnects and navigation failures abort before storage reads', async () => {
  for (const failed of ['Page.enable', 'Page.navigate']) {
    const methods = [];
    await assert.rejects(authenticateConsolePage(async (method) => {
      methods.push(method);
      if (method === failed) return { __cdpClosed: true };
      return {};
    }, { pause: async () => {}, save: () => assert.fail('no persistence') }), /cdp-closed/);
    assert.equal(methods.includes('Runtime.evaluate'), false);
  }
  await assert.rejects(authenticateConsolePage(async (method) => method === 'Page.navigate' ? { result: { errorText: 'net::ERR_TEST' } } : {}, { pause: async () => {} }), /console-navigation-failed/);
});

test('zero-expiry page token is expired, not treated as an opaque token', async () => {
  let reads = 0;
  const current = fakeToken();
  let saved;
  await authenticateConsolePage(async (method, params) => {
    if (method !== 'Runtime.evaluate') return {};
    if (params.expression.includes('accessCode')) return reply('TEST_CODE');
    return reply(++reads === 1 ? fakeToken(0) : current);
  }, { pause: async () => {}, save: (token) => { saved = token; return { exp: 1 }; } });
  assert.equal(reads, 2);
  assert.equal(saved, current);
});

test('origin guarded authentication expressions execute against isolated storage and persist atomically/private', async () => {
  const token = fakeToken();
  const files = new Map();
  const operations = [];
  mock.method(fs, 'mkdirSync', (_, options) => assert.equal(options.mode, 0o700));
  mock.method(fs, 'writeFileSync', (file, value, options) => { assert.equal(options.mode, 0o600); files.set(file, value); operations.push('write'); });
  mock.method(fs, 'chmodSync', (_, mode) => { assert.equal(mode, 0o600); operations.push('chmod'); });
  mock.method(fs, 'renameSync', (from, to) => { assert.equal(to, CONSOLE_SESSION_FILE); files.set(to, files.get(from)); files.delete(from); operations.push('rename'); });
  mock.method(fs, 'rmSync', (file) => { files.delete(file); operations.push('cleanup'); });
  const location = { origin: 'about:blank' };
  const storageReads = [];
  const localStorage = { getItem(name) {
    storageReads.push([location.origin, name]);
    return name === 'accessCode' ? 'TEST_CODE' : token;
  } };
  const result = await authenticateConsolePage(async (method, params) => {
    if (method === 'Page.navigate') location.origin = new URL(params.url).origin;
    if (method === 'Runtime.evaluate') return reply(vm.runInNewContext(params.expression, { location, localStorage }));
    return {};
  }, { pause: async () => {} });
  assert.equal(result.ok, true);
  assert.deepEqual(operations, ['write', 'chmod', 'rename', 'cleanup']);
  assert.deepEqual(storageReads, [['https://easycompute.cs.tsinghua.edu.cn', 'accessCode'], [CONSOLE_ORIGIN, 'PARA_TOKEN']]);
  assert.equal(JSON.parse(files.get(CONSOLE_SESSION_FILE)).token, token);
  assert.equal(files.size, 1);
});

test('console requests sign mock token, bound timeout, and forbid redirect forwarding', async () => {
  const result = await consoleFetch('/lms/api/key/llmSk', {
    read: () => session, method: 'POST', body: { pageNum: 1 },
    fetchImpl: async (url, options) => {
      assert.equal(url, CONSOLE_ORIGIN + '/lms/api/key/llmSk');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.token, session.token);
      assert.equal(options.headers['Ai-Authorization'], 'Bearer ' + crypto.createHash('md5').update(session.token).digest('hex'));
      assert.match(options.headers['Ai-Authorization'], /^Bearer [0-9a-f]{32}$/);
      assert.equal(options.body, '{"pageNum":1}');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(JSON.stringify({ code: '200', data: { rows: [] } }));
    },
  });
  assert.deepEqual(result.data, { rows: [] });
});

test('authentication matches fixed vectors from the official SparkMD5 implementation, not a self-referential hash expectation', async () => {
  const vectors = [
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['FAKE.PUBLIC.RESEARCH.TOKEN', '3568428af04729d163c4c1c87dab3d9a'],
    ['FAKE-中文', '6b9e80b09a1e69f6c286ce4f049a13b4'],
    ['令牌-🔑', '4f8326c0152c4d6220c53270be3a9c7d'],
  ];
  for (const [token, expected] of vectors) {
    for (const [endpoint, method] of [['create', 'POST'], ['delete', 'DELETE']]) {
      const result = await consoleFetch('/lms/api/key/' + endpoint, {
        read: () => ({ token }), method, body: { tokenUuid: 'FAKE+ID/==' },
        fetchImpl: async (_, options) => {
          assert.equal(options.headers.token, token);
          assert.equal(options.headers['Ai-Authorization'], 'Bearer ' + expected);
          return new Response('{"code":200,"data":null}');
        },
      });
      assert.equal(result.ok, true);
    }
  }
  for (const invalid of [null, {}, { token: '' }, { token: 42 }]) {
    assert.deepEqual(await consoleFetch('/lms/api/key/create', { read: () => invalid, fetchImpl: () => assert.fail('missing token must not send empty MD5') }), { ok: false, error: 'console-session-missing' });
  }
});

test('DELETE transport matches the public console JSON contract without query conversion or redirects', async () => {
  const uuid = 'AAAA+BBBB/CCCC==';
  let requests = 0;
  const result = await consoleFetch('/lms/api/key/delete', {
    read: () => session, method: 'DELETE', body: { tokenUuid: uuid },
    fetchImpl: async (url, options) => {
      requests += 1;
      assert.equal(url, CONSOLE_ORIGIN + '/lms/api/key/delete');
      assert.equal(new URL(url).search, '');
      assert.equal(options.method, 'DELETE');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.equal(options.body, JSON.stringify({ tokenUuid: uuid }));
      return new Response('{"code":200,"data":null}');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(requests, 1);
});

test('DELETE transport never retries a rejected or disconnected request or exposes response details', async () => {
  for (const mode of ['server-error', 'network-error', 'timeout', 'invalid-response']) {
    let requests = 0;
    const result = await consoleFetch('/lms/api/key/delete', {
      read: () => session, method: 'DELETE', body: { tokenUuid: 'TEST_OPAQUE_ID' },
      fetchImpl: async () => {
        requests += 1;
        if (mode === 'server-error') return new Response('{"message":"TEST_SECRET"}', { status: 500 });
        if (mode === 'invalid-response') return new Response('TEST_SECRET');
        const error = Error('TEST_SECRET');
        error.name = mode === 'timeout' ? 'TimeoutError' : 'TypeError';
        throw error;
      },
    });
    assert.equal(requests, 1);
    assert.deepEqual(result, { ok: false, error: {
      'server-error': 'console-http-500', 'network-error': 'console-network-error',
      timeout: 'console-timeout', 'invalid-response': 'console-invalid-response',
    }[mode] });
    assert.doesNotMatch(JSON.stringify(result), /TEST_SECRET|TEST_OPAQUE_ID/);
  }
});

test('console path validation rejects non-LMS, cross-origin and normalization tricks before session reads', async () => {
  for (const pathname of ['https://bad.invalid', '//bad.invalid/lms/api/key/create', '/\\bad.invalid', '/lms/\\bad.invalid', '/lms/../../unsafe', '/lms/with\nnewline', '/outside']) {
    assert.deepEqual(await consoleFetch(pathname, { read: () => assert.fail('invalid path must not read') }), { ok: false, error: 'invalid-console-path' });
  }
});

test('create quota failure is identified without returning sensitive upstream text', async () => {
  const result = await consoleFetch('/lms/api/key/create', {
    read: () => session,
    fetchImpl: async () => new Response(JSON.stringify({ code: 500, message: 'API Key数量已达上限 TEST_SENSITIVE_REQUEST' })),
  });
  assert.deepEqual(result, { ok: false, error: 'key-quota-exceeded' });
  assert.doesNotMatch(JSON.stringify(result), /TEST_SENSITIVE_REQUEST/);
});

test('console request failures are structured and never echo upstream secrets', async () => {
  const cases = [
    [new Response('', { status: 401 }), 'console-session-expired'],
    [new Response('', { status: 403 }), 'console-session-expired'],
    [new Response('', { status: 500 }), 'console-http-500'],
    [new Response('<html>test login</html>'), 'console-invalid-response'],
    [new Response('null'), 'console-invalid-response'],
    [new Response('[]'), 'console-invalid-response'],
    [new Response('{"code":"401","message":"TEST_SECRET"}'), 'console-session-expired'],
    [new Response('{"code":500,"message":"TEST_SECRET"}'), 'console-api-error'],
  ];
  for (const [response, error] of cases) assert.deepEqual(await consoleFetch('/lms/mock', { read: () => session, fetchImpl: async () => response }), { ok: false, error });
  for (const [name, expected] of [['TimeoutError', 'console-timeout'], ['TypeError', 'console-network-error']]) {
    assert.deepEqual(await consoleFetch('/lms/mock', { read: () => session, fetchImpl: async () => { const error = Error('TEST_SECRET'); error.name = name; throw error; } }), { ok: false, error: expected });
  }
  assert.deepEqual(await consoleFetch('/lms/mock', { read: () => session, fetchImpl: async () => ({ ok: true, status: 200, text: async () => { const error = Error('TEST_BODY_TIMEOUT'); error.name = 'TimeoutError'; throw error; } }) }), { ok: false, error: 'console-timeout' });
  assert.deepEqual(await consoleFetch('https://bad.invalid', { read: () => assert.fail('invalid path must not read') }), { ok: false, error: 'invalid-console-path' });
  assert.deepEqual(await consoleFetch('/lms/mock', { read: () => null }), { ok: false, error: 'console-session-missing' });
});
