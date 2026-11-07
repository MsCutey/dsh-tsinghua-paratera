import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import { recommendedModel, recommendedMaxTokens, thinkingEfforts, supportsReasoning, isVisionModel, normalizeModel, validateModels, readModels, writeModels } from '../lib/models.mjs';
import { createPlugin } from '../lib/index.js';

const ROUTE = '/tsinghua-paratera/api/models';
afterEach(() => mock.restoreAll());

const stored = () => ({
  ns: 'llm-pi-ai',
  revision: 4,
  user: { providers: { paratera: {
    displayName: 'Paratera', api: 'openai-completions', baseURL: 'https://llmapi.paratera.com/v1',
    apiKeyEnv: 'PARATERA_API_KEY',
    models: [{ id: 'Kimi-K3', name: 'Kimi-K3', contextWindow: 262144, maxTokens: 8192, input: ['text'] }],
  } } },
  value: { providers: { paratera: {
    displayName: 'Paratera', api: 'openai-completions', baseURL: 'https://llmapi.paratera.com/v1',
    apiKeyEnv: 'PARATERA_API_KEY', modelOverrides: {}, models: [{ id: 'Kimi-K3', name: 'Kimi-K3', contextWindow: 262144, maxTokens: 8192, input: ['text'] }],
  } } },
});

function settingsFixture() {
  const writes = [];
  return {
    writes,
    describe: () => [stored()],
    async update(ns, patch, revision) { writes.push({ ns, patch, revision }); },
  };
}

test('recommendations come from the captured platform and online catalogs', () => {
  assert.deepEqual(recommendedModel('DeepSeek-V4.1-Flash-1017'), { id: 'DeepSeek-V4.1-Flash-1017', name: 'DeepSeek-V4.1-Flash-1017', contextWindow: 1024000, maxTokens: 393216, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } });
  assert.equal(recommendedModel('Kimi-K3').maxTokens, 943718);
  assert.equal(recommendedModel('GLM-4.6').maxTokens, 131072);
  assert.equal(recommendedMaxTokens(1024000), 131072);
  assert.equal(recommendedMaxTokens(8192), 4096);
  assert.equal(recommendedModel('GLM-4V').maxTokens, 4096);
  assert.deepEqual(thinkingEfforts(), { off: null, low: 'low', high: 'high', max: 'max' });
  assert.equal(recommendedModel('Kimi-K3').contextWindow, 1024000);
  assert.equal(recommendedModel('MiniMax-M1-80k').contextWindow, 10240000);
  assert.equal(recommendedModel('Qwen-Long').contextWindow, 10240000);
  assert.equal(recommendedModel('GLM-4.6').contextWindow, 204800);
  assert.deepEqual(recommendedModel('GLM-4.5V').input, ['text', 'image']);
  assert.deepEqual(recommendedModel('DeepSeek-V4-Flash-Vision-Exp').input, ['text', 'image']);
  assert.deepEqual(recommendedModel('GLM-4.6').input, ['text']);
  assert.equal(isVisionModel('PaddleOCR-VL-1.5'), true);
  assert.equal(isVisionModel('GLM-4.6'), false);
  assert.equal(supportsReasoning('DeepSeek-V4.1-Flash-1017'), true);
  assert.equal(supportsReasoning('GLM-4.6'), false);
  assert.doesNotMatch(recommendedModel('Kimi-K3').name, /待校准/);
});

test('normalizeModel rejects unservable rows and fills missing fields', () => {
  assert.equal(normalizeModel(null), null);
  assert.equal(normalizeModel({ id: 'bad\nmodel' }), null);
  const { reasoningEfforts, ...plain } = recommendedModel('Kimi-K3');
  // Reading a stored row never invents thinking levels; only new rows start with the trio.
  assert.deepEqual(normalizeModel({ id: 'Kimi-K3' }), plain);
  assert.equal(normalizeModel({ id: 'Kimi-K3', name: '   ' }).name, 'Kimi-K3');
  assert.equal(normalizeModel({ id: 'Kimi-K3', contextWindow: 0 }).contextWindow, 1024000);
  assert.deepEqual(normalizeModel({ id: 'Kimi-K3', input: ['audio'] }).input, recommendedModel('Kimi-K3').input);
  assert.deepEqual(normalizeModel({ id: 'Kimi-K3', input: ['image'] }).input, ['text', 'image']);
});

