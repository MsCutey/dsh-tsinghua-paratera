// Host-only "create a per-device key and import its one-time plaintext" path.
// The console removed the per-row reveal, so this replaces that flow entirely.
import test from 'node:test';
import assert from 'node:assert/strict';
import { importNewKey } from '../lib/import.mjs';

const SECRET = 'sk-fake-created-secret-0123456789';
const OLD = 'sk-fake-previous-secret-9876543210';

function fixture({ created = { ok: true, secret: SECRET }, verified = { ok: true, models: 2, modelIds: ['model-a', 'model-b'] }, applied = { ok: true, added: ['model-a'], updated: true, needsRestart: false }, stored = new Map() } = {}) {
  const calls = { create: [], verify: [], apply: [], set: [], progress: [] };
  const credentials = {
    resolve: async (ref) => stored.has(ref) ? { value: stored.get(ref) } : null,
    set: async (ref, value) => { calls.set.push(ref); stored.set(ref, value); },
  };
  const deps = {
    credentials,
    settings: {},
    llm: {
      listProviders: async () => [{ id: 'paratera' }],
      listModels: async () => [{ id: 'model-a' }, { id: 'model-b' }],
    },
    create: async (name) => { calls.create.push(name); if (created instanceof Error) throw created; return created; },
    verify: async (secret) => { calls.verify.push(secret); if (verified instanceof Error) throw verified; return verified; },
    apply: async (models) => { calls.apply.push(models); return applied; },
    onProgress: (stage) => calls.progress.push(stage),
  };
  return { calls, deps, stored };
}

test('creates one named key, verifies it and stores the secret only on the host', async () => {
  const f = fixture();
  f.stored.set('PARATERA_API_KEY', OLD);
  const result = await importNewKey({ name: 'DESKTOP-TEST', autoModels: true }, f.deps);
  assert.equal(result.ok, true);
  assert.equal(result.credentialImported, true);
  assert.equal(result.createdKeyName, 'DESKTOP-TEST');
  assert.deepEqual(f.calls.create, ['DESKTOP-TEST']);
  assert.deepEqual(f.calls.verify, [SECRET]);
  assert.equal(f.stored.get('PARATERA_API_KEY'), SECRET);
  assert.equal(f.stored.get('PARATERA_API_KEY_BACKUP'), OLD);
  assert.deepEqual(f.calls.apply, [['model-a', 'model-b']]);
  assert.deepEqual(f.calls.progress, ['creating', 'verifying', 'backup', 'saving', 'models', 'subscription']);
  assert.match(result.fingerprint, /^sha256:[a-f0-9]{12}$/);
  // The plaintext must never appear in the returned result.
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('a brand-new key without entitled models still saves the credential', async () => {
  const f = fixture({ verified: { ok: true, models: 0, modelIds: [] } });
  const result = await importNewKey({ name: 'LAPTOP', autoModels: true }, f.deps);
  assert.equal(result.ok, true);
  assert.equal(result.credentialImported, true);
  assert.equal(result.noModelsAvailable, true);
  assert.equal(f.stored.get('PARATERA_API_KEY'), SECRET);
  assert.deepEqual(f.calls.apply, []);
});

test('create failure is explicit, keeps the name for cleanup and never writes a credential', async () => {
  for (const created of [{ ok: false, error: 'key-quota-exceeded' }, { ok: false, error: 'console-timeout' }, new Error('raw upstream text')]) {
    const f = fixture({ created });
    const result = await importNewKey({ name: 'DESKTOP-TEST' }, f.deps);
    assert.equal(result.ok, false);
    assert.equal(result.createdKeyName, 'DESKTOP-TEST');
    assert.equal(f.calls.set.length, 0);
    assert.equal(f.calls.verify.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /raw upstream text/);
  }
});

test('an accepted creation without plaintext cannot be imported and says so', async () => {
  for (const created of [{ ok: true }, { ok: true, secret: null }, { ok: true, secret: 'sk-short' }, { ok: true, secret: 42 }]) {
    const f = fixture({ created });
    const result = await importNewKey({ name: 'DESKTOP-TEST' }, f.deps);
    assert.deepEqual(result, { ok: false, error: 'key-create-secret-missing', createdKeyName: 'DESKTOP-TEST' });
    assert.equal(f.calls.set.length, 0);
  }
});

test('verification failure never stores a credential and reports the created name', async () => {
  for (const verified of [{ ok: false, error: 'verify-http-401' }, { ok: false, error: 'verify-failed' }, new Error('sensitive text')]) {
    const f = fixture({ verified });
    const result = await importNewKey({ name: 'DESKTOP-TEST' }, f.deps);
    assert.equal(result.ok, false);
    assert.equal(result.createdKeyName, 'DESKTOP-TEST');
    assert.equal(f.calls.set.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /sensitive text|sk-fake/);
  }
});

test('credential write failures are distinct and stop before model changes', async () => {
  for (const mode of ['read', 'set']) {
    const f = fixture();
    if (mode === 'read') f.deps.credentials.resolve = async () => { throw Error('sensitive'); };
    else f.deps.credentials.set = async () => { throw Error('sensitive'); };
    const result = await importNewKey({ name: 'DESKTOP-TEST' }, f.deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, mode === 'read' ? 'credential-read-failed' : 'credential-write-failed');
    assert.deepEqual(f.calls.apply, []);
    assert.doesNotMatch(JSON.stringify(result), /sensitive/);
  }
});

test('model configuration failure keeps the imported credential and reports partial success', async () => {
  const f = fixture({ applied: { ok: false, error: 'config-conflict' } });
  const result = await importNewKey({ name: 'DESKTOP-TEST', autoModels: true }, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.credentialImported, true);
  assert.equal(result.error, 'model-import-failed');
  assert.equal(result.modelError, 'config-conflict');
  assert.equal(f.stored.get('PARATERA_API_KEY'), SECRET);
});

test('invalid requests are rejected before any console mutation', async () => {
  for (const body of [null, [], {}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(201) }, { name: 'bad\nname' },
    { name: 'ok', dryRun: true }, { name: 'ok', autoModels: true, models: ['a'] }, { name: 'ok', autoModels: 'yes' },
    { name: 'ok', models: 'a' }, { name: 'ok', models: ['bad id'] }, { name: 'ok', models: new Array(201).fill('m') }]) {
    const f = fixture();
    const result = await importNewKey(body, f.deps);
    assert.equal(result.ok, false);
    assert.deepEqual(f.calls.create, []);
  }
});

test('explicit model selection never applies ids the fresh key cannot use', async () => {
  const f = fixture({ verified: { ok: true, models: 1, modelIds: ['model-a'] } });
  const result = await importNewKey({ name: 'DESKTOP-TEST', models: ['model-a', 'retired-model'] }, f.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.modelsSkipped, ['retired-model']);
  assert.deepEqual(f.calls.apply, [['model-a']]);
});
