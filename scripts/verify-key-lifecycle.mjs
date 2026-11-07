#!/usr/bin/env node
// Explicit, non-billable console mutation acceptance entry. Never reveal/import a key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SAFE_ERRORS = new Set([
  'invalid-arguments', 'name-required', 'key-quota-exceeded', 'invalid-console-path',
  'console-session-missing', 'console-session-expired', 'console-api-error',
  'console-timeout', 'console-network-error', 'console-invalid-response',
  'keys-invalid-response', 'keys-pagination-stalled', 'keys-pagination-limit',
  'key-create-unconfirmed', 'key-delete-unconfirmed', 'key-delete-not-deleted',
]);
const safeError = (value, fallback) => SAFE_ERRORS.has(value) ? value
  : typeof value === 'string' && /^console-http-[45][0-9]{2}$/.test(value) ? value : fallback;
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/[^A-Za-z0-9+/=_-]/.test(value) && !/^sk-/i.test(value);

// listKeys' public result is complete only on success. Require its complete-list
// invariant as well, never infer absence from a failed/partial/malformed list.
function completeList(value) {
  if (value?.ok !== true || !Array.isArray(value.keys) || !Number.isSafeInteger(value.total)
    || value.total !== value.keys.length) return false;
  const seen = new Set();
  for (const key of value.keys) {
    if (!key || !validId(key.uuid) || typeof key.name !== 'string' || !key.name.trim() || seen.has(key.uuid)) return false;
    seen.add(key.uuid);
  }
  return true;
}

/** All dependencies are injected; no session or network is touched without both flags. */
export async function runKeyLifecycle({ live = false, confirmCreateDelete = false, list, create, remove, receipt } = {}) {
  if (live !== true || confirmCreateDelete !== true) return { ok: true, skipped: true, stage: 'not-opted-in' };
  if (![list, create, remove].every((fn) => typeof fn === 'function')) return { ok: false, stage: 'configuration', error: 'missing-dependencies' };
  // Keep the dedicated marker and 80 bits of entropy within common 30-char UI limits.
  const testName = `dsh-test-${crypto.randomBytes(10).toString('hex')}`;
  let testUuid;
  let createAttempted = false;
  const finish = (ok, stage, error) => ({ ok, skipped: false, stage, ...(error ? { error } : {}),
    testName, cleanupRequired: createAttempted && !ok });
  const save = async (stage) => {
    if (receipt) await receipt({ name: testName, ...(testUuid ? { uuid: testUuid } : {}), stage });
  };
  let baseline;
  try { baseline = await list(); } catch { return finish(false, 'baseline', 'list-failed'); }
  if (!completeList(baseline)) return finish(false, 'baseline', safeError(baseline?.error, 'list-incomplete'));
  if (baseline.keys.some((key) => key.name === testName)) return finish(false, 'baseline', 'name-collision');
  const baselineIds = new Set(baseline.keys.map((key) => key.uuid));
  try { await save('before-create'); } catch { return finish(false, 'receipt', 'receipt-write-failed'); }
  createAttempted = true;
  let created;
  try { created = await create(testName); } catch {
    try { await save('create-unknown'); } catch {}
    return finish(false, 'create-unknown', 'create-unconfirmed');
  }
  if (created?.ok !== true) {
    try { await save('create-unconfirmed'); } catch {}
    return finish(false, 'create', safeError(created?.error, 'create-unconfirmed'));
  }
  try { await save('created-unidentified'); } catch { return finish(false, 'receipt', 'receipt-write-failed'); }
  let afterCreate;
  try { afterCreate = await list(); } catch { return finish(false, 'identify', 'list-failed'); }
  if (!completeList(afterCreate)) return finish(false, 'identify', safeError(afterCreate?.error, 'list-incomplete'));
  const matching = afterCreate.keys.filter((key) => key.name === testName);
  if (matching.length !== 1 || baselineIds.has(matching[0]?.uuid)) return finish(false, 'identify', 'created-key-ambiguous');
  testUuid = matching[0].uuid;
  try { await save('before-delete'); } catch { return finish(false, 'receipt', 'receipt-write-failed'); }
  let deleted;
  // Exactly one deletion attempt. No fallback transport or retry after ambiguity.
  try { deleted = await remove(testUuid); } catch {
    try { await save('delete-unknown'); } catch {}
    return finish(false, 'delete-unknown', 'key-delete-unconfirmed');
  }
  if (deleted?.ok !== true) {
    try { await save('delete-unconfirmed'); } catch {}
    return finish(false, 'delete', safeError(deleted?.error, 'key-delete-unconfirmed'));
  }
  try { await save('delete-acknowledged'); } catch { return finish(false, 'receipt', 'receipt-write-failed'); }
  let final;
  try { final = await list(); } catch { return finish(false, 'verify', 'list-failed'); }
  if (!completeList(final)) return finish(false, 'verify', safeError(final?.error, 'list-incomplete'));
  // Check both identifiers: an opaque ID may change representation between lists.
  if (final.keys.some((key) => key.uuid === testUuid || key.name === testName)) return finish(false, 'verify', 'key-delete-not-deleted');
  try { await save('complete'); } catch { return finish(false, 'receipt', 'receipt-write-failed'); }
  return finish(true, 'complete');
}