test('reasoningEfforts is validated and preserved only when it offers a level', () => {
  const efforts = { off: null, low: 'low', medium: 'medium', high: 'high' };
  assert.deepEqual(normalizeModel({ id: 'Kimi-K3', reasoningEfforts: efforts }).reasoningEfforts, efforts);
  assert.equal(normalizeModel({ id: 'Kimi-K3', reasoningEfforts: false }).reasoningEfforts, false);
  assert.equal(normalizeModel({ id: 'Kimi-K3' }).reasoningEfforts, undefined);
  assert.equal(normalizeModel({ id: 'Kimi-K3', reasoningEfforts: { off: null } }), null);
  assert.equal(normalizeModel({ id: 'Kimi-K3', reasoningEfforts: { high: null } }), null);
  assert.equal(normalizeModel({ id: 'Kimi-K3', reasoningEfforts: { bogus: 'x' } }), null);
  assert.equal(normalizeModel({ id: 'Kimi-K3', reasoningEfforts: 'high' }), null);
  assert.deepEqual(validateModels([{ id: 'a', reasoningEfforts: { low: 'low' } }]).models[0].reasoningEfforts, { low: 'low' });
});

test('validateModels rejects duplicates, oversize and invalid ids before any write', () => {
  assert.deepEqual(validateModels(null), { ok: false, error: 'invalid-models' });
  assert.equal(validateModels([{ id: 'a' }, { id: 'a' }]).error, 'invalid-models');
  assert.equal(validateModels(Array.from({ length: 201 }, (_, i) => ({ id: `m-${i}` }))).error, 'invalid-models');
  assert.equal(validateModels([{ id: 'a' }, { id: 42 }]).error, 'invalid-models');
  assert.equal(validateModels([{ id: 'a' }]).ok, true);
});

test('readModels exposes the stored list with its recommendation and revision', async () => {
  const result = await readModels({ settings: settingsFixture() });
  assert.equal(result.ok, true);
  assert.equal(result.revision, 4);
  assert.equal(result.models[0].id, 'Kimi-K3');
  assert.equal(result.models[0].contextWindow, 262144);
  assert.equal(result.models[0].recommended.contextWindow, 1024000);
  assert.equal(result.provider.displayName, 'Paratera');
});

test('readModels reports unavailable settings instead of inventing a list', async () => {
  assert.equal((await readModels({})).error, 'settings-unavailable');
  assert.equal((await readModels({ settings: { describe: () => [] } })).error, 'provider-config-unavailable');
  assert.equal((await readModels({ settings: { describe() { throw Error('boom'); } } })).error, 'model-config-read-failed');
});

test('writeModels writes only the model array and honours the revision', async () => {
  const settings = settingsFixture();
  const result = await writeModels([{ id: 'Kimi-K3', name: 'K3', contextWindow: 64000, maxTokens: 4096, input: ['text', 'image'] }], { settings, revision: 4 });
  assert.equal(result.ok, true);
  assert.deepEqual(settings.writes[0], {
    ns: 'llm-pi-ai', revision: 4,
    patch: { providers: { paratera: { models: [{ id: 'Kimi-K3', name: 'K3', contextWindow: 64000, maxTokens: 4096, input: ['text', 'image'] }] } } },
  });
  const conflict = await writeModels([{ id: 'Kimi-K3' }], { settings, revision: 3 });
  assert.equal(conflict.error, 'config-conflict');
  assert.equal(settings.writes.length, 1);
  assert.equal((await writeModels([{ id: 'x y' }], { settings })).error, 'invalid-models');
  assert.equal((await writeModels([{ id: 'x' }], {})).error, 'settings-unavailable');
});

test('writeModels fills route defaults when the provider does not exist yet', async () => {
  const writes = [];
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, user: { providers: {} }, value: { providers: {} } }],
    async update(ns, patch) { writes.push(patch); },
  };
  const result = await writeModels([{ id: 'Kimi-K3' }], { settings });
  assert.equal(result.ok, true);
  assert.deepEqual(writes[0].providers.paratera, {
    displayName: 'Paratera', api: 'openai-completions', baseURL: 'https://llmapi.paratera.com/v1',
    apiKeyEnv: 'PARATERA_API_KEY', models: [{ id: 'Kimi-K3', name: 'Kimi-K3', contextWindow: 1024000, maxTokens: 943718, input: ['text', 'image'] }],
  });
});

