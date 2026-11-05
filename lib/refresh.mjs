// Tsinghua easycompute session maintenance for the balance chip.
//
// The dedicated Chrome profile keeps a trusted Tsinghua SSO session. Visiting the
// console headlessly renews the 24-hour session token (sliding), so one login can
// keep the balance alive while the SSO session remains valid. Optional silent
// login uses Windows DPAPI or macOS Keychain; no plaintext password file.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { platformPaths } from './platform.mjs';
import { readMacCredentials, openMacCredentialDialog } from './macos-credentials.mjs';

export const EASYCOMPUTE_ORIGIN = 'https://easycompute.cs.tsinghua.edu.cn';
const paths = platformPaths();
export const SESSION_FILE = paths.sessionFile;
export const STATE_FILE = paths.stateFile;
export const PROFILE_DIR = paths.profileDir;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'scripts');
const READ_SCRIPT = path.join(SCRIPTS, 'read-easycompute-credentials.ps1');
const LEGACY_READ = path.join(os.homedir(), '.dsh', 'read-easycompute-credentials.ps1');
export const CRED_SCRIPT = fs.existsSync(READ_SCRIPT) ? READ_SCRIPT : LEGACY_READ;
export const STORE_SCRIPT = fs.existsSync(path.join(SCRIPTS, 'store-easycompute-credentials.ps1'))
  ? path.join(SCRIPTS, 'store-easycompute-credentials.ps1')
  : path.join(os.homedir(), '.dsh', 'store-easycompute-credentials.ps1');
export const CHROME_CANDIDATES = paths.chromeCandidates;

const REFRESH_GRACE_MS = 60 * 60 * 1000; // renew when under an hour remains
const REFRESH_LOCK = path.join(paths.dshHome, 'easycompute-refresh.lock');
// How long the credential dialog host may take to prove it survived startup.
const CREDENTIAL_DIALOG_GRACE_MS = 600;

// Serialize DSH and the scheduled task. A dead process cannot block renewal.
export function acquireRefreshLock() {
  fs.mkdirSync(paths.dshHome, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(REFRESH_LOCK, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(REFRESH_LOCK); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = Number(fs.readFileSync(REFRESH_LOCK, 'utf8')); } catch { return null; }
      // A just-created, not-yet-written lock belongs to another live contender.
      if (!Number.isSafeInteger(pid) || pid < 1) return null;
      try { process.kill(pid, 0); return null; } catch (probe) {
        if (probe.code !== 'ESRCH') return null;
      }
      try { fs.unlinkSync(REFRESH_LOCK); } catch {}
    }
  }
  return null;
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Chrome's macOS singleton lock points to hostname-PID, even while healthy. */
export function chromeProfileBusy(profileDir = PROFILE_DIR, probe = (pid) => process.kill(pid, 0)) {
  try {
    const target = fs.readlinkSync(path.join(profileDir, 'SingletonLock'));
    const match = target.match(/-(\d+)$/);
    if (!match) return false;
    try { probe(Number(match[1])); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  } catch { return false; }
}

export function readSession() {
  try {
    const value = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (typeof value?.token !== 'string' || !value.token) return null;
    return value;
  } catch {
    return null;
  }
}

export function sessionIsFresh(entry, graceMs = REFRESH_GRACE_MS) {
  return Boolean(entry?.exp && entry.exp - Date.now() > graceMs);
}

export function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch {
    return {};
  }
}

export function writeState(patch) {
  const next = { ...readState(), ...patch };
  try {
    writePrivateJson(STATE_FILE, next);
  } catch {}
  return next;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readCdpEndpoint(profileDir = PROFILE_DIR) {
  try {
    const [line, browserPath] = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').trim().split('\n');
    const port = Number(line);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !browserPath?.startsWith('/devtools/browser/')) return null;
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const version = await response.json();
    const expected = `ws://127.0.0.1:${port}${browserPath}`;
    if (version.webSocketDebuggerUrl !== expected) return null;
    return { port, ...version };
  } catch { return null; }
}