export function parseArguments(args) {
  const parsed = { live: false, confirmCreateDelete: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--live') parsed.live = true;
    else if (arg === '--confirm-create-delete') parsed.confirmCreateDelete = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--receipt' && !parsed.receipt && args[i + 1] && !args[i + 1].startsWith('--')) parsed.receipt = args[++i];
    else throw new Error('invalid-arguments');
  }
  return parsed;
}

// Only an explicitly requested NEW receipt beneath this checkout's .artifacts
// may be written. Existing files and symlink/reparse-point parents are refused.
export function openReceipt(receiptPath) {
  const root = path.join(PROJECT_ROOT, '.artifacts');
  const target = path.resolve(PROJECT_ROOT, receiptPath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('invalid-receipt-path');
  const parent = path.dirname(target);
  let current = PROJECT_ROOT;
  for (const component of path.relative(PROJECT_ROOT, parent).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let entry;
    try { entry = fs.lstatSync(current); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('invalid-receipt-path');
    if (!entry) fs.mkdirSync(current, { mode: 0o700 });
  }
  const fd = fs.openSync(target, 'wx', 0o600);
  return {
    write(value) {
      const safe = { name: value.name, ...(value.uuid ? { uuid: value.uuid } : {}), stage: value.stage };
      const bytes = Buffer.from(JSON.stringify(safe, null, 2) + '\n');
      fs.writeSync(fd, bytes, 0, bytes.length, 0);
      fs.ftruncateSync(fd, bytes.length);
      fs.fsyncSync(fd);
    },
    close() { fs.closeSync(fd); },
  };
}

const USAGE = 'Skipped by default. Usage: node scripts/verify-key-lifecycle.mjs --live --confirm-create-delete [--receipt .artifacts/NEW-receipt.json]\nCreates ONE random test key and deletes only its uniquely identified new UUID. No reveal, import, inference, or automatic retries. Stop concurrent key management. On any uncertainty, inspect the printed dedicated test name in the official console and clean up manually. Never attach session files, key values, or raw responses.';

export async function main(args = process.argv.slice(2), { load = () => import('../lib/keys.mjs'), output = console.log } = {}) {
  let options;
  try { options = parseArguments(args); } catch { output('Invalid arguments. ' + USAGE); return 2; }
  if (options.help || !options.live || !options.confirmCreateDelete) { output(USAGE); return 0; }
  let writer;
  try {
    if (options.receipt) writer = openReceipt(options.receipt);
    const keys = await load();
    const result = await runKeyLifecycle({ ...options, list: keys.listKeys, create: keys.createKey, remove: keys.deleteKey,
      receipt: (value) => {
        if (value.stage === 'before-create') output(JSON.stringify({ testName: value.name, stage: value.stage }));
        writer?.write(value);
      } });
    output(JSON.stringify(result));
    if (result.cleanupRequired) output('STOP: do not retry automatically. In the official console, inspect only the dedicated test name above; remove it manually if present. No existing key should be deleted.');
    return result.ok ? 0 : 1;
  } catch { output('Lifecycle entry failed safely. No raw response is shown. If creation had begun, inspect the dedicated test name in the receipt/earlier output; do not rerun blindly.'); return 1; }
  finally { try { writer?.close(); } catch {} }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
