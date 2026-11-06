import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendModels, fingerprint, verifyKey, importKey, confirmProviderModels } from '../lib/import.mjs';

const SECRET = 'sk-test-only-not-a-real-api-key-0123456789';
const PREVIOUS = 'sk-test-only-previous-key-9876543210';
const MODEL = 'deepseek-ai/DeepSeek-V3:latest';
const REF = 'PARATERA_API_KEY';

beforeEach(() => {
  mock.method(fs, 'readFileSync', () => { throw Error('ISOLATION: real state must not be read'); });
  mock.method(fs, 'writeFileSync', () => { throw Error('ISOLATION: real state must not be written'); });
  mock.method(globalThis, 'fetch', () => { throw Error('ISOLATION: unexpected network'); });
});
afterEach(() => mock.restoreAll());

function settingsFixture(providers = {}) {
  const writes = [];
  let revision = 7;
  let current = structuredClone(providers);
  const merge = (under, over) => {
    if (!under || typeof under !== 'object' || Array.isArray(under) || !over || typeof over !== 'object' || Array.isArray(over)) return structuredClone(over);
    const out = { ...under };
    for (const [key, value] of Object.entries(over)) out[key] = key in out ? merge(out[key], value) : structuredClone(value);
    return out;
  };
  // The live config is the parsed one: schemastery materialises dict/array
  // defaults such as modelOverrides:{} and never stores them back.
  const parsed = (value) => {
    const copy = structuredClone(value);
    for (const provider of Object.values(copy)) {
      if (provider && typeof provider === 'object' && !Array.isArray(provider)) {
        provider.modelOverrides ??= {};
        provider.models ??= [];
        provider.transport ??= 'auto';
        provider.defaultContextWindow ??= 128000;
      }
    }
    return copy;
  };
  return {
    writes,
    get providers() { return current; },
    describe() {
      return [{ ns: 'llm-pi-ai', revision, value: { providers: parsed(current) }, user: { providers: structuredClone(current) } }];
    },
    async update(ns, patch, expected) {
      assert.equal(ns, 'llm-pi-ai');
      assert.equal(expected, revision);
      writes.push(structuredClone(patch));
      current = merge(current, structuredClone(patch.providers));
      revision += 1;
    },
  };
}

function importFixture(options = {}) {
  const writes = [];
  const revealed = [];
  const stored = new Map([[REF, PREVIOUS]]);
  const settings = settingsFixture();
  const dependencies = {
    credentials: {
      async resolve(ref) { return stored.has(ref) ? { value: stored.get(ref), source: 'file' } : undefined; },
      async set(ref, value) { writes.push(ref); stored.set(ref, value); },
    },
    settings,
    llm: {
      listProviders: () => Object.keys(settings.providers).map((id) => ({ id, name: id })),
      listModels: async (id) => settings.providers[id]?.models ?? [],
    },
    list: async () => ({ ok: true, keys: [{ uuid: 'uuid-1', name: 'DSH', status: 'valid' }] }),
    reveal: async (target) => { revealed.push(target); return { ok: true, secret: SECRET }; },
    verify: async () => ({ ok: true, models: 2, modelIds: [MODEL, 'test-model'] }),
    ...options,
  };
  return { dependencies, writes, stored, settings, revealed };
}

function assertNoSecrets(result) {
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!JSON.stringify(result).includes(PREVIOUS));
}

test('creates a missing Paratera route through revisioned live Settings', async () => {
  const settings = settingsFixture({ other: { models: [{ id: MODEL, contextWindow: 42 }] } });
  const before = structuredClone(settings.providers.other);
  const result = await appendModels([MODEL, MODEL], { settings });
  assert.equal(result.ok, true);
  assert.deepEqual(result.added, [MODEL]);
  assert.equal(result.needsRestart, false);
  assert.deepEqual(settings.providers.other, before);
  assert.equal(settings.providers.paratera.apiKeyEnv, REF);
  assert.equal(settings.providers.paratera.api, 'openai-completions');
  assert.equal(settings.providers.paratera.baseURL, 'https://llmapi.paratera.com/v1');
  assert.equal(settings.providers.paratera.models[0].id, MODEL);
  assert.deepEqual(Object.keys(settings.writes[0].providers), ['paratera']);
});

