// Automatic Paratera console session. All browser users share the refresh lock
// and the profile's dynamically discovered CDP endpoint (never a fixed port).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { platformPaths } from './platform.mjs';
import { openPage, closePage, acquireRefreshLock, secondFactorStatus } from './refresh.mjs';

export const CONSOLE_ORIGIN = 'https://ai.paratera.com';
export const EASYCOMPUTE_HOME = 'https://easycompute.cs.tsinghua.edu.cn/home';
export const CONSOLE_SESSION_FILE = path.join(platformPaths().dshHome, 'paratera-console-session.json');
const REFRESH_GRACE_MS = 5 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function readConsoleSession() {
  try {
    const value = JSON.parse(fs.readFileSync(CONSOLE_SESSION_FILE, 'utf8'));
    return typeof value?.token === 'string' && value.token ? value : null;
  } catch { return null; }
}

export function consoleSessionFresh(entry, graceMs = REFRESH_GRACE_MS) {
  return Number.isFinite(entry?.exp) && entry.exp - Date.now() > graceMs;
}

function expiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}

function persist(token) {
  const entry = { token, exp: expiry(token) ?? 0, capturedAt: Date.now() };
  fs.mkdirSync(path.dirname(CONSOLE_SESSION_FILE), { recursive: true, mode: 0o700 });
  const temporary = `${CONSOLE_SESSION_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(entry, null, 2), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, CONSOLE_SESSION_FILE);
  } finally { fs.rmSync(temporary, { force: true }); }
  return entry;
}

/** CDP errors/disconnection must terminate polling, not look like an empty value. */
async function consoleCommand(send, method, params) {
  const reply = await send(method, params);
  if (reply?.__cdpClosed) throw new Error('cdp-closed');
  if (reply?.error || reply?.result?.exceptionDetails) throw new Error('console-evaluate-failed');
  if (method === 'Page.navigate' && reply?.result?.errorText) throw new Error('console-navigation-failed');
  return reply;
}

export async function consoleEvaluate(send, expression) {
  const reply = await consoleCommand(send, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return reply?.result?.result?.value;
}

/** Authenticate the already locked/open page; reveal reuses this same browser. */
export async function authenticateConsolePage(send, { pause = sleep, save = persist } = {}) {
  await consoleCommand(send, 'Page.enable');
  await consoleCommand(send, 'Page.navigate', { url: EASYCOMPUTE_HOME });
  let accessCode = '';
  for (let attempt = 0; attempt < 60 && !accessCode; attempt += 1) {
    if (attempt) await pause(500);
    accessCode = await consoleEvaluate(send, `location.origin === ${JSON.stringify(new URL(EASYCOMPUTE_HOME).origin)} ? (localStorage.getItem('accessCode') || '') : ''`);
  }
  if (typeof accessCode !== 'string' || !accessCode) return { ok: false, error: 'easycompute-login-required' };
  // A token left by an earlier session would otherwise be captured as this
  // exchange's result: the SPA keeps it, fails its own check and lands on
  // #/login, which later surfaces as an untrusted-console-page. The script runs
  // before the auth page boots, and is removed as soon as the exchange settles.
  let clearScript;
  try {
    const added = await consoleCommand(send, 'Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.removeItem('PARA_TOKEN'); localStorage.removeItem('PARA_ATOKEN'); } catch {}`,
    });
    clearScript = added?.result?.identifier;
  } catch {}
  try {
    await consoleCommand(send, 'Page.navigate', {
      url: `${CONSOLE_ORIGIN}/#/auth?qh_access_code=${encodeURIComponent(accessCode)}&target=%2Flms%2Fapi`,
    });
    let token = '';
    for (let attempt = 0; attempt < 60 && !token; attempt += 1) {
      if (attempt) await pause(500);
      const candidate = await consoleEvaluate(send, `location.origin === ${JSON.stringify(CONSOLE_ORIGIN)} ? (localStorage.getItem('PARA_TOKEN') || '') : ''`);
      // Do not immediately capture a stale token left in storage from an old login.
      const exp = typeof candidate === 'string' ? expiry(candidate) : null;
      if (typeof candidate === 'string' && candidate && (exp === null || exp > Date.now())) token = candidate;
    }
    if (!token) return { ok: false, error: 'console-auth-failed' };
    const entry = await save(token);
    return { ok: true, exp: entry.exp };
  } finally {
    if (clearScript !== undefined) {
      try { await consoleCommand(send, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: clearScript }); } catch {}
    }
  }
}

