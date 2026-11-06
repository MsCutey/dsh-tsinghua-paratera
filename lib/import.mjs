// Import through the host's revisioned settings and credential services. Never
// search/overwrite the first models: block or assume the desktop profile path.
import { listKeys } from './keys.mjs';
import { revealKeySecret } from './reveal.mjs';
import { recommendedModel } from './models.mjs';

const REF = 'PARATERA_API_KEY';
const validModelId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(id);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Revision-checked, provider-scoped update; native settings owns persistence.
 * The patch is sparse on purpose: `describe()` returns the parsed config, where
 * schemastery materialises defaults (notably `modelOverrides: {}`), so echoing
 * it back would pin defaults and made a second import look "unsupported".
 * `replace` swaps the Paratera model list for the given selection; the default
 * keeps existing entries and appends the new ones.
 */
export async function appendModels(ids, { settings, replace = false } = {}) {
  if (!Array.isArray(ids) || ids.some((id) => !validModelId(id)) || ids.length > 200) return { ok: false, error: 'invalid-models' };
  const wanted = [...new Set(ids)];
  if (!wanted.length) return { ok: true, added: [], backup: null, needsRestart: false };
  if (typeof settings?.describe !== 'function' || typeof settings?.update !== 'function') return { ok: false, error: 'settings-unavailable' };
  try {
    const descriptor = settings.describe().find((row) => row.ns === 'llm-pi-ai');
    if (!descriptor || !object(descriptor.value) || !object(descriptor.value.providers)) return { ok: false, error: 'provider-config-unavailable' };
    const live = descriptor.value.providers.paratera;
    if (live !== undefined && !object(live)) return { ok: false, error: 'provider-config-invalid' };
    // The user layer holds exactly what was stored; the live value adds schema
    // defaults. Prefer the stored half, but hosts that omit `user` (or configs
    // inherited from a lower layer) fall back to the live value.
    const userLayer = object(descriptor.user) && object(descriptor.user.providers) ? descriptor.user.providers.paratera : undefined;
    if (userLayer !== undefined && !object(userLayer)) return { ok: false, error: 'provider-config-invalid' };
    if (userLayer?.models !== undefined && !Array.isArray(userLayer.models)) return { ok: false, error: 'provider-config-invalid' };
    if (live?.models !== undefined && !Array.isArray(live.models)) return { ok: false, error: 'provider-config-invalid' };
    const stored = userLayer ?? live;
    const models = stored?.models ?? [];
    if (models.some((model) => !object(model) || !validModelId(model.id))) return { ok: false, error: 'provider-config-invalid' };
    const existing = new Set(models.map((model) => model.id));
    const added = wanted.filter((id) => !existing.has(id));
    // Old imports carried a "(待校准)" placeholder name. Migrate only those
    // entries; a name the user chose is never rewritten.
    const upgrade = (model) => (typeof model.name === 'string' && /\(待校准\)\s*$/.test(model.name) ? recommendedModel(model.id) : model);
    const kept = (replace ? models.filter((model) => wanted.includes(model.id)) : models).map(upgrade);
    const nextModels = [...kept, ...added.map((id) => recommendedModel(id))];
    const defaults = { displayName: 'Paratera', api: 'openai-completions', baseURL: 'https://llmapi.paratera.com/v1' };
    const patch = { models: nextModels, apiKeyEnv: REF };
    for (const [field, value] of Object.entries(defaults)) if (stored?.[field] === undefined) patch[field] = value;
    const removed = replace ? models.length - kept.length : 0;
    const changed = removed > 0 || added.length > 0 || stored?.apiKeyEnv !== REF
      || JSON.stringify(nextModels) !== JSON.stringify(models)
      || Object.keys(defaults).some((field) => stored?.[field] === undefined);
    if (changed) await settings.update(descriptor.ns, { providers: { paratera: patch } }, descriptor.revision);
    return { ok: true, added, removed, replaced: replace, backup: null, needsRestart: false, updated: changed };
  } catch (error) {
    return { ok: false, error: error?.name === 'SettingsConflictError' || error?.constructor?.name === 'SettingsConflictError' ? 'config-conflict' : 'model-config-write-failed' };
  }
}

/** Fingerprint shown in the UI; never the secret itself. */
export function fingerprint(secret) {
  if (typeof secret !== 'string' || secret.length < 12) return null;
  return secret.slice(0, 5) + '****' + secret.slice(-4);
}

/** Verify against the fixed public model-list endpoint, without token spend. */
export async function verifyKey(secret, { fetchImpl = fetch } = {}) {
  if (typeof secret !== 'string' || !secret.trim() || /\s/.test(secret)) return { ok: false, error: 'invalid-key' };
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
  } catch {
    return { ok: false, error: 'verify-failed' };
  }
}

/** Read the real host registry after Settings reconciles; this is not inference. */
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