test('preserves existing Paratera metadata and is idempotent', async () => {
  const settings = settingsFixture({ paratera: {
    apiKeyEnv: REF, api: 'openai-completions', baseURL: 'https://llmapi.paratera.com/v1',
    headers: { 'x-custom': 'test-only' }, retryPolicy: { mode: 'normal', maxRetries: 1 },
    models: [{ id: 'existing', name: 'Keep me', contextWindow: 8192, reasoningEfforts: false }],
  } });
  const original = structuredClone(settings.providers.paratera.models[0]);
  assert.deepEqual((await appendModels(['existing', MODEL], { settings })).added, [MODEL]);
  assert.deepEqual(settings.providers.paratera.models[0], original);
  assert.equal(settings.providers.paratera.headers['x-custom'], 'test-only');
  assert.equal((await appendModels([MODEL], { settings })).updated, false);
  assert.equal(settings.writes.length, 1);
});

test('binds existing routes to the imported credential reference', async () => {
  const settings = settingsFixture({ paratera: { apiKeyEnv: 'OLD_REF', models: [{ id: MODEL }] } });
  assert.equal((await appendModels([MODEL], { settings })).updated, true);
  assert.equal(settings.providers.paratera.apiKeyEnv, REF);
});

test('an existing key reference does not hide missing required route defaults', async () => {
  const settings = settingsFixture({ paratera: { apiKeyEnv: REF, models: [{ id: MODEL }] } });
  const result = await appendModels([MODEL], { settings });
  assert.equal(result.updated, true);
  assert.equal(settings.providers.paratera.api, 'openai-completions');
  assert.equal(settings.providers.paratera.baseURL, 'https://llmapi.paratera.com/v1');
});

test('a second import tolerates parsed schema defaults and never persists them', async () => {
  // Regression: describe() materialises modelOverrides:{} and other defaults in
  // the live value. Echoing that back made every import after the first fail
  // with provider-config-invalid.
  const settings = settingsFixture({ paratera: {
    displayName: 'Paratera', api: 'openai-completions', baseURL: 'https://llmapi.paratera.com/v1',
    apiKeyEnv: REF, models: [{ id: MODEL, name: MODEL, contextWindow: 128000, maxTokens: 8192 }],
  } });
  const result = await appendModels(['second-model'], { settings });
  assert.equal(result.ok, true);
  assert.deepEqual(result.added, ['second-model']);
  assert.equal(settings.providers.paratera.modelOverrides, undefined);
  assert.equal(Object.hasOwn(settings.writes[0].providers.paratera, 'modelOverrides'), false);
  assert.equal(Object.hasOwn(settings.writes[0].providers.paratera, 'transport'), false);
  assert.deepEqual(settings.providers.paratera.models.map((model) => model.id), [MODEL, 'second-model']);
});

test('legacy 待校准 entries are upgraded to the recommended name and values', async () => {
  const settings = settingsFixture({ paratera: {
    displayName: 'Paratera', api: 'openai-completions', baseURL: 'https://llmapi.paratera.com/v1',
    apiKeyEnv: REF, models: [{ id: 'Kimi-K3', name: 'Kimi-K3 (待校准)', contextWindow: 128000, maxTokens: 8192 }],
  } });
  const result = await appendModels(['Kimi-K3'], { settings });
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.deepEqual(settings.providers.paratera.models, [{ id: 'Kimi-K3', name: 'Kimi-K3', contextWindow: 1024000, maxTokens: 943718, input: ['text', 'image'] }]);
});

test('a user-chosen model name is never overwritten by the importer', async () => {
  const settings = settingsFixture({ paratera: {
    displayName: 'Paratera', api: 'openai-completions', baseURL: 'https://llmapi.paratera.com/v1',
    apiKeyEnv: REF, models: [{ id: 'Kimi-K3', name: 'K3 高速版', contextWindow: 64000, maxTokens: 4096 }],
  } });
  await appendModels(['Qwen3.8-Max'], { settings });
  assert.deepEqual(settings.providers.paratera.models[0], { id: 'Kimi-K3', name: 'K3 高速版', contextWindow: 64000, maxTokens: 4096 });
  assert.equal(settings.providers.paratera.models[1].name, 'Qwen3.8-Max');
});

