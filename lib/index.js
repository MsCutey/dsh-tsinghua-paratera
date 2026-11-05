import process from 'node:process'
import {
  EASYCOMPUTE_ORIGIN, PARATERA_ORIGIN, findChrome,
  readSession, readState, refreshSession, fetchBalance, openLoginWindow,
} from './refresh.mjs'

const PRICE_URL = 'https://ai.paratera.com/platform/paraUser/getPrice'
const QUOTA_URL = 'https://ai.paratera.com/platform/resourceUserConfig/getList'
const TIMEOUT_MS = 12000
const MAX_RESPONSE_BYTES = 128 * 1024
const CALCULATION_NOTE = '余额沿用 chargeFree + creditFree；无独立配额时沿用余额减冻结金额的历史估算，尚未核验官方会计含义；缺失字段不按零计算。'
const BALANCE_STALE_MS = 10 * 60 * 1000
const AUTO_CHECK_MS = 5 * 60 * 1000

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
function amount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null
  const n = Number(value)
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER / 100 ? n : null
}
function money(value) {
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER / 100
    ? Math.round(value * 100) / 100 : null
}

async function requestJson(url, token, post = false) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: post ? 'POST' : 'GET',
      headers: { accept: 'application/json', token, ...(post ? { 'Content-Type': 'application/json' } : {}) },
      body: post ? '{}' : undefined,
      redirect: 'error',
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) throw new Error('TOKEN_REJECTED')
    if (response.status !== 200 || response.redirected) throw new Error('INVALID_RESPONSE')
    if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('INVALID_RESPONSE')
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('INVALID_RESPONSE')
    const text = await response.text()
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('INVALID_RESPONSE')
    const json = JSON.parse(text)
    if (!object(json) || json.success === false
      || (json.code !== undefined && ![0, 200, '0', '200'].includes(json.code))) throw new Error('INVALID_RESPONSE')
    return json.data
  } finally {
    clearTimeout(timer)
  }
}

/** Legacy Paratera console calculation, kept for the optional console source. */
function readParateraBalance(data) {
  const chargeFree = amount(data.chargeFree)
  const creditFree = amount(data.creditFree)
  if (chargeFree === null || creditFree === null) throw new Error('INVALID_RESPONSE')
  const total = money(chargeFree + creditFree)
  if (total === null) throw new Error('INVALID_RESPONSE')
  const parts = [data.aiFrozenPrice, data.userServerFrozenPrice, data.totalLockAmount].map(amount)
  const frozen = parts.every((value) => value !== null) ? money(parts.reduce((a, b) => a + b, 0)) : null
  const optional = (value) => { const n = amount(value); return n === null ? null : money(n) }
  return {
    balance: total,
    available: frozen === null ? null : money(Math.max(0, total - frozen)),
    detail: { chargeFree: money(chargeFree), creditFree: money(creditFree), couponFree: optional(data.couponFree), chargeUsed: optional(data.chargeUsed), frozen },
  }
}

