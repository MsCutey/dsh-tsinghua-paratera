// No real ScheduledTasks operations and no credential read mode in this suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { platformPaths } from '../lib/platform.mjs';
import { EventEmitter } from 'node:events';
import { removeSavedCredentials, openCredentialDialog, credentialDialogOpen } from '../lib/refresh.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const taskScript = path.join(root, 'scripts/setup-windows-task.ps1');
const storeScript = path.join(root, 'scripts/store-easycompute-credentials.ps1');
const readScript = path.join(root, 'scripts/read-easycompute-credentials.ps1');
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const powershell = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : null;

function isolated(fn) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-windows-test-')));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { force: true, recursive: true }); }
}
function runPS(dir, source) {
  const wrapper = path.join(dir, `mock-${Math.random().toString(16).slice(2)}.ps1`);
  // BOM is required for non-ASCII source in Windows PowerShell 5.1.
  const blockedCmdlets = ['Get-ScheduledTask', 'Stop-ScheduledTask', 'Unregister-ScheduledTask', 'Register-ScheduledTask', 'New-ScheduledTaskAction', 'New-ScheduledTaskTrigger', 'New-ScheduledTaskSettingsSet', 'New-ScheduledTaskPrincipal'];
  const guards = blockedCmdlets.map((name) => `function ${name} { throw 'REAL_TASK_CALL_FORBIDDEN' }`).join('\n');
  fs.writeFileSync(wrapper, '\ufeff$ErrorActionPreference = \'Stop\'\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n' + guards + '\n' + source);
  return spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, USERPROFILE: dir, DSH_HOME: path.join(dir, 'isolated-home'), DSH_NODE: '' },
  });
}
function success(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test('Windows paths use target-platform semantics and configured Program Files', () => {
  const value = platformPaths('win32', 'C:\\Users\\Test User', {
    DSH_HOME: 'D:\\isolated [test]\\配置', LOCALAPPDATA: 'E:\\Local',
    ProgramW6432: 'F:\\Programs', 'ProgramFiles(x86)': 'G:\\Programs x86',
  });
  assert.equal(value.dshHome, 'D:\\isolated [test]\\配置');
  assert.equal(value.sessionFile, 'D:\\isolated [test]\\配置\\easycompute-session.json');
  assert.equal(value.profileDir, 'D:\\isolated [test]\\配置\\browser-profile');
  assert.deepEqual(value.chromeCandidates, [
    'F:\\Programs\\Google\\Chrome\\Application\\chrome.exe',
    'G:\\Programs x86\\Google\\Chrome\\Application\\chrome.exe',
    'E:\\Local\\Google\\Chrome\\Application\\chrome.exe',
  ]);
  const standard = platformPaths('win32', 'C:\\Users\\Test', { DSH_HOME: 'c:/users/TEST/.dsh/', LOCALAPPDATA: 'C:\\Local' });
  assert.equal(standard.profileDir, 'C:\\Local\\dsh-tsinghua-paratera-profile');
  const mac = platformPaths('darwin', '/Users/Test', { DSH_HOME: '/tmp/isolated' });
  assert.equal(mac.profileDir, '/tmp/isolated/browser-profile');
});

test('credential removal deletes only a fake blob, is idempotent and never reads bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remove-credentials-'));
  try {
    const file = path.join(dir, 'easycompute-credentials.bin');
    const unrelated = path.join(dir, 'unrelated.bin');
    fs.writeFileSync(file, 'NOT-DPAPI: fictional fixture only');
    fs.writeFileSync(unrelated, 'keep');
    const options = { platform: 'win32', dshHome: dir, dialogOpen: () => false };
    assert.deepEqual(await removeSavedCredentials(options), { ok: true });
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(unrelated), true);
    assert.deepEqual(await removeSavedCredentials(options), { ok: true });
    fs.mkdirSync(file);
    assert.deepEqual(await removeSavedCredentials(options), { ok: false, error: 'credential-remove-failed' });
    assert.equal(fs.statSync(file).isDirectory(), true);
  } finally { fs.rmSync(dir, { force: true, recursive: true }); }
});

