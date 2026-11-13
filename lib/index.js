import {
  EASYCOMPUTE_ORIGIN, findChrome, readSession, readState, refreshSession, fetchBalance, openLoginWindow,
  openCredentialDialog, credentialsSaved, credentialDialogOpen, credentialDialogResult, removeSavedCredentials,
  secondFactorStatus, chooseSecondFactor, submitSecondFactorCode, cancelSecondFactor,
} from './refresh.mjs'
import { ensureConsoleSession, readConsoleSession } from './console.mjs'
import { listKeys, renameKey, setKeyStatus, deleteKey, refreshSupportedModels } from './keys.mjs'
import { createImportController } from './create-session.mjs'
import { readModels, writeModels } from './models.mjs'
import os from 'node:os'
import { IMPORT_REVISION } from './import-status.mjs'
import { compatibility, hostVersion, pluginVersion } from './compat.mjs'
import { errorMessage } from './errors.mjs'
import { publicState, publicImportResponse, publicCreateSession, publicKeysResponse, publicRefreshResult, safeErrorCode } from './privacy.mjs'

const PLUGIN_VERSION = pluginVersion()
const pluginStartedAt = Date.now()

const BALANCE_STALE_MS = 10 * 60 * 1000
const AUTO_CHECK_MS = 5 * 60 * 1000
const CALCULATION_NOTE = '余额取自清华算力平台用户信息接口（couponFree），非账单口径。'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Per-device default key name; the user can still edit it before creating. */
function deviceKeyName() {
  const raw = String(os.hostname() || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (raw || 'DSH').slice(0, 200)
}

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

export function createPlugin({
  controllerFactory = createImportController, controllerDeps = {},
  keyDeps = {}, removeCredentials = removeSavedCredentials,
} = {}) {
  return {
  name: 'tsinghua-paratera',
  apply(root, config) {
    root.inject(['webServer', 'credentials', 'connection'], (ctx) => {
      const cfg = object(config) ? config : {}
      const ttlMs = Number.isFinite(cfg.cacheMs) ? Math.max(0, Math.min(cfg.cacheMs, 60000)) : 5000
      let cache = null
      let inflight = null
      let refreshing = null
      let settingsService = null
      let llmService = null
      let clientLastSeen = null
      const keys = { list: listKeys, rename: renameKey, setStatus: setKeyStatus, remove: deleteKey, refreshModels: refreshSupportedModels, ...keyDeps }
      const controller = controllerFactory({
        list: keys.list, remove: keys.remove, defaultName: deviceKeyName, ...controllerDeps,
        services: () => ({ credentials: ctx.credentials, settings: settingsService, llm: llmService }),
      })
      // Even an injected controller is projected again at the HTTP boundary.
      const flowResponse = (value) => {
        const next = { ok: value?.ok === true, session: publicCreateSession(value?.session) }
        if (value?.error) next.error = publicImportResponse(value).error
        if (value?.result) next.result = publicImportResponse(value.result)
        if (typeof value?.removed === 'boolean') next.removed = value.removed
        return next
      }
      ctx.inject?.(['llm'], (child) => {
        const service = child.llm
        llmService = service
        child.effect(() => () => { if (llmService === service) llmService = null })
      })
      // Optional child injection keeps balance/key-only operation available on
      // hosts without Settings, and observes late service replacement safely.
      ctx.inject?.(['settings'], (child) => {
        const service = child.settings
        settingsService = service
        child.effect(() => () => { if (settingsService === service) settingsService = null })
      })

      function autoRefresh(force) {
        if (refreshing) return refreshing
        refreshing = refreshSession({ force: Boolean(force) })
          .catch((error) => ({ ok: false, error: safeErrorCode(error?.message) }))
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
            // A background poll (the input-bar chip asks on every start) must never
            // spawn a browser just because there is no session yet: renewal belongs to
            // 「立即刷新」 or the 5-minute timer. This is what made every start drive CDP.
            if (!force && !readSession()) {
              return {
                ok: false, configured: false, reason: 'login-required',
                error: '尚未取得清华算力平台会话，请点「立即刷新」或在设置里保存凭据',
              }
            }
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
        const state = publicState(readState())
        return {
          source: 'easycompute',
          importRevision: IMPORT_REVISION,
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

      // Prefer the documented `admit()` fence. `requestRejection()` is a live
      // but undocumented wrapper; if a future host removes both, fail CLOSED
      // instead of silently serving unauthenticated routes.
      const authorize = (req) => {
        let rejection = 403
        try {
          const connection = ctx.connection || ctx.get?.('connection')
          if (typeof connection?.admit === 'function') {
            const admission = connection.admit(req)
            if (!admission || typeof admission !== 'object') rejection = 503
            else if ('rejection' in admission) rejection = admission.rejection
            else rejection = null
          } else if (typeof connection?.requestRejection === 'function') {
            rejection = connection.requestRejection(req)
          } else {
            rejection = 503
          }
        } catch { rejection = 503 }
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
          try { await handler(req, res) } catch { send(res, 500, { ok: false, error: '插件服务暂不可用' }) }
        },
      })

      const disposers = [
        // Diagnostics first: it must stay reachable when another service is
        // missing, because that is exactly when it is worth reading.
        route('/tsinghua-paratera/api/diagnostics', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          const version = hostVersion()
          send(res, 200, {
            ok: true,
            plugin: { version: PLUGIN_VERSION, startedAt: pluginStartedAt },
            host: {
              version, compatibility: compatibility(version),
              platform: process.platform, node: process.versions.node, electron: process.versions.electron ?? null,
            },
            services: {
              webServer: true,
              credentials: Boolean(ctx.credentials),
              connection: Boolean(ctx.connection),
              llm: Boolean(llmService),
              settings: Boolean(settingsService),
            },
            // Which host contract shape was actually found. After a DSH upgrade
            // this distinguishes "service missing" from "method renamed".
            contract: {
              authFence: typeof (ctx.connection || ctx.get?.('connection'))?.admit === 'function' ? 'admit'
                : typeof (ctx.connection || ctx.get?.('connection'))?.requestRejection === 'function' ? 'requestRejection' : 'missing',
              credentials: typeof ctx.credentials?.resolve === 'function' && typeof ctx.credentials?.set === 'function',
              settings: typeof settingsService?.describe === 'function' && typeof settingsService?.update === 'function',
              llmDirectory: typeof llmService?.listProviders === 'function' && typeof llmService?.listModels === 'function',
            },
            client: { lastSeenAt: clientLastSeen, ageMs: clientLastSeen === null ? null : Date.now() - clientLastSeen },
          })
        }),
        // The web client calls this once it mounts; a missing heartbeat is how
        // a silently failing client bundle becomes visible.
        route('/tsinghua-paratera/api/diagnostics/hello', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          clientLastSeen = Date.now()
          send(res, 200, { ok: true, plugin: { version: PLUGIN_VERSION }, host: { version: hostVersion() } })
        }),
        route('/tsinghua-paratera/api/balance', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          const force = new URL(req.url || '/', 'http://localhost').searchParams.get('force') === '1'
          send(res, 200, await balance(force))
        }),
        route('/tsinghua-paratera/api/keys', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          send(res, 200, publicKeysResponse(await keys.list()))
        }),
        route('/tsinghua-paratera/api/keys/defaults', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          // Default display name for a per-device key; the user may still edit it.
          send(res, 200, { ok: true, name: deviceKeyName() })
        }),
        route('/tsinghua-paratera/api/keys/create-import/status', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          send(res, 200, flowResponse(controller.status()))
        }),
        ...['prepare', 'commit', 'cancel'].map((action) => route('/tsinghua-paratera/api/keys/create-import/' + action, async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const body = await readJsonBody(req)
          if (!object(body)) return send(res, 400, { ok: false, session: publicCreateSession(controller.status()?.session), error: 'invalid-import-request' })
          send(res, 200, flowResponse(await controller[action](body)))
        })),
        // Removed one-shot creation: a model selection must precede any save.
        route('/tsinghua-paratera/api/keys/create-import', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          send(res, 410, { ok: false, error: 'key-import-deprecated' })
        }),
        route('/tsinghua-paratera/api/keys/update', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const body = await readJsonBody(req)
          if (!object(body)) return send(res, 400, { ok: false, error: '请求体无效' })
          if (Object.hasOwn(body, 'status') === Object.hasOwn(body, 'name')) return send(res, 400, { ok: false, error: 'invalid-arguments' })
          const result = await controller.mutate(() => Object.hasOwn(body, 'status') ? keys.setStatus(body.uuid, body.status) : keys.rename(body.uuid, body.name))
          send(res, 200, publicImportResponse(result))
        }),
        route('/tsinghua-paratera/api/keys/delete', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const body = await readJsonBody(req)
          if (!object(body)) return send(res, 400, { ok: false, error: '请求体无效' })
          send(res, 200, publicImportResponse(await controller.mutate(() => keys.remove(body.uuid))))
        }),
        route('/tsinghua-paratera/api/keys/import/status', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          send(res, 200, flowResponse(controller.status()))
        }),
        route('/tsinghua-paratera/api/keys/import', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          send(res, 410, { ok: false, error: 'key-import-deprecated' })
        }),
        route('/tsinghua-paratera/api/keys/refresh-models', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          send(res, 200, publicImportResponse(await controller.mutate(() => keys.refreshModels())))
        }),
        route('/tsinghua-paratera/api/models', async (req, res) => {
          if (req.method === 'GET') return send(res, 200, await readModels({ settings: settingsService }))
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 GET/POST' })
          const body = await readJsonBody(req, 256 * 1024)
          if (!object(body) || !Array.isArray(body.models)) return send(res, 400, { ok: false, error: 'invalid-models' })
          const result = await controller.mutate(() => writeModels(body.models, { settings: settingsService, revision: body.revision }))
          send(res, 200, result)
        }),
        route('/tsinghua-paratera/api/credentials/status', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          const saved = await credentialsSaved().catch(() => false)
          send(res, 200, { ok: true, saved, canRemove: process.platform === 'win32', dialog: credentialDialogOpen(), dialogResult: credentialDialogResult(), secondFactor: secondFactorStatus() })
        }),
        route('/tsinghua-paratera/api/2fa/status', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          send(res, 200, { ok: true, ...secondFactorStatus() })
        }),
        route('/tsinghua-paratera/api/2fa/choose', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const body = await readJsonBody(req)
          if (!object(body)) return send(res, 400, { ok: false, error: '请求体无效' })
          const result = await chooseSecondFactor(body.method)
          send(res, 200, { ok: Boolean(result.ok), stage: result.stage ?? null, ...(result.error ? { error: errorMessage(result.error) } : {}) })
        }),
        route('/tsinghua-paratera/api/2fa/code', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const body = await readJsonBody(req)
          if (!object(body)) return send(res, 400, { ok: false, error: '请求体无效' })
          if (body.trustDevice !== undefined && typeof body.trustDevice !== 'boolean') return send(res, 400, { ok: false, error: '请求体无效' })
          const result = await submitSecondFactorCode(body.code, { trustDevice: body.trustDevice === true })
          cache = null
          send(res, 200, {
            ok: Boolean(result.ok),
            trustedDevice: Boolean(result.trustedDevice),
            ...(result.error ? { error: errorMessage(result.error) } : {}),
            status: await status(),
          })
        }),
        route('/tsinghua-paratera/api/2fa/cancel', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          await cancelSecondFactor()
          send(res, 200, { ok: true })
        }),
        route('/tsinghua-paratera/api/console/status', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          const session = readConsoleSession()
          const connected = Boolean(session?.exp && session.exp > Date.now())
          send(res, 200, { ok: true, connected, expiresAt: session?.exp ?? null, origin: 'https://ai.paratera.com' })
        }),
        route('/tsinghua-paratera/api/console/connect', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const result = await ensureConsoleSession({ force: true })
          send(res, 200, { ok: Boolean(result.ok), ...(result.error ? { error: result.error } : {}), expiresAt: result.exp ?? null })
        }),
        route('/tsinghua-paratera/api/status', async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '仅支持 GET' })
          send(res, 200, { ok: true, ...(await status()) })
        }),
        route('/tsinghua-paratera/api/refresh', async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST' })
          const result = await autoRefresh(true)
          cache = null
          send(res, 200, { ok: Boolean(result?.ok), result: publicRefreshResult(result), ...(!result?.ok ? { error: errorMessage(result?.error) } : {}), status: await status() })
        }),
        route('/tsinghua-paratera/api/credentials', async (req, res) => {
          if (req.method === 'DELETE') {
            const body = await readJsonBody(req)
            if (!object(body) || body.confirm !== true) return send(res, 400, { ok: false, error: '需要确认删除已保存密码' })
            const result = await removeCredentials().catch(() => ({ ok: false, error: 'credential-remove-failed' }))
            cache = null
            return send(res, 200, { ok: result.ok === true, ...(result.error ? { error: errorMessage(result.error) } : {}), hint: '仅删除本机保存的登录密码，不会退出平台会话或撤销 API 密钥' })
          }
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '仅支持 POST/DELETE' })
          const result = await openCredentialDialog()
          cache = null
          send(res, 200, { ok: result.ok, ...(result.error ? { error: errorMessage(result.error) } : {}), hint: '保存后会自动用于下次登录' })
        }),
        route('/tsinghua-paratera/api/login', async (req, res) => {
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
        controller.dispose()
        for (const dispose of disposers) { try { dispose() } catch {} }
        cache = null
      })
    })
  },
  }
}

export default createPlugin()
