import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupPluginData, pluginDataPaths, parseArgs, planPatchCleanup, runBackgroundTask, otherPluginProfiles, findPnpm } from '../scripts/install.mjs';
import { resolveInstallPlan } from '../lib/platform.mjs';

afterEach(() => mock.restoreAll());
function fixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'paratera-uninstall-中文 '));
  const profileDir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(profileDir, { recursive: true });
  try { return run({ home, profileDir }); }
  finally { mock.restoreAll(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 2 }); }
}

test('custom home cleanup removes only plugin-owned data and the exact browser profile', () => fixture(({ home, profileDir }) => {
  const data = pluginDataPaths(home);
  const files = [...data.sessionFiles, ...data.credentialFiles, path.join(home, 'easycompute-session.json.123.tmp')];
  for (const file of files) fs.writeFileSync(file, file.endsWith('.lock') ? '2147483647' : 'fake-test-only');
  const unrelated = path.join(home, 'unrelated.json');
  fs.writeFileSync(unrelated, 'must survive');
  fs.mkdirSync(data.chromeProfile, { recursive: true });
  fs.writeFileSync(path.join(data.chromeProfile, 'fake-cookie'), 'fake');
  const patch = path.join(profileDir, 'cordis.patch.yml');
  fs.writeFileSync(patch, '- id: llm-pi-ai\n  config:\n    providers:\n      other: {}\n      paratera:\n        apiKeyEnv: PARATERA_API_KEY\n');
  const result = cleanupPluginData({ profileDir, dshHome: home, purgeProfile: true });
  assert.equal(result.ok, true);
  assert.equal(result.removedProvider, true);
  assert.equal(result.chromeProfileRemoved, true);
  for (const file of files) assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'must survive');
  assert.match(fs.readFileSync(patch, 'utf8'), /other: \{\}/);
  assert.match(fs.readFileSync(result.patchBackup, 'utf8'), /paratera:/);
  assert.equal(cleanupPluginData({ profileDir, dshHome: home, purgeProfile: true }).ok, true);
}));

test('normal cleanup retains browser cookies and explicitly retained Windows credentials', () => fixture(({ home, profileDir }) => {
  const data = pluginDataPaths(home);
  fs.mkdirSync(data.chromeProfile, { recursive: true });
  for (const file of data.credentialFiles) fs.writeFileSync(file, 'fake-test-only');
  const result = cleanupPluginData({ profileDir, dshHome: home, keepCredentials: true });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(data.chromeProfile), true);
  for (const file of data.credentialFiles) assert.equal(fs.existsSync(file), true);
}));

test('failed removal is reported with a bounded code instead of silent success or raw error', () => fixture(({ home, profileDir }) => {
  const target = pluginDataPaths(home).sessionFiles[0];
  fs.writeFileSync(target, 'fake-test-only');
  const remove = fs.rmSync;
  mock.method(fs, 'rmSync', (file, options) => {
    if (file === target) throw Object.assign(Error('sensitive upstream text'), { code: 'EPERM' });
    return remove(file, options);
  });
  const result = cleanupPluginData({ profileDir, dshHome: home });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ file: target, code: 'EPERM' }]);
  assert.equal(JSON.stringify(result).includes('sensitive upstream text'), false);
  assert.equal(fs.existsSync(target), true);
}));

test('cleanup never recursively deletes an unexpected directory at a credential-file path', { skip: process.platform !== 'win32' }, () => fixture(({ home, profileDir }) => {
  const file = pluginDataPaths(home).credentialFiles[0];
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, 'must-survive'), 'test-only');
  const result = cleanupPluginData({ profileDir, dshHome: home });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'EISDIR');
  assert.equal(fs.existsSync(path.join(file, 'must-survive')), true);
}));

test('an active refresh lock prevents all shared-data cleanup without terminating its owner', () => fixture(({ home, profileDir }) => {
  const data = pluginDataPaths(home);
  const lock = data.sessionFiles.find((file) => file.endsWith('.lock'));
  fs.writeFileSync(lock, String(process.pid));
  fs.writeFileSync(data.sessionFiles[0], 'fake-test-only');
  const result = cleanupPluginData({ profileDir, dshHome: home, purgeProfile: true });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'EBUSY');
  assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.existsSync(data.sessionFiles[0]), true);
}));