function fixture(runKeyImport, { rejection = null, settings = {} } = {}) {
  const routes = new Map(), effects = [], settingDisposers = [];
  mock.method(globalThis, 'fetch', () => { throw Error('ISOLATION: unexpected network'); });
  mock.method(fs, 'readFileSync', () => { throw Error('ISOLATION: unexpected real file read'); });
  const ctx = {
    credentials: { async resolve() { return undefined; }, async set() {} },
    connection: { requestRejection: () => rejection },
    webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path); } },
    inject(names, callback) {
      if (names[0] === 'llm') callback({ llm: {}, effect(fn) { effects.push(fn()); } });
      else callback({ settings, effect(fn) { settingDisposers.push(fn()); } });
    },
    effect(fn) { effects.push(fn()); },
  };
  createPlugin({ runKeyImport }).apply({ inject(names, callback) { callback(ctx); } });
  return {
    settings, routes,
    async request(body, { method = 'POST', raw, route = ROUTE } = {}) {
      const req = Readable.from([Buffer.from(raw ?? JSON.stringify(body))]);
      req.method = method; req.url = route;
      const response = { status: 0, headers: {}, body: null };
      const res = { writeHead(status, headers) { response.status = status; response.headers = headers; }, end(text) { response.body = JSON.parse(text); } };
      await routes.get(route)(req, res);
      return response;
    },
    dispose() { for (const dispose of [...effects, ...settingDisposers]) dispose(); },
  };
}

test('models route reads and writes through the injected Settings service', async () => {
  const settings = settingsFixture();
  const f = fixture(async () => ({ ok: true }), { settings });
  const read = await f.request(null, { method: 'GET' });
  assert.equal(read.status, 200);
  assert.equal(read.body.ok, true);
  assert.equal(read.body.models[0].id, 'Kimi-K3');
  const write = await f.request({ revision: 4, models: [{ id: 'Kimi-K3', name: 'K3', contextWindow: 32000, maxTokens: 2048, input: ['text'] }] });
  assert.equal(write.status, 200);
  assert.equal(write.body.ok, true);
  assert.deepEqual(settings.writes[0].patch.providers.paratera.models, [{ id: 'Kimi-K3', name: 'K3', contextWindow: 32000, maxTokens: 2048, input: ['text'] }]);
  f.dispose();
});

test('diagnostics route reports versions, services and the client heartbeat', async () => {
  const f = fixture(async () => ({ ok: true }), { settings: settingsFixture() });
  const diag = await f.request(null, { method: 'GET', route: '/tsinghua-paratera/api/diagnostics' });
  assert.equal(diag.status, 200);
  assert.equal(diag.body.ok, true);
  assert.equal(typeof diag.body.plugin.version, 'string');
  assert.equal(diag.body.services.settings, true);
  assert.equal(diag.body.services.llm, true);
  assert.equal(diag.body.client.lastSeenAt, null);
  const wrong = await f.request({}, { method: 'POST', route: '/tsinghua-paratera/api/diagnostics' });
  assert.equal(wrong.status, 405);
  const hello = await f.request({}, { method: 'POST', route: '/tsinghua-paratera/api/diagnostics/hello' });
  assert.equal(hello.status, 200);
  assert.equal(hello.body.ok, true);
  const again = await f.request(null, { method: 'GET', route: '/tsinghua-paratera/api/diagnostics' });
  assert.ok(again.body.client.ageMs >= 0);
  f.dispose();
});

test('models route rejects anonymous, wrong-method and malformed bodies', async () => {
  const anonymous = fixture(async () => ({ ok: true }), { rejection: 401 });
  assert.equal((await anonymous.request(null, { method: 'GET' })).status, 401);
  anonymous.dispose();
  const f = fixture(async () => ({ ok: true }), { settings: settingsFixture() });
  assert.equal((await f.request(null, { method: 'PUT' })).status, 405);
  assert.equal((await f.request(null, { raw: '{' })).status, 400);
  assert.equal((await f.request({ models: 'nope' })).status, 400);
  f.dispose();
});
