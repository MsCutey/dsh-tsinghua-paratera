#!/usr/bin/env node
// One-command installer for DSH profiles.
//
//   node scripts/install.mjs            install into ~/.dsh/profiles/desktop
//   node scripts/install.mjs --verify   check the current install
//   node scripts/install.mjs --dry-run  show planned changes only
//   node scripts/install.mjs --uninstall
//
// Edits the profile manifest, runs pnpm and manages the native background task.
// It never reads/writes account credentials. Prints a JSON summary for agents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCredentialHelper, removeMacCredentials } from '../lib/macos-credentials.mjs';
import { resolveInstallPlan, platformPaths } from '../lib/platform.mjs';
import { patchCleanupSupported } from '../lib/patch-cleanup-syntax.mjs';

export const PACKAGE_NAME = 'dsh-tsinghua-paratera';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');

export function parseArgs(argv) {
  const options = { profile: 'desktop', dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), dryRun: false, verify: false, uninstall: false, install: true, task: false, taskExplicit: false, json: false, keepData: false, purgeProfile: false, keepCredentials: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile' || arg === '--dsh-home') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('missing value for ' + arg);
      if (arg === '--profile') {
        if (!/^[\w-]+$/.test(value)) throw new Error('invalid profile name');
        options.profile = value;
      } else options.dshHome = path.resolve(value);
    }
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--no-install') options.install = false;
    else if (arg === '--task') { options.task = true; options.taskExplicit = true; }
    else if (arg === '--no-task') { options.task = false; options.taskExplicit = true; }
    else if (arg === '--json') options.json = true;
    else if (arg === '--keep-data') options.keepData = true;
    else if (arg === '--purge-profile') options.purgeProfile = true;
    else if (arg === '--keep-credentials') options.keepCredentials = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('unknown option: ' + arg);
  }
  if (options.uninstall && !options.taskExplicit) options.task = true;
  if (options.keepData && options.purgeProfile) throw new Error('--keep-data conflicts with --purge-profile');
  if (!options.uninstall && (options.keepData || options.purgeProfile || options.keepCredentials)) throw new Error('cleanup flags require --uninstall');
  if (options.verify && (options.uninstall || options.dryRun)) throw new Error('--verify conflicts with --uninstall/--dry-run');
  return options;
}

/** Pure manifest edit: returns the next manifest plus what changed. */
export function planManifest(manifest, pluginDir, { uninstall = false } = {}) {
  const next = JSON.parse(JSON.stringify(manifest));
  const before = JSON.stringify(manifest);

  next.dependencies = next.dependencies || {};
  next.dsh = next.dsh || {};
  next.dsh.profile = next.dsh.profile || {};
  const bundles = Array.isArray(next.dsh.profile.bundles) ? next.dsh.profile.bundles : [];
  next.dsh.profile.bundles = bundles;

  const link = 'link:' + pluginDir.replace(/\\/g, '/');
  const hadDependency = Object.prototype.hasOwnProperty.call(next.dependencies, PACKAGE_NAME);
  const hadBundle = bundles.includes(PACKAGE_NAME);

  if (uninstall) {
    delete next.dependencies[PACKAGE_NAME];
    next.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME);
  } else {
    next.dependencies[PACKAGE_NAME] = link;
    if (!hadBundle) bundles.push(PACKAGE_NAME);
  }

  return {
    manifest: next,
    changed: JSON.stringify(next) !== before,
    hadDependency,
    hadBundle,
    link,
  };
}

/** Data the plugin created outside the profile manifest (models, sessions, profile). */
export function pluginDataPaths(dshHome, platform = process.platform, home = os.homedir(), env = process.env) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const paths = platformPaths(platform, home, { ...env, DSH_HOME: dshHome });
  return {
    sessionFiles: [
      join(paths.dshHome, 'easycompute-session.json'),
      join(paths.dshHome, 'easycompute-state.json'),
      join(paths.dshHome, 'paratera-console-session.json'),
      join(paths.dshHome, 'easycompute-refresh.lock'),
    ],
    credentialFiles: platform === 'win32' ? [join(paths.dshHome, 'easycompute-credentials.bin')] : [],
    chromeProfile: paths.profileDir,
  };
}