test('credential removal refuses an open dialog, links and unsupported platforms, and sanitizes errors', async () => {
  const forbidden = () => { throw Error('must not access any real file'); };
  assert.deepEqual(await removeSavedCredentials({ platform: 'linux', lstat: forbidden }), { ok: false, error: 'unsupported-platform' });
  assert.deepEqual(await removeSavedCredentials({ platform: 'win32', dialogOpen: () => true, lstat: forbidden }), { ok: false, error: 'credential-dialog-open' });
  assert.deepEqual(await removeSavedCredentials({ platform: 'win32', dialogOpen: () => false, lstat: () => ({ isFile: () => true, isSymbolicLink: () => true }), unlink: forbidden }), { ok: false, error: 'credential-remove-failed' });
  assert.deepEqual(await removeSavedCredentials({ platform: 'win32', dialogOpen: () => false, lstat: () => { throw Object.assign(Error('private detail'), { code: 'EACCES' }); } }), { ok: false, error: 'credential-remove-failed' });
});

test('credential removal is blocked throughout dialog startup, before the grace period completes', async () => {
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  const opening = openCredentialDialog({ platform: 'win32', scriptExists: () => true, spawnImpl: () => {
    queueMicrotask(() => child.emit('spawn'));
    setTimeout(() => { child.exitCode = 0; child.emit('exit', 0); }, 25);
    return child;
  } });
  assert.equal(credentialDialogOpen(), true);
  assert.deepEqual(await removeSavedCredentials({ platform: 'win32', lstat: () => { throw Error('must not touch filesystem'); } }), { ok: false, error: 'credential-dialog-open' });
  assert.deepEqual(await opening, { ok: false, error: 'credential-dialog-failed' });
  assert.equal(credentialDialogOpen(), false);
});

test('Windows PowerShell 5.1 parses every maintained Windows script', { skip: !powershell }, () => isolated((dir) => {
  for (const script of [taskScript, storeScript, readScript]) {
    const result = runPS(dir, `$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile(${quote(script)}, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { throw ($errors | Out-String) }; @{ ok = $true } | ConvertTo-Json -Compress`);
    assert.deepEqual(success(result), { ok: true });
  }
}));

test('task dry-run preserves literal Unicode paths and env, and namespaces each home', { skip: !powershell }, () => isolated((dir) => {
  const plugin = path.join(dir, "plugin [literal] O'Brien 中文 & data");
  fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'lib/scheduled.mjs'), '// Never executed');
  const node = path.join(dir, "node [fake] O'Brien.exe");
  fs.writeFileSync(node, 'NOT AN EXECUTABLE');
  const home = path.join(dir, "home [literal] O'Brien 中文 & data");
  const plan = success(runPS(dir, `& ${quote(taskScript)} -DryRun -PluginDir ${quote(plugin)} -DshHome ${quote(home)} -NodeExecutable ${quote(node)}`));
  assert.equal(plan.ok, true);
  assert.equal(plan.dshHome, home);
  assert.equal(plan.node, node);
  assert.match(plan.taskName, /^DSH Tsinghua Balance Refresh [a-f0-9]{12}$/);
  assert.equal(plan.workingDirectory, plugin);
  assert.match(plan.execute, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  const command = Buffer.from(plan.arguments.split(' ').at(-1), 'base64').toString('utf16le');
  assert.ok(command.includes(`$env:DSH_HOME = ${quote(home)}`));
  assert.ok(command.includes(`& ${quote(node)} ${quote(path.join(plugin, 'lib/scheduled.mjs'))}`));
  assert.ok(command.endsWith('; exit $LASTEXITCODE'));
  assert.equal(fs.existsSync(home), false);
  const other = success(runPS(dir, `& ${quote(taskScript)} -Remove -DryRun -DshHome ${quote(home + '-other')}`));
  assert.notEqual(plan.taskName, other.taskName);
  const same = success(runPS(dir, `& ${quote(taskScript)} -Remove -DryRun -DshHome ${quote(home.toUpperCase() + path.sep)}`));
  assert.equal(plan.taskName, same.taskName);
  const standard = success(runPS(dir, `& ${quote(taskScript)} -Remove -DryRun -DshHome ${quote(path.join(dir, '.dsh'))}`));
  assert.equal(standard.taskName, 'DSH Tsinghua Balance Refresh');
}));

test('encoded task action executes only an isolated fake entry and propagates Node exit code', { skip: !powershell }, () => isolated((dir) => {
  const plugin = path.join(dir, "fake [plugin] O'Brien 中文");
  const home = path.join(dir, "home [literal] O'Brien 中文 & data");
  fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'lib/scheduled.mjs'), 'console.log(JSON.stringify({home:process.env.DSH_HOME,node:process.env.DSH_NODE})); process.exitCode=7;');
  const plan = success(runPS(dir, `& ${quote(taskScript)} -DryRun -PluginDir ${quote(plugin)} -DshHome ${quote(home)} -NodeExecutable ${quote(process.execPath)}`));
  const result = spawnSync(plan.execute, plan.arguments.split(' '), { encoding: 'utf8', timeout: 30000, windowsHide: true,
    cwd: plugin, env: { ...process.env, USERPROFILE: dir, DSH_HOME: 'WRONG_TEST_HOME', DSH_NODE: 'WRONG_TEST_NODE' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { home: plan.dshHome, node: plan.node });
  assert.equal(fs.existsSync(home), false);
}));

