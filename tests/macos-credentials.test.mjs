import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { openMacCredentialDialog, macCredentialDialogOpen, macCredentialDialogResult, macCredentialsSaved, keychainService, removeMacCredentials } from '../lib/macos-credentials.mjs';
import { credentialDialogOpen, credentialsSaved, removeSavedCredentials } from '../lib/refresh.mjs';

function child() {
  const value = new EventEmitter();
  Object.assign(value, { exitCode: null, signalCode: null, unref() {} });
  return value;
}

test('Mac dialog is tracked until it exits and duplicate opens are suppressed', async () => {
  const process = child();
  const options = { build: async () => '/fake/credentials', spawnImpl: () => { queueMicrotask(() => process.emit('spawn')); return process; } };
  assert.deepEqual(await openMacCredentialDialog(options), { ok: true });
  assert.equal(macCredentialDialogOpen(), true);
  assert.equal(credentialDialogOpen(), true);
  assert.deepEqual(await openMacCredentialDialog({ build: () => { throw Error('duplicate build'); } }), { ok: true, alreadyOpen: true });
  process.exitCode = 0;
  process.emit('exit', 0);
  assert.equal(macCredentialDialogOpen(), false);
  assert.equal(macCredentialDialogResult(), 'saved');
});

test('Mac dialog cancellation and failure are distinguished from saving', async () => {
  for (const [code, result] of [[2, 'cancelled'], [1, 'failed']]) {
    const process = child();
    await openMacCredentialDialog({ build: async () => '/fake/credentials', spawnImpl: () => { queueMicrotask(() => process.emit('spawn')); return process; } });
    process.exitCode = code;
    process.emit('exit', code);
    assert.equal(macCredentialDialogResult(), result);
    assert.equal(macCredentialDialogOpen(), false);
  }
});

test('Mac credential status uses only metadata, never the password read command', async () => {
  const calls = [];
  const saved = await macCredentialsSaved({
    exists: () => true,
    run: async (file, args) => { calls.push(args); return { stdout: '{"saved":true}' }; },
  });
  assert.equal(saved, true);
  assert.deepEqual(calls, [['status']]);
  assert.equal(await credentialsSaved({ platform: 'darwin', readMacStatus: async () => true, readCredentials: () => { throw Error('must not decrypt for status'); } }), true);
  assert.equal(await macCredentialsSaved({ exists: () => false, run: () => { throw Error('must not spawn'); } }), false);
  assert.equal(await macCredentialsSaved({ exists: () => true, run: async () => { throw Error('locked'); } }), false);
});

test('Mac helper startup errors do not leave the credential dialog marked open', async () => {
  const result = await openMacCredentialDialog({
    build: async () => '/fake/credentials',
    spawnImpl: () => { const process = child(); queueMicrotask(() => process.emit('error', Error('missing'))); return process; },
  });
  assert.equal(result.ok, false);
  assert.equal(macCredentialDialogOpen(), false);
  assert.equal(macCredentialDialogResult(), 'failed');
});


test('Mac keychain service namespace matches the Swift helper for custom DSH homes', () => {
  const home = '/tmp/dsh-home-中文 test';
  const digest = createHash('sha256').update(home, 'utf8').digest('hex').slice(0, 16);
  assert.equal(keychainService(home), 'cn.edu.tsinghua.dsh-tsinghua-paratera.' + digest);
  assert.notEqual(keychainService(home), keychainService('/tmp/other-home'));
});

test('Mac credential removal prefers the helper and never reads the password', async () => {
  const calls = [];
  const result = await removeMacCredentials({
    dshHome: '/tmp/test-dsh-home', exists: () => true,
    run: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: '{"ok":true}' }; },
    security: () => assert.fail('helper success must not fall back to security'),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls[0].args, ['delete']);
  assert.equal(calls[0].options.env.DSH_HOME, '/tmp/test-dsh-home');
  assert.equal(JSON.stringify(calls).includes('password'), false);
});

test('Mac credential removal falls back to security and treats a missing item as success', async () => {
  const calls = [];
  const result = await removeMacCredentials({
    dshHome: '/tmp/test-dsh-home', exists: () => false,
    security: async (file, args) => { calls.push([file, args]); throw Object.assign(Error('not found'), { code: 44 }); },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0][0], '/usr/bin/security');
  assert.deepEqual(calls[0][1].slice(0, 2), ['delete-generic-password', '-s']);
  assert.equal(calls[0][1].includes('easycompute'), true);
});

test('Mac credential removal reports a bounded failure without upstream error text', async () => {
  const result = await removeMacCredentials({
    dshHome: '/tmp/test-dsh-home', exists: () => false,
    security: async () => { throw Object.assign(Error('TEST_SECRET keychain locked'), { code: 1 }); },
  });
  assert.deepEqual(result, { ok: false, error: 'credential-remove-failed' });
  assert.doesNotMatch(JSON.stringify(result), /TEST_SECRET|locked/);
});

test('Mac password removal is refused while the native dialog is open and uses the selected home', async () => {
  assert.deepEqual(await removeSavedCredentials({ platform: 'darwin', dialogOpen: () => true, removeMac: () => assert.fail('must not delete') }), { ok: false, error: 'credential-dialog-open' });
  let called;
  assert.deepEqual(await removeSavedCredentials({
    platform: 'darwin', dshHome: '/tmp/test-dsh-home', dialogOpen: () => false,
    removeMac: async (options) => { called = options; return { ok: true }; },
  }), { ok: true });
  assert.deepEqual(called, { dshHome: '/tmp/test-dsh-home' });
  assert.deepEqual(await removeSavedCredentials({ platform: 'linux', dialogOpen: () => false }), { ok: false, error: 'unsupported-platform' });
});
