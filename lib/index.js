import {
  EASYCOMPUTE_ORIGIN, findChrome, readSession, readState, refreshSession, fetchBalance, openLoginWindow,
  openCredentialDialog,
} from './refresh.mjs'
import { ensureConsoleSession, readConsoleSession } from './console.mjs'
import { listKeys, createKey, renameKey, setKeyStatus, deleteKey, refreshSupportedModels } from './keys.mjs'
import { revealKeySecret } from './reveal.mjs'
import { appendModels, fingerprint, verifyKey } from './import.mjs'
import { errorMessage } from './errors.mjs'

const BALANCE_STALE_MS = 10 * 60 * 1000
const AUTO_CHECK_MS = 5 * 60 * 1000
const CALCULATION_NOTE = '余额取自清华算力平台用户信息接口（couponFree），非账单口径。'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { resolve(null); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

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

export default {
  name: 'paratera-balance',
  apply(root, config) {
    root.inject(['webServer', 'credentials', 'connection'], (ctx) => {
      const cfg = object(config) ? config : {}
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

      async function balance(force) {
        if (!force && cache && Date.now() - cache.at < ttlMs) return cache.value
        if (inflight) return inflight
        inflight = (async () => {
          let live = force
            ? { ok: false, error: 'session-expired' }
            : await fetchBalance().catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
          if (!live.ok) {
            const renewed = await autoRefresh(true)
            if (!renewed?.ok) {
              if (['chrome-profile-in-use', 'chrome-not-ready', 'chrome-not-found', 'refresh-busy'].includes(renewed?.error)) {
                return { ok: false, configured: false, reason: 'unavailable', error: errorMessage(renewed.error) }
              }
              return { ok: false, configured: false, reason: 'login-required', error: '清华算力平台会话已失效，请在设置 → 清华算力余额 中重新登录' }
            }
            live = await fetchBalance()
            if (!live.ok) return { ok: false, configured: false, reason: 'login-required', error: '登录后仍未取得余额，请稍后重试' }
          }
          const data = live.data
          const session = readSession()
          const couponFree = money(amount(data.couponFree))
          if (couponFree === null) return { ok: false, configured: true, reason: 'unavailable', error: '余额字段无效，请稍后重试' }
          return {
            ok: true, configured: true, currency: 'CNY', source: 'easycompute',
            balance: couponFree,
            availableQuota: couponFree,
            quotaStatus: null, quotaSource: 'easycompute-couponFree',
            detail: {
              couponTotal: money(amount(data.couponTotal)),
              couponUsed: money(amount(data.couponUsed)),
              gpuUsed: amount(data.gpuUsed),
              tokenUsed: amount(data.tokenUsed),
            },
            account: { department: data.department ?? null, clazz: data.clazz ?? null },
            calculationVerified: true,
            calculationNote: CALCULATION_NOTE,
            tokenExpiresAt: session?.exp ?? null,
            fetchedAt: Date.now(),
          }
        })()
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
          source: 'easycompute',
          configured: Boolean(session?.token),
          tokenExpiresAt: session?.exp ?? null,
          tokenValid: Boolean(session?.exp && session.exp > Date.now()),
          profileReady: Boolean(findChrome()),
          origin: EASYCOMPUTE_ORIGIN,
          snapshot: state.snapshot ?? null,
          lastRefreshAt: state.lastRefreshAt ?? null,
          lastError: state.lastError ?? null,
          lastErrorMessage: state.lastError ? errorMessage(state.lastError) : null,
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
        route('/paratera-balance/api/keys', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          send(res, 200, await listKeys())
        }),
        route('/paratera-balance/api/keys/create', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const body = await readJsonBody(req)
          if (!body) return send(res, 400, { ok: false, error: '请求体无效' })
          send(res, 200, await createKey(body.name))
        }),
        route('/paratera-balance/api/keys/update', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const body = await readJsonBody(req)
          if (!body) return send(res, 400, { ok: false, error: '请求体无效' })
          const result = body.status ? await setKeyStatus(body.uuid, body.status) : await renameKey(body.uuid, body.name)
          send(res, 200, result)
        }),
        route('/paratera-balance/api/keys/delete', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const body = await readJsonBody(req)
          if (!body) return send(res, 400, { ok: false, error: '请求体无效' })
          send(res, 200, await deleteKey(body.uuid))
        }),
        route('/paratera-balance/api/keys/import', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const body = await readJsonBody(req)
          if (!body?.name) return send(res, 400, { ok: false, error: '缺少密钥名称' })

          const listed = await listKeys()
          if (!listed.ok) return send(res, 200, { ok: false, error: listed.error })
          const target = listed.keys.find((key) => key.name === body.name)
          if (!target) return send(res, 200, { ok: false, error: 'key-not-found' })

          const revealed = await revealKeySecret(target.name)
          if (!revealed.ok) return send(res, 200, { ok: false, error: revealed.error })
          const verified = await verifyKey(revealed.secret)
          if (!verified.ok) return send(res, 200, { ok: false, error: verified.error })

          const result = { ok: true, name: target.name, fingerprint: fingerprint(revealed.secret), verifiedModels: verified.models }
          if (body.dryRun) return send(res, 200, result)

          let previous = null
          try { const current = await ctx.credentials.resolve('PARATERA_API_KEY'); previous = current?.value ?? null } catch {}
          try {
            await ctx.credentials.set('PARATERA_API_KEY', revealed.secret)
          } catch (error) {
            return send(res, 200, { ...result, ok: false, error: 'credential-write-failed' })
          }
          if (previous && previous !== revealed.secret) {
            try { await ctx.credentials.set('PARATERA_API_KEY_BACKUP', previous) } catch {}
          }

          const models = Array.isArray(body.models) ? body.models : []
          if (models.length) {
            const applied = appendModels(models)
            result.modelsAdded = applied.ok ? applied.added : []
            if (!applied.ok) result.modelError = applied.error
            else result.backup = applied.backup
            result.needsRestart = result.modelsAdded.length > 0
          }
          send(res, 200, result)
        }),
        route('/paratera-balance/api/keys/refresh-models', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          send(res, 200, await refreshSupportedModels())
        }),
        route('/paratera-balance/api/console/status', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          const session = readConsoleSession()
          const connected = Boolean(session?.exp && session.exp > Date.now())
          send(res, 200, { ok: true, connected, expiresAt: session?.exp ?? null, origin: 'https://ai.paratera.com' })
        }),
        route('/paratera-balance/api/console/connect', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const result = await ensureConsoleSession({ force: true })
          send(res, 200, { ok: Boolean(result.ok), ...(result.error ? { error: result.error } : {}), expiresAt: result.exp ?? null })
        }),
        route('/paratera-balance/api/status', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          send(res, 200, { ok: true, ...(await status()) })
        }),
        route('/paratera-balance/api/refresh', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const result = await autoRefresh(true)
          cache = null
          send(res, 200, { ok: Boolean(result?.ok), result, ...(!result?.ok ? { error: errorMessage(result?.error) } : {}), status: await status() })
        }),
        route('/paratera-balance/api/credentials', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const result = await openCredentialDialog()
          cache = null
          send(res, 200, { ok: result.ok, ...(result.error ? { error: errorMessage(result.error) } : {}), hint: '保存后会自动用于下次登录' })
        }),
        route('/paratera-balance/api/login', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const result = await openLoginWindow()
          if (result.ok) cache = null
          send(res, 200, { ok: result.ok, ...(result.error ? { error: errorMessage(result.error) } : {}), hint: '登录完成后返回 DSH，点击「立即刷新」；专用窗口可保持打开' })
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
