import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createKey, renameKey, setKeyStatus } from '../lib/keys.mjs';

const SECRET = 'sk-FAKE-ONLY-BOUNDARY-0123456789';

test('one-time create secrets reject trailing newlines, whitespace and oversized values', async () => {
  for (const value of [SECRET + '\n', SECRET + '\r\n', SECRET + ' ', SECRET + '\u2028', 'sk-' + 'x'.repeat(513), 'sk-short', { secretKey: SECRET }, null]) {
    let writes = 0;
    const result = await createKey('TEST-DEVICE', { request: async () => { writes++; return { ok: true, data: value }; } });
    assert.deepEqual(result, { ok: false, error: 'key-create-secret-missing' });
    assert.equal(writes, 1, 'accepted create must never retry');
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test('create and rename refuse secret-shaped labels and invalid names before sending them upstream', async () => {
  const request = () => assert.fail('invalid input must not reach transport');
  for (const name of ['a\n', '\u0000a', 'x'.repeat(201), SECRET, `device ${SECRET}`, '', ' ']) {
    assert.equal((await createKey(name, { request })).ok, false);
    assert.equal((await renameKey('FAKE+ID/==', name, { request })).ok, false);
  }
});

test('rename and toggles validate opaque IDs strictly without trimming or URL conversion', async () => {
  const request = () => assert.fail('invalid ID must not reach transport');
  for (const uuid of ['', 'uuid\n', 'uuid ', 'uuid\u2028', SECRET, 'x'.repeat(513), null]) {
    assert.equal((await renameKey(uuid, 'TEST-DEVICE', { request })).ok, false);
    assert.equal((await setKeyStatus(uuid, 'valid', { request })).ok, false);
  }
  const calls = [];
  const fake = async (url, options) => { calls.push({ url, ...options }); return { ok: true }; };
  await renameKey('FAKE+ID/==', '  TEST-DEVICE  ', { request: fake });
  await setKeyStatus('FAKE+ID/==', 'invalid', { request: fake });
  assert.deepEqual(calls.map((call) => call.body), [{ tokenUuid: 'FAKE+ID/==', tokenName: 'TEST-DEVICE' }, { tokenUuid: 'FAKE+ID/==', tokenStatus: 'invalid' }]);
});

test('retired unguarded live probe no longer imports credentials or mutates accounts', () => {
  const script = fileURLToPath(new URL('../scripts/probe-create-secret.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10000, env: { ...process.env, DSH_HOME: 'NONEXISTENT-DO-NOT-READ' } });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /retired|verify-key-lifecycle/);
  assert.doesNotMatch(child.stdout + child.stderr, /sk-|token=|secretReturned/);
});
