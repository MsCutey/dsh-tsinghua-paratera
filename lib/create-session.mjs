// One controller per host injection/profile. Secrets never enter public snapshots
// or disk. Timers erase references even when no subsequent request is received.
import { randomUUID } from 'node:crypto';
import { createKey, listKeys, deleteKey } from './keys.mjs';
import { verifyKey, fingerprint, importPreparedKey, validModelId, validSecret } from './import.mjs';
import { publicCreateSession, publicImportResponse } from './privacy.mjs';
import { safeImportCode } from './import-status.mjs';

export const CREATE_SESSION_TTL_MS = 10 * 60 * 1000;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validRequestId = (id) => typeof id === 'string' && id.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
const validUuid = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 512 && !/[^A-Za-z0-9+/=_-]/.test(id) && !/^sk-/i.test(id);
const busyStages = new Set(['creating', 'verifying', 'saving', 'models', 'subscription', 'cancelling']);

// Only a complete, unique baseline is useful as deletion evidence. listKeys()
// itself exhausts all pages and supplies total; injected dependencies must too.
function completeKeys(value) {
  if (value?.ok !== true || !Array.isArray(value.keys) || value.total !== value.keys.length
    || value.complete === false || value.partial === true || value.hasMore === true
    || value.keys.some((row) => !object(row) || !validUuid(row.uuid) || typeof row.name !== 'string')) return null;
  return new Set(value.keys.map((row) => row.uuid)).size === value.keys.length ? value.keys : null;
}

