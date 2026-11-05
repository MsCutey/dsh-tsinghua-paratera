import { test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import plugin from '../lib/index.js'

const TOKEN_REF = 'DSH_PARATERA_ISOLATED_TEST_TOKEN_20261102'
const PRICE = 'https://ai.paratera.com/platform/paraUser/getPrice'
const QUOTA = 'https://ai.paratera.com/platform/resourceUserConfig/getList'
const validPrice = { chargeFree: '10.25', creditFree: 2, aiFrozenPrice: 1, userServerFrozenPrice: 0, totalLockAmount: 0.25 }
let networkCalls
let browserCalls
let savedEnv
beforeEach(() => {
  networkCalls = []
  browserCalls = 0
  savedEnv = process.env[TOKEN_REF]
  delete process.env[TOKEN_REF]
  mock.method(globalThis, 'fetch', async (...args) => {
    networkCalls.push(args)
    throw new Error('ISOLATION: no real network permitted')
  })
  mock.method(fs, 'readdirSync', () => { browserCalls++; throw new Error('ISOLATION: no browser reads permitted') })
})
afterEach(() => {
  mock.restoreAll()
  if (savedEnv === undefined) delete process.env[TOKEN_REF]
  else process.env[TOKEN_REF] = savedEnv
  assert.equal(browserCalls, 0)
})
function json(data, options = {}) {
  return new Response(JSON.stringify({ code: 200, data }), { status: 200, headers: { 'content-type': 'application/json' }, ...options })
}
function fetchWith(fn) {
  globalThis.fetch.mock.mockImplementation(async (...args) => { networkCalls.push(args); return fn(...args) })
}
function host({ rejection = null, credential = 'fake-test-token', config = {}, connection } = {}) {
  const routes = new Map()
  let credentialReads = 0
  let authCalls = 0
  const ctx = {
    credentials: { async resolve(ref) { credentialReads++; assert.equal(ref, TOKEN_REF); return { value: credential } } },
    connection: connection ?? { requestRejection() { authCalls++; return rejection } },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
    effect(fn) { fn() },
  }
  plugin.apply({ inject(names, callback) {
    assert.deepEqual(names, ['webServer', 'credentials', 'connection'])
    callback(ctx)
  } }, { source: 'paratera', tokenRef: TOKEN_REF, ...config })
  return {
    routes,
    get credentialReads() { return credentialReads },
    get authCalls() { return authCalls },
    async request(suffix = 'balance', method = 'GET') {
      let status
      let headers
      let body
      const url = `/paratera-balance/api/${suffix}`
      const handler = routes.get(url.split('?')[0])
      if (!handler) return { status: 404 }
      await handler({ url, method, headers: {} }, {
        writeHead(code, fields) { status = code; headers = fields },
        end(value) { body = JSON.parse(value) },
      })
      return { status, headers, body }
    },
  }
}

test('unauthorized request cannot resolve credentials, read browser or fetch', async () => {
  for (const rejection of [401, 403, true, 0, 'unexpected']) {
    const h = host({ rejection })
    const result = await h.request()
    assert.ok([401, 403].includes(result.status))
    assert.equal(h.credentialReads, 0)
  }
  assert.equal(networkCalls.length, 0)
})
test('missing and throwing connection fences fail closed', async () => {
  for (const connection of [{}, { requestRejection() { throw new Error('private') } }]) {
    const h = host({ connection })
    assert.equal((await h.request()).status, 403)
    assert.equal(h.credentialReads, 0)
  }
})
test('legal balance uses only official destinations, POST JSON and redirect denial', async () => {
  fetchWith((url) => json(url === PRICE ? validPrice : { monetaryQuotaStatus: 1, unUsedMonetaryQuota: '7.50' }))
  const h = host({ config: { base: 'https://attacker.invalid/', endpoint: 'secret' } })
  const result = await h.request()
  assert.equal(result.status, 200)
  assert.equal(result.headers['Cache-Control'], 'no-store')
  assert.equal(result.body.balance, 12.25)
  assert.equal(result.body.availableQuota, 7.5)
  assert.equal(result.body.calculationVerified, false)
  assert.equal(result.body.quotaSource, 'unUsedMonetaryQuota')
  assert.deepEqual(networkCalls.map(([url]) => url), [PRICE, QUOTA])
  for (const [, options] of networkCalls) {
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.token, 'fake-test-token')
    assert.ok(options.signal instanceof AbortSignal)
  }
  assert.equal(networkCalls[1][1].method, 'POST')
  assert.equal(networkCalls[1][1].headers['Content-Type'], 'application/json')
  assert.equal(networkCalls[1][1].body, '{}')
  await h.request()
  assert.equal(networkCalls.length, 2)
  assert.equal(h.authCalls, 2)
})
test('missing or invalid required amounts are not successful zero balances', async () => {
  for (const value of [undefined, null, '', true, 'NaN', {}, 'Infinity']) {
    fetchWith(() => json({ ...validPrice, chargeFree: value }))
    const result = await host().request()
    assert.equal(result.body.ok, false)
    assert.equal(result.body.balance, undefined)
  }
})
test('missing optional fields remain unknown; historical calculation is labelled', async () => {
  fetchWith((url) => json(url === PRICE ? { chargeFree: 10, creditFree: 0 } : {}))
  const unknown = (await host().request()).body
  assert.equal(unknown.balance, 10)
  assert.equal(unknown.availableQuota, null)
  assert.equal(unknown.detail.couponFree, null)
  assert.equal(unknown.detail.frozen, null)
  fetchWith((url) => json(url === PRICE ? validPrice : { monetaryQuotaStatus: 0 }))
  const estimate = (await host().request()).body
  assert.equal(estimate.availableQuota, 11)
  assert.equal(estimate.quotaSource, 'legacy-estimate')
  assert.equal(typeof estimate.calculationNote, 'string')
})
test('missing active independent quota must not silently fall back', async () => {
  fetchWith((url) => json(url === PRICE ? validPrice : { monetaryQuotaStatus: 1 }))
  assert.equal((await host().request()).body.availableQuota, null)
})
test('no token defaults to credentials/env only, including string opt-in', async () => {
  for (const config of [{}, { browserTokenAccess: 'true' }, { tokenMode: 'auto' }]) {
    const result = await host({ credential: '', config }).request()
    assert.equal(result.body.ok, false)
    assert.equal(result.body.configured, false)
  }
  assert.equal(networkCalls.length, 0)
})
test('environment token works without browser collection', async () => {
  process.env[TOKEN_REF] = 'fake-env-token'
  fetchWith((url) => json(url === PRICE ? validPrice : {}))
  assert.equal((await host({ credential: '' }).request()).body.ok, true)
  assert.equal(networkCalls[0][1].headers.token, 'fake-env-token')
})
test('network and raw upstream errors are never exposed', async () => {
  fetchWith(() => { throw new Error('fake-test-token PRIVATE_PATH secret response') })
  const failure = (await host().request()).body
  assert.equal(failure.ok, false)
  assert.doesNotMatch(JSON.stringify(failure), /fake-test-token|PRIVATE_PATH|secret response/)
  fetchWith(() => new Response('raw private upstream', { status: 500 }))
  const upstream = (await host().request()).body
  assert.equal(upstream.ok, false)
  assert.doesNotMatch(JSON.stringify(upstream), /raw private upstream/)
})
test('invalid HTTP, JSON envelopes, content types and oversized bodies fail validation', async () => {
  for (const response of [
    json(validPrice, { status: 302 }),
    json(validPrice, { status: 403 }),
    new Response(JSON.stringify({ code: 500, data: validPrice }), { headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } }),
    new Response('bad json', { headers: { 'content-type': 'application/json' } }),
    json(validPrice, { headers: { 'content-type': 'text/html' } }),
    new Response('x'.repeat(128 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
  ]) {
    fetchWith(() => response)
    assert.equal((await host().request()).body.ok, false)
  }
})
test('timeout aborts the isolated request', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  fetchWith((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('private timeout')), { once: true })
  }))
  const pending = host().request()
  // Credential resolution and request creation are asynchronous; drain microtasks.
  await Promise.resolve()
  await Promise.resolve()
  mock.timers.tick(12000)
  assert.equal((await pending).body.ok, false)
  assert.equal(networkCalls[0][1].signal.aborted, true)
})
test('unsafe/debug/script/report routes do not exist; wrong method reads no credentials', async () => {
  const h = host()
  assert.equal(h.routes.size, 4)
  assert.deepEqual([...h.routes.keys()].sort(), ['/paratera-balance/api/balance', '/paratera-balance/api/login', '/paratera-balance/api/refresh', '/paratera-balance/api/status'])
  for (const route of ['probe', 'token-info', 'widget.js', 'report', 'report-log']) {
    assert.equal((await h.request(route)).status, 404)
  }
  assert.equal((await h.request('balance', 'POST')).status, 405)
  assert.equal(h.credentialReads, 0)
  assert.equal(networkCalls.length, 0)
})
