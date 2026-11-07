// Reveal only the selected key through its rendered LMS secret cell. Browser
// ownership, dynamic CDP discovery and timeouts live in refresh.mjs.
import { CONSOLE_ORIGIN, EASYCOMPUTE_HOME, authenticateConsolePage, consoleEvaluate } from './console.mjs';
import { openPage, closePage, acquireRefreshLock, secondFactorStatus } from './refresh.mjs';
import { listKeys } from './keys.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// This function runs in the console page. No broad row-text substring matching,
// arbitrary action links or table-wide secret regexes: those can select a
// similarly named key, delete a row, or mistake a key-shaped name for a secret.
function inspectKeyPage(target, action, origin) {
  if (location.origin !== origin) return { error: 'untrusted-console-page' };
  const rows = [...document.querySelectorAll('.ant-table-tbody tr')]
    .filter((row) => row.querySelector('td') && !row.classList.contains('ant-table-placeholder') && !row.classList.contains('ant-table-measure-row'));
  const text = (element) => (element?.innerText ?? element?.textContent ?? '').trim();
  const id = (row) => row.getAttribute('data-row-key') || row.getAttribute('data-token-uuid') || '';
  // The console labels this column 名称/描述 today; older builds used 名称 or
  // 密钥名称. Match only labels that really name the description column, never a
  // model/status column that happens to contain a similar word.
  const isNameHeader = (value) => {
    const label = text(value).replace(/\s+/g, '');
    return /名称/.test(label) || /^(?:api)?keyname$/i.test(label) || /^name$/i.test(label);
  };
  const nameColumn = (row) => [...(row.closest?.('table') || document).querySelectorAll('.ant-table-thead th')]
    .findIndex(isNameHeader);
  const nameCell = (row) => {
    const index = nameColumn(row);
    return index < 0 ? null : row.querySelectorAll('td')[index];
  };
  // Never include unrelated rows' possibly already-revealed secret cells.
  const signature = JSON.stringify(rows.map((item) => [id(item), text(nameCell(item))]));
  const ready = rows.length > 0 && !document.querySelector('.ant-spin-spinning');
  if (!ready) return { ready: false, signature };
  const nameMatches = (row) => {
    const cell = nameCell(row);
    return Boolean(cell && (text(cell) === target.name || [...cell.querySelectorAll('[title]')].some((el) => el.getAttribute('title') === target.name)));
  };
  const uuidRows = rows.filter((row) => target.uuid && id(row) === target.uuid);
  if (uuidRows.length > 1) return { error: 'ambiguous-key-row' };
  const uuidRow = uuidRows[0];
  if (!uuidRow && rows.some((row) => !target.knownUuids.includes(id(row)) && nameColumn(row) < 0)) return { error: 'key-name-column-not-found' };
  const matching = rows.filter(nameMatches);
  // An index-based rowKey cannot disambiguate duplicate names. Refuse rather
  // than revealing a different account credential. Real UUID rowKeys can.
  const ambiguous = !uuidRow && matching.length > 0 && (!target.uniqueName || matching.length > 1)
    && matching.some((row) => !target.knownUuids.includes(id(row)));
  const fallback = target.uniqueName && matching.length === 1 && !target.knownUuids.includes(id(matching[0])) ? matching[0] : null;
  const row = uuidRow || fallback;
  // Page-number highlights may change before the old rows finish loading;
  // signature deliberately tracks row content only.
  if (action === 'first') {
    const first = document.querySelector('.ant-pagination-item-1');
    const reset = Boolean(first && !first.classList.contains('ant-pagination-item-active'));
    if (reset) (first.querySelector('button,a') || first).click();
    return { reset };
  }
  const next = document.querySelector('.ant-pagination-next');
  const nextEnabled = next && !next.classList.contains('ant-pagination-disabled')
    && next.getAttribute('aria-disabled') !== 'true' && !next.querySelector('button[disabled]');
  if (action === 'next') {
    if (!nextEnabled) return { error: 'row-not-found' };
    (next.querySelector('button,a') || next).click();
    return { advanced: true };
  }
  if (ambiguous) return { error: 'ambiguous-key-name' };
  if (action === 'inspect') return { ready, found: Boolean(row), signature, next: Boolean(nextEnabled) };
  if (!row) return { error: 'row-not-found' };
  const hidden = row.querySelector('.anticon-eye-invisible, [data-icon="eye-invisible"], [aria-label="eye-invisible"]');
  const visible = row.querySelector('.anticon-eye, [data-icon="eye"], [aria-label="eye"]');
  const eye = hidden || visible;
  const cell = eye?.closest('td');
  if (!cell) return { error: 'no-eye' };
  if (action === 'click') {
    if (hidden) {
      // The eye lives inside an antd link button; click the control itself so
      // React's delegated handler sees a real button event.
      const control = hidden.closest?.('button,a');
      if (control && typeof control.click === 'function') control.click();
      else hidden.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    return { clicked: true };
  }
  const values = [text(cell), ...[...cell.querySelectorAll('input,textarea')].map((el) => el.value || '')];
  for (const value of values) {
    const match = value.match(/(?:^|\s)(sk-[A-Za-z0-9_-]{16,})(?=\s|$)/);
    if (match) return { secret: match[1] };
  }
  return { secret: '' };
}

export function keyPageExpression(target, action = 'inspect') {
  return `(${inspectKeyPage.toString()})(${JSON.stringify(target)}, ${JSON.stringify(action)}, ${JSON.stringify(CONSOLE_ORIGIN)})`;
}

/**
 * Park the attached page on the console key table.
 *
 * The auth redirect may still be in flight when the token appears, and a stale
 * browser session can bounce the SPA to `#/login` or back to easycompute. Poll
 * until the document reports the console origin fully loaded, re-applying the
 * key-page hash, so the inspector never runs against a foreign page.
 */
async function enterConsoleKeyPage(send, pause, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let state;
    try {
      state = await consoleEvaluate(send, `(() => {
        if (location.origin !== ${JSON.stringify(CONSOLE_ORIGIN)}) return { ok: false, origin: location.origin };
        if (document.readyState !== 'complete') return { ok: false, ready: document.readyState };
        if (!location.hash.includes('/lms/api')) location.hash = '#/lms/api';
        return { ok: true };
      })()`);
    } catch (error) {
      // A dropped/absent CDP endpoint must abort, not look like a slow page.
      if (['cdp-closed', 'cdp-timeout'].includes(error?.message)) throw error;
      state = null;
    }
    if (state?.ok) {
      await pause(600);
      try {
        const settled = await consoleEvaluate(send, `location.origin === ${JSON.stringify(CONSOLE_ORIGIN)} && document.readyState === 'complete'`);
        if (settled === true) return true;
      } catch (error) {
        if (['cdp-closed', 'cdp-timeout'].includes(error?.message)) throw error;
      }
    }
    await pause(500);
  }
  return false;
}

