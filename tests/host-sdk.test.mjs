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
import vm from 'node:vm';
import { browserSdk } from './browser-sdk.mjs';

const sdkRoot = process.env.DSH_SDK_NODE_MODULES;
const SECRET = 'sk-test-only-installed-host-0123456789';
const PREVIOUS = 'sk-test-only-installed-host-previous-9876543210';
const MODEL = 'test-org/test-import-model';
const SECOND_MODEL = 'test-org/test-import-second-model';

test('installed browser React renders the composer balance using real slot and model services', { skip: !sdkRoot }, async () => {
  const browser = await browserSdk(sdkRoot);
  const { modules, page } = browser;
  const load = (name) => {
    let entry;
    vm.runInNewContext(fs.readFileSync(path.join(sdkRoot, '@deepseek-ai', name, 'lib/client.js'), 'utf8'), { window: { __ModuleLoader__: { load: (value) => { entry = value } } } });
    return entry.factory((id) => { if (!(id in modules)) throw Error('unknown browser module '+id); return modules[id] });
  };
  const cordis = modules['@deepseek-ai/cordis'];
  const React = modules.react;
  const root = new cordis.Context();
  const modelModule = load('dsh-client-ui-model-selection');
  const renderer = load('dsh-client-ui-renderer');
  const store = modules['@deepseek-ai/dsh-client-store'].createSnapshotStore({ next: { provider: 'paratera', model: MODEL } });
  const binding = { session: { projections: { faceOf: () => store }, getSnapshot: () => ({ blank: false }) } };
  class Remote extends cordis.Service {
    constructor(ctx) { super(ctx, 'remote') }
    get session() { return this.ctx['remote.session'] }
    $on() { return () => {} }
  }
  // Real services are owned by sibling plugins, not the root's unguarded store.
  const remoteFork = root.plugin({ apply(ctx) {
    ctx.reflect.provide('sessions', { scope: () => root, binding: () => binding, subagentAddress: () => undefined });
    ctx.reflect.provide('remote.session', { modelCatalog: async () => ({ ok: true, value: { default: { provider: 'paratera', model: MODEL }, groups: [{ id: 'paratera', models: [{ id: MODEL }] }], failures: [] } }) });
    new Remote(ctx);
  } });
  let entry;
  const warnings = [];
  vm.runInNewContext(fs.readFileSync(process.env.DSH_TEST_CLIENT_SOURCE || new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value) => { entry = value } } }, document: page.window.document,
    AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    console: { warn: (...args) => warnings.push(args) },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, availableQuota: 123.45 }) }),
  });
  const slotFork = root.plugin(renderer);
  const scopeBinding = { key: 'rendered-sdk-session', ctx: root, hooks: {}, keyedHooks: {}, props: {} };
  const bindingSource = { getSnapshot: () => scopeBinding, subscribe: () => () => {} };
  const declarationFork = root.plugin({ inject: ['slots'], apply(ctx) {
    ctx.slots.installScope('session', { current: bindingSource, bindingSource: () => bindingSource, renderArea: (_, props) => props.children });
    ctx.slots.register({ name: 'root', children: {
      'settings.section': { kind: 'list', scope: 'root' }, 'conversation.input.right': { kind: 'list', scope: 'session' },
    } }, ({ renderSlot, SessionProvider }) => React.createElement(SessionProvider, { session: 'rendered-sdk-session' }, renderSlot('conversation.input.right', {})));
  } });
  const modelFork = root.plugin(modelModule.ModelDirectoryResolver);
  const pluginFork = root.plugin(entry.factory(() => React));
  let rendered;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const chip = root.get('slots').entries('conversation.input.right')[0];
    assert.ok(chip);
    // Do not call chip.inject from the unguarded root context: that would prime
    // the model-directory cache and hide the undeclared remote.session access.
    rendered = root.get('uiRenderer').mount(page.window.document.getElementById('test'));
    for (let attempt = 0; attempt < 20 && !page.window.document.querySelector('.paratera-balance')?.textContent.includes('123.45'); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(page.window.document.querySelector('.paratera-balance')?.textContent, '¥123.45');
    assert.equal(warnings.length, 0);
  } finally {
    if (rendered) modules['react-dom'].flushSync(() => rendered());
    await pluginFork.dispose(); await modelFork.dispose(); await declarationFork.dispose(); await slotFork.dispose(); await remoteFork.dispose();
    browser.dispose();
  }
});

