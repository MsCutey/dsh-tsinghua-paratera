// Passwords travel only over the helper's stdout pipe to the host process.
// Never put credentials in argv, environment variables, logs, or temp files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'scripts', 'macos-credentials.swift');
const builder = fileURLToPath(import.meta.url);
export const helperPath = path.join(root, '.artifacts', `macos-${process.arch}`, 'credentials');
let building;

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
      await exec('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'cn.edu.tsinghua.dsh-paratera-balance.credentials', temporary], { timeout: 15000 });
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

export async function openMacCredentialDialog() {
  try {
    const helper = await buildCredentialHelper();
    const child = spawn(helper, ['store'], { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { ok: true };
  } catch { return { ok: false, error: 'keychain-helper-unavailable' }; }
}
