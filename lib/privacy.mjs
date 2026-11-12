// Explicit projections at disk/browser boundaries. Never spread upstream rows.
import { publicImportResult } from './import-status.mjs';

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

const safeModel = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(id) && !/^sk-/i.test(id);
export function publicImportResponse(result) {
  const next = publicImportResult(result);
  for (const key of ['modelsAdded', 'modelsSkipped']) if (Array.isArray(result?.[key])) next[key] = result[key].filter(safeModel).slice(0, 200);
  if (/^sha256:[a-f0-9]{12}$/.test(result?.fingerprint)) next.fingerprint = result.fingerprint;
  // The newly created key's display name is not a secret and is needed for the
  // "verify/clean up by name" instruction; the plaintext itself is host-only.
  if (typeof result?.createdKeyName === 'string' && result.createdKeyName.trim()) next.createdKeyName = result.createdKeyName.slice(0, 200);
  for (const flag of ['noModelsAvailable']) if (typeof result?.[flag] === 'boolean') next[flag] = result[flag];
  return next;
}

export function publicRefreshResult(result) {
  const next = { ok: result?.ok === true };
  if (result?.error) next.error = safeErrorCode(result.error);
  if (typeof result?.exp === 'number' && Number.isFinite(result.exp)) next.exp = result.exp;
  for (const key of ['skipped', 'secondFactor']) if (typeof result?.[key] === 'boolean') next[key] = result[key];
  return next;
}