/** Host-only orchestration. Dependencies make failure paths testable in isolation. */
export async function importKey(body, {
  credentials, settings, llm, list = listKeys, reveal = revealKeySecret, verify = verifyKey, apply = appendModels,
  onProgress = () => {},
} = {}) {
  const progress = (stage) => { try { onProgress(stage); } catch {} };
  if (!object(body) || (body.uuid !== undefined && (typeof body.uuid !== 'string' || !body.uuid.trim())) ||
      (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) ||
      (!body.uuid && !body.name) || (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') ||
      (body.replaceModels !== undefined && typeof body.replaceModels !== 'boolean') ||
      (body.autoModels !== undefined && typeof body.autoModels !== 'boolean') || (body.autoModels === true && body.models !== undefined)) {
    return { ok: false, error: 'invalid-import-request' };
  }
  let models = body.models === undefined ? [] : body.models;
  if (!Array.isArray(models) || models.length > 200 || models.some((id) => !validModelId(id))) return { ok: false, error: 'invalid-models' };
  try {
    progress('listing');
    const listed = await list();
    if (!listed.ok) return { ok: false, error: listed.error || 'key-list-failed' };
    const matches = listed.keys.filter((key) => body.uuid ? key.uuid === body.uuid : key.name === body.name);
    if (!matches.length) return { ok: false, error: 'key-not-found' };
    if (matches.length !== 1) return { ok: false, error: 'key-name-ambiguous' };
    const target = matches[0];
    if (target.status === 'invalid' || target.status === 'disabled') return { ok: false, error: 'key-disabled' };
    progress('revealing');
    const revealed = await reveal({ uuid: target.uuid, name: target.name });
    if (!revealed.ok) return { ok: false, error: revealed.error || 'secret-not-revealed' };
    progress('verifying');
    const verified = await verify(revealed.secret);
    if (!verified.ok) return { ok: false, error: verified.error || 'verify-failed' };
    if (body.autoModels) {
      if (!Array.isArray(verified.modelIds) || verified.modelIds.length === 0) return { ok: false, error: 'no-available-models' };
      models = [...new Set(verified.modelIds)];
      if (models.length > 200) return { ok: false, error: 'model-selection-required' };
      if (models.some((id) => !validModelId(id))) return { ok: false, error: 'verify-invalid-response' };
    }
    // The console entitlement can list models the public gateway no longer
    // serves (retired ERNIE/Qwen builds). Importing every entitled id used to
    // fail the whole request; import the served subset and say what was skipped.
    let skipped = [];
    if (models.length) {
      const offered = Array.isArray(verified.modelIds) ? verified.modelIds : [];
      skipped = models.filter((id) => !offered.includes(id));
      models = models.filter((id) => offered.includes(id));
      if (!models.length) return { ok: false, error: 'model-not-available' };
    }
    const result = {
      ok: true, uuid: target.uuid, name: target.name, fingerprint: fingerprint(revealed.secret),
      verifiedModels: verified.models, credentialImported: false, modelsAdded: [], needsRestart: false,
      modelsSkipped: skipped,
    };
    if (body.dryRun) return { ...result, dryRun: true };
    if (typeof credentials?.resolve !== 'function' || typeof credentials?.set !== 'function') return { ...result, ok: false, error: 'credentials-unavailable' };
    let previous;
    try { previous = (await credentials.resolve(REF))?.value; }
    catch { return { ...result, ok: false, error: 'credential-read-failed' }; }
    if (previous && previous !== revealed.secret) {
      progress('backup');
      try { await credentials.set(`${REF}_BACKUP`, previous); }
      catch { return { ...result, ok: false, error: 'credential-backup-failed' }; }
    }
    progress('saving');
    try { await credentials.set(REF, revealed.secret); }
    catch { return { ...result, ok: false, error: 'credential-write-failed' }; }
    result.credentialImported = true;
    if (models.length) {
      progress('models');
      let applied;
      try { applied = await apply([...new Set(models)], { settings, replace: body.replaceModels === true }); }
      catch { applied = { ok: false, error: 'model-config-write-failed' }; }
      if (!applied.ok) return { ...result, ok: false, error: 'model-import-failed', modelError: applied.error };
      result.modelsAdded = applied.added;
      result.modelsRemoved = Number.isSafeInteger(applied.removed) ? applied.removed : 0;
      result.modelsReplaced = applied.replaced === true;
      result.modelConfigUpdated = Boolean(applied.updated);
      result.needsRestart = Boolean(applied.needsRestart);
      progress('subscription'); // Compatibility label: checking the model-provider entry, not purchasing a plan.
      const catalog = await confirmProviderModels(models, llm);
      result.providerRegistered = catalog.providerRegistered;
      result.modelsAvailable = Boolean(catalog.modelsAvailable);
      if (!catalog.ok) return { ...result, ok: false, error: 'model-import-failed', modelError: catalog.error };
    }
    return result;
  } catch {
    return { ok: false, error: 'key-import-failed' };
  }
}