test('Windows task removal is explicit and uses the selected home without a Node dependency', () => {
  let call;
  const result = runBackgroundTask({ plan: resolveInstallPlan('win32'), dshHome: process.cwd(), uninstall: true,
    run(file, args, options) { call = { file, args, options }; return { status: 0, stdout: '{}' }; },
  });
  assert.equal(result.ok, true);
  assert.equal(call.file, 'powershell.exe');
  assert.ok(call.args.includes('-Remove'));
  assert.ok(call.args.includes('-DshHome'));
  assert.equal(call.args.includes('-NodeExecutable'), false);
});

test('cleanup argument conflicts fail before any mutation', () => {
  assert.throws(() => parseArgs(['--uninstall', '--keep-data', '--purge-profile']));
  assert.throws(() => parseArgs(['--purge-profile']));
  assert.throws(() => parseArgs(['--keep-credentials']));
  assert.throws(() => parseArgs(['--verify', '--uninstall']));
  assert.equal(parseArgs(['--uninstall', '--keep-credentials']).keepCredentials, true);
});

test('patch cleanup preserves CRLF, quoted keys and unrelated settings in the same entry', () => {
  const patch = ['- id: "llm-pi-ai"', '  config:', '    providers:', '      "paratera": # imported', '        models: []', '    unrelatedOption: true', '  enabled: true', '- id: agent-default-model', '  config:', "    provider: 'paratera' # default", '    model: fake', ''].join('\r\n');
  const result = planPatchCleanup(patch);
  assert.equal(result.removedProvider, true);
  assert.equal(result.removedDefault, true);
  assert.match(result.text, /unrelatedOption: true\r\n  enabled: true/);
  assert.equal(result.text.includes('providers:'), false);
  assert.equal(result.text.includes('paratera'), false);
  assert.equal(planPatchCleanup(result.text).changed, false);
});

test('nested paratera fields do not delete unrelated providers or default models', () => {
  for (const patch of [
    '- id: llm-pi-ai\n  config:\n    providers:\n      other:\n        settings:\n          paratera: {}\n',
    '- id: agent-default-model\n  config:\n    provider: deepseek\n    model: preserved-default\n    metadata:\n      provider: paratera\n',
    '- id: llm-pi-ai\n  config:\n    metadata:\n      providers:\n        paratera: {}\n',
  ]) assert.deepEqual(planPatchCleanup(patch), { text: patch, changed: false, removedProvider: false, removedDefault: false });
});

test('ambiguous YAML is refused unchanged, rather than silently leaving or corrupting provider data', () => {
  const fixtures = [
    '- id: llm-pi-ai\n  config:\n    providers: {paratera: {models: []}}\n',
    '- id: llm-pi-ai\n  config:\n    providers: &p\n      paratera: {}\n',
    '- id: external\n  config: &p {paratera: {}}\n- id: llm-pi-ai\n  config:\n    providers: *p\n',
    '- id: llm-pi-ai\n  config:\n    providers:\n      <<: *p\n',
    '- {id: llm-pi-ai, config: {providers: {paratera: {}}}}\n',
    '- id: llm-pi-ai\n  config:\n    providers:\n      paratera: &p {}\n      other: *p\n',
    '- id: "llm-\\u0070i-ai"\n  config:\n    providers:\n      "\\u0070aratera": {}\n',
    '- id: agent-default-model\n  config:\n    provider: deepseek\n    prompt: |\n      provider: paratera\n',
  ];
  for (const text of fixtures) {
    const plan = planPatchCleanup(text);
    assert.equal(plan.error, 'patch-cleanup-unsupported', text);
    assert.equal(plan.text, text);
    assert.equal(plan.changed, false);
  }
});

test('unsupported patch preflight leaves manifest, fake password and browser untouched', () => fixture(({ home, profileDir }) => {
  const manifestFile = path.join(profileDir, 'package.json');
  const manifest = JSON.stringify({ name: 'test-only', dependencies: { 'dsh-tsinghua-paratera': 'link:fake' } });
  fs.writeFileSync(manifestFile, manifest);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const patch = '- id: llm-pi-ai\n  config:\n    providers: {paratera: {}}\n';
  fs.writeFileSync(patchFile, patch);
  const data = pluginDataPaths(home);
  for (const file of data.credentialFiles) fs.writeFileSync(file, 'fake-test-only');
  fs.mkdirSync(data.chromeProfile);
  const script = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script, '--dsh-home', home, '--uninstall', '--no-task', '--no-install', '--purge-profile'], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).error, 'patch-cleanup-unsupported');
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), manifest);
  assert.equal(fs.readFileSync(patchFile, 'utf8'), patch);
  for (const file of data.credentialFiles) assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(data.chromeProfile), true);
}));

