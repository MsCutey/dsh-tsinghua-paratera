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
    masked: row.secretKey ?? null,
    models: Array.isArray(row.modelScale) ? row.modelScale : [],
    requestId: row.requestId ?? null,
  };
}

export async function listKeys() {
  const result = await consoleFetch(BASE + '/llmSk', { method: 'POST', body: { pageNum: 1, pageSize: 100 } });
  if (!result.ok) return result;
  const rows = Array.isArray(result.data?.rows) ? result.data.rows : [];
  return { ok: true, keys: rows.map(normalize), total: result.data?.total ?? rows.length };
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
  if (!uuid || typeof name !== 'string' || !name.trim()) return { ok: false, error: 'invalid-arguments' };
  const result = await consoleFetch(BASE + '/update', { method: 'POST', body: { tokenUuid: uuid, tokenName: name.trim() } });
  return result.ok ? { ok: true } : result;
}

export async function setKeyStatus(uuid, status) {
  if (!uuid || !['valid', 'invalid'].includes(status)) return { ok: false, error: 'invalid-arguments' };
  const result = await consoleFetch(BASE + '/update', { method: 'POST', body: { tokenUuid: uuid, tokenStatus: status } });
  return result.ok ? { ok: true } : result;
}

export async function deleteKey(uuid) {
  if (!uuid) return { ok: false, error: 'invalid-arguments' };
  const result = await consoleFetch(BASE + '/delete', { method: 'DELETE', body: { tokenUuid: uuid } });
  return result.ok ? { ok: true } : result;
}

/** Global "更新支持模型": asks the platform to refresh every key's model entitlement. */
export async function refreshSupportedModels() {
  const result = await consoleFetch(BASE + '/open', { method: 'POST', body: { keyModels: 'all' } });
  return result.ok ? { ok: true } : result;
}
