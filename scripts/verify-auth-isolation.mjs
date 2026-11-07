#!/usr/bin/env node
// Real Chrome + localhost-only synthetic login. Never reads account credentials.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openPage, closePage, findChrome } from '../lib/refresh.mjs';
import { trustedEvaluate } from '../lib/browser-security.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-auth-isolation-'));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end('<input id="test"><script>window.hooked=0; JSON.stringify=function(){window.hooked++;throw Error("hostile page hook")};</script>');
});
let page;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  page = await openPage({ headed: false, url: origin, profileDir: folder, chrome: findChrome() });
  assert.equal(page.error, undefined);
  const reply = await trustedEvaluate(page.send, origin, `(() => { document.getElementById('test').value='test-only-password'; return JSON.stringify({ok:true}); })()`);
  assert.equal(JSON.parse(reply.result.result.value).ok, true);
  const hooked = await page.send('Runtime.evaluate', { expression: 'window.hooked', returnByValue: true });
  assert.equal(hooked.result.result.value, 0);
  let secretSent = false;
  await assert.rejects(trustedEvaluate((method, params) => {
    if (params?.expression?.includes('TEST_SECRET_NEVER_SENT')) secretSent = true;
    return page.send(method, params);
  }, 'https://example.invalid', 'TEST_SECRET_NEVER_SENT'), /untrusted-login-page/);
  assert.equal(secretSent, false);
  console.log(JSON.stringify({ ok: true, isolatedWorld: true, pageHookNotInvoked: true, foreignOriginRejected: true, realAccountUsed: false }));
} finally {
  if (page && !page.error) await closePage(page);
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(folder, { recursive: true, force: true });
}
