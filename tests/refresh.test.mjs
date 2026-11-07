import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { refreshSession, refreshWithBrowser, SESSION_FILE, STATE_FILE } from '../lib/refresh.mjs';

const reply = (value) => ({ result: { result: { value: JSON.stringify(value) } } });
const exp = Date.now() + 6 * 3600 * 1000;
const token = `test.${Buffer.from(JSON.stringify({ exp: exp / 1000 })).toString('base64url')}.fake`;

afterEach(() => mock.restoreAll());

// Every filesystem operation is in memory: never touch real sessions/passwords.
function browserFixture({ captureError = false } = {}) {
  const files = new Map();
  const events = [];
  let closed = false;
  mock.method(fs, 'mkdirSync', () => {});
  mock.method(fs, 'readFileSync', (file) => {
    if (file !== STATE_FILE) throw Error('ISOLATION: unexpected read');
    return files.get(file) || '{}';
  });
  mock.method(fs, 'writeFileSync', (file, value) => files.set(file, value));
  mock.method(fs, 'chmodSync', () => {});
  mock.method(fs, 'renameSync', (from, to) => {
    files.set(to, files.get(from));
    files.delete(from);
  });
  mock.method(fs, 'rmSync', (file) => files.delete(file));
  const opened = {
    socket: { close() { closed = true; events.push('close'); } },
    async send(method, params) {
      if (method === 'Page.enable') return {};
      if (!params.awaitPromise) {
        return reply({ href: 'https://easycompute.cs.tsinghua.edu.cn/home', hasToken: true, tokenExp: exp });
      }
      events.push('capture-start');
      // A real Runtime.evaluate waits for the page's HTTP request. Closing CDP
      // during that wait loses its result, exactly like the socket sentinel.
      await new Promise((resolve) => setImmediate(resolve));
      if (captureError) throw Error('test-only capture failure');
      if (closed) return { __cdpClosed: true };
      events.push('capture-done');
      return reply({ token, status: 200, couponFree: 123.45, couponUsed: 6.55, couponTotal: 130 });
    },
  };
  return { files, events, dependencies: { open: async () => opened, pause: async () => {} } };
}

test('refresh keeps CDP open until asynchronous capture and persistence finish', async () => {
  const { files, events, dependencies } = browserFixture();
  const result = await refreshWithBrowser(true, dependencies);
  assert.equal(result.ok, true);
  assert.deepEqual(events, ['capture-start', 'capture-done', 'close']);
  assert.equal(JSON.parse(files.get(SESSION_FILE)).token, token);
  assert.equal(JSON.parse(files.get(STATE_FILE)).snapshot.couponFree, 123.45);
});

function noLoginFixture() {
  const effects = [];
  mock.method(fs, 'readFileSync', () => { throw Error('ISOLATION: no stored session'); });
  mock.method(fs, 'existsSync', () => false); // No credential script or Chrome: never spawn.
  mock.method(fs, 'statSync', () => { throw Object.assign(Error('ISOLATION: no credentials'), { code: 'ENOENT' }); });
  mock.method(fs, 'mkdirSync', () => effects.push('lock-directory'));
  mock.method(fs, 'openSync', () => 99999);
  mock.method(fs, 'writeFileSync', () => {});
  mock.method(fs, 'closeSync', () => {});
  mock.method(fs, 'unlinkSync', () => effects.push('release'));
  mock.method(fs, 'chmodSync', () => {});
  mock.method(fs, 'renameSync', () => {});
  mock.method(fs, 'rmSync', () => {});
  return effects;
}

test('background renewal without a session or credentials never starts a browser', async () => {
  const effects = noLoginFixture();
  assert.deepEqual(await refreshSession(), { ok: false, error: 'credentials-missing' });
  assert.deepEqual(effects, []);
});

test('explicit refresh can collect a manual login without saved credentials', async () => {
  const effects = noLoginFixture();
  // Reach browser discovery instead of rejecting the password-free login path.
  assert.deepEqual(await refreshSession({ force: true }), { ok: false, error: 'chrome-not-found' });
  assert.ok(effects.includes('release'));
});

test('capture rejection is handled by refresh and the browser is still closed', async () => {
  const { files, events, dependencies } = browserFixture({ captureError: true });
  const result = await refreshWithBrowser(true, dependencies);
  assert.deepEqual(result, { ok: false, error: 'refresh-failed' });
  assert.deepEqual(events, ['capture-start', 'close']);
  assert.equal(files.has(SESSION_FILE), false);
  assert.equal(JSON.parse(files.get(STATE_FILE)).lastError, 'refresh-failed');
});
