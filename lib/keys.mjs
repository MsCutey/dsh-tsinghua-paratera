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

function normalize(row) {
  return {
    uuid: row.tokenUuid ?? null,
    name: row.tokenName ?? null,
    status: row.tokenStatus ?? null,
    created: row.createdTime ?? null,
    // Treat even a field normally documented as masked as untrusted plaintext.
    // The settings client needs only a safe display marker, never the raw blob.
    masked: typeof row.secretKey === 'string' && row.secretKey ? '****' : null,
    models: Array.isArray(row.modelScale) ? row.modelScale : [],
    requestId: row.requestId ?? null,
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
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object' || typeof row.tokenUuid !== 'string' || !row.tokenUuid.trim() || typeof row.tokenName !== 'string' || !row.tokenName.trim())) {
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

export async function createKey(name) {
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'name-required' };
  const result = await consoleFetch(BASE + '/create', {
    method: 'POST',
    body: { tokenName: name.trim(), billingType: 'PostPaid' },
  });
  if (!result.ok) return result;
  return { ok: true };
}

export async function renameKey(uuid, name) {
  if (typeof uuid !== 'string' || !uuid.trim() || typeof name !== 'string' || !name.trim()) return { ok: false, error: 'invalid-arguments' };
  const result = await consoleFetch(BASE + '/update', { method: 'POST', body: { tokenUuid: uuid, tokenName: name.trim() } });
  return result.ok ? { ok: true } : result;
}

export async function setKeyStatus(uuid, status) {
  if (typeof uuid !== 'string' || !uuid.trim() || !['valid', 'invalid'].includes(status)) return { ok: false, error: 'invalid-arguments' };
  const result = await consoleFetch(BASE + '/update', { method: 'POST', body: { tokenUuid: uuid, tokenStatus: status } });
  return result.ok ? { ok: true } : result;
}

export async function deleteKey(uuid) {
  if (typeof uuid !== 'string' || !uuid.trim()) return { ok: false, error: 'invalid-arguments' };
  const result = await consoleFetch(BASE + '/delete', { method: 'DELETE', body: { tokenUuid: uuid } });
  return result.ok ? { ok: true } : result;
}

/** Global "更新支持模型": asks the platform to refresh every key's model entitlement. */
export async function refreshSupportedModels() {
  const result = await consoleFetch(BASE + '/open', { method: 'POST', body: { keyModels: 'all' } });
  return result.ok ? { ok: true } : result;
}
