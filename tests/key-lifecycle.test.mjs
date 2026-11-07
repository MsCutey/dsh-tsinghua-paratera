import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runKeyLifecycle, parseArguments, openReceipt, main } from '../scripts/verify-key-lifecycle.mjs';

const EXISTING = { uuid: 'EXISTING+ID/==', name: 'existing-key-do-not-touch' };
const NEW_ID = 'NEW+ID/==';
const full = (keys) => ({ ok: true, keys: keys.map((key) => ({ ...key })), total: keys.length });
function harness() {
  const calls = { list: 0, create: [], remove: [], receipts: [] };
  const state = { keys: [{ ...EXISTING }], name: undefined };
  const deps = {
    live: true, confirmCreateDelete: true,
    list: async () => { calls.list += 1; return full(state.keys); },
    create: async (name) => { calls.create.push(name); state.name = name; state.keys.push({ uuid: NEW_ID, name }); return { ok: true }; },
    remove: async (uuid) => { calls.remove.push(uuid); assert.notEqual(uuid, EXISTING.uuid); state.keys = state.keys.filter((key) => key.uuid !== uuid); return { ok: true }; },
    receipt: async (value) => { calls.receipts.push({ ...value }); },
  };
  return { calls, state, deps };
}
const noExistingDeletion = (h) => assert.equal(h.calls.remove.includes(EXISTING.uuid), false);

test('both strict opt-ins are required before dependencies or state can be touched', async () => {
  for (const options of [{}, { live: true }, { confirmCreateDelete: true }, { live: 'true', confirmCreateDelete: true }]) {
    const fail = () => assert.fail('not opted in must not read state or mutate');
    assert.deepEqual(await runKeyLifecycle({ ...options, list: fail, create: fail, remove: fail, receipt: fail }), { ok: true, skipped: true, stage: 'not-opted-in' });
  }
  for (const args of [[], ['--help'], ['--live'], ['--confirm-create-delete'], ['--live', '--confirm-create-delete', '--help']]) {
    const lines = [];
    assert.equal(await main(args, { load: () => assert.fail('must not import session library'), output: (line) => lines.push(line) }), 0);
    assert.match(lines.join('\n'), /Skipped by default/);
  }
});

test('CLI cannot select an existing UUID or name and rejects unknown inputs before import', async () => {
  for (const args of [['--uuid', EXISTING.uuid], ['--name', EXISTING.name], ['--receipt'], ['--live', '--confirm-create-delete', '--anything']]) {
    assert.equal(await main(args, { load: () => assert.fail('invalid args cannot import'), output() {} }), 2);
  }
  assert.equal(parseArguments(['--live', '--confirm-create-delete']).confirmCreateDelete, true);
});

test('happy lifecycle creates and removes exactly one uniquely identified new UUID', async () => {
  const h = harness();
  const result = await runKeyLifecycle(h.deps);
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'complete');
  assert.equal(result.cleanupRequired, false);
  assert.match(h.calls.create[0], /^dsh-test-[0-9a-f]{20}$/);
  assert.ok(h.calls.create[0].length <= 30);
  assert.equal(h.calls.create.length, 1);
  assert.deepEqual(h.calls.remove, [NEW_ID]);
  assert.equal(h.calls.list, 3);
  assert.deepEqual(h.state.keys, [EXISTING]);
  assert.deepEqual(Object.keys(h.calls.receipts.at(-1)).sort(), ['name', 'stage', 'uuid']);
  assert.equal(h.calls.receipts.at(-1).stage, 'complete');
  noExistingDeletion(h);
});

test('random dedicated names are unique across independent runs', async () => {
  const a = await runKeyLifecycle(harness().deps);
  const b = await runKeyLifecycle(harness().deps);
  assert.notEqual(a.testName, b.testName);
});

