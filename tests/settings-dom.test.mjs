// Optional real installed React + disposable DOM acceptance. No server starts,
// no user profile is read, and every request is a fixed in-memory fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { browserSdk } from './browser-sdk.mjs';

const sdkRoot = process.env.DSH_SDK_NODE_MODULES;
const CLIENT = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const OPERATION = '11111111-1111-4111-8111-111111111111';
const MODELS = Array.from({ length: 205 }, (_, index) => `research/model-${String(index).padStart(3, '0')}`);
const fakeSecret = 'sk-FAKE-NEVER-RETURNED-TO-PAGE-0123456789';

async function until(read, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`DOM did not settle: ${label}`);
}

function capture(page, filename) {
  const directory = process.env.DSH_UI_CAPTURE_DIR;
  if (!directory) return;
  const style = page.window.document.createElement('style');
  style.textContent = 'html{color-scheme:light}body{margin:0;background:#f3f5f8;color:#172337;font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}#test{max-width:900px;margin:24px auto;padding:24px;background:#fff;border:1px solid #dce3ec;border-radius:16px}input,button{font:inherit}button,a{cursor:pointer}*{box-sizing:border-box}';
  page.window.document.head.append(style);
  const viewport = page.window.document.createElement('meta');
  viewport.name = 'viewport'; viewport.content = 'width=device-width,initial-scale=1';
  page.window.document.head.append(viewport);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, filename), page.serialize());
  style.remove(); viewport.remove();
}

test('installed React settings retain model filtering after creation and submit only the explicit selection', { skip: !sdkRoot }, async () => {
  const browser = await browserSdk(sdkRoot);
  const { modules, page } = browser;
  const React = modules.react;
  const dom = modules['react-dom'];
  const { createRoot } = modules['react-dom/client'];
  const calls = [];
  let session = null;
  let entry;
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  const request = async (url, options = {}) => {
    assert.match(String(url), /^\/tsinghua-paratera\/api\//, 'no external network');
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method || 'GET', body });
    if (url.endsWith('/keys/defaults')) return reply({ ok: true, name: 'TEST-LAPTOP' });
    if (url.endsWith('/keys/create-import/status')) return reply({ ok: true, session });
    if (url.endsWith('/keys/create-import/prepare')) {
      assert.equal(body.name, 'TEST-LAPTOP');
      assert.match(body.requestId, /^[a-zA-Z0-9-]{16,80}$/);
      session = {
        operationId: OPERATION, name: body.name, stage: 'awaiting-selection',
        models: MODELS, selectedModels: [], expiresAt: Date.now() + 600000,
        fingerprint: 'sha256:0123456789ab', canCommit: true, canCancel: true, cleanupRequired: true,
      };
      return reply({ ok: true, session });
    }
    if (url.endsWith('/keys/create-import/commit')) {
      assert.deepEqual(body, { operationId: OPERATION, models: [MODELS[204]] });
      const result = { ok: true, credentialImported: true, modelConfigUpdated: true, providerRegistered: true, modelsAvailable: true, modelsAdded: [MODELS[204]], verifiedModels: MODELS.length };
      session = { ...session, stage: 'completed', selectedModels: body.models, canCommit: false, canCancel: false, cleanupRequired: false, result };
      return reply({ ok: true, session, result });
    }
    if (url.endsWith('/keys')) return reply({ ok: true, keys: [{ uuid: 'EXISTING_FAKE_ID', name: '已有设备', status: 'valid', models: [MODELS[0]], masked: '****' }] });
    if (url.endsWith('/console/status')) return reply({ ok: true, connected: true });
    if (url.endsWith('/credentials/status')) return reply({ ok: true, saved: false, canRemove: true });
    if (url.endsWith('/2fa/status')) return reply({ ok: true, pending: false });
    if (url.endsWith('/status')) return reply({ ok: true, tokenValid: true, snapshot: { couponFree: 123.45, couponUsed: 10 }, tokenExpiresAt: Date.now() + 3600000 });
    return reply({ ok: true });
  };
  vm.runInNewContext(CLIENT, {
    window: { __ModuleLoader__: { load(value) { entry = value; } } }, document: page.window.document,
    AbortController, DOMException, setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: globalThis.crypto, fetch: request, console,
  });
  const plugin = entry.factory(() => React);
  let Section;
  plugin.apply({ slots: {
    inject(_, callback) { callback(); },
    register(spec, Component) { if (spec.name === 'settings.section') Section = Component; return () => {}; },
  } });
  assert.equal(typeof Section, 'function');
  const container = page.window.document.getElementById('test');
  const root = createRoot(container);
  const button = (pattern) => [...container.querySelectorAll('button')].find((node) => pattern.test(node.textContent) && !node.disabled);
  const click = (node) => { assert.ok(node, 'expected actionable element'); dom.flushSync(() => node.click()); };
  const fill = (node, value) => {
    assert.ok(node, 'expected input');
    dom.flushSync(() => {
      Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, 'value').set.call(node, value);
      node.dispatchEvent(new page.window.Event('input', { bubbles: true }));
      node.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    });
  };
  try {
    dom.flushSync(() => root.render(React.createElement(Section)));
    const launch = await until(() => button(/新建并导入|创建设备密钥|新建设备密钥/), 'create action');
    click(launch);
    const name = await until(() => container.querySelector('[aria-label="密钥名称/描述"]') || container.querySelector('#paratera-key-name'), 'device name');
    await until(() => name.value === 'TEST-LAPTOP', 'hostname default');
    const form = name.closest('form');
    assert.ok(form);
    dom.flushSync(() => form.dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true })));
    const filter = await until(() => container.querySelector('[aria-label="过滤模型"]'), 'model picker');
    assert.equal(calls.filter((call) => call.url.endsWith('/prepare')).length, 1);
    assert.equal(calls.filter((call) => call.url.endsWith('/commit')).length, 0, 'creation must not import all models');
    assert.equal(container.querySelectorAll('input[type="checkbox"]:checked').length, 0, 'no preselected models');
    capture(page, 'settings-selection.html');
    fill(filter, 'model-204');
    await until(() => [...container.querySelectorAll('label')].filter((label) => label.querySelector('input[type="checkbox"]')).length === 1, 'filter beyond candidate 200');
    click(await until(() => button(/全选筛选|全选当前|全选.*筛选|全选.*1/), 'filtered select all'));
    await until(() => container.querySelectorAll('input[type="checkbox"]:checked').length === 1, 'one selected');
    assert.equal(calls.filter((call) => call.url.endsWith('/commit')).length, 0);
    capture(page, 'settings-filtered.html');
    click(await until(() => button(/导入所选模型|导入并添加|确认导入/), 'commit selection'));
    await until(() => calls.some((call) => call.url.endsWith('/commit')), 'commit request');
    await until(() => /导入完成|已导入|已加入模型/.test(container.textContent), 'completion notice');
    assert.equal(calls.filter((call) => call.url.endsWith('/commit')).length, 1);
    assert.equal(calls.filter((call) => call.url.endsWith('/prepare')).length, 1);
    assert.equal(container.textContent.includes(fakeSecret), false);
    assert.equal(calls.some((call) => call.url === '/tsinghua-paratera/api/keys/import'), false, 'no obsolete reveal route');
    capture(page, 'settings-completed.html');
  } finally {
    dom.flushSync(() => root.unmount());
    browser.dispose();
  }
});
