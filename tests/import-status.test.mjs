import test from 'node:test';
import assert from 'node:assert/strict';
import { createImportStatus, publicImportResult, IMPORT_REVISION } from '../lib/import-status.mjs';

const SECRET = 'sk-test-only-not-real-abcdef0123456789';

test('progress has immutable snapshots, terminal results and stale-operation protection', () => {
  let at = 100;
  const state = createImportStatus({ now: () => at++ });
  assert.equal(state.snapshot().stage, 'idle');
  assert.equal(state.snapshot().importRevision, IMPORT_REVISION);
  state.start('op-one');
  assert.equal(state.snapshot().startedAt, 100);
  state.progress('op-one', 'revealing');
  const active = state.snapshot();
  assert.equal(active.running, true);
  assert.equal(active.stage, 'revealing');
  active.stage = 'wrong';
  assert.equal(state.snapshot().stage, 'revealing');
  state.progress('op-one', SECRET);
  assert.equal(state.snapshot().stage, 'revealing');
  state.start('op-two');
  state.finish('op-one', { ok: false, error: 'verify-failed' });
  assert.equal(state.snapshot().running, true);
  state.finish('op-two', { ok: true, credentialImported: true, modelsAdded: ['a', 'b'], providerRegistered: true, modelsAvailable: true });
  assert.equal(state.snapshot().running, false);
  assert.equal(state.snapshot().stage, 'completed');
  assert.equal(state.snapshot().result.modelsAddedCount, 2);
  state.progress('op-two', 'listing');
  assert.equal(state.snapshot().stage, 'completed');
});

test('public status redacts secrets, names, arbitrary exception text and model values', () => {
  const result = publicImportResult({ ok: false, error: SECRET, modelError: 'model-config-write-failed',
    secret: SECRET, token: SECRET, name: SECRET, uuid: SECRET, fingerprint: SECRET, modelsAdded: [SECRET],
    credentialImported: true, verifiedModels: 2, stack: SECRET,
  });
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.equal(result.error, 'key-import-failed');
  assert.equal(result.modelError, 'model-config-write-failed');
  assert.equal(result.modelsAddedCount, 1);
  assert.equal(result.credentialImported, true);
  assert.equal(result.verifiedModels, 2);
  assert.equal(Object.hasOwn(result, 'modelsAdded'), false);
  const state = createImportStatus();
  state.start('test-op');
  state.finish('test-op', { ok: false, error: 'verify-http-403' });
  assert.equal(state.snapshot().stage, 'failed');
  assert.equal(state.snapshot().result.error, 'verify-http-403');
});