test('imports only ever append: existing entries survive untouched', async () => {
  const settings = settingsFixture({ paratera: {
    displayName: 'Paratera', api: 'openai-completions', baseURL: 'https://llmapi.paratera.com/v1',
    apiKeyEnv: REF, models: [{ id: 'keep' }, { id: 'drop' }],
  } });
  const result = await appendModels(['keep', 'new'], { settings });
  assert.equal(result.ok, true);
  assert.equal(result.replaced, false);
  assert.equal(result.removed, 0);
  assert.deepEqual(result.added, ['new']);
  assert.deepEqual(settings.providers.paratera.models.map((model) => model.id), ['keep', 'drop', 'new']);
  assert.equal(settings.providers.paratera.models[0].name, undefined, 'kept entries keep their stored shape');
});

test('invalid model IDs are rejected rather than silently skipped', async () => {
  const settings = settingsFixture();
  for (const ids of [null, ['ok', 'bad\nmodel'], [{}], Array(201).fill('x')]) {
    assert.deepEqual(await appendModels(ids, { settings }), { ok: false, error: 'invalid-models' });
  }
  assert.equal(settings.writes.length, 0);
});

test('missing/invalid provider configuration and revision conflicts fail safely', async () => {
  assert.equal((await appendModels([MODEL])).error, 'settings-unavailable');
  assert.equal((await appendModels([MODEL], { settings: { describe: () => [], update() {} } })).error, 'provider-config-unavailable');
  for (const provider of [{ models: 'bad' }, { models: [{}] }, 'bad']) {
    const settings = settingsFixture({ paratera: provider });
    assert.equal((await appendModels([MODEL], { settings })).error, 'provider-config-invalid');
    assert.equal(settings.writes.length, 0);
  }
  const settings = settingsFixture();
  settings.update = async () => { const error = Error('test-only conflict'); error.name = 'SettingsConflictError'; throw error; };
  assert.equal((await appendModels([MODEL], { settings })).error, 'config-conflict');
});

test('model verification validates JSON and never follows credential-bearing redirects', async () => {
  let request;
  const result = await verifyKey(SECRET, { fetchImpl: async (url, options) => {
    request = { url, options };
    return Response.json({ data: [{ id: MODEL }, { id: MODEL }, { id: 'test-model' }] });
  } });
  assert.deepEqual(result, { ok: true, models: 2, modelIds: [MODEL, 'test-model'] });
  assert.equal(request.url, 'https://llmapi.paratera.com/v1/models');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, `Bearer ${SECRET}`);
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal((await verifyKey(SECRET, { fetchImpl: async () => Response.json({ error: 'nope' }) })).error, 'verify-invalid-response');
  assert.equal((await verifyKey(SECRET, { fetchImpl: async () => new Response('<html>') })).error, 'verify-invalid-response');
  assert.equal((await verifyKey(SECRET, { fetchImpl: async () => new Response('', { status: 401 }) })).error, 'verify-http-401');
  assert.equal((await verifyKey(SECRET, { fetchImpl: async () => { throw Error(SECRET); } })).error, 'verify-failed');
});

test('UUID import backs up before overwriting and adds models live without exposing secrets', async () => {
  const f = importFixture();
  const result = await importKey({ uuid: 'uuid-1', models: [MODEL] }, f.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.credentialImported, true);
  assert.deepEqual(result.modelsAdded, [MODEL]);
  assert.equal(result.modelConfigUpdated, true);
  assert.equal(result.needsRestart, false);
  assert.deepEqual(f.writes, [`${REF}_BACKUP`, REF]);
  assert.equal(f.stored.get(`${REF}_BACKUP`), PREVIOUS);
  assert.equal(f.stored.get(REF), SECRET);
  assert.deepEqual(f.revealed, [{ uuid: 'uuid-1', name: 'DSH' }]);
  assert.equal(result.fingerprint, fingerprint(SECRET));
  assertNoSecrets(result);
});

