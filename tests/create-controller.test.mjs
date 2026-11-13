// Entirely fake keys, credentials, gateway, clocks and timers. No profile reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImportController, CREATE_SESSION_TTL_MS } from '../lib/create-session.mjs';

const SECRET = 'sk-fake-controller-one-time-0123456789';
const OLD = 'sk-fake-controller-old-key-9876543210';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const OP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const safe = (value) => { assert.ok(!JSON.stringify(value).includes(SECRET)); assert.ok(!JSON.stringify(value).includes(OLD)); assert.ok(!JSON.stringify(value).includes('raw-sensitive')); };
function fixture(overrides = {}) {
  let at = 100;
  const timers = new Map();
  const calls = { create: [], verify: [], remove: [], writes: [], apply: [], lists: 0, unref: 0 };
  const f = { rows: [{ uuid: 'existing-id', name: 'device', status: 'valid' }], models: ['model-a', 'model-b'],
    stored: new Map([['PARATERA_API_KEY', OLD]]), failWrite: false, failApply: false, partial: false };
  const credentials = {
    async resolve(ref) { return f.stored.has(ref) ? { value: f.stored.get(ref) } : null; },
    async set(ref, value) { calls.writes.push(ref); if (f.failWrite && ref === 'PARATERA_API_KEY') throw Error('raw-sensitive'); f.stored.set(ref, value); },
  };
  const deps = {
    defaultName: () => 'device', newId: () => OP, now: () => at,
    setTimer(fn, ms) { const timer = { fn, at: at + ms, unref() { calls.unref++; } }; timers.set(timer, timer); return timer; },
    clearTimer(timer) { timers.delete(timer); },
    async list() { calls.lists++; return { ok: true, keys: structuredClone(f.rows), total: f.rows.length, ...(f.partial ? { partial: true } : {}) }; },
    async create(name) { calls.create.push(name); f.rows.push({ uuid: 'new-id', name, status: 'valid' }); return { ok: true, secret: SECRET, raw: 'raw-sensitive' }; },
    async verify(secret) { calls.verify.push(secret); return { ok: true, modelIds: f.models, models: f.models.length, raw: 'raw-sensitive' }; },
    async remove(uuid) { calls.remove.push(uuid); f.rows = f.rows.filter((row) => row.uuid !== uuid); return { ok: true }; },
    services: () => ({ credentials, settings: {}, llm: {
      listProviders: () => [{ id: 'paratera' }], listModels: () => f.models.map((id) => ({ id })),
    }, apply: async (models) => { calls.apply.push(models); return f.failApply ? { ok: false, error: 'config-conflict' } : { ok: true, added: models, updated: true }; } }),
    ...overrides,
  };
  const controller = createImportController(deps);
  return Object.assign(f, { controller, deps, calls, timers, credentials,
    advance(ms) { at += ms; for (const timer of [...timers.values()]) if (at >= timer.at) { timers.delete(timer); timer.fn(); } },
    prepare: (body = {}) => controller.prepare({ requestId: A, ...body }),
    commit: (models = ['model-b']) => controller.commit({ operationId: OP, models }),
    cancel: (body = {}) => controller.cancel({ operationId: OP, confirmDelete: true, ...body }),
  });
}

test('prepare creates once, restores all candidates and finishes awaiting selection (not running)', async () => {
  const f = fixture();
  const prepared = await f.prepare();
  assert.equal(prepared.ok, true); assert.equal(prepared.session.stage, 'awaiting-selection');
  assert.equal(prepared.session.canCommit, true); assert.equal(prepared.session.canCancel, true);
  assert.deepEqual(prepared.session.models, ['model-a', 'model-b']);
  assert.deepEqual(prepared.session.selectedModels, []);
  assert.equal(prepared.session.expiresAt, 100 + CREATE_SESSION_TTL_MS);
  assert.equal(f.calls.unref, 1);
  const replay = await f.prepare({ name: 'ignored-new-name' });
  assert.deepEqual(replay, prepared); assert.deepEqual(f.controller.status().session, prepared.session);
  assert.equal(f.calls.create.length, 1); safe(prepared); safe(replay);
  f.controller.dispose(); assert.equal(f.timers.size, 0);
});

