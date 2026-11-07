// Passwords travel only over the helper's stdout pipe to the host process.
// Never put credentials in argv, environment variables, logs, or temp files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'scripts', 'macos-credentials.swift');
const builder = fileURLToPath(import.meta.url);
export const helperPath = path.join(root, '.artifacts', `macos-${process.arch}`, 'credentials');
let building;
let dialogChild = null;
let dialogResult = null;

export function macCredentialDialogOpen() {
  return Boolean(dialogChild && dialogChild.exitCode === null && dialogChild.signalCode === null);
}

export function macCredentialDialogResult() {
  return dialogResult;
}

export async function buildCredentialHelper() {
  if (process.platform !== 'darwin') throw new Error('macos-only');
  if (building) return building;
  building = (async () => {
    const recipeTime = Math.max(fs.statSync(source).mtimeMs, fs.statSync(builder).mtimeMs);
    if (fs.existsSync(helperPath) && fs.statSync(helperPath).mtimeMs >= recipeTime) return helperPath;
    fs.mkdirSync(path.dirname(helperPath), { recursive: true, mode: 0o700 });
    const temporary = `${helperPath}.${process.pid}.tmp`;
    try {
      const moduleCache = path.join(root, '.artifacts', 'swift-module-cache');
      await exec('/usr/bin/xcrun', ['swiftc', '-O', '-module-cache-path', moduleCache, source, '-o', temporary], { timeout: 120000 });
      await exec('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'cn.edu.tsinghua.dsh-tsinghua-paratera.credentials', temporary], { timeout: 15000 });
      fs.chmodSync(temporary, 0o700);
      fs.renameSync(temporary, helperPath);
      return helperPath;
    } finally { fs.rmSync(temporary, { force: true }); }
  })().finally(() => { building = null; });
  return building;
}

export async function readMacCredentials() {
  // Build before installation; never compile or prompt from a background read.
  if (!fs.existsSync(helperPath)) return null;
  try {
    const { stdout } = await exec(helperPath, ['read'], { timeout: 15000, maxBuffer: 65536 });
    return JSON.parse(stdout);
  } catch { return null; }
}

export async function macCredentialsSaved({ helper = helperPath, exists = fs.existsSync, run = exec } = {}) {
  if (!exists(helper)) return false;
  try {
    const { stdout } = await run(helper, ['status'], { timeout: 15000, maxBuffer: 4096 });
    return JSON.parse(stdout)?.saved === true;
  } catch { return false; }
}

export async function openMacCredentialDialog({ build = buildCredentialHelper, spawnImpl = spawn } = {}) {
  try {
    if (macCredentialDialogOpen()) return { ok: true, alreadyOpen: true };
    const helper = await build();
    if (macCredentialDialogOpen()) return { ok: true, alreadyOpen: true };
    const child = spawnImpl(helper, ['store'], { detached: true, stdio: 'ignore' });
    dialogChild = child;
    dialogResult = null;
    child.once('exit', (code) => {
      if (dialogChild !== child) return;
      dialogChild = null;
      dialogResult = code === 0 ? 'saved' : code === 2 ? 'cancelled' : 'failed';
    });
    child.once('error', () => {
      if (dialogChild !== child) return;
      dialogChild = null;
      dialogResult = 'failed';
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { ok: true };
  } catch { return { ok: false, error: 'keychain-helper-unavailable' }; }
}


/** Keychain service name, matching scripts/macos-credentials.swift exactly. */
export function keychainService(dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  const resolved = path.resolve(dshHome);
  const defaultHome = path.resolve(os.homedir(), '.dsh');
  const namespace = resolved === defaultHome ? ''
    : '.' + createHash('sha256').update(resolved, 'utf8').digest('hex').slice(0, 16);
  return 'cn.edu.tsinghua.dsh-tsinghua-paratera' + namespace;
}

/**
 * Remove the saved login password without reading or decrypting it. The compiled
 * helper is preferred; the system `security` tool is a dependency-free fallback
 * for uninstall or a removed .artifacts directory. Idempotent when absent.
 */
export async function removeMacCredentials({
  dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  helper = helperPath,
  exists = fs.existsSync,
  run = exec,
  security = exec,
} = {}) {
  const options = { timeout: 15000, maxBuffer: 4096, env: { ...process.env, DSH_HOME: dshHome } };
  if (exists(helper)) {
    try {
      const { stdout } = await run(helper, ['delete'], options);
      if (JSON.parse(stdout)?.ok === true) return { ok: true };
    } catch {}
  }
  try {
    await security('/usr/bin/security', ['delete-generic-password', '-s', keychainService(dshHome), '-a', 'easycompute'], options);
    return { ok: true };
  } catch (error) {
    // errSecItemNotFound means there is nothing left to delete.
    return error?.code === 44 ? { ok: true } : { ok: false, error: 'credential-remove-failed' };
  }
}