/**
 * Compatibility: revealKeySecret(name), revealKeySecret({uuid,name}), or
 * revealKeySecret(name, {uuid}). Dependencies in options are for isolated tests.
 */
export async function revealKeySecret(input, {
  uuid, open = openPage, close = closePage, acquire = acquireRefreshLock,
  pending = secondFactorStatus, authenticate = authenticateConsolePage,
  list = listKeys, pause = sleep, maxPages = 100,
} = {}) {
  const supplied = typeof input === 'string' ? { name: input, uuid } : input;
  if (!supplied || (typeof supplied.name !== 'string' && typeof supplied.uuid !== 'string')
    || (supplied.name !== undefined && (typeof supplied.name !== 'string' || !supplied.name.trim()))
    || (supplied.uuid !== undefined && (typeof supplied.uuid !== 'string' || !supplied.uuid.trim()))
    || !Number.isInteger(maxPages) || maxPages < 1) return { ok: false, error: 'invalid-arguments' };
  if (pending().pending) return { ok: false, error: 'second-factor-pending' };
  let release;
  let opened;
  try {
    release = acquire();
    if (!release) return { ok: false, error: 'refresh-busy' };
    opened = await open({ headed: false, url: EASYCOMPUTE_HOME });
    if (opened.error) return { ok: false, error: opened.error };
    const authenticated = await authenticate(opened.send);
    if (!authenticated.ok) return authenticated;
    const listed = await list();
    if (!listed.ok) return listed;
    const matches = listed.keys.filter((key) => supplied.uuid ? key.uuid === supplied.uuid : key.name === supplied.name);
    if (!matches.length) return { ok: false, error: 'row-not-found' };
    if (matches.length !== 1) return { ok: false, error: 'ambiguous-key-name' };
    const selected = matches[0];
    const target = {
      uuid: selected.uuid, name: selected.name,
      uniqueName: listed.keys.filter((key) => key.name === selected.name).length === 1,
      knownUuids: listed.keys.map((key) => key.uuid),
    };
    // The auth redirect can land on #/login (or another origin) when a stale
    // token survived; only start inspecting once the console key page settled.
    if (!await enterConsoleKeyPage(opened.send, pause)) {
      // One clean retry: a failed/revoked exchange leaves the SPA on #/login,
      // and re-running the (token-clearing) auth is what recovers it.
      const retried = await authenticate(opened.send);
      if (!retried.ok) return retried;
      if (!await enterConsoleKeyPage(opened.send, pause)) return { ok: false, error: 'untrusted-console-page' };
    }
    const inspect = (action) => consoleEvaluate(opened.send, keyPageExpression(target, action));
    let previous = null;
    let resetChecked = false;
    for (let page = 0; page < maxPages; page += 1) {
      let state;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await pause(500);
        state = await inspect('inspect');
        if (state?.error) return { ok: false, error: state.error };
        if (state?.ready && state.signature !== previous) break;
      }
      if (!state?.ready) return { ok: false, error: 'keys-table-not-ready' };
      if (state.signature === previous) return { ok: false, error: 'keys-pagination-stalled' };
      if (!resetChecked) {
        resetChecked = true;
        const reset = await inspect('first');
        if (reset?.error) return { ok: false, error: reset.error };
        if (reset?.reset) {
          previous = state.signature;
          page -= 1;
          continue;
        }
      }
      if (state.found) {
        const clicked = await inspect('click');
        if (clicked?.error) return { ok: false, error: clicked.error };
        if (!clicked?.clicked) return { ok: false, error: 'keys-table-not-ready' };
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await pause(1000);
          const revealed = await inspect('read');
          if (revealed?.error) return { ok: false, error: revealed.error };
          if (typeof revealed?.secret === 'string' && /^sk-[A-Za-z0-9_-]{16,}$/.test(revealed.secret)) return { ok: true, secret: revealed.secret };
        }
        return { ok: false, error: 'secret-not-revealed' };
      }
      if (!state.next) return { ok: false, error: 'row-not-found' };
      if (page + 1 < maxPages) {
        previous = state.signature;
        const advanced = await inspect('next');
        if (advanced?.error) return { ok: false, error: advanced.error };
      }
    }
    return { ok: false, error: 'keys-pagination-limit' };
  } catch (error) {
    return { ok: false, error: ['cdp-closed', 'cdp-timeout'].includes(error?.message) ? error.message : 'key-reveal-failed' };
  } finally {
    try { if (opened && !opened.error) await close(opened); } catch {}
    finally { release?.(); }
  }
}