test('missing/malformed request IDs and names never issue CREATE or baseline reads', async () => {
  const f = fixture();
  for (const body of [null, [], {}, { requestId: 'not-a-uuid' }, { requestId: A + '\n' },
    { requestId: A, name: null }, { requestId: A, name: '' }, { requestId: A, name: 'x\n' }, { requestId: A, name: 'x'.repeat(201) }]) {
    assert.equal((await f.controller.prepare(body)).ok, false);
  }
  assert.equal(f.calls.create.length, 0); assert.equal(f.calls.lists, 0);
});

test('pending sessions reject a new requestId and dangerous mutations without losing candidates', async () => {
  const f = fixture(); await f.prepare();
  assert.equal((await f.prepare({ requestId: B })).error, 'key-import-busy');
  let mutated = false;
  assert.equal((await f.controller.mutate(() => { mutated = true; })).error, 'key-import-busy');
  assert.equal(mutated, false); assert.equal(f.calls.create.length, 1); f.controller.dispose();
});

test('concurrent prepare replays see creating without triggering a second CREATE', async () => {
  const gate = deferred(); const f = fixture({ create: async () => { f.calls.create.push('device'); await gate.promise; return { ok: true, secret: SECRET }; } });
  const first = f.prepare(); await new Promise((resolve) => setImmediate(resolve));
  const status = f.controller.status(); assert.equal(status.session.stage, 'creating'); assert.equal(status.session.canCommit, false);
  assert.equal((await f.prepare()).session.stage, 'creating');
  assert.equal((await f.prepare({ requestId: B })).error, 'key-import-busy');
  gate.resolve(); await first; assert.equal(f.calls.create.length, 1); f.controller.dispose();
});

test('invalid selection never consumes the secret; offered ids reach the write core', async () => {
  const f = fixture(); await f.prepare();
  for (const models of [null, 'model-a', Array(201).fill('model-a'), ['bad id'], ['model-a\n'], [SECRET], ['not-offered']]) {
    const failed = await f.commit(models); assert.equal(failed.ok, false); assert.equal(failed.session.canCommit, true); safe(failed);
  }
  assert.deepEqual(f.calls.writes, []);
  const result = await f.commit(['model-b']);
  assert.equal(result.ok, true); assert.deepEqual(f.calls.apply, [['model-b']]);
  assert.deepEqual(result.session.selectedModels, ['model-b']);
  assert.deepEqual(result.result.modelsAdded, ['model-b']); assert.equal(result.session.stage, 'completed');
  assert.equal(result.session.canCancel, false); assert.equal(result.session.cleanupRequired, false); safe(result);
});

test('explicit empty selection saves only and does not claim entitled models are unavailable', async () => {
  const f = fixture(); await f.prepare(); const result = await f.commit([]);
  assert.equal(result.ok, true); assert.equal(result.result.credentialImported, true);
  assert.equal(result.result.noModelsAvailable, false); assert.deepEqual(f.calls.apply, []);
  assert.equal(f.stored.get('PARATERA_API_KEY'), SECRET); assert.equal(f.stored.get('PARATERA_API_KEY_BACKUP'), OLD);
});

test('more than 200 offered models survive prepare; only selection count is limited', async () => {
  const f = fixture(); f.models = Array.from({ length: 350 }, (_, i) => 'model-' + i);
  const prepared = await f.prepare(); assert.equal(prepared.ok, true); assert.equal(prepared.session.models.length, 350);
  assert.equal((await f.commit(f.models)).error, 'invalid-models');
  assert.equal((await f.commit([f.models[349]])).ok, true);
});

