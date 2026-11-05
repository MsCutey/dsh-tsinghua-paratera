// Automatic Paratera console session.
//
// The console has no password login we can use; Tsinghua users reach it through
// easycompute. The exchange is:
//   easycompute localStorage.accessCode
//     -> https://ai.paratera.com/#/auth?qh_access_code=<code>&target=...
//       -> PARA_TOKEN in localStorage
// That makes the console session as automatic as the balance session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { PROFILE_DIR, findChrome } from './refresh.mjs';

export const CONSOLE_ORIGIN = 'https://ai.paratera.com';
export const EASYCOMPUTE_HOME = 'https://easycompute.cs.tsinghua.edu.cn/home';
export const CONSOLE_SESSION_FILE = path.join(os.homedir(), '.dsh', 'paratera-console-session.json');
const REFRESH_GRACE_MS = 5 * 60 * 1000;
const CDP_PORT = 9370;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function readConsoleSession() {
  try {
    const value = JSON.parse(fs.readFileSync(CONSOLE_SESSION_FILE, 'utf8'));
    return typeof value?.token === 'string' && value.token ? value : null;
  } catch {
    return null;
  }
}

export function consoleSessionFresh(entry, graceMs = REFRESH_GRACE_MS) {
  return Boolean(entry?.exp && entry.exp - Date.now() > graceMs);
}

function persist(token) {
  let exp = 0;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    exp = Number.isFinite(payload?.exp) ? payload.exp * 1000 : 0;
  } catch {}
  const entry = { token, exp, capturedAt: Date.now() };
  fs.writeFileSync(CONSOLE_SESSION_FILE, JSON.stringify(entry, null, 2), { mode: 0o600 });
  return entry;
}

async function launch() {
  const chrome = findChrome();
  if (!chrome) return { error: 'chrome-not-found' };
  if (!fs.existsSync(PROFILE_DIR)) return { error: 'profile-missing' };
  const child = spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    await sleep(500);
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) version = await r.json(); } catch {}
  }
  if (!version) { try { child.kill(); } catch {}; return { error: 'chrome-not-ready' }; }
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Page.enable');
  return { child, ws, send };
}

async function closeBrowser(instance) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const bws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r) => { bws.onopen = r; setTimeout(r, 1500); });
    bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(1500);
    bws.close();
  } catch {}
  try { instance.ws?.close(); } catch {}
  try { instance.child?.kill(); } catch {}
}

async function evalValue(send, expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  return r?.result?.result?.value;
}

/**
 * Ensure a live console token, exchanging the easycompute access code when needed.
 * @returns {Promise<{ok: true, exp: number, reused?: boolean} | {ok: false, error: string}>}
 */
export async function ensureConsoleSession({ force = false } = {}) {
  const cached = readConsoleSession();
  if (!force && consoleSessionFresh(cached)) return { ok: true, exp: cached.exp, reused: true };

  const instance = await launch();
  if (instance.error) return { ok: false, error: instance.error };
  try {
    await instance.send('Page.navigate', { url: EASYCOMPUTE_HOME });
    let accessCode = '';
    for (let i = 0; i < 20 && !accessCode; i++) {
      await sleep(1500);
      accessCode = (await evalValue(instance.send, `localStorage.getItem('accessCode') || ''`)) || '';
    }
    if (!accessCode) return { ok: false, error: 'easycompute-login-required' };

    await instance.send('Page.navigate', {
      url: `${CONSOLE_ORIGIN}/#/auth?qh_access_code=${encodeURIComponent(accessCode)}&target=%2Fcontainer%2Finstance`,
    });
    let token = '';
    for (let i = 0; i < 20 && !token; i++) {
      await sleep(1500);
      token = (await evalValue(instance.send, `localStorage.getItem('PARA_TOKEN') || ''`)) || '';
    }
    if (!token) return { ok: false, error: 'console-auth-failed' };
    const entry = persist(token);
    return { ok: true, exp: entry.exp, reused: false };
  } finally {
    await closeBrowser(instance);
  }
}

/**
 * Call a console platform endpoint with the cached session token.
 * The LMS routes additionally require `Ai-Authorization: Bearer sha256(token)`.
 */
export async function consoleFetch(pathname, { method = 'GET', body } = {}) {
  const session = readConsoleSession();
  if (!session) return { ok: false, error: 'console-session-missing' };
  const signature = crypto.createHash('sha256').update(session.token).digest('hex');
  const response = await fetch(CONSOLE_ORIGIN + pathname, {
    method,
    headers: {
      accept: 'application/json',
      token: session.token,
      'Ai-Authorization': 'Bearer ' + signature,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403) return { ok: false, error: 'console-session-expired' };
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!response.ok) return { ok: false, error: `console-http-${response.status}` };
  if (json && typeof json.code === 'number' && json.code !== 200) {
    return { ok: false, error: 'console-code-' + json.code, message: json.message ?? null };
  }
  return { ok: true, data: json?.data ?? null, raw: json };
}
