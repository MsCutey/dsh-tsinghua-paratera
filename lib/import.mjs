// Host-only import core. The controller owns creation/idempotency/lifetime;
// settings and credential writes are shared by the offline compatibility APIs.
import { listKeys, createKey } from './keys.mjs';
import { recommendedModel } from './models.mjs';
import { createHash } from 'node:crypto';

const REF = 'PARATERA_API_KEY';
export const validModelId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 256
  && /^[A-Za-z0-9]/.test(id) && !/[^A-Za-z0-9._:/+-]/.test(id) && !/^sk-/i.test(id);
export const validSecret = (value) => typeof value === 'string' && value.length >= 19 && value.length <= 4096
  && value.startsWith('sk-') && !/[^A-Za-z0-9_-]/.test(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validSelection = (models) => Array.isArray(models) && models.length <= 200 && models.every(validModelId);

/** Revision-checked, provider-scoped, sparse and append-only Settings update. */
export async function appendModels(ids, { settings } = {}) {
  if (!validSelection(ids)) return { ok: false, error: 'invalid-models' };
  const wanted = [...new Set(ids)];
  if (!wanted.length) return { ok: true, added: [], backup: null, needsRestart: false };
  if (typeof settings?.describe !== 'function' || typeof settings?.update !== 'function') return { ok: false, error: 'settings-unavailable' };
  try {
    const descriptor = settings.describe().find((row) => row.ns === 'llm-pi-ai');
    if (!descriptor || !object(descriptor.value) || !object(descriptor.value.providers)) return { ok: false, error: 'provider-config-unavailable' };
    const live = descriptor.value.providers.paratera;
    if (live !== undefined && !object(live)) return { ok: false, error: 'provider-config-invalid' };
    const userLayer = object(descriptor.user) && object(descriptor.user.providers) ? descriptor.user.providers.paratera : undefined;
    if (userLayer !== undefined && !object(userLayer)) return { ok: false, error: 'provider-config-invalid' };
    if (userLayer?.models !== undefined && !Array.isArray(userLayer.models)) return { ok: false, error: 'provider-config-invalid' };
    if (live?.models !== undefined && !Array.isArray(live.models)) return { ok: false, error: 'provider-config-invalid' };
    const stored = userLayer ?? live;
    const models = stored?.models ?? [];
    if (models.some((model) => !object(model) || !validModelId(model.id))) return { ok: false, error: 'provider-config-invalid' };
    const existing = new Set(models.map((model) => model.id));
    const added = wanted.filter((id) => !existing.has(id));
    const upgrade = (model) => (typeof model.name === 'string' && /\(待校准\)\s*$/.test(model.name) ? recommendedModel(model.id) : model);
    const nextModels = [...models.map(upgrade), ...added.map((id) => recommendedModel(id))];
    const defaults = { displayName: 'Paratera', api: 'openai-completions', baseURL: 'https://llmapi.paratera.com/v1' };
    const patch = { models: nextModels, apiKeyEnv: REF };
    for (const [field, value] of Object.entries(defaults)) if (stored?.[field] === undefined) patch[field] = value;
    const changed = added.length > 0 || stored?.apiKeyEnv !== REF
      || JSON.stringify(nextModels) !== JSON.stringify(models)
      || Object.keys(defaults).some((field) => stored?.[field] === undefined);
    if (changed) await settings.update(descriptor.ns, { providers: { paratera: patch } }, descriptor.revision);
    return { ok: true, added, removed: 0, replaced: false, backup: null, needsRestart: false, updated: changed };
  } catch (error) {
    return { ok: false, error: error?.name === 'SettingsConflictError' || error?.constructor?.name === 'SettingsConflictError' ? 'config-conflict' : 'model-config-write-failed' };
  }
}

export function fingerprint(secret) {
  if (typeof secret !== 'string' || secret.length < 12) return null;
  return 'sha256:' + createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

/** Fixed model-list endpoint only; no inference or redirects with credentials. */
export async function verifyKey(secret, { fetchImpl = fetch } = {}) {
  if (!validSecret(secret)) return { ok: false, error: 'invalid-key' };
  try {
    const response = await fetchImpl('https://llmapi.paratera.com/v1/models', {
      headers: { Authorization: `Bearer ${secret}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    if (!response.ok) return { ok: false, error: `verify-http-${response.status}` };
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body?.data)) return { ok: false, error: 'verify-invalid-response' };
    const modelIds = [...new Set(body.data.filter((row) => object(row) && validModelId(row.id)).map((row) => row.id))];
    if (body.data.length && !modelIds.length) return { ok: false, error: 'verify-invalid-response' };
    return { ok: true, models: modelIds.length, modelIds };
  } catch { return { ok: false, error: 'verify-failed' }; }
}

/** Registry check, not a subscription purchase or inference request. */
export async function confirmProviderModels(ids, llm) {
  if (typeof llm?.listProviders !== 'function' || typeof llm?.listModels !== 'function') return { ok: false, error: 'model-directory-unavailable', providerRegistered: false };
  try {
    const providers = await llm.listProviders();
    if (!Array.isArray(providers) || !providers.some((provider) => provider.id === 'paratera')) return { ok: false, error: 'provider-not-registered', providerRegistered: false };
    const available = await llm.listModels('paratera');
    if (!Array.isArray(available) || ids.some((id) => !available.some((model) => model.id === id))) return { ok: false, error: 'model-directory-missing-models', providerRegistered: true, modelsAvailable: false };
    return { ok: true, providerRegistered: true, modelsAvailable: true };
  } catch { return { ok: false, error: 'model-directory-unavailable', providerRegistered: false }; }
}

/**
 * The ONLY credential write path. `state` belongs to one controller operation.
 * A backup is made at most once. An ambiguous set is reconciled against the
 * host on retry before doing anything else; callers must not delete that key.
 */
async function saveSecret(secret, { credentials, progress, result, state, isActive }) {
  if (state.credentialImported) return { ...result, credentialImported: true };
  if (!isActive()) return { ...result, ok: false, error: 'key-create-session-expired' };
  if (typeof credentials?.resolve !== 'function' || typeof credentials?.set !== 'function') return { ...result, ok: false, error: 'credentials-unavailable' };
  let previous;
  try { previous = (await credentials.resolve(REF))?.value; }
  catch { return { ...result, ok: false, error: 'credential-read-failed' }; }
  if (previous === secret) {
    state.credentialImported = true; state.credentialWriteUncertain = false;
    return { ...result, credentialImported: true };
  }
  state.credentialWriteUncertain = false;
  if (previous && !state.backupDone) {
    if (!isActive()) return { ...result, ok: false, error: 'key-create-session-expired' };
    progress('backup');
    try { await credentials.set(`${REF}_BACKUP`, previous); state.backupDone = true; }
    catch { return { ...result, ok: false, error: 'credential-backup-failed' }; }
  }
  previous = null;
  if (!isActive()) return { ...result, ok: false, error: 'key-create-session-expired' };
  progress('saving'); state.credentialWriteUncertain = true;
  try { await credentials.set(REF, secret); }
  catch { return { ...result, ok: false, error: 'credential-write-failed' }; }
  state.credentialImported = true; state.credentialWriteUncertain = false;
  return { ...result, credentialImported: true };
}

/** Retryable write core. Validate BEFORE touching credentials or state. */
export async function importPreparedKey(prepared, {
  credentials, settings, llm, apply = appendModels, onProgress = () => {},
  state = {}, isActive = () => true,
} = {}) {
  const progress = (stage) => { try { onProgress(stage); } catch {} };
  if (!object(prepared) || (!state.credentialImported && !validSecret(prepared.secret))) return { ok: false, error: 'key-create-session-expired' };
  const name = typeof prepared.name === 'string' ? prepared.name.trim() : '';
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: 'invalid-import-request' };
  if (!validSelection(prepared.models)) return { ok: false, error: 'invalid-models' };
  if (!Array.isArray(prepared.offered) || prepared.offered.some((id) => !validModelId(id))) return { ok: false, error: 'invalid-models' };
  if (prepared.models.some((id) => !prepared.offered.includes(id))) return { ok: false, error: 'model-not-available' };
  const models = [...new Set(prepared.models)];
  const result = {
    ok: true, name, fingerprint: prepared.fingerprint, createdKeyName: name,
    credentialImported: Boolean(state.credentialImported), modelsAdded: [], modelsSkipped: [], needsRestart: false,
    verifiedModels: prepared.verifiedModels,
  };
  const saved = await saveSecret(prepared.secret, { credentials, progress, result, state, isActive });
  if (!saved.ok) return saved;
  if (!models.length) return { ...saved, noModelsAvailable: prepared.offered.length === 0, modelConfigUpdated: false };
  if (!state.applied) {
    progress('models');
    let applied;
    try { applied = await apply(models, { settings }); }
    catch { applied = { ok: false, error: 'model-config-write-failed' }; }
    if (!applied?.ok) return { ...saved, ok: false, error: 'model-import-failed', modelError: applied?.error || 'model-config-write-failed' };
    state.applied = { added: Array.isArray(applied.added) ? applied.added.filter(validModelId) : [], updated: Boolean(applied.updated), needsRestart: Boolean(applied.needsRestart) };
  }
  Object.assign(saved, { modelsAdded: state.applied.added, modelsRemoved: 0, modelsReplaced: false,
    modelConfigUpdated: state.applied.updated, needsRestart: state.applied.needsRestart });
  progress('subscription');
  const catalog = await confirmProviderModels(models, llm);
  saved.providerRegistered = catalog.providerRegistered;
  saved.modelsAvailable = Boolean(catalog.modelsAvailable);
  if (!catalog.ok) return { ...saved, ok: false, error: 'model-import-failed', modelError: catalog.error };
  return saved;
}

/** Offline one-shot compatibility; host routes use the instance controller. */
export async function prepareNewKey(body, { create = createKey, verify = verifyKey, onProgress = () => {} } = {}) {
  if (!object(body)) return { ok: false, error: 'invalid-import-request' };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { ok: false, error: 'name-required' };
  if (name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: 'invalid-import-request' };
  const progress = (stage) => { try { onProgress(stage); } catch {} };
  progress('creating');
  let created;
  try { created = await create(name); } catch { created = { ok: false, error: 'key-create-unconfirmed' }; }
  if (created?.ok !== true) return { ok: false, error: created?.error || 'key-create-unconfirmed', createdKeyName: name };
  if (!validSecret(created.secret)) return { ok: false, error: 'key-create-secret-missing', createdKeyName: name };
  progress('verifying');
  let verified;
  try { verified = await verify(created.secret); } catch { verified = { ok: false, error: 'verify-failed' }; }
  if (verified?.ok !== true) return { ok: false, error: verified?.error || 'verify-failed', createdKeyName: name, credentialImported: false };
  if (!Array.isArray(verified.modelIds) || verified.modelIds.some((id) => !validModelId(id))) return { ok: false, error: 'verify-invalid-response', createdKeyName: name };
  const offered = [...new Set(verified.modelIds)];
  return { ok: true, name, createdKeyName: name, secret: created.secret, fingerprint: fingerprint(created.secret),
    models: offered, offered, verifiedModels: offered.length, credentialImported: false };
}

/** Offline compatibility wrapper; no separate save/apply implementation. */
export async function importNewKey(body, deps = {}) {
  if (!object(body) || body.dryRun !== undefined || (body.autoModels !== undefined && typeof body.autoModels !== 'boolean')
    || (body.autoModels === true && body.models !== undefined)) return { ok: false, error: 'invalid-import-request' };
  if (!validSelection(body.models === undefined ? [] : body.models)) return { ok: false, error: 'invalid-models' };
  const prepared = await prepareNewKey(body, deps);
  if (!prepared.ok) return prepared;
  const wanted = body.autoModels ? prepared.offered : body.models ?? [];
  if (wanted.length > 200) return { ok: false, error: 'model-selection-required', createdKeyName: prepared.name, credentialImported: false };
  const models = wanted.filter((id) => prepared.offered.includes(id));
  const result = await importPreparedKey({ ...prepared, models }, deps);
  return { ...result, modelsSkipped: wanted.filter((id) => !prepared.offered.includes(id)) };
}

/**
 * Legacy pure compatibility, available ONLY with an explicitly injected reveal
 * dependency for offline fixtures. No browser reveal code is imported by host.
 */
export async function importKey(body, {
  list = listKeys, reveal, verify = verifyKey, onProgress = () => {}, ...deps
} = {}) {
  if (typeof reveal !== 'function') return { ok: false, error: 'key-import-deprecated' };
  if (!object(body) || (body.uuid !== undefined && (typeof body.uuid !== 'string' || !body.uuid.trim()))
    || (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) || (!body.uuid && !body.name)
    || (body.dryRun !== undefined && typeof body.dryRun !== 'boolean')
    || (body.autoModels !== undefined && typeof body.autoModels !== 'boolean') || (body.autoModels === true && body.models !== undefined)) return { ok: false, error: 'invalid-import-request' };
  if (!validSelection(body.models === undefined ? [] : body.models)) return { ok: false, error: 'invalid-models' };
  const progress = (stage) => { try { onProgress(stage); } catch {} };
  try {
    progress('listing');
    const listed = await list();
    if (!listed?.ok) return { ok: false, error: listed?.error || 'key-list-failed' };
    const matches = listed.keys.filter((key) => body.uuid ? key.uuid === body.uuid : key.name === body.name);
    if (!matches.length) return { ok: false, error: 'key-not-found' };
    if (matches.length !== 1) return { ok: false, error: 'key-name-ambiguous' };
    const target = matches[0];
    if (['invalid', 'disabled'].includes(target.status)) return { ok: false, error: 'key-disabled' };
    progress('revealing');
    const revealed = await reveal({ uuid: target.uuid, name: target.name });
    if (!revealed?.ok) return { ok: false, error: revealed?.error || 'secret-not-revealed' };
    progress('verifying');
    const verified = await verify(revealed.secret);
    if (!verified?.ok) return { ok: false, error: verified?.error || 'verify-failed' };
    const offered = Array.isArray(verified.modelIds) ? verified.modelIds : [];
    const wanted = body.autoModels ? offered : body.models ?? [];
    if (body.autoModels && !wanted.length) return { ok: false, error: 'no-available-models' };
    if (wanted.length > 200) return { ok: false, error: 'model-selection-required' };
    if (wanted.some((id) => !validModelId(id))) return { ok: false, error: 'verify-invalid-response' };
    const skipped = wanted.filter((id) => !offered.includes(id));
    const models = wanted.filter((id) => offered.includes(id));
    if (wanted.length && !models.length) return { ok: false, error: 'model-not-available' };
    const prepared = { name: target.name, secret: revealed.secret, models, offered,
      fingerprint: fingerprint(revealed.secret), verifiedModels: verified.models };
    if (body.dryRun) return { ok: true, uuid: target.uuid, name: target.name, fingerprint: prepared.fingerprint,
      verifiedModels: verified.models, credentialImported: false, modelsAdded: [], modelsSkipped: skipped, needsRestart: false, dryRun: true };
    const result = await importPreparedKey(prepared, { ...deps, onProgress });
    return { ...result, uuid: target.uuid, modelsSkipped: skipped };
  } catch { return { ok: false, error: 'key-import-failed' }; }
}
