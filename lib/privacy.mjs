// Explicit projections at disk/browser boundaries. Never spread upstream rows.
import { publicImportResult, safeImportCode } from './import-status.mjs';

const numericFields = ['couponFree', 'couponUsed', 'couponTotal', 'gpuUsed', 'tokenUsed', 'fetchedAt'];
export function publicSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(numericFields.filter((key) => typeof value[key] === 'number' && Number.isFinite(value[key])).map((key) => [key, value[key]]));
}

const errorCodes = new Set([
  'chrome-not-found', 'chrome-profile-in-use', 'chrome-not-ready', 'refresh-busy',
  'refresh-failed', 'stale-token-cleared', 'second-factor-required', 'second-factor-pending',
  'untrusted-login-page', 'credentials-missing', 'captcha-required', 'login-timeout',
  'login-not-started', 'login-window-closed', 'empty-evaluate', 'login-required',
  'no-session-token', 'session-expired', 'invalid-response', 'malformed-session-token',
]);
export const safeErrorCode = (value) => value == null ? null : errorCodes.has(value) ? value : 'operation-failed';

export function publicState(value = {}) {
  const next = {};
  for (const key of ['lastRefreshAt', 'lastErrorAt', 'lastLoginAt']) {
    if (value[key] === null || (typeof value[key] === 'number' && Number.isFinite(value[key]))) next[key] = value[key];
  }
  if (Object.hasOwn(value, 'lastError')) next.lastError = safeErrorCode(value.lastError);
  if (value.snapshot) next.snapshot = publicSnapshot(value.snapshot);
  if (value.lastLoginResult && typeof value.lastLoginResult === 'object') {
    next.lastLoginResult = Object.fromEntries(['filledUser', 'filledPass', 'clicked'].filter((key) => typeof value.lastLoginResult[key] === 'boolean').map((key) => [key, value.lastLoginResult[key]]));
  }
  return next;
}

const safeModel = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 256 && /^[A-Za-z0-9]/.test(id) && !/[^A-Za-z0-9._:/+-]/.test(id) && !/^sk-/i.test(id);
export function publicImportResponse(result) {
  const next = publicImportResult(result);
  for (const key of ['modelsAdded', 'modelsSkipped']) if (Array.isArray(result?.[key])) next[key] = result[key].filter(safeModel).slice(0, 200);
  if (/^sha256:[a-f0-9]{12}$/.test(result?.fingerprint)) next.fingerprint = result.fingerprint;
  // The newly created key's display name is not a secret and is needed for the
  // "verify/clean up by name" instruction; the plaintext itself is host-only.
  if (typeof result?.createdKeyName === 'string' && result.createdKeyName.trim()) next.createdKeyName = safeName(result.createdKeyName);
  for (const flag of ['noModelsAvailable']) if (typeof result?.[flag] === 'boolean') next[flag] = result[flag];
  return next;
}

const safeName = (value) => typeof value === 'string'
  ? value.replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) : '';
const createStages = new Set(['creating', 'verifying', 'awaiting-selection', 'saving', 'models', 'subscription', 'completed', 'failed', 'expired', 'cancelled', 'cancelling']);
export function publicCreateSession(value) {
  if (!value || typeof value !== 'object') return null;
  const next = {
    operationId: typeof value.operationId === 'string' && value.operationId.length === 36 && /^[a-f0-9-]{36}$/i.test(value.operationId) ? value.operationId : null,
    requestId: typeof value.requestId === 'string' && value.requestId.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.requestId) ? value.requestId : null,
    name: safeName(value.name), stage: createStages.has(value.stage) ? value.stage : 'failed',
    models: Array.isArray(value.models) ? value.models.filter(safeModel) : [],
    selectedModels: Array.isArray(value.selectedModels) ? value.selectedModels.filter(safeModel).slice(0, 200) : [],
    expiresAt: Number.isFinite(value.expiresAt) ? value.expiresAt : null,
    fingerprint: /^sha256:[a-f0-9]{12}$/.test(value.fingerprint) ? value.fingerprint : null,
    canCommit: value.canCommit === true, canCancel: value.canCancel === true,
    canRetryVerification: value.canRetryVerification === true, cleanupRequired: value.cleanupRequired === true,
  };
  if (value.error) next.error = safeImportCode(value.error);
  if (value.result) next.result = publicImportResponse(value.result);
  return next;
}

export function publicKeysResponse(value) {
  const next = { ok: value?.ok === true };
  if (value?.error) next.error = safeImportCode(value.error);
  if (Array.isArray(value?.keys)) next.keys = value.keys.map((row) => ({
    uuid: typeof row?.uuid === 'string' && row.uuid.length >= 1 && row.uuid.length <= 512 && !/[^A-Za-z0-9+/=_-]/.test(row.uuid) && !/^sk-/i.test(row.uuid) ? row.uuid : null,
    name: safeName(row?.name), status: ['valid', 'invalid'].includes(row?.status) ? row.status : null,
    created: typeof row?.created === 'number' && Number.isFinite(row.created) ? row.created
      : typeof row?.created === 'string' && /^\d{4}-\d\d-\d\d(?:[T ][\d:.+Z -]+)?$/.test(row.created) ? row.created : null,
    masked: row?.masked ? '****' : null,
    models: Array.isArray(row?.models) ? row.models.filter(safeModel) : [],
  }));
  if (Number.isSafeInteger(value?.total) && value.total >= 0) next.total = value.total;
  return next;
}

export function publicRefreshResult(result) {
  const next = { ok: result?.ok === true };
  if (result?.error) next.error = safeErrorCode(result.error);
  if (typeof result?.exp === 'number' && Number.isFinite(result.exp)) next.exp = result.exp;
  for (const key of ['skipped', 'secondFactor']) if (typeof result?.[key] === 'boolean') next[key] = result[key];
  return next;
}
