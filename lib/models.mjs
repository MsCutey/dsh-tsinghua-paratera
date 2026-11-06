// Per-model defaults and the editable model list behind 「模型设置」.
// Context lengths come from the platform's own model plaza detail dialogs
// (lib/model-catalog.mjs); the family heuristics below only fill ids the
// catalog does not know. Everything stays user-editable.
import { MODEL_CATALOG } from './model-catalog.mjs';

const DEFAULT_CONTEXT = 131072; // 128K, the value most unknown Paratera routes accept.
const MAX_MODELS = 200;
const MIN_CONTEXT = 1;
const MAX_CONTEXT = 4_000_000;
const MIN_MAX_TOKENS = 1;
const MAX_MAX_TOKENS = 1_000_000;
const MODALITIES = new Set(['text', 'image']);
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const ROUTE_DEFAULTS = { displayName: 'Paratera', api: 'openai-completions', baseURL: 'https://llmapi.paratera.com/v1' };

const validModelId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(id);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Vision chat models: -VL, GLM's 4V/4.5V/4.6V suffixes, "Vision" and "Omni".
// A plain "-V4" version marker (DeepSeek-V4…) is not a vision model.
const VISION = /vision|(?:^|[-_.])vl(?:$|[-_.\d])|\d+(?:\.\d+)?v(?:$|[-_.\d])|omni/i;
// Families whose context window is documented and larger than the 128K floor.
const LARGER_CONTEXT = [
  [/^kimi-k[23]/i, 262144],
  [/^qwen-long/i, 1048576],
  [/^glm-4-long/i, 1048576],
];

export function isVisionModel(id) {
  return typeof id === 'string' && (Boolean(MODEL_CATALOG[id]?.vision) || VISION.test(id));
}

/** Whether the platform tags this model as a thinking model (informational only). */
export function supportsReasoning(id) {
  return Boolean(MODEL_CATALOG[id]?.reasoning);
}

function contextHint(id) {
  if (MODEL_CATALOG[id]?.contextWindow) return MODEL_CATALOG[id].contextWindow;
  const explicit = id.match(/[-_.](\d{2,4})k(?:[-_.]|$)/i);
  if (explicit) {
    const tokens = Number(explicit[1]) * 1024;
    if (Number.isSafeInteger(tokens) && tokens >= MIN_CONTEXT && tokens <= MAX_CONTEXT) return tokens;
  }
  for (const [pattern, tokens] of LARGER_CONTEXT) if (pattern.test(id)) return tokens;
  return DEFAULT_CONTEXT;
}

/** Recommended model entry for one catalog id; used at import and by 「恢复推荐值」. */
export function recommendedModel(id) {
  const contextWindow = contextHint(id);
  const knownCap = MODEL_CATALOG[id]?.maxOutput;
  return {
    id,
    name: id,
    contextWindow,
    maxTokens: Number.isFinite(knownCap) && knownCap > 0 ? Math.min(knownCap, contextWindow) : recommendedMaxTokens(contextWindow),
    input: isVisionModel(id) ? ['text', 'image'] : ['text'],
  };
}

/**
 * Output cap for models no online catalog covers: half the window, never more
 * than 128K (the largest cap the matched Paratera routes publish). Half keeps
 * room for the prompt on small-window models.
 */
export function recommendedMaxTokens(contextWindow) {
  return Math.min(131072, Math.max(2048, Math.floor(contextWindow / 2)));
}

/**
 * The levels 「模型设置」 writes when thinking is on: the native four the
 * composer shows for reasoning models (Off / Low / High / Max), not DSH's
 * full six-level editor scale. Off sends nothing; the rest are wire spellings.
 */
export function thinkingEfforts() {
  return { off: null, low: 'low', high: 'high', max: 'max' };
}