export default {
  name: 'paratera-balance',
  apply(root, config) {
    root.inject(['webServer', 'credentials', 'connection'], (ctx) => {
      const cfg = object(config) ? config : {}
      const source = cfg.source === 'paratera' ? 'paratera' : 'easycompute'
      const ttlMs = Number.isFinite(cfg.cacheMs) ? Math.max(0, Math.min(cfg.cacheMs, 60000)) : 5000
      let cache = null
      let inflight = null
      let refreshing = null

      function autoRefresh(force) {
        if (refreshing) return refreshing
        refreshing = refreshSession({ force: Boolean(force) })
          .catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
          .finally(() => { refreshing = null })
        return refreshing
      }

      async function easycomputeBalance(force) {
        let live = force ? { ok: false, error: 'session-expired' } : await fetchBalance().catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
        if (!live.ok) {
          const renewed = await autoRefresh(true)
          if (!renewed?.ok) {
            return { ok: false, reason: 'login-required', error: '清华算力平台会话已失效，请在设置 → 并行智算云 中重新登录' }
          }
          live = await fetchBalance()
          if (!live.ok) return { ok: false, reason: 'login-required', error: '登录后仍未取得余额，请稍后重试' }
        }
        const data = live.data
        const session = readSession()
        return {
          ok: true, configured: true, currency: 'CNY', source: 'easycompute',
          balance: money(data.couponFree),
          availableQuota: money(data.couponFree),
          quotaStatus: null, quotaSource: 'easycompute-couponFree',
          detail: {
            couponTotal: money(data.couponTotal),
            couponUsed: money(data.couponUsed),
            gpuUsed: amount(data.gpuUsed),
            tokenUsed: amount(data.tokenUsed),
          },
          account: { department: data.department ?? null, clazz: data.clazz ?? null, uuid: data.uuid ?? null },
          calculationVerified: true,
          calculationNote: '余额取自清华算力平台用户信息接口（couponFree），非账单口径。',
          tokenExpiresAt: session?.exp ?? null,
          fetchedAt: Date.now(),
        }
      }

      async function parateraBalance() {
        const credentialRef = typeof cfg.tokenRef === 'string' && cfg.tokenRef.trim() ? cfg.tokenRef.trim() : 'PARATERA_CONSOLE_TOKEN'
        let token = ''
        try {
          const credential = await ctx.credentials?.resolve(credentialRef)
          if (typeof credential?.value === 'string') token = credential.value.trim()
        } catch {}
        if (!token) token = process.env[credentialRef]?.trim() ?? ''
        if (!token) return { ok: false, configured: false, reason: 'login-required', error: '未配置控制台 token' }
        try {
          const read = readParateraBalance(await requestJson(PRICE_URL, token))
          let quotaStatus = null
          let availableQuota = read.available
          let quotaSource = availableQuota === null ? 'unknown' : 'legacy-estimate'
          try {
            const quota = await requestJson(QUOTA_URL, token, true)
            const status = amount(quota.monetaryQuotaStatus)
            if (status === 0 || status === 1) quotaStatus = status
            if (quotaStatus === 1) {
              const unused = amount(quota.unUsedMonetaryQuota)
              availableQuota = unused === null ? null : money(unused)
              quotaSource = availableQuota === null ? 'unknown' : 'unUsedMonetaryQuota'
            }
          } catch { /* Optional quota failure never fabricates zero or leaks an upstream error. */ }
          return { ok: true, configured: true, currency: 'CNY', source: 'paratera', balance: read.balance,
            availableQuota, quotaStatus, quotaSource, detail: read.detail,
            calculationVerified: false, calculationNote: CALCULATION_NOTE, fetchedAt: Date.now() }
        } catch (error) {
          return { ok: false, configured: true, reason: error?.message === 'TOKEN_REJECTED' ? 'token-expired' : 'unavailable',
            error: '余额请求失败：登录态失效、网络异常或响应不符合预期' }
        }
      }

      async function balance(force) {
        if (!force && cache && Date.now() - cache.at < ttlMs) return cache.value
        if (inflight) return inflight
        inflight = (async () => source === 'paratera' ? parateraBalance() : easycomputeBalance(force))()
        try {
          const value = await inflight
          cache = { at: Date.now(), value }
          return value
        } finally { inflight = null }
      }

      async function status() {
        const session = readSession()
        const state = readState()
        return {
          source,
          configured: Boolean(session?.token),
          tokenExpiresAt: session?.exp ?? null,
          tokenValid: Boolean(session?.exp && session.exp > Date.now()),
          profileReady: Boolean(findChrome()),
          origin: source === 'paratera' ? PARATERA_ORIGIN : EASYCOMPUTE_ORIGIN,
          snapshot: state.snapshot ?? null,
          lastRefreshAt: state.lastRefreshAt ?? null,
          lastError: state.lastError ?? null,
          lastErrorAt: state.lastErrorAt ?? null,
        }
      }

      const authorize = (req) => {
        let rejection = 403
        try {
          const connection = ctx.connection || ctx.get?.('connection')
          if (typeof connection?.requestRejection === 'function') rejection = connection.requestRejection(req)
        } catch {}
        if (rejection === null || rejection === undefined || rejection === false) return null
        return Number.isInteger(rejection) && rejection >= 400 && rejection <= 599 ? rejection : 403
      }

      const send = (res, statusCode, body) => {
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        res.end(JSON.stringify(body))
      }

      const route = (path, handler) => ctx.webServer.register({
        kind: 'exact', path,
        handler: async (req, res) => {
          const rejection = authorize(req)
          if (rejection !== null) return send(res, rejection, { ok: false, error: '请求未获授权' })
          try { await handler(req, res) } catch { send(res, 500, { ok: false, error: '余额服务暂不可用' }) }
        },
      })

      const disposers = [
        route('/paratera-balance/api/balance', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          const force = new URL(req.url || '/', 'http://localhost').searchParams.get('force') === '1'
          send(res, 200, await balance(force))
        }),
        route('/paratera-balance/api/status', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          send(res, 200, { ok: true, ...(await status()) })
        }),
        route('/paratera-balance/api/refresh', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const result = await autoRefresh(true)
          cache = null
          send(res, 200, { ok: Boolean(result?.ok), result, status: await status() })
        }),
        route('/paratera-balance/api/login', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const result = openLoginWindow()
          if (result.ok) cache = null
          send(res, 200, { ok: result.ok, ...(result.error ? { error: result.error } : {}), hint: '登录完成后余额会自动恢复' })
        }),
      ]

      const timer = setInterval(() => {
        const session = readSession()
        if (!session?.exp || session.exp - Date.now() < 60 * 60 * 1000) autoRefresh(false).catch(() => {})
        else if (!readState().snapshot || Date.now() - (readState().lastRefreshAt ?? 0) > BALANCE_STALE_MS) {
          fetchBalance().catch(() => {})
        }
      }, AUTO_CHECK_MS)
      if (typeof timer.unref === 'function') timer.unref()

      ctx.effect(() => () => {
        clearInterval(timer)
        for (const dispose of disposers) { try { dispose() } catch {} }
        cache = null
      })
    })
  },
}
