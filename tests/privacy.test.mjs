import test from 'node:test';
import assert from 'node:assert/strict';
import { publicState, publicSnapshot, publicImportResponse, publicRefreshResult } from '../lib/privacy.mjs';
import { fingerprint } from '../lib/import.mjs';
import { validCdpSocket, credentialsSaved, ensureLoggedIn, holdSecondFactor, submitSecondFactorCode, cancelSecondFactor, confirmTrustDevice } from '../lib/refresh.mjs';
import { trustedEvaluate } from '../lib/browser-security.mjs';
import { parseArgs } from '../scripts/install.mjs';

const SECRET = 'sk-test-only-private-value-00000000';
const SSO = 'https://id.tsinghua.edu.cn';

test('state and browser projections exclude identity, secrets and raw errors', () => {
  const snapshot = { couponFree: 100, couponUsed: 20, uuid: SECRET, clazz: SECRET, department: SECRET, token: SECRET };
  assert.deepEqual(publicSnapshot(snapshot), { couponFree: 100, couponUsed: 20 });
  const state = publicState({ snapshot, token: SECRET, lastError: SECRET, lastLoginResult: { filledUser: true, password: SECRET } });
  assert.equal(state.lastError, 'operation-failed');
  assert.equal(JSON.stringify(state).includes(SECRET), false);
  const response = publicImportResponse({ ok: true, secret: SECRET, name: SECRET, uuid: SECRET, fingerprint: SECRET, modelsAdded: ['test-model', SECRET], unexpected: SECRET });
  assert.deepEqual(response.modelsAdded, ['test-model']);
  assert.equal(JSON.stringify(response).includes(SECRET), false);
  assert.equal(JSON.stringify(publicRefreshResult({ ok: false, error: SECRET, token: SECRET, debug: SECRET })).includes(SECRET), false);
});

test('key fingerprints contain a hash instead of any key prefix or suffix', () => {
  assert.match(fingerprint(SECRET), /^sha256:[a-f0-9]{12}$/);
  assert.equal(fingerprint(SECRET).includes(SECRET.slice(-8)), false);
});

test('CDP sockets cannot leave the discovered loopback port', () => {
  assert.equal(validCdpSocket('ws://127.0.0.1:1234/devtools/page/abc-def', 1234), true);
  for (const value of ['wss://example.invalid/devtools/page/abc', 'ws://127.0.0.1:1235/devtools/page/abc', 'ws://user@127.0.0.1:1234/devtools/page/abc', 'ws://127.0.0.1:1234/devtools/page/abc?token=hidden']) assert.equal(validCdpSocket(value, 1234), false);
});

test('a foreign or navigated frame never receives the secret-bearing expression', async () => {
  for (const foreignFrame of [true, false]) {
    const calls = [];
    const send = async (method, params) => {
      calls.push([method, params]);
      if (method === 'Page.getFrameTree') return { result: { frameTree: { frame: { id: 'frame', url: foreignFrame ? 'https://example.invalid/' : SSO + '/login' } } } };
      if (method === 'Page.createIsolatedWorld') return { result: { executionContextId: 9 } };
      return { result: { result: { value: 'https://example.invalid' } } };
    };
    await assert.rejects(trustedEvaluate(send, SSO, SECRET), /untrusted-login-page/);
    assert.equal(JSON.stringify(calls).includes(SECRET), false);
  }
});

test('trusted evaluation pins the password operation to an isolated execution context', async () => {
  const calls = [];
  await trustedEvaluate(async (method, params) => {
    calls.push([method, params]);
    if (method === 'Page.getFrameTree') return { result: { frameTree: { frame: { id: 'frame', url: SSO + '/login' } } } };
    if (method === 'Page.createIsolatedWorld') return { result: { executionContextId: 9 } };
    return { result: { result: { value: SSO } } };
  }, SSO, 'TEST_OPERATION');
  assert.equal(calls.at(-1)[1].contextId, 9);
  assert.equal(calls[1][1].grantUniveralAccess, false);
});

test('second-factor spoofing is rejected before credentials are read', async () => {
  const state = { href: 'https://id.tsinghua.edu.cn.example.invalid/', secondFactor: true };
  const result = await ensureLoggedIn(async () => ({ result: { result: { value: JSON.stringify(state) } } }), { readCredentials: () => { throw Error('must not read'); } });
  assert.equal(result, 'untrusted-login-page');
});

test('OTP submission does not send the code after the page navigates away', async () => {
  const calls = [];
  const opened = { send: async (method, params) => {
    calls.push([method, params]);
    if (method === 'Page.getFrameTree') return { result: { frameTree: { frame: { id: 'frame', url: 'https://example.invalid' } } } };
    return { result: { result: { value: JSON.stringify({ radios: [], hasCodeInput: true }) } } };
  } };
  await holdSecondFactor(opened);
  try {
    const result = await submitSecondFactorCode('000000');
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(calls).includes('000000'), false);
  } finally { await cancelSecondFactor(); }
});

test('browser trust and background installation are opt-in', async () => {
  let expression;
  await confirmTrustDevice(async (_, params) => { expression = params.expression; return { result: { result: { value: '{}' } } }; });
  assert.match(expression, /"trust":false/);
  assert.equal(parseArgs([]).task, false);
  assert.equal(parseArgs(['--task']).task, true);
  assert.equal(parseArgs(['--uninstall']).task, true);
});

test('Windows credential status checks file metadata without decrypting a password', async () => {
  assert.equal(await credentialsSaved({ platform: 'win32', stat: () => ({ isFile: () => true, size: 40 }) }), true);
  assert.equal(await credentialsSaved({ platform: 'win32', stat: () => { throw Error('missing'); } }), false);
});
