import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { revealKeySecret, keyPageExpression } from '../lib/reveal.mjs';
import { CONSOLE_ORIGIN } from '../lib/console.mjs';

const SECRET = 'sk-TEST_ONLY_0123456789abcdef';
const reply = (value) => ({ result: { result: { value } } });
const key = (uuid = 'selected-id', name = 'selected') => ({ uuid, name });
const classList = (...classes) => ({ contains: (name) => classes.includes(name) });

// Tiny DOM doubles execute the actual serialized page function, not a regex
// approximation of its result. No browser, network or on-disk sessions are used.
function makeRow({ uuid, name, secret = SECRET, eye = true, revealed = false, nameTitle, button = false, nameAt = 0 } = {}) {
  const state = { clicks: 0, revealed };
  const nameCell = { innerText: name, querySelectorAll: () => nameTitle ? [{ getAttribute: () => nameTitle }] : [] };
  const secretCell = {
    get innerText() { return state.revealed ? secret : 'sk-********'; },
    querySelectorAll: () => [],
  };
  const cells = [...Array(nameAt).fill(null).map(() => ({ innerText: '', querySelectorAll: () => [] })), nameCell, secretCell];
  // Real rows wrap the eye in an antd link button; other fixtures use a bare span.
  const control = button ? { click() { state.clicks += 1; state.revealed = true; } } : null;
  const icon = {
    closest: (selector) => control && selector === 'button,a' ? control : secretCell,
    dispatchEvent() { state.clicks += 1; state.revealed = true; },
  };
  return {
    state, classList: classList(),
    get innerText() { return name + '\n' + secretCell.innerText; },
    getAttribute: (attribute) => attribute === 'data-row-key' ? uuid : null,
    querySelectorAll: (selector) => selector === 'td' ? cells : [],
    querySelector(selector) {
      if (selector === 'td') return nameCell;
      if (!eye) return null;
      if (selector.includes('eye-invisible')) return state.revealed ? null : icon;
      if (selector.includes('eye')) return state.revealed ? icon : null;
      return null;
    },
  };
}

function fixture({ pages = [[makeRow({ uuid: 'selected-id', name: 'selected' })]], keys = [key()], stuck = false, disconnect = false, timeout = false, initialPage = 0, headers = ['名称', 'API Key'], renderDelay = 0 } = {}) {
  const events = [];
  let page = initialPage;
  let pendingPage = null;
  let loading = 0;
  const go = (target) => {
    if (stuck) return;
    if (renderDelay) { pendingPage = target; loading = renderDelay; }
    else page = target;
  };
  const next = {
    get classList() { return classList(...(page + 1 >= pages.length ? ['ant-pagination-disabled'] : [])); },
    getAttribute: () => null,
    querySelector: () => null,
    click() { events.push('next'); go(page + 1); },
  };
  const first = {
    get classList() { return classList(...(page === 0 ? ['ant-pagination-item-active'] : [])); },
    querySelector: () => null,
    click() { events.push('first'); go(0); },
  };
  const document = {
    readyState: 'complete',
    querySelectorAll(selector) {
      if (selector === '.ant-table-tbody tr') return pages[page];
      if (selector === '.ant-table-thead th') return headers.map((innerText) => ({ innerText }));
      return [];
    },
    querySelector(selector) {
      if (selector === '.ant-pagination-next') return next;
      if (selector === '.ant-pagination-item-1') return pages.length > 1 ? first : null;
      if (selector === '.ant-spin-spinning' && pendingPage !== null) {
        if (loading-- > 0) return {};
        page = pendingPage;
        pendingPage = null;
      }
      return null;
    },
  };
  const context = { document, location: { origin: CONSOLE_ORIGIN, hash: '' }, MouseEvent: function (type, options) { return { type, ...options }; } };
  const deps = {
    pending: () => ({ pending: false }),
    acquire: () => { events.push('lock'); return () => events.push('release'); },
    open: async () => {
      events.push('open');
      return { send: async (method, { expression }) => {
        assert.equal(method, 'Runtime.evaluate');
        if (disconnect) return { __cdpClosed: true };
        if (timeout) throw Error('cdp-timeout');
        return reply(vm.runInNewContext(expression, context));
      } };
    },
    close: async () => events.push('close'),
    authenticate: async () => { events.push('authenticate'); return { ok: true }; },
    list: async () => ({ ok: true, keys }),
    pause: async () => {},
  };
  return { events, deps, pages, context };
}