test('task removal only touches exact mocked task, stops before unregister, and is idempotent', { skip: !powershell }, () => isolated((dir) => {
  const result = success(runPS(dir, `
$global:dshTestPresent = $true; $global:dshTestCalls = @()
function Get-ScheduledTask { param($TaskPath, $ErrorAction) if ($global:dshTestPresent) { [pscustomobject]@{ TaskName = 'Isolated [task]' } }; [pscustomobject]@{ TaskName = 'Other task' } }
function Stop-ScheduledTask { param($InputObject, $ErrorAction) $global:dshTestCalls += 'stop:' + $InputObject.TaskName }
function Unregister-ScheduledTask { param($InputObject, $Confirm, $ErrorAction) $global:dshTestCalls += 'remove:' + $InputObject.TaskName; $global:dshTestPresent = $false }
$first = & ${quote(taskScript)} -Remove -TaskName 'Isolated [task]' -PluginDir 'Z:\\does-not-exist' -NodeExecutable 'Z:\\no-node.exe' | ConvertFrom-Json
$second = & ${quote(taskScript)} -Remove -TaskName 'Isolated [task]' | ConvertFrom-Json
@{ first = $first; second = $second; calls = @($global:dshTestCalls) } | ConvertTo-Json -Depth 8 -Compress`));
  assert.equal(result.first.removed, true);
  assert.equal(result.second.removed, false);
  assert.deepEqual(result.calls, ['stop:Isolated [task]', 'remove:Isolated [task]']);
}));

test('mocked task access/stop failures cannot masquerade as successful removal', { skip: !powershell }, () => isolated((dir) => {
  for (const failure of ['probe', 'stop']) {
    const result = runPS(dir, `
function Get-ScheduledTask { param($TaskPath, $ErrorAction) ${failure === 'probe' ? "throw 'TEST_ONLY_PROBE_FAILURE'" : "[pscustomobject]@{ TaskName = 'Isolated' }"} }
function Stop-ScheduledTask { param($InputObject, $ErrorAction) throw 'TEST_ONLY_STOP_FAILURE' }
function Unregister-ScheduledTask { throw 'UNSAFE_UNREGISTER' }
& ${quote(taskScript)} -Remove -TaskName 'Isolated'`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /TEST_ONLY_(PROBE|STOP)_FAILURE/);
    assert.doesNotMatch(result.stderr, /UNSAFE_UNREGISTER/);
  }
}));

test('credential script remove/status use only fake data and literal paths; dry-run is inert', { skip: !powershell }, () => isolated((dir) => {
  const home = path.join(dir, "credentials [literal] O'Brien 中文");
  fs.mkdirSync(home);
  const blob = path.join(home, 'easycompute-credentials.bin');
  fs.writeFileSync(blob, 'FICTIONAL NON-DPAPI FIXTURE');
  // -Status must succeed on invalid DPAPI bytes: no decrypt/read is attempted.
  const status = runPS(dir, `& ${quote(readScript)} -DshHome ${quote(home)} -Status`);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.trim(), 'SAVED');
  const dry = success(runPS(dir, `& ${quote(storeScript)} -DshHome ${quote(home)} -Remove -DryRun`));
  assert.equal(dry.dryRun, true);
  assert.equal(fs.existsSync(blob), true);
  assert.equal(success(runPS(dir, `& ${quote(storeScript)} -DshHome ${quote(home)} -Remove`)).removed, true);
  assert.equal(fs.existsSync(blob), false);
  assert.equal(success(runPS(dir, `& ${quote(storeScript)} -DshHome ${quote(home)} -Remove`)).removed, false);
  const nonexistent = path.join(dir, 'never-created');
  assert.equal(success(runPS(dir, `& ${quote(storeScript)} -DshHome ${quote(nonexistent)} -Remove`)).removed, false);
  assert.equal(fs.existsSync(nonexistent), false);
  fs.mkdirSync(blob);
  assert.notEqual(runPS(dir, `& ${quote(storeScript)} -DshHome ${quote(home)} -Remove`).status, 0);
  assert.equal(fs.statSync(blob).isDirectory(), true);
}));
