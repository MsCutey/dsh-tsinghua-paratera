// Import a revealed API key into DSH, optionally appending selected models to the
// profile's cordis.patch.yml (append-only, backed up, text-level edit).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CONTEXT = 128000;
const DEFAULT_MAX_TOKENS = 8192;

function profileConfigPath(dshHome) {
  return path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
}

/** Append model ids to the paratera provider block. Returns what was added. */
export function appendModels(ids, { dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh') } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return { ok: true, added: [], backup: null };
  const file = profileConfigPath(dshHome);
  if (!fs.existsSync(file)) return { ok: false, error: 'config-not-found' };
  const text = fs.readFileSync(file, 'utf8');
  const existing = new Set([...text.matchAll(/^\s*-\s*id:\s*([^\s#]+)/gm)].map((m) => m[1]));
  const wanted = ids.filter((id) => typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id) && !existing.has(id));
  if (wanted.length === 0) return { ok: true, added: [], backup: null };

  const lines = text.split('\n');
  const modelsIndex = lines.findIndex((line) => /^\s*models:\s*$/.test(line));
  if (modelsIndex === -1) return { ok: false, error: 'models-block-not-found' };

  // Determine indentation from the first existing entry under models:
  let entryIndent = '          ';
  for (let i = modelsIndex + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\s*)-\s+id:/);
    if (match) { entryIndent = match[1]; break; }
    if (/^\s{0,6}\S/.test(lines[i])) break;
  }
  const fieldIndent = entryIndent + '  ';

  const block = [];
  for (const id of wanted) {
    block.push(`${entryIndent}- id: ${id}`);
    block.push(`${fieldIndent}name: ${id} (待校准)`);
    block.push(`${fieldIndent}contextWindow: ${DEFAULT_CONTEXT}`);
    block.push(`${fieldIndent}maxTokens: ${DEFAULT_MAX_TOKENS}`);
  }

  // Insert before the first sibling key at a lower indent after the models list.
  let insertAt = lines.length;
  for (let i = modelsIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent < entryIndent.length) { insertAt = i; break; }
  }

  const backup = `${file}.balance-backup-${Date.now()}`;
  fs.copyFileSync(file, backup);
  const next = [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)].join('\n');
  fs.writeFileSync(file, next);
  return { ok: true, added: wanted, backup };
}

/** Fingerprint shown in the UI; never the secret itself. */
export function fingerprint(secret) {
  if (typeof secret !== 'string' || secret.length < 8) return null;
  return secret.slice(0, 5) + '****' + secret.slice(-4);
}

/** Verify the key against the public model list (no token spend). */
export async function verifyKey(secret) {
  try {
    const response = await fetch('https://llmapi.paratera.com/v1/models', {
      headers: { Authorization: `Bearer ${secret}`, accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { ok: false, error: `verify-http-${response.status}` };
    const body = await response.json().catch(() => null);
    return { ok: true, models: Array.isArray(body?.data) ? body.data.length : 0 };
  } catch (error) {
    return { ok: false, error: 'verify-failed' };
  }
}