/** Ensure a live console token without launching competing profile processes. */
export async function ensureConsoleSession({
  force = false, read = readConsoleSession, open = openPage, close = closePage,
  acquire = acquireRefreshLock, pending = secondFactorStatus, authenticate = authenticateConsolePage,
} = {}) {
  const cached = read();
  if (!force && consoleSessionFresh(cached)) return { ok: true, exp: cached.exp, reused: true };
  if (pending().pending) return { ok: false, error: 'second-factor-pending' };
  let release;
  let opened;
  try {
    release = acquire();
    if (!release) return { ok: false, error: 'refresh-busy' };
    opened = await open({ headed: false, url: EASYCOMPUTE_HOME });
    if (opened.error) return { ok: false, error: opened.error };
    const result = await authenticate(opened.send);
    return result.ok ? { ...result, reused: false } : result;
  } catch (error) {
    return { ok: false, error: ['cdp-closed', 'cdp-timeout'].includes(error?.message) ? error.message : 'console-auth-failed' };
  } finally {
    try { if (opened && !opened.error) await close(opened); } catch {}
    finally { release?.(); }
  }
}

/** Host-only request. Never return raw upstream errors which might echo a key. */
export async function consoleFetch(pathname, {
  method = 'GET', body, read = readConsoleSession, fetchImpl = fetch,
} = {}) {
  let url;
  try {
    if (typeof pathname !== 'string' || !pathname.startsWith('/lms/') || /[\\\u0000-\u0020#]/.test(pathname)) throw new Error('invalid-path');
    url = new URL(pathname, CONSOLE_ORIGIN);
    if (url.origin !== CONSOLE_ORIGIN || !url.pathname.startsWith('/lms/')) throw new Error('invalid-path');
  } catch { return { ok: false, error: 'invalid-console-path' }; }
  const session = read();
  if (!session) return { ok: false, error: 'console-session-missing' };
  const signature = crypto.createHash('sha256').update(session.token).digest('hex');
  try {
    const response = await fetchImpl(url.href, {
      method, redirect: 'error',
      headers: {
        accept: 'application/json', token: session.token,
        'Ai-Authorization': 'Bearer ' + signature,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, error: 'console-session-expired' };
    if (!response.ok) return { ok: false, error: `console-http-${response.status}` };
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { return { ok: false, error: 'console-invalid-response' }; }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, error: 'console-invalid-response' };
    if (json.code !== undefined && Number(json.code) !== 200) {
      if ([401, 403].includes(Number(json.code))) return { ok: false, error: 'console-session-expired' };
      // Interpret only a boolean condition on the host; never return the raw
      // message, which upstream services may populate with request credentials.
      if (url.pathname === '/lms/api/key/create' && typeof json.message === 'string'
        && /(?:密钥|秘钥|api\s*key|token).{0,80}(?:数量|上限|limit|quota)|(?:最多|配额|上限).{0,80}(?:密钥|秘钥|api\s*key|token|key)/i.test(json.message.slice(0, 2000))) {
        return { ok: false, error: 'key-quota-exceeded' };
      }
      return { ok: false, error: 'console-api-error' };
    }
    return { ok: true, data: json.data ?? null, raw: json };
  } catch (error) {
    return { ok: false, error: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'console-timeout' : 'console-network-error' };
  }
}