test('key-only and dry-run imports do not modify model settings', async () => {
  const f = importFixture();
  const preview = await importKey({ uuid: 'uuid-1', dryRun: true, models: [MODEL] }, f.dependencies);
  assert.equal(preview.ok, true);
  assert.equal(preview.credentialImported, false);
  assert.equal(preview.dryRun, true);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.settings.writes, []);
  assertNoSecrets(preview);
  assert.equal((await importKey({ name: 'DSH' }, f.dependencies)).ok, true);
  assert.deepEqual(f.settings.writes, []);
});

test('models the gateway no longer lists are skipped instead of failing the whole import', async () => {
  const f = importFixture({ verify: async () => ({ ok: true, models: 1, modelIds: [MODEL] }) });
  const result = await importKey({ uuid: 'uuid-1', models: [MODEL, 'retired-model'] }, f.dependencies);
  assert.equal(result.ok, true);
  assert.deepEqual(result.modelsSkipped, ['retired-model']);
  assert.deepEqual(result.modelsAdded, [MODEL]);
  assert.deepEqual(f.settings.providers.paratera.models.map((model) => model.id), [MODEL]);
  assertNoSecrets(result);
});

test('a selection with no served models still fails instead of writing an empty route', async () => {
  const f = importFixture({ verify: async () => ({ ok: true, models: 1, modelIds: [MODEL] }) });
  const result = await importKey({ uuid: 'uuid-1', models: ['retired-model'] }, f.dependencies);
  assert.equal(result.error, 'model-not-available');
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.settings.writes, []);
});

test('auto-discovery import creates a real provider entry and reports every stage', async () => {
  const stages = [];
  const f = importFixture({ onProgress: (stage) => stages.push(stage) });
  const result = await importKey({ uuid: 'uuid-1', autoModels: true }, f.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.providerRegistered, true);
  assert.equal(result.modelsAvailable, true);
  assert.deepEqual(result.modelsAdded, [MODEL, 'test-model']);
  assert.deepEqual(stages, ['listing', 'revealing', 'verifying', 'backup', 'saving', 'models', 'subscription']);
  assertNoSecrets(result);
});

test('no/too many auto-discovered models require an explicit choice before writing credentials', async () => {
  for (const [modelIds, code] of [[[], 'no-available-models'], [Array.from({ length: 201 }, (_, n) => `m-${n}`), 'model-selection-required']]) {
    const f = importFixture({ verify: async () => ({ ok: true, modelIds, models: modelIds.length }) });
    const result = await importKey({ uuid: 'uuid-1', autoModels: true }, f.dependencies);
    assert.equal(result.error, code);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.settings.writes, []);
  }
});

test('a saved config is not reported as a usable provider without real model-directory visibility', async () => {
  for (const [llm, code] of [
    [null, 'model-directory-unavailable'],
    [{ listProviders: () => [], listModels: async () => [] }, 'provider-not-registered'],
    [{ listProviders: () => [{ id: 'paratera' }], listModels: async () => [] }, 'model-directory-missing-models'],
    [{ listProviders() { throw Error(SECRET); }, listModels: async () => [] }, 'model-directory-unavailable'],
  ]) {
    const f = importFixture({ llm });
    const result = await importKey({ uuid: 'uuid-1', models: [MODEL] }, f.dependencies);
    assert.equal(result.ok, false);
    assert.equal(result.credentialImported, true);
    assert.equal(result.modelConfigUpdated, true);
    assert.equal(result.modelError, code);
    assertNoSecrets(result);
  }
  assert.deepEqual(await confirmProviderModels([MODEL], { listProviders: () => [{ id: 'paratera' }], listModels: async () => [{ id: MODEL }] }), { ok: true, providerRegistered: true, modelsAvailable: true });
});

test('a broken progress observer cannot prevent the actual import', async () => {
  const f = importFixture({ onProgress() { throw Error('test-only listener failure'); } });
  assert.equal((await importKey({ uuid: 'uuid-1', models: [MODEL] }, f.dependencies)).ok, true);
});

