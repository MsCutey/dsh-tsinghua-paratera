// Reveal a console API key's plaintext through the LMS page.
//
// The console returns an encrypted blob from /lms/api/key/to and decrypts it in
// the page, so the only reliable way to obtain the secret from the host is to
// drive the page, click the eye icon and read the rendered value.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { CONSOLE_ORIGIN, EASYCOMPUTE_HOME, ensureConsoleSession } from './console.mjs';
import { findChrome, PROFILE_DIR } from './refresh.mjs';

const CDP_PORT = 9385;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.result?.value;
}

/**
 * Read the plaintext secret for one key by driving the LMS page.
 * @param {{ name: string }} target key name shown in the table
 * @returns {Promise<{ok: true, secret: string} | {ok: false, error: string}>}
 */
export async function revealKeySecret(name) {
  const session = await ensureConsoleSession();
  if (!session.ok) return { ok: false, error: session.error };

  const instance = await launch();
  if (instance.error) return { ok: false, error: instance.error };
  try {
    await instance.send('Page.navigate', { url: EASYCOMPUTE_HOME });
    let accessCode = '';
    for (let i = 0; i < 20 && !accessCode; i++) {
      await sleep(1500);
      accessCode = (await evaluate(instance.send, `localStorage.getItem('accessCode') || ''`)) || '';
    }
    if (!accessCode) return { ok: false, error: 'easycompute-login-required' };

    await instance.send('Page.navigate', {
      url: `${CONSOLE_ORIGIN}/#/auth?qh_access_code=${encodeURIComponent(accessCode)}&target=%2Fcontainer%2Finstance`,
    });
    await sleep(9000);
    await evaluate(instance.send, `location.hash = '#/lms/api'`);

    let ready = false;
    for (let i = 0; i < 20 && !ready; i++) {
      await sleep(1500);
      ready = Boolean(await evaluate(instance.send, `!!document.querySelector('.ant-table-tbody tr')`));
    }
    if (!ready) return { ok: false, error: 'keys-table-not-ready' };

    const clicked = await evaluate(instance.send, `(() => {
      const rows = [...document.querySelectorAll('.ant-table-tbody tr')];
      const row = rows.find((r) => (r.innerText || '').includes(${JSON.stringify(name)}));
      if (!row) return 'row-not-found';
      const eye = row.querySelector('.anticon-eye-invisible, [class*="eye"]');
      if (eye) { eye.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'eye-clicked'; }
      const icon = row.querySelector('td a, td span');
      if (icon) { icon.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'fallback-clicked'; }
      return 'no-eye';
    })()`);

    if (clicked !== 'eye-clicked' && clicked !== 'fallback-clicked') return { ok: false, error: String(clicked) };

    let secret = '';
    for (let i = 0; i < 12 && !secret; i++) {
      await sleep(1000);
      secret = (await evaluate(instance.send, `(() => {
        const rows = [...document.querySelectorAll('.ant-table-tbody tr')];
        const row = rows.find((r) => (r.innerText || '').includes(${JSON.stringify(name)}));
        if (!row) return '';
        const text = (row.innerText || '').trim();
        const match = text.match(/sk-[A-Za-z0-9_-]{16,}/);
        return match ? match[0] : '';
      })()`)) || '';
    }
    if (!secret) return { ok: false, error: 'secret-not-revealed' };
    return { ok: true, secret };
  } finally {
    await closeBrowser(instance);
  }
}
