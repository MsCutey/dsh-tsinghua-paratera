#!/usr/bin/env node
// Exercise real Chrome startup/reuse on about:blank with a disposable profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openPage, closePage, findChrome, readCdpEndpoint } from '../lib/refresh.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-chrome-check-'));
let owned;
let attached;
let replacement;
try {
  owned = await openPage({ headed: false, url: 'about:blank', profileDir: folder, chrome: findChrome() });
  assert.equal(owned.error, undefined);
  assert.ok(owned.child);
  const first = await owned.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  assert.equal(first.result.result.value, 'about:blank');
  attached = await openPage({ headed: false, url: 'about:blank', profileDir: folder, chrome: findChrome() });
  assert.equal(attached.error, undefined);
  assert.equal(attached.child, null);
  assert.equal(attached.port, owned.port);
  await closePage(attached);
  attached = null;
  const again = await owned.send('Runtime.evaluate', { expression: '2 + 2', returnByValue: true });
  assert.equal(again.result.result.value, 4);
  const target = await owned.send('Target.getTargetInfo');
  try { await owned.send('Target.closeTarget', { targetId: target.result.targetInfo.targetId }); }
  catch (error) { assert.match(error.message, /cdp-closed/); }
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(await readCdpEndpoint(folder), 'browser process should remain after its last page closes');
  replacement = await openPage({ headed: false, url: 'about:blank', profileDir: folder, chrome: findChrome() });
  assert.equal(replacement.error, undefined);
  assert.ok(replacement.child, 'a windowless browser is replaced with a headless one');
  const recovered = await replacement.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  assert.equal(recovered.result.result.value, 'about:blank');
  console.log(JSON.stringify({ ok: true, freshChromeStarted: true, existingProfileReused: true, attachedBrowserLeftOpen: true, windowlessBrowserRecovered: true, realAccountUsed: false }));
} finally {
  if (attached) await closePage(attached);
  if (owned && !owned.error) await closePage(owned);
  if (replacement && !replacement.error) await closePage(replacement);
  fs.rmSync(folder, { recursive: true, force: true });
}