export function createImportController({
  create = createKey, list = listKeys, remove = deleteKey, verify = verifyKey,
  commitPrepared = importPreparedKey, services = () => ({}), defaultName = () => 'DSH',
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  ttlMs = CREATE_SESSION_TTL_MS, newId = randomUUID,
} = {}) {
  let current = null;
  let disposed = false;
  let mutationBusy = false;
  // Retain request tombstones for this controller's lifetime: an old request
  // must NEVER create again, even after its secret expires or a newer flow runs.
  const requests = new Map();
  const pending = () => current && (busyStages.has(current.stage) || current.secret || current.cleanupRequired
    || (current.commitStarted && !['completed', 'cancelled'].includes(current.stage)));
  const expire = (s) => {
    s.secret = null;
    if (s.timer !== null) clearTimer(s.timer);
    s.timer = null;
    if (s.writeState?.credentialImported) { s.cleanupRequired = false; return; }
    if (!['completed', 'cancelled'].includes(s.stage)) {
      s.stage = 'expired'; s.error = 'key-create-session-expired';
    }
  };
  const checkExpiry = (s) => { if (s?.secret && now() >= s.expiresAt) expire(s); };
  const clearSecret = (s) => {
    s.secret = null;
    if (s.timer !== null) clearTimer(s.timer);
    s.timer = null;
  };
  const snapshot = (s = current) => {
    checkExpiry(s);
    return publicCreateSession(s ? {
      ...s,
      canCommit: !disposed && !s.running && !mutationBusy && !busyStages.has(s.stage) && Boolean(s.verified) && Boolean(s.secret || s.writeState?.credentialImported)
        && !['completed', 'expired', 'cancelled', 'cancelling'].includes(s.stage),
      canCancel: !disposed && !s.running && !mutationBusy && !busyStages.has(s.stage) && !s.writeState?.credentialImported && !s.writeState?.credentialWriteUncertain
        && Boolean(s.cleanupRequired),
      canRetryVerification: !disposed && !s.running && !mutationBusy && Boolean(s.secret) && !s.verified && s.stage === 'failed',
    } : null);
  };
  const reply = (ok, error, s = current, extra = {}) => ({
    ok, session: snapshot(s), ...(error ? { error: safeImportCode(error) } : {}), ...extra,
  });
  const done = (ok, error, s, extra) => { s.running = false; return reply(ok, error, s, extra); };
  const fail = (s, error) => { s.error = safeImportCode(error); if (s.stage !== 'expired') s.stage = 'failed'; };
  async function proveCreated(s) {
    const keys = completeKeys(await list());
    if (!keys || !s.baseline) return;
    const added = keys.filter((key) => !s.baseline.has(key.uuid));
    if (added.length === 1 && added[0].name === s.name) s.createdUuid = added[0].uuid;
  }
  async function verifyCandidate(s) {
    checkExpiry(s);
    if (!s.secret || disposed || s.stage === 'expired') return;
    s.stage = 'verifying'; s.error = null;
    let verified;
    try { verified = await verify(s.secret); } catch { verified = { ok: false, error: 'verify-failed' }; }
    checkExpiry(s);
    if (disposed || !s.secret || s.stage === 'expired') return;
    if (verified?.ok !== true || !Array.isArray(verified.modelIds) || verified.modelIds.some((id) => !validModelId(id))) {
      fail(s, verified?.ok === true ? 'verify-invalid-response' : verified?.error || 'verify-failed'); return;
    }
    s.models = [...new Set(verified.modelIds)];
    s.verifiedModels = s.models.length;
    s.verified = true; s.stage = 'awaiting-selection'; s.error = null;
  }
  return {
    status() { return { ok: true, session: snapshot() }; },
    isPending() { checkExpiry(current); return Boolean(pending() || mutationBusy); },
    async prepare(body) {
      if (!object(body) || !validRequestId(body.requestId)) return reply(false, 'invalid-import-request');
      const existing = requests.get(body.requestId);
      if (disposed) return reply(false, 'key-create-session-expired');
      if (existing) {
        checkExpiry(existing);
        // Same-id replay restores candidates/outcome, and may retry only the
        // read-only model verification, never the one-time CREATE.
        if (!existing.running && existing.secret && !existing.verified && !mutationBusy) {
          existing.running = true; existing.stage = 'verifying';
          try {
            if (!existing.createdUuid) await proveCreated(existing).catch(() => {});
            await verifyCandidate(existing);
          } finally { existing.running = false; }
        }
        return reply(!existing.error, existing.error, existing);
      }
      const name = body.name === undefined ? defaultName() : body.name;
      if (typeof name !== 'string' || !name.trim()) return reply(false, 'name-required');
      if (name.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(name)) return reply(false, 'invalid-import-request');
      checkExpiry(current);
      if (pending() || mutationBusy) return reply(false, 'key-import-busy');
      if (requests.size >= 1000) return reply(false, 'key-import-busy');
      const s = {
        operationId: newId(), requestId: body.requestId, name: name.trim(), stage: 'creating', models: [], selectedModels: [],
        expiresAt: now() + ttlMs, fingerprint: null, cleanupRequired: false,
        secret: null, baseline: null, createdUuid: null, timer: null, running: true, verified: false,
        writeState: {}, deleteAttempted: false, error: null, result: null,
      };
      current = s; requests.set(body.requestId, s);
      s.timer = setTimer(() => expire(s), ttlMs);
      s.timer?.unref?.();
      try {
        let baseline;
        try { baseline = completeKeys(await list()); } catch {}
        if (!baseline) { fail(s, 'key-list-failed'); return done(false, s.error, s); }
        s.baseline = new Set(baseline.map((key) => key.uuid));
        if (disposed || now() >= s.expiresAt) { expire(s); return done(false, s.error, s); }
        // From immediately before CREATE onward, failure is not proof that no
        // key exists. Preserve cleanup metadata even if the response is lost.
        s.cleanupRequired = true;
        let created;
        try { created = await create(s.name); } catch { created = { ok: false, error: 'key-create-unconfirmed' }; }
        const createdError = created?.ok === true ? (validSecret(created.secret) ? null : 'key-create-secret-missing') : created?.error || 'key-create-unconfirmed';
        if (!disposed && now() < s.expiresAt && !createdError) {
          s.secret = created.secret; s.fingerprint = fingerprint(s.secret);
        }
        if (created?.ok === false && (['console-session-missing', 'console-session-expired', 'invalid-console-path', 'key-quota-exceeded', 'invalid-arguments', 'name-required'].includes(created.error)
          || (typeof created.error === 'string' && /^console-http-4\d\d$/.test(created.error)))) s.cleanupRequired = false;
        created = null;
        if (disposed || now() >= s.expiresAt) { expire(s); return done(false, 'key-create-session-expired', s); }
        if (s.cleanupRequired) await proveCreated(s).catch(() => {});
        if (createdError) { fail(s, createdError); return done(false, s.error, s); }
        await verifyCandidate(s);
        return done(!s.error, s.error, s);
      } catch { fail(s, 'key-import-failed'); return done(false, s.error, s); }
      finally { s.running = false; if (!s.secret) { if (s.timer !== null) clearTimer(s.timer); s.timer = null; } }
    },
    async commit(body) {
      if (!object(body) || typeof body.operationId !== 'string' || !Array.isArray(body.models)
        || body.models.length > 200 || body.models.some((id) => !validModelId(id))) return reply(false, 'invalid-models');
      const s = current?.operationId === body.operationId ? current
        : [...requests.values()].find((entry) => entry.operationId === body.operationId && entry.stage === 'completed');
      if (!s) return reply(false, 'key-create-session-expired');
      checkExpiry(s);
      const models = [...new Set(body.models)];
      if (models.some((id) => !s.models.includes(id))) return reply(false, 'model-not-available');
      if (s.stage === 'completed') return JSON.stringify(models) === JSON.stringify(s.selectedModels)
        ? reply(true, null, s, { result: publicImportResponse(s.result) }) : reply(false, 'invalid-models');
      if (disposed || s.stage === 'expired' || (!s.secret && !s.writeState.credentialImported)) return reply(false, 'key-create-session-expired');
      if (s.running || mutationBusy) return reply(false, 'key-import-busy');
      if (!s.verified || ['cancelled', 'cancelling'].includes(s.stage)) return reply(false, 'invalid-import-request');
      // Once any write has been attempted, retries retain the exact selection.
      if (s.commitStarted && JSON.stringify(models) !== JSON.stringify(s.selectedModels)) return reply(false, 'invalid-models');
      s.selectedModels = models; s.commitStarted = true; s.running = true; s.error = null; s.stage = 'saving';
      try {
        const result = await commitPrepared({
          name: s.name, secret: s.secret, offered: s.models, models, fingerprint: s.fingerprint, verifiedModels: s.verifiedModels,
        }, {
          ...services(), state: s.writeState,
          onProgress(stage) { if (!disposed && s.stage !== 'expired') s.stage = stage === 'backup' ? 'saving' : stage; },
          isActive: () => !disposed && now() < s.expiresAt,
        });
        s.result = publicImportResponse(result);
        if (result?.credentialImported) { s.writeState.credentialImported = true; s.cleanupRequired = false; clearSecret(s); }
        if (result?.ok) { s.stage = 'completed'; s.error = null; clearSecret(s); }
        else { checkExpiry(s); fail(s, result?.error || 'key-import-failed'); }
        return done(result?.ok === true, s.error, s, { result: publicImportResponse(s.result) });
      } catch { fail(s, 'key-import-failed'); return done(false, s.error, s); }
      finally { s.running = false; }
    },
    async cancel(body) {
      if (!object(body) || typeof body.operationId !== 'string' || body.confirmDelete !== true) return reply(false, 'delete-confirmation-required');
      const s = current;
      if (!s || s.operationId !== body.operationId) return reply(false, 'key-create-session-expired');
      checkExpiry(s);
      if (disposed) return reply(false, 'key-create-session-expired');
      if (s.running || mutationBusy) return reply(false, 'key-import-busy');
      if (s.writeState.credentialImported || s.writeState.credentialWriteUncertain || s.stage === 'completed') return reply(false, 'key-already-imported');
      if (s.stage === 'cancelled' && !s.cleanupRequired) return reply(true, null, s, { removed: s.removed === true });
      // A definitive pre-create rejection is not evidence that a later same-name
      // key belongs to us. Local cancellation must never investigate/delete it.
      if (!s.cleanupRequired) {
        clearSecret(s); s.stage = 'cancelled'; s.error = null; s.removed = false;
        return reply(true, null, s, { removed: false });
      }
      s.running = true; s.stage = 'cancelling';
      clearSecret(s);
      try {
        const keys = completeKeys(await list());
        if (!keys || !s.baseline) {
          fail(s, 'key-delete-unsafe'); return done(false, s.error, s, { removed: false });
        }
        const added = keys.filter((key) => !s.baseline.has(key.uuid));
        const matching = added.filter((key) => key.name === s.name);
        const provenPresent = s.createdUuid && keys.some((key) => key.uuid === s.createdUuid);
        // A complete list can acknowledge manual cleanup without pretending
        // that this plugin sent a DELETE. Require BOTH id and new-name absence.
        if (!provenPresent && matching.length === 0) {
          s.stage = 'cancelled'; s.cleanupRequired = false; s.error = null; s.removed = s.deleteAttempted;
          return done(true, null, s, { removed: s.removed });
        }
        // Replays after an uncertain DELETE are strictly read only, including
        // cases where the old id disappeared but a new same-name id exists.
        if (s.deleteAttempted) {
          fail(s, 'key-delete-unconfirmed'); return done(false, s.error, s, { removed: false });
        }
        if (!s.createdUuid && added.length === 1 && matching.length === 1) s.createdUuid = added[0].uuid;
        if (!s.createdUuid || s.baseline.has(s.createdUuid) || !keys.some((key) => key.uuid === s.createdUuid)) {
          fail(s, 'key-delete-unsafe'); return done(false, s.error, s, { removed: false });
        }
        s.deleteAttempted = true;
        let removed;
        try { removed = await remove(s.createdUuid); } catch { removed = { ok: false, error: 'key-delete-unconfirmed' }; }
        if (removed?.ok === true) {
          s.stage = 'cancelled'; s.cleanupRequired = false; s.error = null; s.removed = true;
          return done(true, null, s, { removed: true });
        }
        fail(s, removed?.error || 'key-delete-unconfirmed');
        return done(false, s.error, s, { removed: false });
      } catch { fail(s, 'key-delete-unconfirmed'); return done(false, s.error, s, { removed: false }); }
      finally { s.running = false; }
    },
    async mutate(action) {
      checkExpiry(current);
      if (disposed || pending() || mutationBusy) return { ok: false, error: 'key-import-busy' };
      mutationBusy = true;
      try { return await action(); } finally { mutationBusy = false; }
    },
    dispose() {
      disposed = true;
      for (const s of requests.values()) { clearSecret(s); if (!['completed', 'cancelled'].includes(s.stage)) expire(s); }
      // Keep non-secret metadata for an explicit final status/cleanup hint. No
      // network deletion on expiry, disposal, unload, or process restart.
    },
  };
}
