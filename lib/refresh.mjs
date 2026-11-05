// Tsinghua easycompute session maintenance for the balance chip.
//
// The dedicated Chrome profile keeps a trusted Tsinghua SSO session. Visiting the
// console headlessly renews the 24-hour session token (sliding), so one login can
// keep the balance alive indefinitely. No password is stored anywhere.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const EASYCOMPUTE_ORIGIN = 'https://easycompute.cs.tsinghua.edu.cn';
export const SESSION_FILE = path.join(os.homedir(), '.dsh', 'easycompute-session.json');
export const STATE_FILE = path.join(os.homedir(), '.dsh', 'easycompute-state.json');
export const PROFILE_DIR = path.join(os.homedir(), 'AppData', 'Local', 'dsh-paratera-profile');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'scripts');
const READ_SCRIPT = path.join(SCRIPTS, 'read-easycompute-credentials.ps1');
const LEGACY_READ = path.join(os.homedir(), '.dsh', 'read-easycompute-credentials.ps1');
export const CRED_SCRIPT = fs.existsSync(READ_SCRIPT) ? READ_SCRIPT : LEGACY_READ;
export const STORE_SCRIPT = fs.existsSync(path.join(SCRIPTS, 'store-easycompute-credentials.ps1'))
  ? path.join(SCRIPTS, 'store-easycompute-credentials.ps1')
  : path.join(os.homedir(), '.dsh', 'store-easycompute-credentials.ps1');
export const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];

const REFRESH_GRACE_MS = 60 * 60 * 1000; // renew when under an hour remains
const CDP_PORT = 9350;

export function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
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
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  } catch {}
  return next;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCdp(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(500);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return response.json();
    } catch {}
  }
  return null;
}

/** Ask Chrome to exit through CDP so cookies and storage are flushed to disk. */
async function closeBrowserGracefully(port, child, timeoutMs = 8000) {
  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const url = version?.webSocketDebuggerUrl;
    if (url) {
      const socket = new WebSocket(url);
      await new Promise((resolve) => { socket.onopen = resolve; setTimeout(resolve, 2000); });
      try { socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
      try { socket.close(); } catch {}
    }
  } catch {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.killed) return;
    await sleep(250);
  }
  try { child.kill(); } catch {}
}

const execFileAsync = promisify(execFile);

/** Decrypt the DPAPI-protected Tsinghua credentials (only used for silent login). */
export async function readStoredCredentials() {
  try {
    if (!fs.existsSync(CRED_SCRIPT)) return null;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CRED_SCRIPT], { timeout: 15000 });
    const text = (stdout || '').trim();
    if (!text || text === 'MISSING' || text === 'DECRYPT_FAILED') return null;
    const parsed = JSON.parse(text);
    return typeof parsed?.username === 'string' && typeof parsed?.password === 'string' && parsed.username && parsed.password
      ? parsed : null;
  } catch {
    return null;
  }
}

async function evaluateJson(send, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true });
  const raw = result?.result?.result?.value;
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

const PAGE_STATE = `(() => {
  const vis = (el) => { if (!el) return false; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const loginAnchor = [...document.querySelectorAll('a,button')].find((el) => /^\s*登\s*录\s*$/.test(el.innerText || '') && vis(el));
  const entry = [...document.querySelectorAll('a,button')].find((el) => (el.innerText || '').includes('登录领券') && vis(el));
  return JSON.stringify({
    href: location.href,
    hasToken: !!localStorage.getItem('token'),
    ssoForm: !!document.querySelector('#i_user') && vis(document.querySelector('#i_user')),
    captcha: vis(document.querySelector('#i_code')) || vis(document.querySelector('#captcha')),
    hasLoginAnchor: !!loginAnchor,
    hasEntryButton: !!entry,
  });
})()`;