test('reveal uses one locked browser and finds a UUID outside the first table page', async () => {
  const other = makeRow({ uuid: 'other-id', name: 'other' });
  const selected = makeRow({ uuid: 'selected-id', name: 'selected' });
  const { deps, events } = fixture({ pages: [[other], [selected]], keys: [key('other-id', 'other'), key()] });
  assert.deepEqual(await revealKeySecret({ uuid: 'selected-id', name: 'selected' }, deps), { ok: true, secret: SECRET });
  assert.deepEqual(events, ['lock', 'open', 'authenticate', 'next', 'close', 'release']);
  assert.equal(other.state.clicks, 0);
  assert.equal(selected.state.clicks, 1);
});

test('attached page starting after page one resets before searching with delayed table renders', async () => {
  const selected = makeRow({ uuid: 'selected-id', name: 'selected' });
  const other = makeRow({ uuid: 'other-id', name: 'other' });
  const { deps, events } = fixture({ pages: [[selected], [other]], initialPage: 1, renderDelay: 3 });
  assert.equal((await revealKeySecret('selected', deps)).secret, SECRET);
  assert.deepEqual(events, ['lock', 'open', 'authenticate', 'first', 'close', 'release']);
  assert.equal(other.state.clicks, 0);
});

test('normal next-page search waits through loading rather than inspecting stale rows', async () => {
  const other = makeRow({ uuid: 'other-id', name: 'other' });
  const selected = makeRow({ uuid: 'selected-id', name: 'selected' });
  const { deps } = fixture({ pages: [[other], [selected]], renderDelay: 3 });
  assert.equal((await revealKeySecret('selected', deps)).secret, SECRET);
  assert.equal(other.state.clicks, 0);
});

test('legacy string and second-parameter UUID forms remain compatible', async () => {
  for (const supplied of ['selected', { uuid: 'selected-id' }]) {
    const { deps } = fixture();
    assert.equal((await revealKeySecret(supplied, deps)).secret, SECRET);
  }
  const { deps } = fixture();
  assert.equal((await revealKeySecret('selected', { ...deps, uuid: 'selected-id' })).secret, SECRET);
});

test('unique-name fallback uses exact cells, never includes/substring selection', async () => {
  const prefix = makeRow({ uuid: '0', name: 'selected-extra' });
  const selected = makeRow({ uuid: '1', name: 'selected' });
  const { deps } = fixture({ pages: [[prefix, selected]], keys: [key(), key('other-id', 'selected-extra')] });
  assert.equal((await revealKeySecret('selected', deps)).secret, SECRET);
  assert.equal(prefix.state.clicks, 0);
  assert.equal(selected.state.clicks, 1);
});

test('name fallback is confined to the named column, not a matching status/secret/action cell', async () => {
  const wrong = makeRow({ uuid: '0', name: 'other', secret: 'selected', revealed: true });
  const { deps } = fixture({ pages: [[wrong]] });
  assert.deepEqual(await revealKeySecret('selected', deps), { ok: false, error: 'row-not-found' });
  assert.equal(wrong.state.clicks, 0);
});

test('name fallback supports full titles on truncated name cells and fails closed without a name header', async () => {
  const selected = makeRow({ uuid: '0', name: 'sele...', nameTitle: 'selected' });
  const titled = fixture({ pages: [[selected]], headers: ['API Key 名称', 'API Key'] });
  assert.equal((await revealKeySecret('selected', titled.deps)).secret, SECRET);
  const missing = fixture({ pages: [[selected]], headers: ['未知列', 'API Key'] });
  assert.deepEqual(await revealKeySecret('selected', missing.deps), { ok: false, error: 'key-name-column-not-found' });
});