async function waitForCdp(child, profileDir) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(500);
    if (child.exitCode !== null || child.signalCode !== null || child.spawnError) return null;
    const endpoint = await readCdpEndpoint(profileDir);
    if (endpoint) return endpoint;
  }
  return null;
}

/** Ask Chrome to exit through CDP so cookies and storage are flushed to disk. */
async function closeBrowserGracefully(port, child, timeoutMs = 8000) {
  if (child && (child.exitCode !== null || child.signalCode !== null)) return;
  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
    const url = version?.webSocketDebuggerUrl;
    if (url) {
      const socket = new WebSocket(url);
      socket.onerror = () => {};
      await new Promise((resolve) => { socket.onopen = resolve; setTimeout(resolve, 2000); });
      try { socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
      try { socket.close(); } catch {}
    }
  } catch {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.killed)) return;
    if (!child) {
      try { await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) }); }
      catch { return; }
    }
    await sleep(250);
  }
  try { child?.kill(); } catch {}
}

export async function closePage(opened) {
  try { opened.socket?.close(); } catch {}
  // An attached visible login browser belongs to the user; leave it open.
  if (opened.child) await closeBrowserGracefully(opened.port, opened.child);
}

const execFileAsync = promisify(execFile);

/** Host-only: credentials never reach the DSH client or log output. */
export async function readStoredCredentials({ platform = process.platform, readMac = readMacCredentials, exec = execFileAsync } = {}) {
  try {
    if (platform === 'darwin') {
      const value = await readMac();
      return validCredentials(value) ? value : null;
    }
    if (platform !== 'win32') return null;
    if (!fs.existsSync(CRED_SCRIPT)) return null;
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CRED_SCRIPT], { timeout: 15000 });
    const text = (stdout || '').trim();
    if (!text || text === 'MISSING' || text === 'DECRYPT_FAILED') return null;
    const parsed = JSON.parse(text);
    return validCredentials(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validCredentials(value) {
  return typeof value?.username === 'string' && typeof value?.password === 'string' && Boolean(value.username && value.password);
}

async function evaluateJson(send, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true });
  const raw = result?.result?.result?.value;
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

const PAGE_STATE = String.raw`(() => {
  const vis = (el) => { if (!el) return false; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const loginAnchor = [...document.querySelectorAll('a,button')].find((el) => /^\s*登\s*录\s*$/.test(el.innerText || '') && vis(el));
  const entry = [...document.querySelectorAll('a,button')].find((el) => (el.innerText || '').includes('登录领券') && vis(el));
  return JSON.stringify({
    href: location.href,
    hasToken: !!localStorage.getItem('token'),
    tokenExp: (() => {
      try {
        const raw = localStorage.getItem('token') || '';
        const part = raw.split('.')[1] || '';
        const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
        return Number.isFinite(json?.exp) ? json.exp * 1000 : 0;
      } catch { return 0; }
    })(),
    ssoForm: !!document.querySelector('#i_user') && vis(document.querySelector('#i_user')),
    captcha: vis(document.querySelector('#i_code')) || vis(document.querySelector('#captcha')),
    secondFactor: /二次认证|二次验证|双重认证/.test(document.title || ''),
    hasLoginAnchor: !!loginAnchor,
    hasEntryButton: !!entry,
  });
})()`;

