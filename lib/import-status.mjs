// In-memory operational metadata only. Never persist/return secrets, upstream
// responses or exception text. A GUI reload can inspect the last known outcome.
export const IMPORT_REVISION = '2026-11-06.import-status.1';
const stages = new Set(['listing', 'revealing', 'verifying', 'backup', 'saving', 'models', 'subscription']);
const codes = new Set([
  'key-import-failed', 'key-import-busy', 'key-list-failed', 'key-not-found', 'key-name-ambiguous', 'key-disabled',
  'invalid-import-request', 'invalid-models', 'invalid-arguments', 'invalid-key', 'no-available-models', 'model-selection-required',
  'credentials-unavailable', 'credential-read-failed', 'credential-backup-failed', 'credential-write-failed',
  'model-import-failed', 'model-not-available', 'settings-unavailable', 'provider-config-unavailable', 'provider-config-invalid',
  'config-conflict', 'model-config-write-failed', 'provider-not-registered', 'model-directory-unavailable', 'model-directory-missing-models',
  'console-session-missing', 'console-session-expired', 'console-auth-failed', 'console-invalid-response', 'console-api-error',
  'console-timeout', 'console-network-error', 'easycompute-login-required', 'second-factor-pending', 'refresh-busy',
  'chrome-not-found', 'chrome-not-ready', 'chrome-profile-in-use', 'profile-missing', 'cdp-closed', 'cdp-timeout',
  'keys-invalid-response', 'keys-pagination-stalled', 'keys-pagination-limit', 'keys-table-not-ready',
  'row-not-found', 'ambiguous-key-name', 'ambiguous-key-row', 'key-name-column-not-found', 'no-eye',
  'secret-not-revealed', 'key-reveal-failed', 'untrusted-console-page', 'verify-invalid-response', 'verify-failed',
]);
const safeCode = (code) => codes.has(code) || (typeof code === 'string' && /^(?:verify|console)-http-[1-5]\d\d$/.test(code)) ? code : 'key-import-failed';

export function publicImportResult(result) {
  const value = { ok: result?.ok === true };
  for (const flag of ['credentialImported', 'modelConfigUpdated', 'needsRestart', 'providerRegistered', 'modelsAvailable', 'dryRun', 'modelsReplaced']) {
    if (typeof result?.[flag] === 'boolean') value[flag] = result[flag];
  }
  for (const field of ['error', 'modelError']) if (result?.[field]) value[field] = safeCode(result[field]);
  // Model names/IDs and key fingerprints are not needed for progress recovery;
  // keep only a count, avoiding arbitrary upstream values in this endpoint.
  if (Array.isArray(result?.modelsAdded)) value.modelsAddedCount = result.modelsAdded.length;
  if (Number.isSafeInteger(result?.modelsRemoved) && result.modelsRemoved >= 0) value.modelsRemoved = result.modelsRemoved;
  if (Number.isSafeInteger(result?.verifiedModels) && result.verifiedModels >= 0) value.verifiedModels = result.verifiedModels;
  return value;
}

export function createImportStatus({ now = Date.now } = {}) {
  let state = { ok: true, importRevision: IMPORT_REVISION, operationId: null, running: false, stage: 'idle', startedAt: null, updatedAt: null, result: null };
  return {
    snapshot() { return structuredClone(state); },
    start(operationId) { const at = now(); state = { ok: true, importRevision: IMPORT_REVISION, operationId, running: true, stage: 'listing', startedAt: at, updatedAt: at, result: null }; },
    progress(operationId, stage) { if (state.running && state.operationId === operationId && stages.has(stage)) state = { ...state, stage, updatedAt: now() }; },
    finish(operationId, result) { if (state.operationId === operationId) state = { ...state, running: false, stage: result?.ok ? 'completed' : 'failed', result: publicImportResult(result), updatedAt: now() }; },
  };
}