test('baseline failure, pagination error, partial or duplicate list cannot create or delete', async () => {
  for (const response of [
    { ok: false, error: 'keys-pagination-stalled' }, { ok: false, error: 'keys-pagination-limit' },
    { ok: true, keys: [], total: 1 }, { ok: true, keys: [] },
    full([EXISTING, EXISTING]), full([{ uuid: 'sk-FAKE_SECRET', name: 'bad' }]),
  ]) {
    const h = harness(); h.deps.list = async () => response;
    const result = await runKeyLifecycle(h.deps);
    assert.equal(result.ok, false); assert.equal(result.stage, 'baseline');
    assert.equal(result.cleanupRequired, false);
    assert.deepEqual(h.calls.create, []); assert.deepEqual(h.calls.remove, []);
  }
  const h = harness(); h.deps.list = async () => { throw Error('FAKE_RAW_SECRET'); };
  assert.equal((await runKeyLifecycle(h.deps)).error, 'list-failed');
  assert.deepEqual(h.calls.create, []);
});

test('quota, generic create failure or uncertain create never retries or deletes', async () => {
  for (const kind of ['key-quota-exceeded', 'console-api-error', 'console-timeout', 'throw', 'malformed']) {
    const h = harness();
    h.deps.create = async (name) => {
      h.calls.create.push(name); h.state.keys.push({ uuid: NEW_ID, name });
      if (kind === 'throw') throw Error('FAKE_RAW_SECRET');
      return kind === 'malformed' ? { raw: 'FAKE_RAW_SECRET' } : { ok: false, error: kind, raw: 'FAKE_RAW_SECRET' };
    };
    const result = await runKeyLifecycle(h.deps);
    assert.equal(result.ok, false); assert.equal(result.cleanupRequired, true);
    assert.equal(h.calls.create.length, 1); assert.equal(h.calls.list, 1);
    assert.deepEqual(h.calls.remove, []);
    assert.doesNotMatch(JSON.stringify(result), /FAKE_RAW_SECRET/);
  }
});

test('post-create list failure, incomplete pagination or ambiguity never deletes', async () => {
  for (const kind of ['failure', 'pagination', 'partial', 'missing', 'duplicate-name', 'reused-existing-id', 'throw']) {
    const h = harness();
    const list = h.deps.list;
    h.deps.list = async () => {
      if (!h.state.name) return list();
      if (kind === 'throw') throw Error('FAKE_RAW_SECRET');
      if (kind === 'failure') return { ok: false, error: 'console-network-error' };
      if (kind === 'pagination') return { ok: false, error: 'keys-pagination-limit' };
      if (kind === 'partial') return { ok: true, keys: [], total: 1 };
      if (kind === 'missing') return full([EXISTING]);
      if (kind === 'duplicate-name') return full([EXISTING, { uuid: NEW_ID, name: h.state.name }, { uuid: 'ANOTHER_NEW', name: h.state.name }]);
      return full([{ ...EXISTING, name: h.state.name }]);
    };
    const result = await runKeyLifecycle(h.deps);
    assert.equal(result.ok, false); assert.equal(result.stage, 'identify');
    assert.equal(result.cleanupRequired, true); assert.equal(h.calls.create.length, 1);
    assert.deepEqual(h.calls.remove, []); noExistingDeletion(h);
  }
});

test('delete failures and unknown responses stop after one remove with recovery name', async () => {
  for (const kind of ['key-delete-not-deleted', 'key-delete-unconfirmed', 'console-http-500', 'throw', 'malformed']) {
    const h = harness();
    h.deps.remove = async (uuid) => {
      h.calls.remove.push(uuid);
      if (kind === 'throw') throw Error('FAKE_RAW_SECRET');
      return kind === 'malformed' ? { raw: 'FAKE_RAW_SECRET' } : { ok: false, error: kind, raw: 'FAKE_RAW_SECRET' };
    };
    const result = await runKeyLifecycle(h.deps);
    assert.equal(result.ok, false); assert.equal(result.cleanupRequired, true);
    assert.equal(result.testName, h.state.name);
    assert.deepEqual(h.calls.remove, [NEW_ID]); assert.equal(h.calls.list, 2);
    assert.doesNotMatch(JSON.stringify(result), /FAKE_RAW_SECRET/); noExistingDeletion(h);
  }
});