test('other installed profiles retain shared credentials, sessions, browser and task ownership', () => fixture(({ home, profileDir }) => {
  const sibling = path.join(home, 'profiles', 'secondary');
  fs.mkdirSync(sibling);
  const manifest = { name: 'test-only', private: true, dependencies: { 'dsh-tsinghua-paratera': 'link:fake' }, dsh: { profile: { bundles: ['dsh-tsinghua-paratera'] } } };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(sibling, 'package.json'), JSON.stringify(manifest));
  assert.deepEqual(otherPluginProfiles(home, process.platform === 'win32' ? 'DESKTOP' : 'desktop'), ['secondary']);
  const data = pluginDataPaths(home);
  fs.writeFileSync(data.sessionFiles[0], 'fake-test-only');
  for (const file of data.credentialFiles) fs.writeFileSync(file, 'fake-test-only');
  fs.mkdirSync(data.chromeProfile);
  const script = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, '--dsh-home', home, '--no-task', '--no-install', '--uninstall', ...args], { encoding: 'utf8', timeout: 30000 });
  const refused = run('--purge-profile');
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).error, 'shared-data-in-use');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')), manifest);
  const removed = run();
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal(JSON.parse(removed.stdout).sharedDataRetained, true);
  assert.equal(fs.existsSync(data.sessionFiles[0]), true);
  for (const file of data.credentialFiles) assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(data.chromeProfile), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sibling, 'package.json'), 'utf8')), manifest);
}));

test('Windows resolves the JavaScript behind npm pnpm.cmd without using a command shell', { skip: process.platform !== 'win32' }, () => fixture(({ home }) => {
  const bin = path.join(home, 'global bin');
  const entry = path.join(bin, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "console.log('fake-pnpm-only')");
  fs.writeFileSync(path.join(bin, 'pnpm.cmd'), '@echo must-not-execute');
  const options = { platform: 'win32', home, env: { PATH: bin } };
  const result = findPnpm(path.join(home, 'fake-node', 'node.exe'), options);
  assert.deepEqual(result, { kind: 'script', path: entry });
  const child = spawnSync(process.execPath, [result.path, '--version'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.equal(child.stdout.trim(), 'fake-pnpm-only');
  fs.unlinkSync(entry);
  assert.throws(() => findPnpm(path.join(home, 'fake-node', 'node.exe'), options), /JavaScript entry not found/);
}));

test('Windows entry point previews an isolated Unicode profile and never changes its manifest', { skip: process.platform !== 'win32' }, () => fixture(({ home, profileDir }) => {
  const file = path.join(profileDir, 'package.json');
  const before = JSON.stringify({ name: 'fake-test-profile', private: true });
  fs.writeFileSync(file, before);
  const script = fileURLToPath(new URL('../scripts/windows.ps1', import.meta.url));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'Plan', '-NodeExecutable', process.execPath, '-DshHome', home], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.profileDir, profileDir);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
}));

test('macOS uninstall cleans only the selected home keychain namespace and supports keep-credentials', { skip: process.platform !== 'darwin' }, () => fixture(({ home, profileDir }) => {
  const manifest = { name: 'test-only', private: true, dependencies: { 'dsh-tsinghua-paratera': 'link:fake' }, dsh: { profile: { bundles: ['dsh-tsinghua-paratera'] } } };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest));
  const script = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, '--dsh-home', home, '--no-task', '--no-install', '--uninstall', ...args], { encoding: 'utf8', timeout: 30000 });
  const kept = run('--keep-credentials');
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  assert.equal(Object.hasOwn(JSON.parse(kept.stdout), 'credentialCleanup'), false);
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest));
  const removed = run();
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.deepEqual(JSON.parse(removed.stdout).credentialCleanup, { ok: true });
}));
