import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openMacCredentialDialog, macCredentialDialogOpen, macCredentialDialogResult, macCredentialsSaved } from '../lib/macos-credentials.mjs';
import { credentialDialogOpen, credentialsSaved } from '../lib/refresh.mjs';

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
