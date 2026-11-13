// LLM API key management on the Paratera console (LMS routes).
//
// Endpoints (captured from the console bundle `lms-*.js`):
//   POST   /lms/api/key/llmSk    list
//   POST   /lms/api/key/create   { tokenName, billingType: 'PostPaid' }
//   POST   /lms/api/key/update   { tokenUuid, tokenName | tokenStatus }
//   DELETE /lms/api/key/delete   { tokenUuid }
//   POST   /lms/api/key/open     { keyModels: 'all' }  (更新支持模型)
import { consoleFetch } from './console.mjs';

const BASE = '/lms/api/key';
const validTokenUuid = (uuid) => typeof uuid === 'string' && uuid.length >= 1 && uuid.length <= 512
  && !/[^A-Za-z0-9+/=_-]/.test(uuid) && !/^sk-/i.test(uuid);
// One-time plaintext returned by /lms/api/key/create. Never log or persist it.
const validSecret = (value) => typeof value === 'string' && value.length >= 19 && value.length <= 512
  && value.startsWith('sk-') && !/[^A-Za-z0-9_-]/.test(value);
const validName = (value) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200
  && !/[\u0000-\u001f\u007f]/.test(value) && !/sk-[A-Za-z0-9_-]{16,}/i.test(value);

function normalize(row) {
  return {
    uuid: row.tokenUuid ?? null,
    name: row.tokenName.replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]').slice(0, 200),
    status: ['valid', 'invalid'].includes(row.tokenStatus) ? row.tokenStatus : null,
    created: typeof row.createdTime === 'number' && Number.isFinite(row.createdTime) ? row.createdTime
      : typeof row.createdTime === 'string' && /^\d{4}-\d\d-\d\d(?:[T ][\d:.+Z -]+)?$/.test(row.createdTime) ? row.createdTime : null,
    // Treat even a field normally documented as masked as untrusted plaintext.
    // The settings client needs only a safe display marker, never the raw blob.
    masked: typeof row.secretKey === 'string' && row.secretKey ? '****' : null,
    models: Array.isArray(row.modelScale) ? row.modelScale.map((item) => typeof item === 'string' ? item
      : item && typeof item === 'object' ? item.id ?? item.modelId ?? item.model ?? item.value ?? item.name ?? item.modelName : null)
      .filter((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(id) && !/^sk-/i.test(id)) : [],
  };
}

export async function listKeys({ request = consoleFetch, pageSize = 100, maxPages = 100 } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(maxPages) || maxPages < 1) return { ok: false, error: 'invalid-arguments' };
  const keys = [];
  const seen = new Set();
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const result = await request(BASE + '/llmSk', { method: 'POST', body: { pageNum, pageSize } });
    if (!result.ok) return result;
    const rows = result.data?.rows;
    // The console switched to opaque base64 token ids (observed: 70 chars with
    // "+" and "/"), so the id must accept the full base64 alphabet rather than
    // only UUID-safe characters. It is sent back inside JSON bodies, never a URL.
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object' || !validTokenUuid(row.tokenUuid) || typeof row.tokenName !== 'string' || !row.tokenName.trim())) {
      return { ok: false, error: 'keys-invalid-response' };
    }
    const rawTotal = result.data.total;
    if (rawTotal != null && typeof rawTotal !== 'number' && !(typeof rawTotal === 'string' && /^\d+$/.test(rawTotal))) return { ok: false, error: 'keys-invalid-response' };
    const total = rawTotal == null ? null : Number(rawTotal);
    if (total !== null && (!Number.isSafeInteger(total) || total < keys.length + rows.length)) return { ok: false, error: 'keys-invalid-response' };
    for (const row of rows) {
      // A server ignoring pageNum must not make an import silently pick a subset.
      if (seen.has(row.tokenUuid)) return { ok: false, error: 'keys-pagination-stalled' };
      seen.add(row.tokenUuid);
      keys.push(normalize(row));
    }
    if (total !== null && keys.length >= total) return { ok: true, keys, total: keys.length };
    if (rows.length === 0) return total === null
      ? { ok: true, keys, total: keys.length }
      : { ok: false, error: 'keys-pagination-stalled' };
    if (total === null && rows.length < pageSize) return { ok: true, keys, total: keys.length };
  }
  return { ok: false, error: 'keys-pagination-limit' };
}

