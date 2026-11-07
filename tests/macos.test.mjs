import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { platformPaths } from '../lib/platform.mjs';
import { readStoredCredentials, ensureLoggedIn, chromeProfileBusy } from '../lib/refresh.mjs';
import { makePlist } from '../scripts/setup-macos-task.mjs';
import { parseArgs, findPnpm } from '../scripts/install.mjs';

// path.join uses backslashes on Windows; normalize before comparing to POSIX fixtures.
const posix = (value) => String(value).split(path.sep).join('/');

test('Mac uses system/user Chrome apps and an isolated Application Support profile', () => {
  const value = platformPaths('darwin', '/Users/测试 User', { DSH_HOME: '/tmp/test dsh' });
  // path.resolve() prefixes a drive on Windows, so only the suffix is host-independent.
  assert.ok(posix(value.sessionFile).endsWith('/easycompute-session.json'));
  assert.ok(posix(value.dshHome).endsWith('/test dsh'));
  assert.equal(value.profileDir, path.posix.join(value.dshHome, 'browser-profile'));
  assert.equal(posix(platformPaths('darwin', '/Users/Example', {}).profileDir), '/Users/Example/Library/Application Support/DSH Tsinghua Paratera/Chrome');
  assert.ok(value.chromeCandidates.map(posix).includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(value.chromeCandidates.map(posix).includes('/Users/测试 User/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(!value.chromeCandidates.some((file) => file.endsWith('.exe')));
});

test('Windows retains Chrome and LOCALAPPDATA profile locations', () => {
  const value = platformPaths('win32', 'C:/Users/test', { LOCALAPPDATA: 'C:/custom-local' });
  const windowsToPosix = (value) => value.replaceAll('\\', '/');
  assert.equal(windowsToPosix(value.profileDir), 'C:/custom-local/dsh-tsinghua-paratera-profile');
  assert.ok(value.chromeCandidates.map(windowsToPosix).includes('C:/custom-local/Google/Chrome/Application/chrome.exe'));
});

test('Mac credential lookup never invokes PowerShell and handles locked/missing items', async () => {
  const exec = () => { throw new Error('must not invoke PowerShell'); };
  const credentials = { username: 'test-only-user', password: 'fake-test-password' };
  assert.deepEqual(await readStoredCredentials({ platform: 'darwin', readMac: async () => credentials, exec }), credentials);
  assert.equal(await readStoredCredentials({ platform: 'darwin', readMac: async () => null, exec }), null);
  assert.equal(await readStoredCredentials({ platform: 'darwin', readMac: async () => { throw Error('locked'); }, exec }), null);
  assert.equal(await readStoredCredentials({ platform: 'darwin', readMac: async () => ({ username: 'x' }), exec }), null);
});

const reply = (value) => ({ result: { result: { value: JSON.stringify(value) } } });
const dependencies = { pause: async () => {}, updateState: () => {}, readCredentials: async () => { throw Error('credentials must not be accessed'); } };

test('an open dedicated Chrome is detected without modifying its profile or debug file', { skip: process.platform === 'win32' }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-chrome-lock-'));
  try {
    fs.symlinkSync(`test-host.local-${process.pid}`, path.join(folder, 'SingletonLock'));
    fs.writeFileSync(path.join(folder, 'DevToolsActivePort'), '12345\n/test');
    assert.equal(chromeProfileBusy(folder), true);
    assert.equal(fs.readFileSync(path.join(folder, 'DevToolsActivePort'), 'utf8'), '12345\n/test');
    assert.equal(chromeProfileBusy(folder, () => { throw Object.assign(Error('dead'), { code: 'ESRCH' }); }), false);
    assert.equal(chromeProfileBusy(folder, () => { throw Object.assign(Error('restricted'), { code: 'EPERM' }); }), true);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('captcha and untrusted SSO pages stop before reading credentials', async () => {
  const send = async () => reply({ href: 'https://id.tsinghua.edu.cn/login', ssoForm: true, captcha: true });
  assert.equal(await ensureLoggedIn(send, dependencies), 'captcha-required');
  const untrusted = async () => reply({ href: 'https://id.tsinghua.edu.cn.evil.invalid/login', ssoForm: true });
  assert.equal(await ensureLoggedIn(untrusted, dependencies), 'untrusted-login-page');
});

test('a valid existing easycompute session does not read credentials', async () => {
  const send = async () => reply({ href: 'https://easycompute.cs.tsinghua.edu.cn/home', hasToken: true, tokenExp: Date.now() + 3600000 });
  assert.equal(await ensureLoggedIn(send, dependencies), 'already');
});

test('SSO fills the form, matches a spaced login label, and submits once', async () => {
  let submitted = 0;
  const fields = {};
  class Input {
    set value(v) { fields[this.name] = v; }
    dispatchEvent() {}
    constructor(name) { this.name = name; }
  }
  const button = { innerText: ' 登 录 ', offsetParent: {}, click() { submitted += 1; } };
  const user = new Input('username');
  const password = new Input('password');
  let reads = 0;
  const send = async (method, { expression } = {}) => {
    if (method === 'Page.getFrameTree') return { result: { frameTree: { frame: { id: 'test-frame', url: 'https://id.tsinghua.edu.cn/login' } } } };
    if (method === 'Page.createIsolatedWorld') return { result: { executionContextId: 9 } };
    if (expression === 'location.origin') return { result: { result: { value: 'https://id.tsinghua.edu.cn' } } };
    if (expression.includes('const { user, pass }')) {
      return { result: { result: { value: vm.runInNewContext(expression, {
        location: { origin: 'https://id.tsinghua.edu.cn' },
        window: { HTMLInputElement: Input }, Event: class {},
        document: { querySelector: (selector) => selector === '#i_user' ? user : password, querySelectorAll: () => [button] },
      }) } } };
    }
    return reply(submitted ? { href: 'https://easycompute.cs.tsinghua.edu.cn/home', hasToken: true, tokenExp: Date.now() + 3600000 }
      : { href: 'https://id.tsinghua.edu.cn/login', ssoForm: true });
  };
  assert.equal(await ensureLoggedIn(send, { ...dependencies, readCredentials: async () => { reads += 1; return { username: 'fake-user', password: 'fake-password' }; } }), 'already');
  assert.equal(submitted, 1);
  assert.equal(reads, 1);
  assert.deepEqual(fields, { username: 'fake-user', password: 'fake-password' });
});

test('launchd plist preserves Unicode/spaces and escapes XML without shell interpolation', () => {
  const plist = makePlist({ node: '/Applications/DSH & Tools/node', pluginDir: '/tmp/中文 "插件"', dshHome: '/tmp/dsh <test>', interval: 21600 });
  assert.match(plist, /DSH &amp; Tools/);
  assert.match(plist, /中文 &quot;插件&quot;/);
  assert.match(plist, /dsh &lt;test&gt;/);
  assert.match(plist, /<integer>21600<\/integer>/);
  assert.doesNotMatch(plist, /\/bin\/sh|password|token/);
  assert.throws(() => makePlist({ interval: 0 }));
  if (process.platform === 'darwin') {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-plist-'));
    try {
      const file = path.join(folder, 'test.plist');
      fs.writeFileSync(file, plist);
      const result = spawnSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
  }
});

test('installer rejects missing/unsafe arguments and keeps pnpm enabled on uninstall', () => {
  assert.throws(() => parseArgs(['--profile']));
  assert.throws(() => parseArgs(['--profile', '../../escape']));
  assert.throws(() => parseArgs(['--dsh-home', '--verify']));
  assert.equal(parseArgs(['--uninstall']).install, true);
  if (process.platform === 'darwin' && findPnpm().kind === 'script') assert.ok(fs.existsSync(findPnpm().path));
});

test('refresh lock excludes concurrent processes and state snapshots are private', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-lock-'));
  let holder;
  try {
    const module = new URL('../lib/refresh.mjs', import.meta.url).href;
    const code = `import fs from 'node:fs'; import {acquireRefreshLock,writeState,STATE_FILE} from ${JSON.stringify(module)};
      const release = acquireRefreshLock();
      if (!release || acquireRefreshLock() !== null) process.exit(1);
      writeState({lastError:'test-only'});
      if (process.platform !== 'win32' && (fs.statSync(STATE_FILE).mode & 0o777) !== 0o600) process.exit(2);
      release(); const again=acquireRefreshLock(); if (!again) process.exit(3); again();`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DSH_HOME: folder }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(folder, 'easycompute-refresh.lock')), false);
    const holdCode = `import {acquireRefreshLock} from ${JSON.stringify(module)};
      const release=acquireRefreshLock(); if(!release) process.exit(1);
      process.stdout.write('ready'); process.stdin.resume();
      process.stdin.on('end',()=>{release();process.exit(0)});`;
    holder = spawn(process.execPath, ['--input-type=module', '-e', holdCode], { env: { ...process.env, DSH_HOME: folder }, stdio: ['pipe', 'pipe', 'pipe'] });
    await Promise.race([once(holder.stdout, 'data'), once(holder, 'exit').then(() => { throw Error('lock holder exited early'); })]);
    const competing = spawnSync(process.execPath, ['--input-type=module', '-e', `import {acquireRefreshLock} from ${JSON.stringify(module)}; if(acquireRefreshLock()!==null)process.exit(1)`], { env: { ...process.env, DSH_HOME: folder }, encoding: 'utf8' });
    assert.equal(competing.status, 0, competing.stderr);
    const exited = once(holder, 'exit');
    holder.stdin.end();
    await exited;
    assert.equal(holder.exitCode, 0);
    assert.equal(fs.existsSync(path.join(folder, 'easycompute-refresh.lock')), false);
  } finally { if (holder && holder.exitCode === null) holder.kill(); fs.rmSync(folder, { recursive: true, force: true }); }
});