test('composer uses the real model-directory service with all guarded remote dependencies', { skip: !sdkRoot }, async () => {
  const cordis = await import(pathToFileURL(path.join(sdkRoot, '@deepseek-ai/cordis/lib/index.js')).href);
  const root = new cordis.Context();
  const snapshotStore = (initial) => {
    let value = initial;
    const listeners = new Set();
    return {
      getSnapshot: () => value,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
      set(next) { value = next; for (const listener of listeners) listener() },
      update(update) { const draft = structuredClone(value); update(draft); this.set(draft) },
    };
  };
  let stockEntry, pluginEntry;
  vm.runInNewContext(fs.readFileSync(path.join(sdkRoot, '@deepseek-ai/dsh-client-ui-model-selection/lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: (entry) => { stockEntry = entry } } },
  });
  const stock = stockEntry.factory((name) => name === '@deepseek-ai/cordis' ? cordis
    : name === '@deepseek-ai/dsh-client-store' ? { createSnapshotStore: snapshotStore } : {});
  const projected = snapshotStore({ next: { provider: 'paratera', model: MODEL } });
  const binding = { session: { projections: { faceOf: () => projected }, getSnapshot: () => ({ blank: false }) } };
  root.reflect.provide('sessions', { scope: () => root, binding: () => binding, subagentAddress: () => undefined });
  root.reflect.provide('remote.session', {
    modelCatalog: async () => ({ ok: true, value: { default: { provider: 'paratera', model: MODEL }, groups: [{ id: 'paratera', models: [{ id: MODEL }] }], failures: [] } }),
  });
  // The real remote namespace also guards its dotted service via caller context.
  class Remote extends cordis.Service {
    constructor(ctx) { super(ctx, 'remote') }
    get session() { return this.ctx['remote.session'] }
    $on() { return () => {} }
  }
  new Remote(root);
  const registrations = new Map();
  root.reflect.provide('slots', {
    inject: (_, callback) => callback(),
    register(spec, component) { registrations.set(spec.name, { spec, component }); return () => registrations.delete(spec.name) },
  });
  const warnings = [];
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (entry) => { pluginEntry = entry } } },
    fetch: async () => ({ ok: true }), console: { warn: (...args) => warnings.push(args) },
  });
  const modelFork = root.plugin(stock.ModelDirectoryResolver);
  const pluginFork = root.plugin(pluginEntry.factory(() => ({ createElement: () => {} })));
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const store = registrations.get('conversation.input.right').spec.inject('sdk-composer-session').directory;
    assert.equal(store.getSnapshot().current?.provider, 'paratera', warnings.map((args) => String(args.at(-1))).join('\n'));
    assert.equal(store.getSnapshot().current?.model, MODEL);
    assert.equal(warnings.length, 0);
  } finally { await pluginFork.dispose(); await modelFork.dispose(); }
});

test('installed client context binds a late model directory before mounting the balance chip', { skip: !sdkRoot }, async () => {
  const { Context } = await import(pathToFileURL(path.join(sdkRoot, '@deepseek-ai/cordis/lib/index.js')).href);
  const root = new Context();
  let entry;
  const registrations = new Map();
  const store = { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: 'paratera', model: MODEL } }) };
  for (const service of ['sessions', 'remote', 'remote.session']) root.reflect.provide(service, {});
  root.reflect.provide('slots', {
    inject: (_, callback) => callback(),
    register(spec, component) { registrations.set(spec.name, { spec, component }); return () => registrations.delete(spec.name) },
  });
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value) => { entry = value } } },
    fetch: async () => ({ ok: true }),
  });
  const fork = root.plugin(entry.factory(() => ({ createElement: () => {} })));
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(registrations.has('settings.section'));
    assert.equal(registrations.has('conversation.input.right'), false);
    root.reflect.provide('modelDirectories', { directoryFor: (id) => { assert.equal(id, 'late-sdk-session'); return { store } } });
    await new Promise((resolve) => setImmediate(resolve));
    const chip = registrations.get('conversation.input.right');
    assert.ok(chip, 'chip must become available when the real context activates the child injection');
    assert.equal(chip.spec.inject('late-sdk-session').directory, store);
  } finally { await fork.dispose(); }
});

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
    // describe() mirrors the real projection: `user` is the stored layer while
    // `value` is the parsed config, where schemastery materialises dict/array
    // defaults (modelOverrides:{} etc.) that a writer must not echo back.
    const parsedProviders = (providers) => Object.fromEntries(Object.entries(structuredClone(providers)).map(([id, profile]) => [id, {
      ...profile,
      models: profile.models ?? [],
      modelOverrides: profile.modelOverrides ?? {},
      transport: profile.transport ?? 'auto',
      defaultContextWindow: profile.defaultContextWindow ?? 128000,
    }]));
    const settings = Object.assign(Object.create(SettingsForms.prototype), {
      describe: () => [{
        ns: 'llm-pi-ai',
        revision,
        user: { providers: structuredClone(raw.providers) },
        value: { providers: parsedProviders(raw.providers) },
      }],
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
    assert.equal((await llm.resolveModelInfo('paratera', MODEL)).context.contextWindow, 131072);

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
    assert.equal((await llm.resolveModelInfo('paratera', SECOND_MODEL)).context.contextWindow, 131072);
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
