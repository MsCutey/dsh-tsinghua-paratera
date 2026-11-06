import test from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledRefresh } from '../lib/scheduled.mjs';

test('background jobs release a newly parked second-factor browser', async () => {
  let cancelled = 0;
  const result = await runScheduledRefresh({ refresh: async () => ({ ok: false, error: 'second-factor-required', secondFactor: true }), cancel: async () => { cancelled++; } });
  assert.equal(result.error, 'second-factor-required');
  assert.equal(cancelled, 1);
});

test('background jobs do not cancel another refresh or a successful session', async () => {
  for (const result of [{ ok: true, skipped: true }, { ok: false, error: 'refresh-busy' }, { ok: false, error: 'second-factor-pending' }]) {
    assert.deepEqual(await runScheduledRefresh({ refresh: async () => result, cancel: () => { throw Error('must not cancel another operation'); } }), result);
  }
});