test('verification failure is retryable without another CREATE and keeps cleanup metadata', async () => {
  let count = 0; const f = fixture({ verify: async () => ++count === 1 ? { ok: false, error: 'verify-http-503' } : { ok: true, modelIds: ['model-a'] } });
  const failed = await f.prepare(); assert.equal(failed.ok, false); assert.equal(failed.session.cleanupRequired, true);
  assert.equal(failed.session.canCancel, true); assert.equal(failed.session.canCommit, false);
  assert.equal(failed.session.requestId, A); assert.equal(failed.session.canRetryVerification, true);
  assert.equal(f.controller.status().session.canRetryVerification, true);
  const ready = await f.controller.prepare({ requestId: f.controller.status().session.requestId });
  assert.equal(ready.ok, true); assert.equal(ready.session.canCommit, true); assert.equal(ready.session.canRetryVerification, false);
  assert.equal(f.calls.create.length, 1); assert.equal((await f.commit(['model-a'])).ok, true);
});

test('during verify retry, status and actions cannot offer/perform writes or cancellation', async () => {
  const gate = deferred(); let count = 0;
  const f = fixture({ verify: async () => ++count === 1 ? { ok: false, error: 'verify-failed' } : gate.promise });
  await f.prepare(); const retry = f.prepare(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.controller.status().session.stage, 'verifying');
  assert.equal(f.controller.status().session.canCommit, false); assert.equal(f.controller.status().session.canCancel, false);
  assert.equal((await f.cancel()).error, 'key-import-busy');
  gate.resolve({ ok: true, modelIds: ['model-a'] }); await retry; f.controller.dispose();
});

test('unknown creation replays never CREATE again and may cancel only a proven unique new id', async () => {
  const f = fixture({ create: async (name) => { f.calls.create.push(name); f.rows.push({ uuid: 'new-id', name }); throw Error('raw-sensitive'); } });
  const failed = await f.prepare(); assert.equal(failed.error, 'key-create-unconfirmed'); assert.equal(failed.session.cleanupRequired, true);
  assert.equal((await f.prepare()).error, 'key-create-unconfirmed'); assert.equal(f.calls.create.length, 1);
  const cancel = await f.cancel(); assert.equal(cancel.ok, true); assert.deepEqual(f.calls.remove, ['new-id']);
  assert.equal(f.rows[0].uuid, 'existing-id'); safe(failed); safe(cancel);
});

test('partial/invalid baseline forbids CREATE and never claims a cleanup deletion', async () => {
  const f = fixture(); f.partial = true;
  assert.equal((await f.prepare()).error, 'key-list-failed'); assert.equal(f.calls.create.length, 0);
  assert.equal((await f.prepare()).error, 'key-list-failed'); assert.equal(f.calls.create.length, 0);
  f.partial = false; assert.equal((await f.prepare({ requestId: B })).ok, true); f.controller.dispose();
});

test('definitive create auth/quota rejection does not claim an orphan and allows a new request id', async () => {
  for (const error of ['console-session-missing', 'console-session-expired', 'key-quota-exceeded', 'invalid-arguments', 'console-http-403']) {
    let attempts = 0;
    const f = fixture({ create: async () => { attempts++; return { ok: false, error }; } });
    const failed = await f.prepare(); assert.equal(failed.ok, false); assert.equal(failed.session.cleanupRequired, false);
    assert.equal(failed.session.canCancel, false); assert.equal(f.controller.isPending(), false);
    await f.prepare(); assert.equal(attempts, 1);
    f.rows.push({ uuid: 'foreign-new-id', name: 'device' });
    const cancelled = await f.cancel(); assert.equal(cancelled.ok, true); assert.equal(cancelled.removed, false);
    assert.equal(f.calls.lists, 1); assert.equal(f.calls.remove.length, 0);
    await f.prepare({ requestId: B }); assert.equal(attempts, 2); assert.equal(f.calls.remove.length, 0);
    f.controller.dispose();
  }
});

