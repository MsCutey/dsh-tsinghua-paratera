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

export const PACKAGE_NAME = 'dsh-paratera-balance';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');

export function parseArgs(argv) {
  const options = { profile: 'desktop', dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), dryRun: false, verify: false, uninstall: false, install: true, task: false, taskExplicit: false, json: false };
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

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exit(1);
  }
  if (options.help) {
    console.log('node scripts/install.mjs [--profile desktop] [--dsh-home DIR] [--dry-run|--verify|--uninstall|--no-install|--task|--no-task]');
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

  if (options.task && !options.uninstall && platformPlan.task) {
    summary.task = runBackgroundTask({ plan: platformPlan, dshHome: options.dshHome });
  }

  const state = inspect(profileDir);
  summary.profileReady = options.uninstall ? !state.bundleListed && !state.linked : state.linked && state.bundleListed && state.moduleLinked;
  summary.ok = summary.profileReady && summary.task?.ok !== false;
  if (summary.task?.ok === false) summary.error = 'background-task-failed';
  summary.state = { linked: state.linked, bundleListed: state.bundleListed, moduleLinked: state.moduleLinked };
  summary.next = options.uninstall
    ? ['restart DSH']
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