/** Drive the SSO login with stored credentials. Returns a status string. */
export async function ensureLoggedIn(send, { readCredentials = readStoredCredentials, pause = sleep, updateState = writeState } = {}) {
  let credentials = undefined;
  let submitted = false;
  let clearedStale = false;
  let blank = 0;
  for (let step = 0; step < 30; step += 1) {
    const state = await evaluateJson(send, PAGE_STATE);
    if (!state) {
      // The headed window can be closed while we poll; stop instead of grinding
      // through every remaining step and holding the refresh lock.
      blank += 1;
      if (blank >= 3) return 'login-window-closed';
      await pause(1000);
      continue;
    }
    blank = 0;
    // The SSO wants a second factor (SMS / WeCom). A headless run cannot answer it,
    // so hand control back instead of polling until the timeout.
    if (state.secondFactor) return 'second-factor-required';
    // A token that is already past its own expiry cannot pass validation; drop it
    // and let the SSO flow issue a fresh one instead of harvesting a dead token.
    if (state.hasToken && !clearedStale && state.tokenExp && state.tokenExp < Date.now() + 60000) {
      await evaluateJson(send, `(() => { localStorage.removeItem('token'); return JSON.stringify({ cleared: true }); })()`);
      clearedStale = true;
      updateState({ lastError: 'stale-token-cleared', lastErrorAt: Date.now() });
      await pause(1500);
      continue;
    }
    let location;
    try { location = new URL(state.href); } catch { return 'untrusted-login-page'; }
    if (state.hasToken && location.origin === EASYCOMPUTE_ORIGIN) return 'already';
    if (state.ssoForm) {
      if (location.origin !== 'https://id.tsinghua.edu.cn') return 'untrusted-login-page';
      if (state.captcha) return 'captcha-required';
      if (credentials === undefined) credentials = await readCredentials();
      if (!credentials) return 'credentials-missing';
      if (!submitted) {
        const payload = JSON.stringify({ user: credentials.username, pass: credentials.password });
        const result = await evaluateJson(send, String.raw`(() => {
          if (location.origin !== 'https://id.tsinghua.edu.cn') return JSON.stringify({ refused: true });
          const { user, pass } = ${payload};
          const setValue = (sel, value) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          };
          const filledUser = setValue('#i_user', user);
          const filledPass = setValue('#i_pass', pass);
          const anchor = [...document.querySelectorAll('a,button')].find((el) => /^\s*登\s*录\s*$/.test(el.innerText || '') && el.offsetParent !== null);
          if (anchor) anchor.click();
          return JSON.stringify({ filledUser, filledPass, clicked: !!anchor });
        })()`);
        submitted = true;
        updateState({ lastLoginAt: Date.now(), lastLoginResult: result });
      }
      await pause(2000);
      continue;
    }
    if (state.hasEntryButton) {
      if (location.origin !== EASYCOMPUTE_ORIGIN) return 'untrusted-login-page';
      await evaluateJson(send, `(() => { const b = [...document.querySelectorAll('a,button')].find((el) => (el.innerText || '').includes('登录领券')); if (b) b.click(); return 'ok'; })()`);
      await pause(2500);
      continue;
    }
    await pause(1500);
  }
  return submitted ? 'login-timeout' : 'login-not-started';
}