test('completed commit replay remains read-only even after a new flow starts', async () => {
  let ids = 0;
  const f = fixture({ newId: () => ++ids === 1 ? OP : C });
  await f.prepare(); const saved = await f.commit();
  await f.prepare({ requestId: B });
  assert.equal(f.controller.status().session.operationId, C);
  const replay = await f.commit(); assert.deepEqual(replay, saved); assert.equal(f.calls.writes.length, 2);
  assert.equal(f.controller.status().session.operationId, C); f.controller.dispose();
});

test('malformed and duplicate baseline UUIDs cannot prove any deletion or permit CREATE', async () => {
  for (const keys of [[{ uuid: 'id\n', name: 'device' }], [{ uuid: 'id', name: 'device' }, { uuid: 'id', name: 'device' }]]) {
    const f = fixture({ list: async () => ({ ok: true, keys, total: keys.length }) });
    assert.equal((await f.prepare()).error, 'key-list-failed'); assert.equal(f.calls.create.length, 0); f.controller.dispose();
  }
});

test('missing one-time plaintext retains metadata and never writes credentials', async () => {
  const f = fixture({ create: async (name) => { f.rows.push({ uuid: 'new-id', name }); return { ok: true, secret: SECRET + '\n' }; } });
  const result = await f.prepare(); assert.equal(result.error, 'key-create-secret-missing');
  assert.equal(result.session.cleanupRequired, true); assert.deepEqual(f.calls.verify, []); assert.deepEqual(f.calls.writes, []);
  assert.equal((await f.cancel()).ok, true);
});

test('cancellation requires exact explicit confirmation and never deletes an existing same-name UUID', async () => {
  const f = fixture(); await f.prepare();
  for (const confirmDelete of [undefined, false, 'true', 1]) assert.equal((await f.cancel({ confirmDelete })).error, 'delete-confirmation-required');
  assert.equal(f.calls.remove.length, 0); assert.equal(f.controller.status().session.canCommit, true);
  const removed = await f.cancel(); assert.equal(removed.ok, true); assert.equal(removed.removed, true);
  assert.deepEqual(f.calls.remove, ['new-id']); assert.deepEqual(f.rows.map((row) => row.uuid), ['existing-id']);
  const replay = await f.cancel(); assert.equal(replay.removed, true); assert.equal(f.calls.remove.length, 1);
});

test('ambiguous post-create differences never authorize a DELETE; manual cleanup can unblock the controller', async () => {
  const f = fixture({ create: async (name) => { f.rows.push({ uuid: 'new-one', name }, { uuid: 'new-two', name }); return { ok: true, secret: SECRET }; } });
  await f.prepare(); const unsafe = await f.cancel();
  assert.equal(unsafe.error, 'key-delete-unsafe'); assert.equal(unsafe.session.cleanupRequired, true); assert.equal(unsafe.session.canCancel, true);
  assert.deepEqual(f.calls.remove, []); assert.equal((await f.prepare({ requestId: B })).error, 'key-import-busy');
  f.rows = f.rows.filter((row) => row.uuid === 'existing-id');
  const acknowledged = await f.cancel(); assert.equal(acknowledged.ok, true); assert.equal(acknowledged.removed, false);
  assert.equal(acknowledged.session.cleanupRequired, false); assert.equal(acknowledged.session.stage, 'cancelled');
  assert.equal((await f.cancel()).removed, false); assert.deepEqual(f.calls.remove, []);
  assert.equal((await f.prepare({ requestId: B })).ok, true); f.controller.dispose();
});

test('uncertain deletion is never retried; only complete id AND name absence reconciles cleanup', async () => {
  const f = fixture({ remove: async (uuid) => { f.calls.remove.push(uuid); throw Error('raw-sensitive'); } });
  await f.prepare(); assert.equal((await f.cancel()).error, 'key-delete-unconfirmed');
  assert.equal((await f.cancel()).error, 'key-delete-unconfirmed'); assert.equal(f.calls.remove.length, 1);
  f.rows = [{ uuid: 'existing-id', name: 'device' }, { uuid: 'replacement-id', name: 'device' }];
  assert.equal((await f.cancel()).error, 'key-delete-unconfirmed'); assert.equal(f.calls.remove.length, 1);
  f.rows = [{ uuid: 'existing-id', name: 'device' }]; f.partial = true;
  assert.equal((await f.cancel()).ok, false); f.partial = false;
  const checked = await f.cancel(); assert.equal(checked.ok, true); assert.equal(checked.removed, true); assert.equal(f.calls.remove.length, 1);
});