export async function createKey(name, { request = consoleFetch } = {}) {
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'name-required' };
  if (!validName(name)) return { ok: false, error: 'invalid-arguments' };
  let result;
  try {
    result = await request(BASE + '/create', {
      method: 'POST',
      body: { tokenName: name.trim(), billingType: 'PostPaid' },
    });
  } catch { return { ok: false, error: 'key-create-unconfirmed' }; }
  if (result?.ok !== true) {
    if (result?.ok === false && (['console-session-missing', 'console-session-expired', 'invalid-console-path', 'key-quota-exceeded'].includes(result.error)
      || /^console-http-4\d\d$/.test(result.error))) return { ok: false, error: result.error };
    return { ok: false, error: 'key-create-unconfirmed' };
  }
  // Public console UI (index-DTXuSgsC.js showSecretKeyAfterCreate) renders
  // response.data verbatim as the one-time plaintext; it is a string, not an
  // object. Keep it host-only: callers must never project it to the client.
  if (!validSecret(result.data)) return { ok: false, error: 'key-create-secret-missing' };
  return { ok: true, secret: result.data };
}

export async function renameKey(uuid, name, { request = consoleFetch } = {}) {
  if (!validTokenUuid(uuid) || !validName(name)) return { ok: false, error: 'invalid-arguments' };
  const result = await request(BASE + '/update', { method: 'POST', body: { tokenUuid: uuid, tokenName: name.trim() } });
  return result.ok ? { ok: true } : result;
}

export async function setKeyStatus(uuid, status, { request = consoleFetch } = {}) {
  if (!validTokenUuid(uuid) || !['valid', 'invalid'].includes(status)) return { ok: false, error: 'invalid-arguments' };
  const result = await request(BASE + '/update', { method: 'POST', body: { tokenUuid: uuid, tokenStatus: status } });
  return result.ok ? { ok: true } : result;
}

export async function deleteKey(uuid, { request = consoleFetch, list = () => listKeys({ request }) } = {}) {
  if (!validTokenUuid(uuid)) return { ok: false, error: 'invalid-arguments' };
  let result;
  try {
    // Public console UI/action/transport (2026-11-07): index-CLU5W59i.js,
    // lms-DoN-e3lZ.js and index-CdbFYLD1.js at ai.paratera.com/assets/js/.
    // Preserve its DELETE + JSON contract and the opaque id verbatim. Never
    // retry a destructive request with a guessed method, body or query string.
    result = await request(BASE + '/delete', { method: 'DELETE', body: { tokenUuid: uuid } });
  } catch {
    // A disconnected response does not prove that the deletion was rejected.
  }
  if (result?.ok === false && (['invalid-console-path', 'console-session-missing', 'console-session-expired'].includes(result.error)
    || /^console-http-4\d\d$/.test(result.error))) return { ok: false, error: result.error };
  try {
    // Even HTTP 200 is only an acknowledgement. Confirm absence using every
    // list page; a partial/failed list must never be treated as an empty list.
    const verified = await list();
    if (verified?.ok !== true || !Array.isArray(verified.keys)
      || verified.keys.some((key) => !key || !validTokenUuid(key.uuid))) {
      return { ok: false, error: 'key-delete-unconfirmed' };
    }
    return verified.keys.some((key) => key.uuid === uuid)
      ? { ok: false, error: 'key-delete-not-deleted' }
      : { ok: true };
  } catch {
    return { ok: false, error: 'key-delete-unconfirmed' };
  }
}

/** Global "更新支持模型": asks the platform to refresh every key's model entitlement. */
export async function refreshSupportedModels() {
  const result = await consoleFetch(BASE + '/open', { method: 'POST', body: { keyModels: 'all' } });
  return result.ok ? { ok: true } : result;
}