test('the console 名称/描述 column is recognised and the eye is clicked through its button', async () => {
  const selected = makeRow({ uuid: '0', name: 'selected', button: true, nameAt: 3 });
  const { deps } = fixture({
    pages: [[selected]],
    keys: [key('selected-id', 'selected')],
    headers: ['密钥', '支持模型', '状态', '名称/描述', '创建时间', '操作'],
  });
  assert.equal((await revealKeySecret('selected', deps)).secret, SECRET);
  assert.equal(selected.state.clicks, 1);
  const missing = makeRow({ uuid: '0', name: 'selected' });
  const unrelated = fixture({ pages: [[missing]], keys: [key('selected-id', 'selected')], headers: ['支持模型', '操作'] });
  assert.deepEqual(await revealKeySecret('selected', unrelated.deps), { ok: false, error: 'key-name-column-not-found' });
});

test('duplicate UUID DOM rows fail closed without clicking any eye', async () => {
  const one = makeRow({ uuid: 'selected-id', name: 'selected' });
  const two = makeRow({ uuid: 'selected-id', name: 'other' });
  const { deps } = fixture({ pages: [[one, two]] });
  assert.deepEqual(await revealKeySecret('selected', deps), { ok: false, error: 'ambiguous-key-row' });
  assert.equal(one.state.clicks + two.state.clicks, 0);
});

test('duplicate names require UUID; known UUID rows can be selected across pages', async () => {
  const first = makeRow({ uuid: 'first-id', name: 'duplicate' });
  const selected = makeRow({ uuid: 'selected-id', name: 'duplicate' });
  const options = { pages: [[first], [selected]], keys: [key('first-id', 'duplicate'), key('selected-id', 'duplicate')] };
  const ambiguous = fixture(options);
  assert.deepEqual(await revealKeySecret('duplicate', ambiguous.deps), { ok: false, error: 'ambiguous-key-name' });
  assert.equal(first.state.clicks, 0);
  const matched = fixture(options);
  assert.equal((await revealKeySecret({ uuid: 'selected-id', name: 'duplicate' }, matched.deps)).secret, SECRET);
  assert.equal(first.state.clicks, 0);
  assert.equal(selected.state.clicks, 1);
});

test('duplicate names with index rowKeys fail closed rather than reveal the wrong key', async () => {
  const wrong = makeRow({ uuid: '0', name: 'duplicate' });
  const { deps } = fixture({ pages: [[wrong]], keys: [key('first-id', 'duplicate'), key('selected-id', 'duplicate')] });
  assert.deepEqual(await revealKeySecret({ uuid: 'selected-id', name: 'duplicate' }, deps), { ok: false, error: 'ambiguous-key-name' });
  assert.equal(wrong.state.clicks, 0);
});

test('known different UUID never falls back to an identically named row', async () => {
  const wrong = makeRow({ uuid: 'other-id', name: 'selected' });
  const { deps } = fixture({ pages: [[wrong]], keys: [key(), key('other-id', 'other')] });
  assert.deepEqual(await revealKeySecret({ uuid: 'selected-id', name: 'selected' }, deps), { ok: false, error: 'row-not-found' });
  assert.equal(wrong.state.clicks, 0);
});

test('no eye icon never falls back to an arbitrary operation link', async () => {
  const selected = makeRow({ uuid: 'selected-id', name: 'selected', eye: false });
  const { deps } = fixture({ pages: [[selected]] });
  assert.deepEqual(await revealKeySecret('selected', deps), { ok: false, error: 'no-eye' });
  assert.equal(selected.state.clicks, 0);
});

test('a secret-shaped key name is not read as plaintext from the whole row', async () => {
  const selected = makeRow({ uuid: 'selected-id', name: SECRET, secret: 'sk-****' });
  const { deps } = fixture({ pages: [[selected]], keys: [key('selected-id', SECRET)] });
  assert.deepEqual(await revealKeySecret(SECRET, deps), { ok: false, error: 'secret-not-revealed' });
});