test('same credential does not replace the previous backup', async () => {
  const f = importFixture();
  f.stored.set(REF, SECRET);
  f.stored.set(`${REF}_BACKUP`, PREVIOUS);
  assert.equal((await importKey({ uuid: 'uuid-1' }, f.dependencies)).ok, true);
  assert.deepEqual(f.writes, [REF]);
  assert.equal(f.stored.get(`${REF}_BACKUP`), PREVIOUS);
});

test('malformed input performs no remote reads or writes', async () => {
  let called = false;
  const f = importFixture({ list: async () => { called = true; throw Error('should not list'); } });
  for (const body of [null, [], {}, { uuid: {} }, { name: 123 }, { uuid: 'uuid-1', dryRun: 'false' }, { uuid: 'uuid-1', autoModels: 'true' }, { uuid: 'uuid-1', autoModels: true, models: [MODEL] }, { uuid: 'uuid-1', models: 'oops' }, { uuid: 'uuid-1', models: null }, { uuid: 'uuid-1', models: ['bad\nmodel'] }]) {
    assert.equal((await importKey(body, f.dependencies)).ok, false);
  }
  assert.equal(called, false);
  assert.deepEqual(f.writes, []);
});

test('missing, disabled, ambiguous keys and unavailable models never overwrite credentials', async () => {
  const f = importFixture();
  assert.equal((await importKey({ uuid: 'missing' }, f.dependencies)).error, 'key-not-found');
  f.dependencies.list = async () => ({ ok: true, keys: [{ uuid: 'uuid-1', name: 'DSH', status: 'invalid' }] });
  assert.equal((await importKey({ uuid: 'uuid-1' }, f.dependencies)).error, 'key-disabled');
  f.dependencies.list = async () => ({ ok: true, keys: [{ uuid: 'uuid-1', name: 'DSH' }, { uuid: 'uuid-2', name: 'DSH' }] });
  assert.equal((await importKey({ name: 'DSH' }, f.dependencies)).error, 'key-name-ambiguous');
  assert.equal((await importKey({ uuid: 'uuid-1', models: ['not-entitled'] }, f.dependencies)).error, 'model-not-available');
  assert.deepEqual(f.writes, []);
});

test('failed reveal or verification never touches credentials', async () => {
  for (const override of [
    { list: async () => ({ ok: false, error: 'console-session-expired' }) },
    { reveal: async () => ({ ok: false, error: 'secret-not-revealed' }) },
    { verify: async () => ({ ok: false, error: 'verify-http-403' }) },
  ]) {
    const f = importFixture(override);
    assert.equal((await importKey({ uuid: 'uuid-1' }, f.dependencies)).ok, false);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.settings.writes, []);
  }
});

test('credential read/backup/write failures are distinct and do not write models', async () => {
  for (const phase of ['read', 'backup', 'write']) {
    const f = importFixture();
    if (phase === 'read') f.dependencies.credentials.resolve = async () => { throw Error(SECRET); };
    else f.dependencies.credentials.set = async (ref) => {
      if (phase === 'backup' || ref === REF) throw Error(SECRET);
      f.writes.push(ref);
    };
    const result = await importKey({ uuid: 'uuid-1', models: [MODEL] }, f.dependencies);
    assert.equal(result.error, `credential-${phase}-failed`);
    assert.equal(result.credentialImported, false);
    assert.equal(f.stored.get(REF), PREVIOUS);
    assert.deepEqual(f.settings.writes, []);
    assertNoSecrets(result);
  }
});

test('model write failure reports partial success, including thrown failures', async () => {
  for (const apply of [async () => ({ ok: false, error: 'config-conflict' }), async () => { throw Error(SECRET); }]) {
    const f = importFixture({ apply });
    const result = await importKey({ uuid: 'uuid-1', models: [MODEL] }, f.dependencies);
    assert.equal(result.ok, false);
    assert.equal(result.credentialImported, true);
    assert.equal(result.error, 'model-import-failed');
    assert.equal(f.stored.get(REF), SECRET);
    assert.deepEqual(result.modelsAdded, []);
    assertNoSecrets(result);
  }
});
