import { test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import plugin from '../lib/index.js'
import { SESSION_FILE, STATE_FILE } from '../lib/refresh.mjs'

const ORIGIN = 'https://easycompute.cs.tsinghua.edu.cn'
const session = { token: 'fake-session-token', exp: Date.now() + 6 * 3600 * 1000, capturedAt: Date.now() }
const validUser = { code: 200, data: { couponFree: 976.9321, couponUsed: 2123.0679, couponTotal: 2000, gpuUsed: 0.14, tokenUsed: 145344533, department: '物理系', clazz: 'X0011' } }

let calls
let rejection

function host(config = {}) {
  const routes = new Map()
  const ctx = {
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
    credentials: { async resolve() { throw new Error('ISOLATION: credentials must not be read') } },
    connection: { requestRejection() { return rejection } },
    effect(fn) { fn() },
  }
  plugin.apply({ inject(names, callback) { assert.deepEqual(names, ['webServer', 'credentials', 'connection']); callback(ctx) } }, config)
  return {
    routes,
    async request(path, method = 'GET') {
      const handler = routes.get('/paratera-balance/api/' + path)
      if (!handler) return { status: 404 }
      let status = 0
      let headers = {}
      let body = ''
      const res = { writeHead(code, h) { status = code; headers = h }, end(text) { body = text } }
      await handler({ method, url: '/paratera-balance/api/' + path }, res)
      return { status, headers, body: body ? JSON.parse(body) : null }
    },
  }
}

beforeEach(() => {
  calls = []
  rejection = null
  mock.method(fs, 'readFileSync', (file) => {
    if (file === SESSION_FILE) return JSON.stringify(session)
    if (file === STATE_FILE) return JSON.stringify({ snapshot: { couponFree: 976.93 }, lastRefreshAt: Date.now() })
    throw new Error('unexpected read: ' + file)
  })
  mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return new Response(JSON.stringify(validUser), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})

afterEach(() => {
  mock.restoreAll()
})

test('balance reads only the official easycompute endpoint and reports coupon amounts', async () => {
  const h = host()
  const result = await h.request('balance')
  assert.equal(result.status, 200)
  assert.equal(result.headers['Cache-Control'], 'no-store')
  assert.equal(result.body.ok, true)
  assert.equal(result.body.source, 'easycompute')
  assert.equal(result.body.availableQuota, 976.93)
  assert.equal(result.body.detail.couponUsed, 2123.07)
  assert.equal(result.body.account.department, '物理系')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, ORIGIN + '/auth/userInfo/query')
  assert.equal(calls[0].options.headers.token, 'fake-session-token')
  assert.ok(calls[0].options.signal instanceof AbortSignal)
})

test('unauthorized request neither fetches nor returns data', async () => {
  rejection = 401
  const h = host()
  const result = await h.request('balance')
  assert.equal(result.status, 401)
  assert.equal(result.body.ok, false)
  assert.equal(calls.length, 0)
})

test('wrong methods are rejected without fetching', async () => {
  const h = host()
  assert.equal((await h.request('balance', 'POST')).status, 405)
  assert.equal((await h.request('status', 'POST')).status, 405)
  assert.equal((await h.request('refresh', 'GET')).status, 405)
  assert.equal(calls.length, 0)
})

test('status exposes the session lifetime and last snapshot', async () => {
  const h = host()
  const result = await h.request('status')
  assert.equal(result.status, 200)
  assert.equal(result.body.source, 'easycompute')
  assert.equal(result.body.configured, true)
  assert.equal(result.body.tokenValid, true)
  assert.equal(result.body.tokenExpiresAt, session.exp)
  assert.equal(result.body.snapshot.couponFree, 976.93)
})

test('an invalid payload never fabricates a zero balance', async () => {
  mock.restoreAll()
  mock.method(fs, 'readFileSync', (file) => {
    if (file === SESSION_FILE) return JSON.stringify(session)
    if (file === STATE_FILE) return '{}'
    throw new Error('unexpected read')
  })
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 200, data: { couponUsed: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const h = host()
  const result = await h.request('balance')
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, false)
  assert.notEqual(result.body.balance, 0)
})

test('only the documented routes exist', async () => {
  const h = host()
  assert.deepEqual([...h.routes.keys()].sort(), [
    '/paratera-balance/api/balance',
    '/paratera-balance/api/credentials',
    '/paratera-balance/api/login',
    '/paratera-balance/api/refresh',
    '/paratera-balance/api/status',
  ])
  for (const legacy of ['probe', 'token-info', 'widget.js', 'report', 'report-log']) {
    assert.equal((await h.request(legacy)).status, 404)
  }
})
