// Real-protocol probe (opt-in, one temporary key). Proves the console returns
// the one-time plaintext from /lms/api/key/create, verifies it against the
// public model list, then deletes only that freshly created key.
// Never prints the secret. The key name is a unique test marker.
import { createKey, listKeys, deleteKey } from '../lib/keys.mjs';
import { verifyKey } from '../lib/import.mjs';
import crypto from 'node:crypto';

const name = `dsh-probe-${crypto.randomBytes(6).toString('hex')}`;
const out = { name, steps: [] };
const step = (stage, extra = {}) => { out.steps.push({ stage, ...extra }); };
let uuid = null;

try {
  step('baseline');
  const before = await listKeys();
  if (!before.ok) throw new Error('baseline-list-failed');
  const baseline = new Set(before.keys.map((key) => key.uuid));

  step('create');
  const created = await createKey(name);
  if (!created.ok) throw new Error(created.error || 'create-failed');
  const secret = created.secret;
  out.secretReturned = typeof secret === 'string' && /^sk-[A-Za-z0-9_-]{16,}$/.test(secret);
  out.secretLength = typeof secret === 'string' ? secret.length : 0;

  step('verify');
  const verified = await verifyKey(secret);
  out.verified = Boolean(verified.ok);
  out.models = verified.ok ? verified.models : 0;
  if (!verified.ok) throw new Error(verified.error || 'verify-failed');

  step('identify');
  const after = await listKeys();
  if (!after.ok) throw new Error('list-failed');
  const fresh = after.keys.filter((key) => key.name === name && !baseline.has(key.uuid));
  if (fresh.length !== 1) throw new Error('created-key-ambiguous');
  uuid = fresh[0].uuid;
  out.identified = true;

  step('delete');
  const deleted = await deleteKey(uuid, { list: listKeys });
  out.deleted = deleted.ok === true;
  if (!deleted.ok) throw new Error(deleted.error || 'delete-failed');
} catch (error) {
  out.error = String(error?.message || 'failed');
  out.cleanupRequired = Boolean(uuid);
} finally {
  if (!out.deleted) {
    // Best-effort cleanup by the unique test name; report only the outcome.
    try {
      const final = await listKeys();
      const match = final.ok ? final.keys.filter((key) => key.name === name) : [];
      if (match.length === 1) {
        const removed = await deleteKey(match[0].uuid, { list: listKeys });
        out.cleanup = removed.ok ? 'deleted' : 'failed';
      } else out.cleanup = match.length ? 'ambiguous' : 'absent';
    } catch { out.cleanup = 'failed'; }
  }
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.deleted || out.cleanup === 'deleted' || out.cleanup === 'absent' ? 0 : 1;
}