/** Validate a stored `reasoningEfforts`; undefined when off, null when refused. */
function normalizeEfforts(value) {
  if (value === undefined || value === false) return undefined;
  if (!object(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length) return null;
  let offersLevel = false;
  for (const [level, wire] of entries) {
    if (!THINKING_LEVELS.has(level)) return null;
    if (wire === null) {
      if (level !== 'off') return null;
    } else if (typeof wire === 'string' && wire.length > 0) {
      if (level !== 'off') offersLevel = true;
    } else return null;
  }
  return offersLevel ? Object.fromEntries(entries) : null;
}

const clampInt = (value, min, max) => (Number.isSafeInteger(value) && value >= min && value <= max ? value : null);

/** Validate and detach one stored model entry; null when it cannot be served. */
export function normalizeModel(value) {
  if (!object(value) || !validModelId(value.id)) return null;
  const recommended = recommendedModel(value.id);
  const name = typeof value.name === 'string' && value.name.trim() && value.name.trim().length <= 120 && !/[\u0000-\u001f\u007f]/.test(value.name)
    ? value.name.trim() : recommended.name;
  const contextWindow = clampInt(value.contextWindow, MIN_CONTEXT, MAX_CONTEXT) ?? recommended.contextWindow;
  const maxTokens = clampInt(value.maxTokens, MIN_MAX_TOKENS, MAX_MAX_TOKENS) ?? recommended.maxTokens;
  const input = Array.isArray(value.input) && value.input.length && value.input.every((item) => MODALITIES.has(item))
    ? [...new Set(value.input)].filter((item) => item === 'text' || item === 'image')
    : recommended.input;
  const efforts = normalizeEfforts(value.reasoningEfforts);
  if (efforts === null) return null;
  return {
    id: value.id, name, contextWindow, maxTokens,
    input: input.includes('text') ? input : ['text', ...input],
    ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
  };
}

/** Validate a full model list for writing; returns { ok, models } or an error code. */
export function validateModels(value) {
  if (!Array.isArray(value) || value.length > MAX_MODELS) return { ok: false, error: 'invalid-models' };
  const seen = new Set();
  const models = [];
  for (const entry of value) {
    const model = normalizeModel(entry);
    if (!model) return { ok: false, error: 'invalid-models' };
    if (seen.has(model.id)) return { ok: false, error: 'invalid-models' };
    seen.add(model.id);
    models.push(model);
  }
  return { ok: true, models };
}

/** The stored user layer for the Paratera route, without schema-materialised defaults. */
function storedProvider(descriptor) {
  if (!descriptor) return undefined;
  const user = object(descriptor.user) && object(descriptor.user.providers) ? descriptor.user.providers.paratera : undefined;
  if (object(user)) return user;
  const live = object(descriptor.value) && object(descriptor.value.providers) ? descriptor.value.providers.paratera : undefined;
  return object(live) ? live : undefined;
}

/** Read the editable model list, with the recommendation shown for each row. */
export async function readModels({ settings } = {}) {
  if (typeof settings?.describe !== 'function') return { ok: false, error: 'settings-unavailable' };
  try {
    const descriptor = settings.describe().find((row) => row.ns === 'llm-pi-ai');
    if (!descriptor) return { ok: false, error: 'provider-config-unavailable' };
    const provider = storedProvider(descriptor);
    const stored = Array.isArray(provider?.models) ? provider.models : [];
    const models = [];
    for (const entry of stored) {
      const model = normalizeModel(entry);
      if (!model) continue; // never echo an entry the host could not serve
      models.push({
        ...model,
        reasoning: Boolean(model.reasoningEfforts),
        supportsReasoning: supportsReasoning(model.id),
        recommended: recommendedModel(model.id),
      });
    }
    return {
      ok: true,
      models,
      provider: { displayName: provider?.displayName ?? 'Paratera', api: provider?.api ?? 'openai-completions', baseURL: provider?.baseURL ?? 'https://llmapi.paratera.com/v1' },
      revision: descriptor.revision,
    };
  } catch {
    return { ok: false, error: 'model-config-read-failed' };
  }
}

/** Replace the Paratera model list through the revisioned Settings API. */
export async function writeModels(value, { settings, revision } = {}) {
  const checked = validateModels(value);
  if (!checked.ok) return checked;
  if (typeof settings?.describe !== 'function' || typeof settings?.update !== 'function') return { ok: false, error: 'settings-unavailable' };
  try {
    const descriptor = settings.describe().find((row) => row.ns === 'llm-pi-ai');
    if (!descriptor) return { ok: false, error: 'provider-config-unavailable' };
    if (Number.isSafeInteger(revision) && descriptor.revision !== revision) return { ok: false, error: 'config-conflict' };
    const provider = storedProvider(descriptor);
    // A route without protocol fields cannot be resolved by the host adapter,
    // so the first save from this page also fills the same defaults as import.
    const patch = { models: checked.models };
    for (const [field, value] of Object.entries(ROUTE_DEFAULTS)) if (provider?.[field] === undefined) patch[field] = value;
    if (provider?.apiKeyEnv === undefined) patch.apiKeyEnv = 'PARATERA_API_KEY';
    await settings.update(descriptor.ns, { providers: { paratera: patch } }, descriptor.revision);
    return { ok: true, models: checked.models, revision: descriptor.revision + 1 };
  } catch (error) {
    return { ok: false, error: error?.name === 'SettingsConflictError' || error?.constructor?.name === 'SettingsConflictError' ? 'config-conflict' : 'model-config-write-failed' };
  }
}