export async function openPage({ headed, url, profileDir = PROFILE_DIR, chrome = findChrome(), retryEmpty = true }) {
  if (!chrome) return { error: 'chrome-not-found' };
  let version = await readCdpEndpoint(profileDir);
  let child = null;
  if (!version) {
    if (chromeProfileBusy(profileDir)) return { error: 'chrome-profile-in-use' };
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true });
    const args = [
      ...(headed ? [] : ['--headless=new']),
      '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check',
      ...(headed ? [] : ['--disable-gpu']),
      url,
    ];
    child = spawn(chrome, args, { stdio: 'ignore' });
    child.on('error', (error) => { child.spawnError = error; });
    version = await waitForCdp(child, profileDir);
    if (!version) { try { child.kill(); } catch {}; return { error: 'chrome-not-ready' }; }
  }
  const port = version.port;
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    const page = targets.find((target) => target.type === 'page' && target.url.includes('easycompute'))
      ?? targets.find((target) => target.type === 'page');
    if (!page && !child && retryEmpty) {
      // macOS keeps Chrome running after its last window closes. No user pages
      // remain, so close this dedicated browser before starting a headless one.
      await closeBrowserGracefully(port, null);
      return openPage({ headed, url, profileDir, chrome, retryEmpty: false });
    }
    if (!page?.webSocketDebuggerUrl) throw new Error('no-page');

    const socket = new WebSocket(page.webSocketDebuggerUrl);
    let sequence = 0;
    const pending = new Map();
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
          pending.get(message.id).resolve(message);
          pending.delete(message.id);
        }
      } catch {}
    };
    socket.onerror = () => {};
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('cdp-timeout')); }, 5000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('cdp-unavailable')); };
    });
    // Closing the socket rejects every in-flight call. An unobserved rejection is
    // fatal in the DSH host (it aborts startup with "fatal load failure"), so the
    // close handler must never throw and every call needs a catch of its own.
    socket.onclose = () => {
      try {
        for (const item of pending.values()) {
          try { item.reject(new Error('cdp-closed')); } catch {}
        }
        pending.clear();
      } catch {}
    };
    const send = (method, params = {}) => {
      const promise = new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('cdp-timeout')); }, 20000);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
      // Callers that forget to handle a closed socket must not crash the host.
      promise.catch(() => {});
      return promise;
    };
    return { child, socket, send, port };
  } catch {
    if (child) await closeBrowserGracefully(port, child);
    return { error: 'chrome-not-ready' };
  }
}

function decodeExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Renew the easycompute session and snapshot the balance from the console.
 * @returns {Promise<{ok: true, exp: number} | {ok: false, error: string}>}
 */
export async function refreshSession({ force = false } = {}) {
  // Never start a second login while one is parked waiting for a code: the parked
  // browser already holds the SSO state and must not be driven from two places.
  if (secondFactorStatus().pending) return { ok: false, error: 'second-factor-pending' };
  const current = readSession();
  if (!force && sessionIsFresh(current)) return { ok: true, exp: current.exp, skipped: true };
  // Without a stored credential the browser flow cannot log in, so do not spawn a
  // headless Chrome just to discover that (the settings chip asks on every start).
  if (!current && !(await credentialsSaved().catch(() => false))) return { ok: false, error: 'credentials-missing' };

  const release = acquireRefreshLock();
  if (!release) return { ok: false, error: 'refresh-busy' };
  try { return await refreshWithBrowser(force); } finally { release(); }
}

async function refreshWithBrowser(force) {
  const opened = await openPage({ headed: false, url: EASYCOMPUTE_ORIGIN + '/home' });
  if (opened.error) {
    writeState({ lastError: opened.error, lastErrorAt: Date.now() });
    return { ok: false, error: opened.error };
  }
  try {
    await opened.send('Page.enable');
    await sleep(4000);
    const loginState = await ensureLoggedIn(opened.send);
    if (loginState === 'second-factor-required') {
      // Keep this browser alive so the settings page can offer the SMS / WeCom
      // choice and submit the code without logging in again.
      await holdSecondFactor(opened);
      writeState({ lastError: loginState, lastErrorAt: Date.now() });
      return { ok: false, error: loginState, secondFactor: true };
    }
    if (loginState !== 'already') {
      writeState({ lastError: loginState, lastErrorAt: Date.now() });
      return { ok: false, error: loginState };
    }
    await sleep(2000);
    return captureSession(opened.send, { force });
  } catch {
    writeState({ lastError: 'refresh-failed', lastErrorAt: Date.now() });
    return { ok: false, error: 'refresh-failed' };
  } finally {
    // A held second-factor session keeps its browser for the code exchange.
    if (!secondFactorHeld(opened)) await closePage(opened);
  }
}

