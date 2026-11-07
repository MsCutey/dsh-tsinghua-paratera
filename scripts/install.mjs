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
import { buildCredentialHelper } from '../lib/macos-credentials.mjs';
import { resolveInstallPlan } from '../lib/platform.mjs';

export const PACKAGE_NAME = 'dsh-tsinghua-paratera';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');

export function parseArgs(argv) {
  const options = { profile: 'desktop', dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), dryRun: false, verify: false, uninstall: false, install: true, task: false, taskExplicit: false, json: false, keepData: false, purgeProfile: false };
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
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('unknown option: ' + arg);
  }
  if (options.uninstall && !options.taskExplicit) options.task = true;
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
  const join = platform === 'win32' ? path.win32.join : path.join;
  return {
    sessionFiles: [
      join(dshHome, 'easycompute-session.json'),
      join(dshHome, 'easycompute-state.json'),
      join(dshHome, 'paratera-console-session.json'),
      join(dshHome, 'easycompute-refresh.lock'),
    ],
    chromeProfile: platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'DSH Tsinghua Paratera')
      : join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'dsh-tsinghua-paratera-profile'),
  };
}

/**
 * Remove the Paratera provider (and a default-model pointer to it) from the
 * profile's cordis.patch.yml without reformatting unrelated entries.
 * Returns the next text plus what would change; callers write with a backup.
 */
export function planPatchCleanup(text) {
  if (typeof text !== 'string') return { text, changed: false, removedProvider: false, removedDefault: false };
  const lines = text.split('\n');
  const indentOf = (line) => (line.match(/^ */) || [''])[0].length;
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
    const id = (block[0].match(/id:\s*([^\s#]+)/) || [])[1];
    if (id === 'agent-default-model' && block.some((line) => /^\s*provider:\s*paratera\s*$/.test(line))) {
      for (let i = from; i < to; i += 1) drop.add(i);
      removedDefault = true;
      continue;
    }
    if (id !== 'llm-pi-ai') continue;
    const providerIndex = block.findIndex((line) => /^\s*providers:\s*$/.test(line));
    if (providerIndex === -1) continue;
    const providersIndent = indentOf(block[providerIndex]);
    const keyIndex = block.findIndex((line, index) => index > providerIndex
      && /^\s*paratera:\s*$/.test(line) && indentOf(line) > providersIndent);
    if (keyIndex === -1) continue;
    const keyIndent = indentOf(block[keyIndex]);
    let keyEnd = keyIndex + 1;
    while (keyEnd < block.length && (block[keyEnd].trim() === '' || indentOf(block[keyEnd]) > keyIndent)) keyEnd += 1;
    for (let i = from + keyIndex; i < from + keyEnd; i += 1) drop.add(i);
    removedProvider = true;
    // Any sibling provider left at the same level keeps the entry; otherwise the
    // empty providers mapping would fail validation, so drop the whole entry.
    const siblings = block.filter((line, index) => index > providerIndex && (index < keyIndex || index >= keyEnd)
      && line.trim() !== '' && indentOf(line) === keyIndent && !line.trim().startsWith('-'));
    if (!siblings.length) for (let i = from; i < to; i += 1) drop.add(i);
  }
  if (!drop.size) return { text, changed: false, removedProvider, removedDefault };
  const kept = lines.filter((_, index) => !drop.has(index));
  const next = kept.join('\n');
  return { text: next, changed: next !== text, removedProvider, removedDefault };
}

export function findPnpm(nodeExecutable = process.execPath) {
  const candidates = [];
  if (process.env.DSH_PNPM) candidates.push(process.env.DSH_PNPM);
  const nodeDir = path.dirname(nodeExecutable);
  candidates.push(path.resolve(nodeDir, '..', '..', 'pnpm', 'bin', 'pnpm.cjs'));
  candidates.push(path.resolve(nodeDir, '..', 'pnpm', 'bin', 'pnpm.cjs'));
  candidates.push(path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'));
  if (process.platform === 'darwin') {
    for (const apps of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      candidates.push(path.join(apps, 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'));
    }
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return { kind: 'script', path: candidate };
  }
  return { kind: 'path', path: 'pnpm' };
}

export function runBackgroundTask({ plan, pluginDir = PLUGIN_DIR, dshHome, uninstall = false, run = spawnSync }) {
  if (!plan.task) return { ok: false, error: 'task-unavailable' };
  const scriptPath = path.join(pluginDir, plan.task.script);
  const summary = { kind: plan.task.kind, script: path.basename(scriptPath), action: uninstall ? 'remove' : 'install' };
  if (!fs.existsSync(scriptPath)) return { ...summary, ok: false, error: 'task-script-missing' };
  const execution = plan.task.kind === 'powershell'
    ? { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-PluginDir', pluginDir] }
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

/** Remove imported models and plugin state so an uninstall leaves no stale config. */
function cleanupPluginData({ profileDir, dshHome, purgeProfile = false }) {
  const result = { patchFile: null, removedProvider: false, removedDefault: false, removedFiles: [], chromeProfileRemoved: false };
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  if (fs.existsSync(patchFile)) {
    const before = fs.readFileSync(patchFile, 'utf8');
    const plan = planPatchCleanup(before);
    if (plan.changed) {
      const backup = `${patchFile}.balance-backup-${Date.now()}`;
      fs.copyFileSync(patchFile, backup);
      fs.chmodSync(backup, 0o600);
      fs.writeFileSync(patchFile, plan.text);
      result.patchFile = patchFile;
      result.patchBackup = backup;
      result.removedProvider = plan.removedProvider;
      result.removedDefault = plan.removedDefault;
    }
  }
  for (const file of pluginDataPaths(dshHome).sessionFiles) {
    try { if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); result.removedFiles.push(file); } } catch {}
  }
  if (purgeProfile) {
    const dir = pluginDataPaths(dshHome).chromeProfile;
    try { if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); result.chromeProfileRemoved = true; } } catch {}
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
    console.log('node scripts/install.mjs [--profile desktop] [--dsh-home DIR] [--dry-run|--verify|--uninstall|--no-install|--task|--no-task] [--keep-data] [--purge-profile]');
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

  const plan = planManifest(manifest, PLUGIN_DIR, { uninstall: options.uninstall });
  summary.changed = plan.changed;

  if (options.dryRun) {
    console.log(JSON.stringify({ ...summary, ok: true, wouldWrite: plan.changed, link: plan.link, taskRequested: options.task, nextManifest: options.json ? plan.manifest : undefined }, null, 2));
    return;
  }

  if (options.uninstall && options.task && process.platform === 'darwin') {
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
    const pnpm = findPnpm();
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
    summary.cleanup = cleanupPluginData({ profileDir, dshHome: options.dshHome, dshProfile: options.profile, purgeProfile: options.purgeProfile });
  }

  if (options.task && !options.uninstall && platformPlan.task) {
    summary.task = runBackgroundTask({ plan: platformPlan, dshHome: options.dshHome });
  }

  const state = inspect(profileDir);
  summary.profileReady = options.uninstall ? !state.bundleListed && !state.linked : state.linked && state.bundleListed && state.moduleLinked;
  summary.ok = summary.profileReady && summary.task?.ok !== false;
  if (summary.task?.ok === false) summary.error = 'background-task-failed';
  summary.state = { linked: state.linked, bundleListed: state.bundleListed, moduleLinked: state.moduleLinked };
  summary.next = options.uninstall
    ? ['restart DSH', options.keepData ? null : 'imported models and session files were removed; rerun with --keep-data to keep them'].filter(Boolean)
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