test('already visible secret is not hidden by another eye click', async () => {
  const selected = makeRow({ uuid: 'selected-id', name: 'selected', revealed: true });
  const { deps } = fixture({ pages: [[selected]] });
  assert.equal((await revealKeySecret('selected', deps)).secret, SECRET);
  assert.equal(selected.state.clicks, 0);
});

test('CDP timeout/disconnect finish and always close/release without leaking errors', async () => {
  for (const [options, error] of [[{ disconnect: true }, 'cdp-closed'], [{ timeout: true }, 'cdp-timeout']]) {
    const { deps, events } = fixture(options);
    assert.deepEqual(await revealKeySecret('selected', deps), { ok: false, error });
    assert.deepEqual(events.slice(-2), ['close', 'release']);
  }
});

test('pagination stops on unchanged rows and at configured page bound', async () => {
  const pages = [[makeRow({ uuid: 'other-id', name: 'other' })], [makeRow({ uuid: 'selected-id', name: 'selected' })]];
  const stuck = fixture({ pages, stuck: true });
  assert.deepEqual(await revealKeySecret('selected', stuck.deps), { ok: false, error: 'keys-pagination-stalled' });
  const bounded = fixture({ pages });
  assert.deepEqual(await revealKeySecret('selected', { ...bounded.deps, maxPages: 1 }), { ok: false, error: 'keys-pagination-limit' });
});

test('busy, invalid arguments and parked second factor never open/modify a browser', async () => {
  const { deps, events } = fixture();
  for (const input of [null, {}, '', { uuid: 123 }, { name: ' ' }]) {
    assert.deepEqual(await revealKeySecret(input, deps), { ok: false, error: 'invalid-arguments' });
  }
  assert.deepEqual(await revealKeySecret('selected', { ...deps, acquire: () => null }), { ok: false, error: 'refresh-busy' });
  assert.deepEqual(await revealKeySecret('selected', { ...deps, pending: () => ({ pending: true }) }), { ok: false, error: 'second-factor-pending' });
  assert.deepEqual(events, []);
});

test('page inspection fingerprints do not return unrelated already-visible key secrets', () => {
  const unrelated = makeRow({ uuid: 'other-id', name: 'other', secret: 'sk-UNRELATED_TEST_ONLY_SECRET', revealed: true });
  const { context } = fixture({ pages: [[unrelated]] });
  const expression = keyPageExpression({ uuid: 'selected-id', name: 'selected', uniqueName: true, knownUuids: ['selected-id', 'other-id'] });
  const result = vm.runInNewContext(expression, context);
  assert.equal(result.found, false);
  assert.doesNotMatch(JSON.stringify(result), /UNRELATED_TEST_ONLY_SECRET/);
});

test('page evaluation refuses a different origin before inspecting/clicking DOM', () => {
  const expression = keyPageExpression({ uuid: 'selected-id', name: 'selected', uniqueName: true, knownUuids: ['selected-id'] });
  const result = vm.runInNewContext(expression, { location: { origin: 'https://untrusted.invalid' } });
  assert.equal(result.error, 'untrusted-console-page');
});

test('authentication/list failures and thrown errors all release browser ownership', async () => {
  for (const failure of ['authenticate', 'list']) {
    const { deps, events } = fixture();
    deps[failure] = async () => ({ ok: false, error: 'mock-failure' });
    assert.deepEqual(await revealKeySecret('selected', deps), { ok: false, error: 'mock-failure' });
    assert.deepEqual(events.slice(-2), ['close', 'release']);
  }
  const { deps, events } = fixture();
  deps.authenticate = async () => { throw Error('TEST_SECRET_MUST_NOT_ESCAPE'); };
  assert.deepEqual(await revealKeySecret('selected', deps), { ok: false, error: 'key-reveal-failed' });
  assert.deepEqual(events.slice(-2), ['close', 'release']);
});