/**
 * Remove the Paratera provider (and a default-model pointer to it) from the
 * profile's cordis.patch.yml without reformatting unrelated entries.
 * Returns the next text plus what would change; callers write with a backup.
 */
export function planPatchCleanup(text) {
  if (typeof text !== 'string') return { text, changed: false, removedProvider: false, removedDefault: false };
  if (!patchCleanupSupported(text)) return { text, changed: false, removedProvider: false, removedDefault: false, error: 'patch-cleanup-unsupported' };
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const indentOf = (line) => (line.match(/^ */) || [''])[0].length;
  const meaningful = (line) => line.trim() !== '' && !line.trim().startsWith('#');
  const scalar = (value) => value?.replace(/\s+#.*$/, '').trim().replace(/^(?:"([^"]*)"|'([^']*)')$/, (_, a, b) => a ?? b);
  // Patch entries are top-level list items; nested "- id:" keys (model rows) are not entries.
  const isEntryStart = (line) => /^-\s+id:/.test(line);
  const blocks = [];
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isEntryStart(lines[i])) {
      if (start !== -1) blocks.push([start, i]);
      start = i;
    }
  }
  if (start !== -1) blocks.push([start, lines.length]);

  const drop = new Set();
  let removedProvider = false;
  let removedDefault = false;
  for (const [from, to] of blocks) {
    const block = lines.slice(from, to);
    const id = scalar((block[0].match(/id:\s*(.*)$/) || [])[1]);
    if (!['agent-default-model', 'llm-pi-ai'].includes(id)) continue;
    const configStart = block.findIndex((line) => /^  (?:config|"config"|'config'):\s*(?:#.*)?$/.test(line));
    if (configStart === -1) continue;
    let configLimit = configStart + 1;
    while (configLimit < block.length && (!meaningful(block[configLimit]) || indentOf(block[configLimit]) > 2)) configLimit += 1;
    const configChildIndent = Math.min(...block.slice(configStart + 1, configLimit).filter(meaningful).map(indentOf));
    if (id === 'agent-default-model') {
      if (block.some((line, index) => index > configStart && index < configLimit && indentOf(line) === configChildIndent && scalar((line.match(/^\s*(?:provider|"provider"|'provider'):\s*(.*)$/) || [])[1]) === 'paratera')) {
        for (let i = from; i < to; i += 1) drop.add(i);
        removedDefault = true;
      }
      continue;
    }
    const providerIndex = block.findIndex((line, index) => index > configStart && index < configLimit && indentOf(line) === configChildIndent && /^\s*(?:providers|"providers"|'providers'):\s*(?:#.*)?$/.test(line));
    if (providerIndex === -1) continue;
    const providersIndent = indentOf(block[providerIndex]);
    let providersEnd = providerIndex + 1;
    while (providersEnd < block.length && (!meaningful(block[providersEnd]) || indentOf(block[providersEnd]) > providersIndent)) providersEnd += 1;
    const providerChildIndent = Math.min(...block.slice(providerIndex + 1, providersEnd).filter(meaningful).map(indentOf));
    const keyIndex = block.findIndex((line, index) => index > providerIndex && index < providersEnd
      && /^\s*(?:paratera|"paratera"|'paratera'):\s*(?:#.*|\{.*\})?$/.test(line) && indentOf(line) === providerChildIndent);
    if (keyIndex === -1) continue;
    const keyIndent = indentOf(block[keyIndex]);
    let keyEnd = keyIndex + 1;
    while (keyEnd < block.length && (block[keyEnd].trim() === '' || indentOf(block[keyEnd]) > keyIndent)) keyEnd += 1;
    for (let i = from + keyIndex; i < from + keyEnd; i += 1) drop.add(i);
    removedProvider = true;
    // Any sibling provider left at the same level keeps the entry; otherwise the
    // empty providers mapping would fail validation, so drop the whole entry.
    const siblings = block.filter((line, index) => index > providerIndex && index < providersEnd && (index < keyIndex || index >= keyEnd)
      && meaningful(line) && indentOf(line) === keyIndent && !line.trim().startsWith('-'));
    if (!siblings.length) {
      drop.add(from + providerIndex);
      // Remove an empty config/entry, but never discard unrelated LLM settings.
      const configIndex = configStart;
      if (configIndex !== -1) {
        let configEnd = configIndex + 1;
        while (configEnd < block.length && (!meaningful(block[configEnd]) || indentOf(block[configEnd]) > 2)) configEnd += 1;
        if (!block.some((line, index) => index > configIndex && index < configEnd && meaningful(line) && !drop.has(from + index))) drop.add(from + configIndex);
      }
      if (!block.some((line, index) => index > 0 && meaningful(line) && !drop.has(from + index))) {
        for (let i = from; i < to; i += 1) drop.add(i);
      }
    }
  }
  if (!drop.size) return { text, changed: false, removedProvider, removedDefault };
  const kept = lines.filter((_, index) => !drop.has(index));
  const next = kept.join(newline);
  return { text: next, changed: next !== text, removedProvider, removedDefault };
}

export function findPnpm(nodeExecutable = process.execPath, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const candidates = [];
  if (env.DSH_PNPM) {
    if (!fs.statSync(env.DSH_PNPM, { throwIfNoEntry: false })?.isFile() || !/\.(?:cjs|mjs|js)$/.test(env.DSH_PNPM)) throw new Error('DSH_PNPM must point to a pnpm JavaScript entry file');
    return { kind: 'script', path: path.resolve(env.DSH_PNPM) };
  }
  const nodeDir = path.dirname(nodeExecutable);
  candidates.push(path.resolve(nodeDir, '..', '..', 'pnpm', 'bin', 'pnpm.mjs'));
  candidates.push(path.resolve(nodeDir, '..', '..', 'pnpm', 'bin', 'pnpm.cjs'));
  candidates.push(path.resolve(nodeDir, '..', 'pnpm', 'bin', 'pnpm.mjs'));
  candidates.push(path.resolve(nodeDir, '..', 'pnpm', 'bin', 'pnpm.cjs'));
  candidates.push(path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'));
  candidates.push(path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'));
  if (platform === 'win32') {
    for (const directory of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
      for (const entry of ['node_modules/pnpm/bin/pnpm.cjs', 'node_modules/pnpm/bin/pnpm.mjs', 'pnpm.cjs', 'pnpm.mjs', 'node_modules/corepack/dist/pnpm.js']) candidates.push(path.join(directory.replace(/^"|"$/g, ''), entry));
    }
  }
  if (platform === 'darwin') {
    for (const apps of ['/Applications', path.join(home, 'Applications')]) {
      candidates.push(path.join(apps, 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'));
    }
  }
  for (const candidate of candidates) {
    if (candidate && fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return { kind: 'script', path: candidate };
  }
  if (platform === 'win32') {
    for (const directory of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
      const executable = path.join(directory.replace(/^"|"$/g, ''), 'pnpm.exe');
      if (fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) return { kind: 'path', path: executable };
    }
    // Never hand pnpm.cmd or user-controlled arguments to cmd.exe.
    throw new Error('pnpm JavaScript entry not found; set DSH_PNPM to pnpm.cjs or pnpm.mjs');
  }
  return { kind: 'path', path: 'pnpm' };
}

export function runBackgroundTask({ plan, pluginDir = PLUGIN_DIR, dshHome, uninstall = false, run = spawnSync }) {
  if (!plan.task) return { ok: false, error: 'task-unavailable' };
  const scriptPath = path.join(pluginDir, plan.task.script);
  const summary = { kind: plan.task.kind, script: path.basename(scriptPath), action: uninstall ? 'remove' : 'install' };
  if (!fs.existsSync(scriptPath)) return { ...summary, ok: false, error: 'task-script-missing' };
  const execution = plan.task.kind === 'powershell'
    ? { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-PluginDir', pluginDir, '-DshHome', path.resolve(dshHome), ...(uninstall ? ['-Remove'] : ['-NodeExecutable', process.execPath])] }
    : { file: process.execPath, args: [scriptPath, ...(uninstall ? ['--remove'] : [])] };
  const result = run(execution.file, execution.args, {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, DSH_HOME: path.resolve(dshHome), PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') },
  });
  return { ...summary, ok: result.status === 0, tail: (result.status === 0 ? result.stdout || '' : result.stderr || result.stdout || result.error?.message || '').trim().split('\n').slice(-6).join('\n') };
}

function runPnpm(profileDir, pnpm, extraArgs = []) {
  const args = pnpm.kind === 'script'
    ? [pnpm.path, 'install', '--no-frozen-lockfile', '--dir', profileDir, ...extraArgs]
    : ['install', '--no-frozen-lockfile', '--dir', profileDir, ...extraArgs];
  const executable = pnpm.kind === 'script' ? process.execPath : pnpm.path;
  const result = spawnSync(executable, args, {
    encoding: 'utf8', timeout: 1000 * 60 * 10,
    env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trim().split('\n').slice(-8).join('\n'),
    stderr: (result.stderr || '').trim().split('\n').slice(-8).join('\n'),
  };
}

function inspect(profileDir) {
  const manifestPath = path.join(profileDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const linkEntry = manifest.dependencies?.[PACKAGE_NAME] ?? null;
  const linked = linkEntry?.startsWith('link:') ?? false;
  const target = linked ? linkEntry.slice(5) : null;
  const bundleListed = Boolean(manifest.dsh?.profile?.bundles?.includes(PACKAGE_NAME));
  const moduleDir = path.join(profileDir, 'node_modules', PACKAGE_NAME);
  let moduleLinked = false;
  try { moduleLinked = fs.existsSync(moduleDir) && fs.realpathSync(moduleDir) === fs.realpathSync(target); } catch { moduleLinked = false; }
  return { manifestPath, linkEntry, linked, bundleListed, moduleLinked, target, moduleDir };
}

/** Other profiles share the same browser, password and background task. */
export function otherPluginProfiles(dshHome, selectedProfile) {
  const root = path.join(dshHome, 'profiles');
  const others = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const sameName = process.platform === 'win32' ? entry.name.toLowerCase() === selectedProfile.toLowerCase() : entry.name === selectedProfile;
    if (sameName || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const file = path.join(root, entry.name, 'package.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (manifest.dependencies?.[PACKAGE_NAME] || manifest.dsh?.profile?.bundles?.includes(PACKAGE_NAME)) others.push(entry.name);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('shared-profile-scan-failed'); }
  }
  return others;
}

/** Delete only plugin-owned data. Partial failure is never reported as success. */
export function cleanupPluginData({ profileDir, dshHome, purgeProfile = false, keepCredentials = false, keepSharedData = false }) {
  const result = { ok: true, patchFile: null, removedProvider: false, removedDefault: false, removedFiles: [], chromeProfileRemoved: false, sharedDataRetained: keepSharedData, errors: [] };
  const recordError = (file, error) => { result.ok = false; result.errors.push({ file, code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'cleanup-failed' }); };
  const data = pluginDataPaths(dshHome);
  const lockFile = data.sessionFiles.find((file) => file.endsWith('easycompute-refresh.lock'));
  try {
    const pid = keepSharedData ? null : Number(fs.readFileSync(lockFile, 'utf8').trim());
    if (!keepSharedData) {
      if (!Number.isSafeInteger(pid) || pid < 1) throw Object.assign(new Error(), { code: 'EBUSY' });
      try { process.kill(pid, 0); throw Object.assign(new Error(), { code: 'EBUSY' }); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') { recordError(lockFile, error); return result; }
  }
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  try {
    if (fs.existsSync(patchFile)) {
      const before = fs.readFileSync(patchFile, 'utf8');
      const plan = planPatchCleanup(before);
      if (plan.error) { result.ok = false; result.errors.push({ file: patchFile, code: plan.error }); return result; }
      if (plan.changed) {
        const backup = `${patchFile}.balance-backup-${Date.now()}`;
        fs.copyFileSync(patchFile, backup, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(backup, 0o600);
        fs.writeFileSync(patchFile, plan.text);
        result.patchFile = patchFile;
        result.patchBackup = backup;
        result.removedProvider = plan.removedProvider;
        result.removedDefault = plan.removedDefault;
      }
    }
  } catch (error) { recordError(patchFile, error); }
  const files = keepSharedData ? [] : [...data.sessionFiles, ...(keepCredentials ? [] : data.credentialFiles)];
  // Remove abandoned atomic-write files, never arbitrary JSON/credential files.
  try {
    for (const name of keepSharedData ? [] : fs.readdirSync(dshHome)) {
      if (/^(?:easycompute-session|easycompute-state|paratera-console-session)\.json\.\d+\.tmp$/.test(name)) files.push(path.join(dshHome, name));
    }
  } catch (error) { if (error.code !== 'ENOENT') recordError(dshHome, error); }
  for (const file of files) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) throw Object.assign(new Error(), { code: 'EISDIR' });
      fs.rmSync(file, { force: true });
      result.removedFiles.push(file);
    } catch (error) { if (error.code !== 'ENOENT') recordError(file, error); }
  }
  if (purgeProfile && !keepSharedData) {
    try {
      // Do not terminate a user's browser or follow directory links.
      const stat = fs.lstatSync(data.chromeProfile);
      fs.rmSync(data.chromeProfile, { recursive: !stat.isSymbolicLink(), force: true, maxRetries: 2 });
      result.chromeProfileRemoved = true;
    } catch (error) { if (error.code !== 'ENOENT') recordError(data.chromeProfile, error); }
  }
  return result;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exit(1);
  }
  if (options.help) {
    console.log('node scripts/install.mjs [--profile desktop] [--dsh-home DIR] [--dry-run|--verify|--uninstall|--no-install|--task|--no-task] [--keep-data|--purge-profile] [--keep-credentials]');
    return;
  }
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('supported platforms: macOS and Windows');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22+ required');

  const platformPlan = resolveInstallPlan(process.platform);
  if (!platformPlan.supported) {
    console.log(JSON.stringify({ ok: false, error: platformPlan.reason, platform: process.platform, hint: 'supported platforms: Windows 11/10, macOS 13+' }, null, 2));
    process.exit(1);
  }

  const profileDir = path.join(options.dshHome, 'profiles', options.profile);
  const manifestPath = path.join(profileDir, 'package.json');
  const summary = { ok: false, pluginDir: PLUGIN_DIR, platform: process.platform, profile: options.profile, profileDir, dryRun: options.dryRun };

  if (!fs.existsSync(manifestPath)) {
    console.log(JSON.stringify({ ...summary, error: 'profile-not-found', hint: `no manifest at ${manifestPath}` }, null, 2));
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (options.verify) {
    const state = inspect(profileDir);
    const sameTarget = (() => {
      try { return fs.realpathSync(state.target) === fs.realpathSync(PLUGIN_DIR); } catch { return false; }
    })();
    const ok = state.linked && state.bundleListed && state.moduleLinked && sameTarget;
    console.log(JSON.stringify({ ok, profileDir, ...state, hint: ok ? 'restart DSH to load the plugin' : 'run: node scripts/install.mjs' }, null, 2));
    process.exit(ok ? 0 : 1);
  }

  if (options.uninstall && !options.keepData) {
    const patchFile = path.join(profileDir, 'cordis.patch.yml');
    if (fs.existsSync(patchFile) && planPatchCleanup(fs.readFileSync(patchFile, 'utf8')).error) {
      console.log(JSON.stringify({ ...summary, error: 'patch-cleanup-unsupported', hint: 'complex YAML was left untouched; remove the Paratera provider manually, or use --uninstall --keep-data' }, null, 2));
      process.exit(1);
    }
  }
  const sharedProfiles = options.uninstall ? otherPluginProfiles(options.dshHome, options.profile) : [];
  const keepSharedData = sharedProfiles.length > 0;
  if (keepSharedData) {
    summary.sharedProfiles = sharedProfiles;
    summary.sharedDataRetained = true;
    if (options.purgeProfile) {
      console.log(JSON.stringify({ ...summary, error: 'shared-data-in-use', hint: 'other profiles still use this plugin; uninstall them before purging shared browser data' }, null, 2));
      process.exit(1);
    }
  }
  const plan = planManifest(manifest, PLUGIN_DIR, { uninstall: options.uninstall });
  summary.changed = plan.changed;

  if (options.dryRun) {
    const data = pluginDataPaths(options.dshHome);
    console.log(JSON.stringify({ ...summary, ok: true, wouldWrite: plan.changed, link: plan.link, taskRequested: options.task,
      taskAction: options.task && !keepSharedData ? (options.uninstall ? 'remove' : 'install') : null,
      cleanup: options.uninstall && !options.keepData ? { files: keepSharedData ? [] : [...data.sessionFiles, ...(options.keepCredentials ? [] : data.credentialFiles)], chromeProfile: options.purgeProfile ? data.chromeProfile : null, provider: 'paratera', sharedDataRetained: keepSharedData, keychain: process.platform === 'darwin' && !keepSharedData && !options.keepCredentials ? 'DSH 清华算力余额' : null } : null,
      nextManifest: options.json ? plan.manifest : undefined }, null, 2));
    return;
  }

  const pnpm = options.install ? findPnpm() : null;
  if (options.uninstall && options.task && !keepSharedData) {
    summary.task = runBackgroundTask({ plan: platformPlan, dshHome: options.dshHome, uninstall: true });
    if (!summary.task.ok) {
      console.log(JSON.stringify({ ...summary, error: 'task-removal-failed', hint: 'profile was not changed; stop the background agent before uninstalling' }, null, 2));
      process.exit(1);
    }
  }

  if (process.platform === 'darwin' && !options.uninstall) {
    try { summary.credentialHelper = await buildCredentialHelper(); }
    catch { throw new Error('keychain-helper-build-failed: install Xcode Command Line Tools (xcode-select --install)'); }
  }
  if (plan.changed) {
    summary.backup = `${manifestPath}.balance-backup-${Date.now()}`;
    fs.copyFileSync(manifestPath, summary.backup);
    fs.chmodSync(summary.backup, 0o600);
    fs.writeFileSync(manifestPath, JSON.stringify(plan.manifest, null, 2) + '\n');
  }

  if (options.install) {
    summary.pnpm = pnpm.kind === 'script' ? pnpm.path : 'pnpm (PATH)';
    const install = runPnpm(profileDir, pnpm);
    summary.install = { ok: install.ok, status: install.status, tail: install.ok ? install.stdout : (install.stderr || install.stdout) };
    if (!install.ok) {
      if (summary.backup) fs.copyFileSync(summary.backup, manifestPath);
      console.log(JSON.stringify({ ...summary, ok: false, error: 'pnpm-failed', hint: 'install pnpm or pass DSH_PNPM=<path to pnpm.cjs>' }, null, 2));
      process.exit(1);
    }
  }

  if (options.uninstall && !options.keepData) {
    summary.cleanup = cleanupPluginData({ profileDir, dshHome: options.dshHome, purgeProfile: options.purgeProfile, keepCredentials: options.keepCredentials, keepSharedData });
    if (process.platform === 'darwin' && !options.keepCredentials && !keepSharedData) {
      // Keychain data is not a plugin file, so remove it explicitly after the
      // file cleanup. It is never read or decrypted.
      summary.credentialCleanup = await removeMacCredentials({ dshHome: options.dshHome }).catch(() => ({ ok: false, error: 'credential-remove-failed' }));
    }
  }

  if (options.task && !options.uninstall && platformPlan.task) {
    summary.task = runBackgroundTask({ plan: platformPlan, dshHome: options.dshHome });
  }

  const state = inspect(profileDir);
  summary.profileReady = options.uninstall ? !state.bundleListed && !state.linked : state.linked && state.bundleListed && state.moduleLinked;
  summary.ok = summary.profileReady && summary.task?.ok !== false && summary.cleanup?.ok !== false && summary.credentialCleanup?.ok !== false;
  if (summary.task?.ok === false) summary.error = 'background-task-failed';
  if (summary.cleanup?.ok === false || summary.credentialCleanup?.ok === false) summary.error = 'cleanup-incomplete';
  summary.state = { linked: state.linked, bundleListed: state.bundleListed, moduleLinked: state.moduleLinked };
  summary.next = options.uninstall
    ? ['fully exit and restart DSH',
      summary.cleanup?.ok === false ? 'cleanup incomplete: close dedicated Chrome and credential dialogs, inspect cleanup.errors, then rerun uninstall' : null,
      options.keepData ? 'plugin data was intentionally retained' : keepSharedData ? 'shared sessions, saved password, browser data and background task remain for other profiles; only this profile models were cleaned' : 'plugin models, sessions and saved password were cleaned unless explicitly retained; recovery backups remain',
      !options.purgeProfile ? 'dedicated browser cookies remain; use --uninstall --purge-profile to remove them' : null,
      'DSH-owned PARATERA_API_KEY and PARATERA_API_KEY_BACKUP must be removed using DSH credential management; remote keys are not revoked',
    ].filter(Boolean)
    : [
      'restart DSH',
      'settings -> 清华算力余额 -> 保存凭据',
      summary.task?.ok === false ? 'background task failed; rerun with --task or see the error above' : null,
    ].filter(Boolean);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
}
