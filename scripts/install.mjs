#!/usr/bin/env node
// One-command installer for DSH profiles.
//
//   node scripts/install.mjs            install into ~/.dsh/profiles/desktop
//   node scripts/install.mjs --verify   check the current install
//   node scripts/install.mjs --dry-run  show planned changes only
//   node scripts/install.mjs --uninstall
//
// The script only edits the profile manifest and runs pnpm; it never reads or
// writes credentials. Prints a JSON summary on stdout for agent consumption.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'dsh-paratera-balance';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');

function parseArgs(argv) {
  const options = { profile: 'desktop', dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), dryRun: false, verify: false, uninstall: false, install: true, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile') options.profile = argv[++i];
    else if (arg === '--dsh-home') options.dshHome = argv[++i];
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--uninstall') { options.uninstall = true; options.install = false; }
    else if (arg === '--no-install') options.install = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error('unknown option: ' + arg);
  }
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

function findPnpm(nodeExecutable = process.execPath) {
  const candidates = [];
  if (process.env.DSH_PNPM) candidates.push(process.env.DSH_PNPM);
  const nodeDir = path.dirname(nodeExecutable);
  candidates.push(path.resolve(nodeDir, '..', '..', 'pnpm', 'bin', 'pnpm.cjs'));
  candidates.push(path.resolve(nodeDir, '..', 'pnpm', 'bin', 'pnpm.cjs'));
  candidates.push(path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'));
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return { kind: 'script', path: candidate };
  }
  return { kind: 'path', path: 'pnpm' };
}

function runPnpm(profileDir, pnpm, extraArgs = []) {
  const args = pnpm.kind === 'script'
    ? [pnpm.path, 'install', '--dir', profileDir, ...extraArgs]
    : ['install', '--dir', profileDir, ...extraArgs];
  const executable = pnpm.kind === 'script' ? process.execPath : pnpm.path;
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 1000 * 60 * 10 });
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

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exit(1);
  }
  if (options.help) {
    console.log('node scripts/install.mjs [--profile desktop] [--dsh-home DIR] [--dry-run|--verify|--uninstall|--no-install]');
    return;
  }

  const profileDir = path.join(options.dshHome, 'profiles', options.profile);
  const manifestPath = path.join(profileDir, 'package.json');
  const summary = { ok: false, pluginDir: PLUGIN_DIR, profile: options.profile, profileDir, dryRun: options.dryRun };

  if (!fs.existsSync(manifestPath)) {
    console.log(JSON.stringify({ ...summary, error: 'profile-not-found', hint: `no manifest at ${manifestPath}` }, null, 2));
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (options.verify) {
    const state = inspect(profileDir);
    const ok = state.linked && state.bundleListed && state.moduleLinked;
    console.log(JSON.stringify({ ok, profileDir, ...state, hint: ok ? 'restart DSH to load the plugin' : 'run: node scripts/install.mjs' }, null, 2));
    process.exit(ok ? 0 : 1);
  }

  const plan = planManifest(manifest, PLUGIN_DIR, { uninstall: options.uninstall });
  summary.changed = plan.changed;

  if (options.dryRun) {
    console.log(JSON.stringify({ ...summary, ok: true, wouldWrite: plan.changed, link: plan.link, nextManifest: options.json ? plan.manifest : undefined }, null, 2));
    return;
  }

  if (plan.changed) fs.writeFileSync(manifestPath, JSON.stringify(plan.manifest, null, 2) + '\n');

  if (options.install) {
    const pnpm = findPnpm();
    summary.pnpm = pnpm.kind === 'script' ? pnpm.path : 'pnpm (PATH)';
    const install = runPnpm(profileDir, pnpm);
    summary.install = { ok: install.ok, status: install.status, tail: install.ok ? install.stdout : install.stderr };
    if (!install.ok) {
      console.log(JSON.stringify({ ...summary, ok: false, error: 'pnpm-failed', hint: 'install pnpm or pass DSH_PNPM=<path to pnpm.cjs>' }, null, 2));
      process.exit(1);
    }
  }

  const state = inspect(profileDir);
  summary.ok = options.uninstall ? !state.bundleListed : state.linked && state.bundleListed;
  summary.state = { linked: state.linked, bundleListed: state.bundleListed, moduleLinked: state.moduleLinked };
  summary.next = options.uninstall
    ? ['restart DSH']
    : ['restart DSH', 'settings -> 清华算力余额 -> 保存凭据', 'optional: powershell -ExecutionPolicy Bypass -File scripts/setup-windows-task.ps1'];
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