test('credential write failure retains secret and backup; retry does not recreate or overwrite backup', async () => {
  const f = fixture(); await f.prepare(); f.failWrite = true;
  const failed = await f.commit(); assert.equal(failed.error, 'credential-write-failed'); assert.equal(failed.session.canCommit, true);
  assert.equal(failed.session.canCancel, false); assert.equal((await f.cancel()).error, 'key-already-imported');
  assert.equal(f.stored.get('PARATERA_API_KEY_BACKUP'), OLD);
  f.failWrite = false; const saved = await f.commit(); assert.equal(saved.ok, true);
  assert.deepEqual(f.calls.writes, ['PARATERA_API_KEY_BACKUP', 'PARATERA_API_KEY', 'PARATERA_API_KEY']);
  assert.equal(f.calls.create.length, 1); assert.equal(f.stored.get('PARATERA_API_KEY_BACKUP'), OLD);
});

test('lost credential success is read back and a lost commit response can be safely replayed', async () => {
  const f = fixture(); const originalSet = f.credentials.set;
  f.credentials.set = async (ref, value) => { await originalSet(ref, value); if (ref === 'PARATERA_API_KEY') throw Error('raw-sensitive'); };
  await f.prepare(); assert.equal((await f.commit()).error, 'credential-write-failed');
  const saved = await f.commit(); assert.equal(saved.ok, true);
  const replay = await f.commit(); assert.deepEqual(replay, saved);
  assert.equal((await f.commit(['model-a'])).error, 'invalid-models');
  assert.deepEqual(f.calls.writes, ['PARATERA_API_KEY_BACKUP', 'PARATERA_API_KEY']); assert.equal(f.calls.apply.length, 1);
  assert.equal(f.stored.get('PARATERA_API_KEY_BACKUP'), OLD);
});

test('partial model failure cannot delete an imported key and retries models without another credential write', async () => {
  const f = fixture(); await f.prepare(); f.failApply = true;
  const failed = await f.commit(); assert.equal(failed.ok, false); assert.equal(failed.result.credentialImported, true);
  assert.equal(failed.session.canCommit, true); assert.equal(failed.session.canCancel, false); assert.equal(failed.session.cleanupRequired, false);
  assert.equal(f.timers.size, 0); assert.equal((await f.cancel()).error, 'key-already-imported');
  assert.equal((await f.prepare({ requestId: B })).error, 'key-import-busy');
  f.advance(CREATE_SESSION_TTL_MS * 2); f.failApply = false;
  assert.equal((await f.commit()).ok, true); assert.equal(f.calls.writes.length, 2); assert.equal(f.calls.create.length, 1);
});

test('registry failure retries only registry, preserving append and backup result metadata', async () => {
  const f = fixture(); let providers = [];
  const services = f.deps.services;
  f.deps.services = null; // controller captured the function, not this property
  const g = fixture({ services: () => ({ ...services(), llm: { listProviders: () => providers, listModels: () => [{ id: 'model-b' }] } }) });
  // The injected services intentionally share fake credential storage only.
  await g.prepare(); const failed = await g.commit(); assert.equal(failed.error, 'model-import-failed');
  assert.equal(f.calls.apply.length, 1); providers = [{ id: 'paratera' }];
  const saved = await g.commit(); assert.equal(saved.ok, true); assert.equal(f.calls.apply.length, 1);
  assert.deepEqual(saved.result.modelsAdded, ['model-b']); assert.equal(f.calls.writes.length, 2);
});