test('final verification rejects failed/partial lists, surviving UUID and rotated opaque ID', async () => {
  for (const kind of ['failure', 'partial', 'same-id', 'rotated-id', 'throw']) {
    const h = harness();
    const list = h.deps.list;
    h.deps.list = async () => {
      if (h.calls.remove.length === 0) return list();
      if (kind === 'throw') throw Error('FAKE_RAW_SECRET');
      if (kind === 'failure') return { ok: false, error: 'keys-pagination-stalled' };
      if (kind === 'partial') return { ok: true, keys: [], total: 1 };
      return full([EXISTING, { uuid: kind === 'same-id' ? NEW_ID : 'ROTATED+ID/==', name: h.state.name }]);
    };
    const result = await runKeyLifecycle(h.deps);
    assert.equal(result.ok, false); assert.equal(result.stage, 'verify');
    assert.equal(h.calls.create.length, 1); assert.deepEqual(h.calls.remove, [NEW_ID]);
    noExistingDeletion(h);
  }
});

test('receipt write failure before create/deletion blocks the following mutation', async () => {
  for (const stage of ['before-create', 'created-unidentified', 'before-delete']) {
    const h = harness();
    h.deps.receipt = async (value) => { if (value.stage === stage) throw Error('FAKE_RAW_SECRET'); };
    const result = await runKeyLifecycle(h.deps);
    assert.equal(result.error, 'receipt-write-failed');
    assert.equal(h.calls.create.length, stage === 'before-create' ? 0 : 1);
    assert.deepEqual(h.calls.remove, []);
  }
});

test('live main still uses injected fake functions, publishes recovery name before create and redacts raw errors', async () => {
  const h = harness(); const lines = [];
  const create = h.deps.create;
  const code = await main(['--live', '--confirm-create-delete'], {
    load: async () => ({ listKeys: h.deps.list, createKey: async (name) => {
      assert.match(lines[0], /before-create/); assert.match(lines[0], new RegExp(name));
      await create(name); return { ok: false, error: 'UNKNOWN_FAKE_SECRET', raw: 'FAKE_RAW_SECRET' };
    }, deleteKey: h.deps.remove }), output: (line) => lines.push(line),
  });
  assert.equal(code, 1); assert.equal(h.calls.create.length, 1); assert.deepEqual(h.calls.remove, []);
  assert.doesNotMatch(lines.join('\n'), /UNKNOWN_FAKE_SECRET|FAKE_RAW_SECRET|EXISTING/);
  assert.match(lines.join('\n'), /do not retry automatically/);
});

test('receipt is opt-in, own metadata only, no overwrite, confined to .artifacts', () => {
  const root = fileURLToPath(new URL('../.artifacts/', import.meta.url));
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'lifecycle-fixture-'));
  const receipt = path.join(directory, 'receipt.json');
  try {
    for (const invalid of ['README.md', '.artifacts', '../outside-receipt.json']) assert.throws(() => openReceipt(invalid));
    const writer = openReceipt(receipt);
    try {
      writer.write({ name: 'dsh-lifecycle-test-FAKE', stage: 'before-create', raw: 'FAKE_RAW_SECRET' });
      writer.write({ name: 'dsh-lifecycle-test-FAKE', uuid: NEW_ID, stage: 'complete', raw: 'FAKE_RAW_SECRET' });
    } finally { writer.close(); }
    const saved = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.deepEqual(saved, { name: 'dsh-lifecycle-test-FAKE', uuid: NEW_ID, stage: 'complete' });
    assert.throws(() => openReceipt(receipt));
  } finally {
    assert.equal(path.dirname(directory), path.resolve(root));
    assert.match(path.basename(directory), /^lifecycle-fixture-/);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