/** Read the balance from the loaded console page and persist the session. */
export async function captureSession(send, { force = false } = {}) {
  const result = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      if (location.origin !== ${JSON.stringify(EASYCOMPUTE_ORIGIN)}) return JSON.stringify({ error: 'login-required' });
      const token = localStorage.getItem('token') || '';
      if (!token) return JSON.stringify({ error: 'no-session-token' });
      const response = await fetch('/auth/userInfo/query', { headers: { token }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      const body = await response.json().catch(() => ({}));
      const data = body.data || body || {};
      return JSON.stringify({
        token,
        status: response.status,
        couponFree: data.couponFree,
        couponUsed: data.couponUsed,
        couponTotal: data.couponTotal,
        gpuUsed: data.gpuUsed,
        tokenUsed: data.tokenUsed,
        department: data.department ?? null,
        clazz: data.clazz ?? null,
        uuid: data.uuid ?? null,
        href: location.href,
      });
    })()`,
  });

  const raw = result?.result?.result?.value;
  if (!raw) {
    writeState({ lastError: 'empty-evaluate', lastErrorAt: Date.now() });
    return { ok: false, error: 'empty-evaluate' };
  }
  const info = JSON.parse(raw);
  if (info.error) {
    writeState({ lastError: info.error, lastErrorAt: Date.now() });
    return { ok: false, error: info.error };
  }
  const exp = decodeExpiry(info.token);
  if (info.status === 401 || info.status === 403) return { ok: false, error: 'session-expired' };
  if (info.status !== 200 || typeof info.couponFree !== 'number' || !Number.isFinite(info.couponFree)) return { ok: false, error: 'invalid-response' };
  if (!Number.isFinite(exp) || exp <= Date.now()) return { ok: false, error: 'malformed-session-token' };
  const session = { token: info.token, exp, capturedAt: Date.now(), source: force ? 'manual-refresh' : 'scheduled-refresh' };
  writePrivateJson(SESSION_FILE, session);
  writeState({
    lastRefreshAt: Date.now(),
    lastError: null,
    lastErrorAt: null,
    snapshot: {
      couponFree: info.couponFree,
      couponUsed: info.couponUsed,
      couponTotal: info.couponTotal,
      gpuUsed: info.gpuUsed,
      tokenUsed: info.tokenUsed,
      department: info.department,
      clazz: info.clazz,
      uuid: info.uuid,
      fetchedAt: Date.now(),
    },
  });
  return { ok: true, exp };
}

/** Live balance query with the stored session token (no browser needed). */
export async function fetchBalance() {
  const session = readSession();
  if (!session?.token) return { ok: false, error: 'login-required' };
  const response = await fetch(EASYCOMPUTE_ORIGIN + '/auth/userInfo/query', {
    headers: { accept: 'application/json', token: session.token },
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (response.status === 401 || response.status === 403) return { ok: false, error: 'session-expired' };
  if (!response.ok) return { ok: false, error: 'upstream-' + response.status };
  const body = await response.json().catch(() => null);
  const data = body?.data ?? null;
  if (!data || typeof data.couponFree !== 'number') return { ok: false, error: 'invalid-response' };
  return { ok: true, data };
}

/** Open a visible window on the Tsinghua console so the user can sign in once. */
export async function openLoginWindow() {
  const chrome = findChrome();
  if (!chrome) return { ok: false, error: 'chrome-not-found' };
  const release = acquireRefreshLock();
  if (!release) return { ok: false, error: 'refresh-busy' };
  try {
    if (chromeProfileBusy() && !(await readCdpEndpoint())) return { ok: false, error: 'chrome-profile-in-use' };
    fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
    const child = spawn(chrome, [
      `--user-data-dir=${PROFILE_DIR}`,
      '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check',
      EASYCOMPUTE_ORIGIN + '/home',
    ], { stdio: 'ignore', detached: true });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { ok: true };
  } catch { return { ok: false, error: 'chrome-not-ready' }; }
  finally { release(); }
}

// ---- second factor (SMS / WeCom) -----------------------------------------
// The SSO asks for a second factor after the password step. The choices live on
// that page (radio inputs + a 确定 button); the code field appears only after the
// code has been sent. A headless run cannot answer it, so a refresh that lands
// here parks its browser and hands the choice to the settings page.
const SECOND_FACTOR_VIEW = String.raw`(() => {
  const vis = (el) => { if (!el) return false; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const radios = [...document.querySelectorAll('input[type=radio]')].filter(vis).map((el) => {
    const wrap = el.closest('label') || el.parentElement;
    return { value: el.value || '', label: (wrap ? wrap.innerText || '' : '').replace(/\s+/g, ' ').trim() };
  });
  const textInputs = [...document.querySelectorAll('input')]
    .filter((el) => vis(el) && !['hidden', 'radio', 'checkbox', 'submit', 'button', 'password'].includes(el.type));
  const code = textInputs.find((el) => /code|验证码|verify/i.test([el.id, el.name, el.placeholder].join(' ')) || el.type === 'tel' || el.inputMode === 'numeric');
  return JSON.stringify({ href: location.href, title: document.title, radios, hasCodeInput: Boolean(code) || textInputs.length > 0 });
})()`;

let pendingSecondFactor = null;

/** Whether this browser is parked on the second-factor page and must stay open. */
export function secondFactorHeld(opened) {
  return Boolean(pendingSecondFactor) && pendingSecondFactor.opened === opened;
}

export function secondFactorStatus() {
  if (!pendingSecondFactor) return { pending: false };
  const { stage, methods, method, phoneHint, startedAt } = pendingSecondFactor;
  // Never describe the other channel: the hint must match what was actually sent.
  const hint = stage === 'code'
    ? (method === 'wechat' ? '验证码已发送到您的清华大学信息服务（企业微信）'
      : method === 'mobile' ? (phoneHint || '验证码已发送到您登记的手机')
        : '请输入收到的验证码')
    : '';
  return { pending: true, stage, methods, method: method || null, hint, phoneHint, startedAt };
}

export async function holdSecondFactor(opened) {
  const view = await evaluateJson(opened.send, SECOND_FACTOR_VIEW).catch(() => null);
  // A wrapping label can carry every option's text, so prefer the known name.
  const names = { wechat: '企业微信', mobile: '短信' };
  const methods = (view?.radios || []).filter((radio) => radio.value).map((radio) => {
    const raw = String(radio.label || '').replace(/\s+/g, ' ').trim();
    return { id: radio.value, label: names[radio.value] || raw || radio.value };
  });
  const phone = (view?.radios || []).map((radio) => radio.label || '').join(' ').match(/1\d\*{2,}\d{2,4}/);
  pendingSecondFactor = {
    opened,
    send: opened.send,
    stage: view?.hasCodeInput ? 'code' : 'choose',
    methods,
    method: null,
    phoneHint: phone ? `验证码将发送到 ${phone[0]}` : '',
    startedAt: Date.now(),
  };
  return secondFactorStatus();
}

export async function chooseSecondFactor(method) {
  const pending = pendingSecondFactor;
  if (!pending) return { ok: false, error: 'no-second-factor' };
  if (!pending.methods.some((m) => m.id === method)) return { ok: false, error: 'invalid-second-factor-method' };
  const payload = JSON.stringify({ method });
  // Select first, verify the radio really flipped, and only then submit: pressing
  // 确定 with the wrong radio still sends a code, just down the other channel.
  const picked = await evaluateJson(pending.send, String.raw`(() => {
    const { method } = ${payload};
    const radio = [...document.querySelectorAll('input[type=radio]')].find((el) => el.value === method);
    if (!radio) return JSON.stringify({ found: false, checked: false });
    if (!radio.checked) {
      radio.click();
      if (!radio.checked) {
        const label = radio.closest('label');
        if (label) label.click();
      }
      if (!radio.checked) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    return JSON.stringify({ found: true, checked: radio.checked });
  })()`).catch(() => null);
  if (!picked?.found) return { ok: false, error: 'second-factor-method-missing' };
  if (!picked.checked) return { ok: false, error: 'second-factor-method-not-selected' };
  const submitted = await evaluateJson(pending.send, String.raw`(() => {
    const submit = [...document.querySelectorAll('button,input[type=submit]')].find((el) => /确\s*定/.test(el.innerText || el.value || ''));
    if (!submit) return JSON.stringify({ submitted: false });
    submit.click();
    return JSON.stringify({ submitted: true });
  })()`).catch(() => null);
  if (!submitted?.submitted) return { ok: false, error: 'second-factor-submit-missing' };
  pending.method = method;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sleep(2000);
    const view = await evaluateJson(pending.send, SECOND_FACTOR_VIEW).catch(() => null);
    if (view?.hasCodeInput) {
      pending.stage = 'code';
      return { ok: true, stage: 'code', method };
    }
  }
  return { ok: false, error: 'second-factor-code-page-missing' };
}

export async function submitSecondFactorCode(code) {
  const pending = pendingSecondFactor;
  if (!pending) return { ok: false, error: 'no-second-factor' };
  const trimmed = String(code || '').replace(/\s+/g, '');
  if (!/^\d{4,8}$/.test(trimmed)) return { ok: false, error: 'invalid-second-factor-code' };
  const payload = JSON.stringify({ code: trimmed });
  const filled = await evaluateJson(pending.send, String.raw`(() => {
    const { code } = ${payload};
    const vis = (el) => { if (!el) return false; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    const inputs = [...document.querySelectorAll('input')]
      .filter((el) => vis(el) && !['hidden', 'radio', 'checkbox', 'submit', 'button', 'password'].includes(el.type));
    // Prefer the field that looks like a code box; fall back to a single text field.
    const target = inputs.find((el) => /code|验证码|verify/i.test([el.id, el.name, el.placeholder].join(' ')) || el.type === 'tel' || el.inputMode === 'numeric')
      || (inputs.length === 1 ? inputs[0] : null);
    if (!target) return JSON.stringify({ filled: false });
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(target, code);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    const submit = [...document.querySelectorAll('button,input[type=submit]')].find((el) => vis(el) && /确\s*定|提\s*交|验\s*证|登\s*录/.test(el.innerText || el.value || ''));
    if (submit) submit.click();
    return JSON.stringify({ filled: true, submitted: Boolean(submit) });
  })()`).catch(() => null);
  if (!filled?.filled) return { ok: false, error: 'second-factor-code-field-missing' };
  let trustedDevice = false;
  for (let step = 0; step < 16; step += 1) {
    await sleep(1500);
    const state = await evaluateJson(pending.send, PAGE_STATE).catch(() => null);
    if (state?.hasToken && String(state.href).startsWith(EASYCOMPUTE_ORIGIN)) {
      const captured = await captureSession(pending.send, { force: true });
      await cancelSecondFactor();
      return trustedDevice ? { ...captured, trustedDevice: true } : captured;
    }
    // A correct code lands on the "记住信任浏览器" prompt, not on the console.
    const view = await trustDeviceState(pending.send);
    if (view?.asking) {
      if (!(await confirmTrustDevice(pending.send, { trust: true }))) return { ok: false, error: 'trust-device-not-confirmed' };
      trustedDevice = true;
      await sleep(1000);
    }
  }
  return { ok: false, error: 'second-factor-code-rejected' };
}

// After a correct code Tsinghua asks whether this browser should be trusted for
// 180 days. The page is the same URL/title as the code step, so it has to be
// recognised by its text and answered, otherwise the login never completes.
const TRUST_DEVICE_VIEW = String.raw`(() => {
  const vis = (el) => { if (!el) return false; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const text = document.body.innerText || '';
  const radios = [...document.querySelectorAll('input[type=radio]')].filter(vis)
    .map((el) => ({ value: el.value, checked: el.checked }));
  return JSON.stringify({
    asking: /信任浏览器/.test(text),
    radios,
    trust: (radios.find((r) => /^\s*是/.test(r.value) || /信任/.test(r.value)) || {}).value || null,
  });
})()`;

/** Whether the page is currently asking to remember this browser. */
export async function trustDeviceState(send) {
  return evaluateJson(send, TRUST_DEVICE_VIEW).catch(() => null);
}

/**
 * Answer the "记住信任浏览器" prompt. Returns true when 确定 was actually pressed.
 * The plugin's Chrome profile is dedicated to this plugin, so trusting it is what
 * makes every later silent renewal skip the second factor.
 */
export async function confirmTrustDevice(send, { trust = true } = {}) {
  const payload = JSON.stringify({ trust });
  const result = await evaluateJson(send, String.raw`(() => {
    const { trust } = ${payload};
    const vis = (el) => { if (!el) return false; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    const radios = [...document.querySelectorAll('input[type=radio]')].filter(vis);
    const target = radios.find((el) => (trust ? /^\s*是/.test(el.value) || /信任/.test(el.value) : /^\s*否/.test(el.value)));
    if (!target) return JSON.stringify({ found: false });
    if (!target.checked) target.click();
    if (!target.checked) { const label = target.closest('label'); if (label) label.click(); }
    if (!target.checked) return JSON.stringify({ found: true, checked: false });
    const submit = [...document.querySelectorAll('button,input[type=submit]')].find((el) => /确\s*定/.test(el.innerText || el.value || ''));
    if (!submit) return JSON.stringify({ found: true, checked: true, submitted: false });
    submit.click();
    return JSON.stringify({ found: true, checked: true, submitted: true });
  })()`).catch(() => null);
  return Boolean(result?.submitted);
}

export async function cancelSecondFactor() {
  const pending = pendingSecondFactor;
  pendingSecondFactor = null;
  if (pending) { try { await closePage(pending.opened); } catch {} }
  return { ok: true };
}

// The native credential dialog lives in its own PowerShell host. Keep a handle so
// the settings page can stop polling once the window is gone.
let credentialDialogChild = null;

/** Whether the credential dialog opened earlier is still alive. */
export function credentialDialogOpen() {
  if (!credentialDialogChild) return false;
  const { exitCode, signalCode } = credentialDialogChild;
  if (exitCode !== null || signalCode !== null) {
    credentialDialogChild = null;
    return false;
  }
  return true;
}

/**
 * Open the DPAPI credential dialog so the user can store or rotate the password.
 *
 * `-WindowStyle Hidden` hides the PowerShell console only; the WinForms dialog it
 * creates stays visible. Never pass `detached: true` here: a detached console host
 * exits (code 0) before running the script, so the window never appears and the
 * settings page waits for a credential file that can never be written.
 */
export async function openCredentialDialog({
  platform = process.platform,
  spawnImpl = spawn,
  script = STORE_SCRIPT,
  scriptExists = fs.existsSync,
} = {}) {
  if (platform === 'darwin') return openMacCredentialDialog();
  if (platform !== 'win32') return { ok: false, error: 'unsupported-platform' };
  if (!scriptExists(script)) return { ok: false, error: 'script-missing' };
  if (credentialDialogOpen()) return { ok: true, alreadyOpen: true };
  const child = spawnImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], {
    stdio: 'ignore',
  });
  try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }
  catch { return { ok: false, error: 'credential-dialog-failed' }; }
  // A host that dies immediately never painted a window; report it instead of
  // letting the caller poll for a full minute.
  const earlyExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), CREDENTIAL_DIALOG_GRACE_MS);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code ?? 0); });
  });
  if (earlyExit !== null) return { ok: false, error: 'credential-dialog-failed' };
  if (typeof child.unref === 'function') child.unref();
  credentialDialogChild = child;
  return { ok: true };
}

/** Whether a decryptable DPAPI credential file exists (never returns the secret). */
export async function credentialsSaved() {
  const value = await readStoredCredentials();
  return Boolean(value);
}
