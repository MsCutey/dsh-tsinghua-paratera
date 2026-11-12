// An actual loopback HTTP peer checks the browser protocol independently of
// consoleFetch's implementation. All tokens, rows and secrets are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { consoleFetch, CONSOLE_ORIGIN } from '../lib/console.mjs';
import { createKey, deleteKey, listKeys } from '../lib/keys.mjs';

const TOKEN = 'abc'; // Public RFC MD5 vector; never an account credential.
const EXPECTED_PROOF = 'Bearer 900150983cd24fb0d6963f7d28e17f72';
const OLD_SHA256_PROOF = 'Bearer ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const EXISTING = 'EXISTING_FAKE_ID';
const CREATED = 'NEW+FAKE/OPAQUE==';
const NAME = 'dsh-verify-中文-test-only';
const FAKE_SECRET = 'sk-fake-wire-only-never-a-real-secret';

async function peer(t) {
  const rows = new Map([[EXISTING, { tokenUuid: EXISTING, tokenName: 'existing fake key', tokenStatus: 'valid', modelScale: [] }]]);
  const calls = [];
  const server = http.createServer(async (req, res) => {
    // Do not leave undici keep-alive sockets for --test-force-exit to tear down
    // on Windows. The response and request both explicitly close this peer.
    res.setHeader('connection', 'close');
    try {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : null;
      calls.push({ method: req.method, url: req.url, body, proof: req.headers['ai-authorization'] });
      assert.equal(req.headers.token, TOKEN);
      assert.equal(req.headers['content-type'], 'application/json');
      if (req.headers['ai-authorization'] !== EXPECTED_PROOF) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 401, message: 'fake invalid browser proof' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/lms/api/key/create') {
        assert.equal(req.method, 'POST');
        assert.deepEqual(body, { tokenName: NAME, billingType: 'PostPaid' });
        rows.set(CREATED, { tokenUuid: CREATED, tokenName: body.tokenName, tokenStatus: 'valid', modelScale: [], secretKey: FAKE_SECRET });
        // The public UI renders response.data verbatim as the one-time secret.
        res.end(JSON.stringify({ code: 200, data: FAKE_SECRET }));
      } else if (req.url === '/lms/api/key/delete') {
        assert.equal(req.method, 'DELETE');
        assert.deepEqual(body, { tokenUuid: CREATED });
        rows.delete(body.tokenUuid);
        res.end('{"code":200,"data":null}');
      } else if (req.url === '/lms/api/key/llmSk') {
        assert.equal(req.method, 'POST');
        const all = [...rows.values()];
        const start = (body.pageNum - 1) * body.pageSize;
        res.end(JSON.stringify({ code: 200, data: { rows: all.slice(start, start + body.pageSize), total: all.length } }));
      } else {
        assert.fail('unexpected path');
      }
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ code: 500 }));
      // Record fixed assertion metadata, never real upstream response bodies.
      calls.push({ fixtureFailure: error.message });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const local = new URL(`http://127.0.0.1:${server.address().port}`);
  // Plain node:http avoids undici's global keep-alive pool, which otherwise
  // races --test-force-exit teardown on Windows.
  const rawFetch = (url, config) => new Promise((resolve, reject) => {
    const target = new URL(new URL(url).pathname + new URL(url).search, local);
    const payload = config.body === undefined ? null : Buffer.from(String(config.body));
    const headers = {
      ...config.headers, connection: 'close',
      ...(payload ? { 'content-length': String(payload.length) } : {}),
      ...(oldProofFor(config) ? { 'Ai-Authorization': OLD_SHA256_PROOF } : {}),
    };
    const req = http.request({
      hostname: target.hostname, port: target.port, path: target.pathname + target.search,
      method: config.method || 'GET', headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  let oldProofFor = () => false;
  const request = (pathname, options = {}, oldProof = false) => {
    oldProofFor = () => oldProof;
    return consoleFetch(pathname, { ...options, read: () => ({ token: TOKEN }), fetchImpl: rawFetch });
  };
  return { rows, calls, request };
}

test('real HTTP new/list/delete lifecycle uses the official MD5 proof and preserves existing fake keys', async (t) => {
  const p = await peer(t);
  const before = await listKeys({ request: p.request, pageSize: 1 });
  assert.deepEqual(before.keys.map((key) => key.uuid), [EXISTING]);
  const created = await createKey('  ' + NAME + '  ', { request: p.request });
  // The host keeps the one-time plaintext; only its caller sees it.
  assert.deepEqual(created, { ok: true, secret: FAKE_SECRET });
  const listed = await listKeys({ request: p.request, pageSize: 1 });
  assert.deepEqual(listed.keys.map((key) => key.uuid), [EXISTING, CREATED]);
  assert.equal(JSON.stringify(listed).includes(FAKE_SECRET), false);
  const deleted = await deleteKey(CREATED, { request: p.request, list: () => listKeys({ request: p.request, pageSize: 1 }) });
  assert.deepEqual(deleted, { ok: true });
  const after = await listKeys({ request: p.request, pageSize: 1 });
  assert.deepEqual(after.keys.map((key) => key.uuid), [EXISTING]);
  assert.equal(p.calls.filter((call) => call.url === '/lms/api/key/create').length, 1);
  assert.equal(p.calls.filter((call) => call.method === 'DELETE').length, 1);
  assert.ok(p.calls.every((call) => call.proof === EXPECTED_PROOF));
  assert.ok(p.rows.has(EXISTING));
  assert.equal(p.calls.some((call) => call.fixtureFailure), false);
});

test('the old SHA-256 header fails both mutations on the same real HTTP peer; corrected MD5 succeeds without retries', async (t) => {
  const p = await peer(t);
  const old = (pathname, options) => p.request(pathname, options, true);
  assert.deepEqual(await createKey(NAME, { request: old }), { ok: false, error: 'console-session-expired' });
  assert.equal(p.rows.has(CREATED), false);
  assert.deepEqual(await createKey(NAME, { request: p.request }), { ok: true, secret: FAKE_SECRET });
  assert.equal(p.rows.has(CREATED), true);
  let verificationReads = 0;
  assert.deepEqual(await deleteKey(CREATED, { request: old, list: () => { verificationReads++; assert.fail('authentication rejection must not verify/retry'); } }), { ok: false, error: 'console-session-expired' });
  assert.equal(verificationReads, 0);
  assert.equal(p.rows.has(CREATED), true);
  assert.deepEqual(await deleteKey(CREATED, { request: p.request }), { ok: true });
  assert.equal(p.rows.has(CREATED), false);
  assert.equal(p.rows.has(EXISTING), true);
  assert.equal(p.calls.filter((call) => call.method === 'DELETE').length, 2); // two deliberate calls, not an automatic retry
  assert.equal(p.calls.some((call) => call.fixtureFailure), false);
});

test('HTTP 200 without an explicit LMS success code never reports a newly created key', async () => {
  for (const data of [{}, { success: false }, { success: true }, { code: null }, { code: true }, { code: [] }, { code: {} }, { code: 200, success: false }, { code: 200, ok: false }]) {
    let count = 0;
    const result = await createKey('test-only-name', { request: (pathname, options) => consoleFetch(pathname, {
      ...options, read: () => ({ token: TOKEN }), fetchImpl: async () => {
        count++;
        return new Response(JSON.stringify({ ...data, message: FAKE_SECRET }));
      },
    }) });
    assert.equal(result.ok, false, JSON.stringify(data));
    assert.equal(count, 1);
    assert.equal(JSON.stringify(result).includes(FAKE_SECRET), false);
  }
});

test('invalid new-key names do not reach the transport, including control characters and oversized input', async () => {
  for (const name of [null, [], '', ' ', 'x'.repeat(201), 'fake\nname', 'fake\u0000name']) {
    const result = await createKey(name, { request: () => assert.fail('invalid input must not send') });
    assert.equal(result.ok, false);
  }
});
