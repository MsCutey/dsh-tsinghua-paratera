// Optional installed-carrier contract test. Run with Electron in Node mode and
// DSH_SDK_NODE_MODULES pointing at the installed ASAR's dsh/node_modules path.
// It never starts a server or reads the real DSH home. All credential writes are
// fake keys in a freshly-created temporary directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importKey } from '../lib/import.mjs';

const sdkRoot = process.env.DSH_SDK_NODE_MODULES;
const SECRET = 'sk-test-only-installed-host-0123456789';
const PREVIOUS = 'sk-test-only-installed-host-previous-9876543210';
const MODEL = 'test-org/test-import-model';
const SECOND_MODEL = 'test-org/test-import-second-model';

function assertSafeTemp(folder) {
  assert.equal(path.dirname(folder), os.tmpdir());
  assert.match(path.basename(folder), /^paratera-host-sdk-/);
}

test('installed SDK imports and hot-updates models on the same adapter and volatile reference', { skip: !sdkRoot }, async () => {
  const load = (name) => import(pathToFileURL(path.join(sdkRoot, '@deepseek-ai', name, 'lib', 'index.js')).href);
  const [{ SettingsForms }, { LocalCredentialProvider }, adapterModule, { Entry }, { LlmRuntime }, { resolveConfig }] = await Promise.all([
    load('dsh-settings'), load('dsh-credentials-local'), load('dsh-llm-pi-ai'),
    load('cordis-plugin-loader'), load('dsh-llm'), load('cordis'),
  ]);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'paratera-host-sdk-'));
  assertSafeTemp(folder);
  const originalFetch = globalThis.fetch;
  const disposers = [];
  globalThis.fetch = () => { throw Error('ISOLATION: installed SDK test must not access network'); };
  try {
    // Execute the installed provider's real resolve/set/write/atomic-file-lock
    // methods, replacing only boot/lifecycle/ambient-environment boundaries.
    const credentials = Object.assign(Object.create(LocalCredentialProvider.prototype), {
      spec: { filename: path.join(folder, '.credentials.yaml'), watch: false, debounceMs: 0 },
      text: undefined, values: new Map(), records: new Map(), operations: Promise.resolve(), closed: false,
      notifyUpdated() {}, inherited() {}, dotenvFallback() {}, warnIgnoredKeys() {},
    });
    await credentials.set('PARATERA_API_KEY', PREVIOUS);
    let raw = { providers: { other: { api: 'openai-completions', baseURL: 'https://example.invalid/v1', models: [{ id: 'untouched' }] } } };
    let revision = 0;
    let commits = 0;
    let volatileEvents = 0;
    const listeners = new Map();
    const diagnostics = [];
    const fiber = { runtime: { Config: adapterModule.Config }, state: 2 };
    const configuration = adapterModule.Config(structuredClone(raw));
    fiber.config = configuration;
    const originalProvidersRef = configuration.providers;
    const ctx = {
      fiber,
      inject() {},
      get(name) { if (name === 'credentials') return credentials; throw Error('ISOLATION: unexpected host service'); },
      on(event, listener) {
        const group = listeners.get(event) ?? [];
        group.push(listener);
        listeners.set(event, group);
        return () => { const index = group.indexOf(listener); if (index >= 0) group.splice(index, 1); };
      },
      // Adapter listeners use the same fiber receiver as the real Cordis
      // waterfall. Entry._commitVolatile itself parses the candidate and emits.
      waterfall(receiver, event, value, next) {
        let current = value;
        for (const listener of listeners.get(event) ?? []) current = listener.call(receiver, current, next);
        return current;
      },
      emit(receiver, event, paths) {
        assert.equal(Object.getPrototypeOf(receiver), ctx);
        assert.equal(event, 'loader/volatile-update');
        assert.deepEqual(paths, [['providers']]);
        volatileEvents += 1;
        for (const listener of listeners.get(event) ?? []) listener.call(fiber, paths);
      },
      effect(effect) {
        const resource = effect();
        if (resource?.next) {
          const initial = resource.next();
          const dispose = () => { if (typeof initial.value === 'function') initial.value(); resource.return?.(); };
          disposers.push(dispose);
          return dispose;
        }
        if (typeof resource === 'function') disposers.push(resource);
        return typeof resource === 'function' ? resource : () => {};
      },
      events: { dispatch: () => [] },
      logger: { warn(...args) { diagnostics.push(args); }, error(...args) { diagnostics.push(args); } },
    };
    fiber.ctx = ctx;
    // Real installed LlmRuntime registry/validation/registration handles, not a
    // fake registerAdapter which could hide a missing volatile-update listener.
    const llm = Object.create(LlmRuntime.prototype);
    Object.defineProperty(llm, 'ctx', { value: ctx });
    llm.adapters = new Map();
    llm.directory = new Map();
    llm.discoveries = new Map();
    ctx.llm = llm;
    const entry = Object.create(Entry.prototype);
    entry.ctx = ctx;
    entry.options = { id: 'llm-pi-ai', config: structuredClone(raw) };
    entry.fiber = fiber;
    fiber.entry = entry;
    adapterModule.apply(ctx, configuration);
    const originalAdapter = llm.adapters.get('other').adapter;
    assert.deepEqual(llm.listProviders().map((provider) => provider.id), ['other']);
    assert.equal(llm.listProviders().some((provider) => provider.id === 'paratera'), false);

    // SettingsForms.write/update and Entry._commitVolatile are installed code.
    // Only ConfigEditor.edit's persistence/reconciliation boundary is in-memory:
    // this does NOT claim to test full ConfigEditor/profile/HMR integration.
    const settings = Object.assign(Object.create(SettingsForms.prototype), {
      describe: () => [{ ns: 'llm-pi-ai', revision, value: structuredClone(raw) }],
      ownerContext: { configEditor: {
        entries: () => [entry],
        async edit(actualEntry, transform) {
          assert.equal(actualEntry, entry);
          const candidate = transform(structuredClone(raw), { providers: {} });
          resolveConfig(fiber.runtime, ctx.waterfall(fiber, 'internal/config', candidate, () => candidate));
          entry.options.config = candidate;
          fiber._config = candidate;
          assert.equal(entry._commitVolatile(), true);
          commits += 1;
          raw = candidate;
          revision += 1;
          assert.equal(fiber.config, configuration);
          assert.equal(fiber.config.providers, originalProvidersRef);
          assert.equal(llm.adapters.get('other').adapter, originalAdapter);
          assert.deepEqual(diagnostics, []);
        },
      } },
    });
    const dependencies = {
      credentials, settings, llm,
      list: async () => ({ ok: true, keys: [{ uuid: 'mock-uuid', name: 'mock-key', status: 'valid' }] }),
      reveal: async () => ({ ok: true, secret: SECRET }),
      verify: async () => ({ ok: true, models: 2, modelIds: [MODEL, SECOND_MODEL] }),
    };
    const first = await importKey({ uuid: 'mock-uuid', models: [MODEL] }, dependencies);
    assert.equal(first.ok, true);
    assert.equal(first.credentialImported, true);
    assert.equal(first.modelConfigUpdated, true);
    assert.equal(first.providerRegistered, true);
    assert.equal(first.modelsAvailable, true);
    assert.equal(first.needsRestart, false);
    assert.equal(commits, 1);
    assert.equal(volatileEvents, 1);
    assert.equal((await credentials.resolve('PARATERA_API_KEY')).value, SECRET);
    assert.equal((await credentials.resolve('PARATERA_API_KEY_BACKUP')).value, PREVIOUS);
    assert.equal(raw.providers.other.models[0].id, 'untouched');
    assert.equal(llm.listProviders().find((provider) => provider.id === 'paratera').name, 'Paratera');
    assert.equal(llm.listConfigurableProviders().find((provider) => provider.provider === 'paratera').settingsNs, 'llm-pi-ai');
    assert.equal(llm.adapters.get('paratera').adapter, originalAdapter);
    assert.deepEqual((await llm.listModels('paratera')).map((model) => model.id), [MODEL]);
    assert.equal((await llm.resolveModelInfo('paratera', MODEL)).context.contextWindow, 128000);

    // Add a second model without booting another adapter. Route-registration
    // facts do not change, so this also catches stale adapter profile snapshots.
    const second = await importKey({ uuid: 'mock-uuid', models: [SECOND_MODEL] }, dependencies);
    assert.equal(second.ok, true);
    assert.equal(second.providerRegistered, true);
    assert.equal(second.modelsAvailable, true);
    assert.equal(second.modelConfigUpdated, true);
    assert.deepEqual(second.modelsAdded, [SECOND_MODEL]);
    assert.equal(commits, 2);
    assert.equal(volatileEvents, 2);
    assert.equal(configuration.providers, originalProvidersRef);
    assert.equal(originalProvidersRef.get().providers, undefined);
    assert.deepEqual(originalProvidersRef.get().paratera.models.map((model) => model.id), [MODEL, SECOND_MODEL]);
    assert.equal(llm.adapters.get('paratera').adapter, originalAdapter);
    assert.deepEqual((await llm.listModels('paratera')).map((model) => model.id), [MODEL, SECOND_MODEL]);
    assert.equal((await llm.resolveModelInfo('paratera', SECOND_MODEL)).context.contextWindow, 128000);
    assert.deepEqual((await llm.listModels('other')).map((model) => model.id), ['untouched']);

    // Idempotent import verifies the real directory even with no settings edit.
    const repeated = await importKey({ uuid: 'mock-uuid', models: [SECOND_MODEL] }, dependencies);
    assert.equal(repeated.ok, true);
    assert.equal(repeated.modelConfigUpdated, false);
    assert.equal(repeated.providerRegistered, true);
    assert.equal(repeated.modelsAvailable, true);
    assert.equal(commits, 2);
    assert.equal(volatileEvents, 2);
    const document = fs.readFileSync(path.join(folder, '.credentials.yaml'), 'utf8');
    assert.match(document, /version: 1/);
    assert.match(document, /refs:/);
    for (const result of [first, second, repeated]) assert.ok(!JSON.stringify(result).includes(SECRET));
    // A stale revision must not mutate either the raw settings or the live ref.
    await assert.rejects(() => settings.update('llm-pi-ai', { providers: { paratera: raw.providers.paratera } }, revision - 1), (error) => error.constructor.name === 'SettingsConflictError');
    assert.equal(commits, 2);
    assert.deepEqual((await llm.listModels('paratera')).map((model) => model.id), [MODEL, SECOND_MODEL]);
    assert.deepEqual(diagnostics, []);
  } finally {
    for (const dispose of disposers.reverse()) dispose();
    globalThis.fetch = originalFetch;
    assertSafeTemp(folder);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