/** Drive the SSO login with stored credentials. Returns a status string. */
async function ensureLoggedIn(send) {
  let credentials = undefined;
  let submitted = false;
  for (let step = 0; step < 30; step += 1) {
    const state = await evaluateJson(send, PAGE_STATE);
    if (!state) { await sleep(1000); continue; }
    if (state.hasToken && /easycompute/.test(state.href)) return 'already';
    if (state.ssoForm) {
      if (state.captcha) return 'captcha-required';
      if (credentials === undefined) credentials = await readStoredCredentials();
      if (!credentials) return 'credentials-missing';
      if (!submitted) {
        const payload = JSON.stringify({ user: credentials.username, pass: credentials.password });
        const result = await evaluateJson(send, `(() => {
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
        writeState({ lastLoginAt: Date.now(), lastLoginResult: result });
      }
      await sleep(2000);
      continue;
    }
    if (state.hasEntryButton) {
      await evaluateJson(send, `(() => { const b = [...document.querySelectorAll('a,button')].find((el) => (el.innerText || '').includes('登录领券')); if (b) b.click(); return 'ok'; })()`);
      await sleep(2500);
      continue;
    }
    await sleep(1500);
  }
  return submitted ? 'login-timeout' : 'login-not-started';
}

async function openPage({ headed, url, port }) {
  const chrome = findChrome();
  if (!chrome) return { error: 'chrome-not-found' };
  if (!fs.existsSync(PROFILE_DIR)) return { error: 'profile-missing' };

  const args = [
    ...(headed ? [] : ['--headless=new']),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check',
    ...(headed ? [] : ['--disable-gpu']),
    url,
  ];
  const child = spawn(chrome, args, { stdio: 'ignore' });
  const version = await waitForCdp(port);
  if (!version) { try { child.kill(); } catch {}; return { error: 'chrome-not-ready' }; }

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page' && target.url.includes('easycompute'))
    ?? targets.find((target) => target.type === 'page');
  if (!page?.webSocketDebuggerUrl) return { error: 'no-page', child };

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  await new Promise((resolve) => { socket.onopen = resolve; });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++sequence;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { child, socket, send };
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
  const current = readSession();
  if (!force && sessionIsFresh(current)) return { ok: true, exp: current.exp, skipped: true };

  const opened = await openPage({ headed: false, url: EASYCOMPUTE_ORIGIN + '/home', port: CDP_PORT });
  if (opened.error) {
    writeState({ lastError: opened.error, lastErrorAt: Date.now() });
    return { ok: false, error: opened.error };
  }
  try {
    await opened.send('Page.enable');
    await sleep(4000);
    const loginState = await ensureLoggedIn(opened.send);
    if (loginState === 'captcha-required' || loginState === 'credentials-missing' || loginState === 'login-timeout' || loginState === 'login-not-started') {
      writeState({ lastError: loginState, lastErrorAt: Date.now() });
      return { ok: false, error: loginState };
    }
    await sleep(2000);

    const result = await opened.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const token = localStorage.getItem('token') || '';
        if (!token) return JSON.stringify({ error: 'no-session-token' });
        const response = await fetch('/auth/userInfo/query', { headers: { token } });
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
    const session = { token: info.token, exp, capturedAt: Date.now(), source: force ? 'manual-refresh' : 'scheduled-refresh' };
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
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
    if (!Number.isFinite(exp)) { writeState({ lastError: 'malformed-session-token', lastErrorAt: Date.now() }); }
    return { ok: true, exp };
  } finally {
    try { opened.socket?.close(); } catch {}
    await closeBrowserGracefully(CDP_PORT, opened.child);
  }
}

/** Live balance query with the stored session token (no browser needed). */
export async function fetchBalance() {
  const session = readSession();
  if (!session?.token) return { ok: false, error: 'login-required' };
  const response = await fetch(EASYCOMPUTE_ORIGIN + '/auth/userInfo/query', {
    headers: { accept: 'application/json', token: session.token },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403) return { ok: false, error: 'session-expired' };
  if (!response.ok) return { ok: false, error: 'upstream-' + response.status };
  const body = await response.json().catch(() => null);
  const data = body?.data ?? null;
  if (!data || typeof data.couponFree !== 'number') return { ok: false, error: 'invalid-response' };
  return { ok: true, data };
}

/** Open a visible window on the Tsinghua console so the user can sign in once. */
export function openLoginWindow() {
  const chrome = findChrome();
  if (!chrome) return { ok: false, error: 'chrome-not-found' };
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(chrome, [
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check',
    EASYCOMPUTE_ORIGIN + '/home',
  ], { stdio: 'ignore', detached: true });
  child.unref();
  return { ok: true };
}

/** Open the DPAPI credential dialog so the user can store or rotate the password. */
export function openCredentialDialog() {
  if (!fs.existsSync(STORE_SCRIPT)) return { ok: false, error: 'script-missing' };
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', STORE_SCRIPT], {
    stdio: 'ignore', detached: true,
  });
  child.unref();
  return { ok: true };
}