test('real timer erases the hand-off without any status/prune request and is unreferenced', async () => {
  let unrefs = 0;
  const f = fixture({ ttlMs: 10, setTimer(fn, ms) { const timer = setTimeout(fn, ms); const unref = timer.unref.bind(timer); timer.unref = () => { unrefs++; return unref(); }; return timer; }, clearTimer: clearTimeout });
  await f.prepare();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(unrefs, 1); assert.equal((await f.commit()).error, 'key-create-session-expired');
  assert.equal(f.calls.writes.length, 0); assert.equal(f.controller.status().session.stage, 'expired');
  assert.equal(f.controller.status().session.cleanupRequired, true); assert.equal(f.calls.remove.length, 0);
  f.controller.dispose();
});

test('timer expiry and disposal clear secrets, retain cleanup metadata and do not delete remotely', async () => {
  const f = fixture(); await f.prepare(); f.advance(CREATE_SESSION_TTL_MS);
  const expired = f.controller.status(); assert.equal(expired.session.stage, 'expired'); assert.equal(expired.session.canCommit, false);
  assert.equal(expired.session.cleanupRequired, true); assert.equal((await f.prepare()).error, 'key-create-session-expired');
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.remove.length, 0);
  const g = fixture(); await g.prepare(); g.controller.dispose();
  assert.equal(g.timers.size, 0); assert.equal(g.controller.status().session.stage, 'expired');
  assert.equal(g.controller.status().session.cleanupRequired, true); assert.equal(g.calls.remove.length, 0);
  assert.equal((await g.commit()).error, 'key-create-session-expired'); safe(expired); safe(g.controller.status());
});

test('expiry while CREATE is unresolved discards late plaintext and never verifies or saves it', async () => {
  const gate = deferred(); const f = fixture({ create: async () => gate.promise });
  const preparing = f.prepare(); await new Promise((resolve) => setImmediate(resolve)); f.advance(CREATE_SESSION_TTL_MS);
  gate.resolve({ ok: true, secret: SECRET }); const done = await preparing;
  assert.equal(done.error, 'key-create-session-expired'); assert.equal(done.session.cleanupRequired, true);
  assert.equal(f.calls.verify.length, 0); assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.remove.length, 0);
});

test('controllers isolate profiles, request tombstones, candidates and timers', async () => {
  const a = fixture(); const b = fixture(); b.models = ['other-model'];
  await a.prepare(); await b.prepare();
  assert.deepEqual(a.controller.status().session.models, ['model-a', 'model-b']);
  assert.deepEqual(b.controller.status().session.models, ['other-model']);
  a.controller.dispose(); assert.equal(b.controller.status().session.stage, 'awaiting-selection');
  assert.equal((await b.commit(['other-model'])).ok, true); assert.equal(a.calls.writes.length, 0);
  const restarted = fixture(); assert.deepEqual(restarted.controller.status(), { ok: true, session: null });
  assert.equal((await restarted.cancel()).error, 'key-create-session-expired'); assert.equal(restarted.calls.remove.length, 0);
});

test('metadata projections redact secret-shaped names, fields, IDs and unknown errors', async () => {
  const f = fixture({ verify: async () => ({ ok: false, error: 'raw-sensitive', raw: SECRET }) });
  const failed = await f.prepare({ name: SECRET }); safe(failed);
  assert.equal(failed.error, 'key-import-failed'); assert.equal(failed.session.name, '[redacted]');
  assert.deepEqual(Object.keys(failed.session).sort(), ['canCancel', 'canCommit', 'canRetryVerification', 'cleanupRequired', 'error', 'expiresAt', 'fingerprint', 'models', 'name', 'operationId', 'requestId', 'selectedModels', 'stage'].sort());
  f.controller.dispose();
});

test('key mutations take the same lock as prepare and never race a CREATE baseline', async () => {
  const gate = deferred(); const f = fixture();
  const mutation = f.controller.mutate(() => gate.promise);
  assert.equal((await f.prepare()).error, 'key-import-busy'); assert.equal(f.calls.create.length, 0);
  gate.resolve({ ok: true }); assert.equal((await mutation).ok, true);
  assert.equal((await f.prepare()).ok, true); f.controller.dispose();
});
