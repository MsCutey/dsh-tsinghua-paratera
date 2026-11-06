/** Native composer quota slot, matching dsh-codex-subscription's ComposerRight. */
window.__ModuleLoader__.load({
  id: 'dsh-paratera-balance',
  factory(require) {
    const imported = require('react')
    const React = imported.createElement ? imported : imported.default
    const h = React.createElement
    const REFRESH_MS = 60000
    const STATUS_MS = 15000
    // Levels a hand-declared paratera model may offer; "off" is implicit (no
    // parameter sent) and always available when the model reasons at all.
    const THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

    function presentation(data) {
      if (!data) return { text: '余额…', title: '正在读取清华算力余额' }
      if (!data.ok) {
        const needsLogin = data.reason === 'login-required' || data.reason === 'token-expired'
        return {
          text: needsLogin ? '需登录' : '余额?',
          title: (data.error || '暂时无法读取余额') + (needsLogin ? '\n在设置 → 清华算力余额 中登录或刷新' : ''),
        }
      }
      const quota = typeof data.availableQuota === 'number' && Number.isFinite(data.availableQuota)
      const value = quota ? data.availableQuota : data.balance
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { text: '余额?', title: '控制台未返回有效金额' }
      }
      const lines = ['清华算力平台（当前 DSH 宿主配置的账户）', `算力券余额 ¥${value.toFixed(2)}`]
      const detail = data.detail || {}
      if (typeof detail.couponUsed === 'number') lines.push(`已用 ¥${detail.couponUsed.toFixed(2)}${typeof detail.couponTotal === 'number' ? ` / 总额 ¥${detail.couponTotal.toFixed(2)}` : ''}`)
      if (data.account?.department) lines.push(`${data.account.department}${data.account.clazz ? ' · ' + data.account.clazz : ''}`)
      if (data.calculationNote) lines.push(data.calculationNote)
      if (data.tokenExpiresAt) lines.push(`会话有效期至 ${new Date(data.tokenExpiresAt).toLocaleString()}`)
      if (data.fetchedAt) lines.push(`更新于 ${new Date(data.fetchedAt).toLocaleTimeString()}`)
      lines.push('每 60 秒查询；平台结算可能延迟。')
      return { text: `¥${value.toFixed(2)}`, title: lines.join('\n') }
    }

    function Balance({ directory }) {
      const snapshot = React.useSyncExternalStore(
        (listener) => directory.subscribe(listener),
        () => directory.getSnapshot(),
      )
      const current = snapshot.current
      const enabled = current?.provider === 'paratera'
      const model = current?.model
      const [data, setData] = React.useState(null)
      React.useEffect(() => {
        if (!enabled) { setData(null); return }
        let disposed = false
        let busy = false
        let controller
        setData(null)
        async function refresh() {
          if (disposed || busy || document.visibilityState === 'hidden') return
          busy = true
          controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 15000)
          try {
            const response = await fetch('/paratera-balance/api/balance', {
              credentials: 'same-origin', headers: { accept: 'application/json' }, signal: controller.signal,
            })
            if (!response.ok) throw new Error(response.status === 401 || response.status === 403
              ? 'DSH 身份验证失败，请重新打开已登录的页面' : '余额服务暂时不可用')
            const next = await response.json()
            if (!disposed) setData(next)
          } catch (error) {
            if (!disposed) setData({ ok: false, error: error.name === 'AbortError' ? '查询超时，请稍后重试' : error.message })
          } finally { clearTimeout(timeout); busy = false }
        }
        refresh()
        const timer = setInterval(refresh, REFRESH_MS)
        document.addEventListener('visibilitychange', refresh)
        return () => {
          disposed = true
          controller?.abort()
          clearInterval(timer)
          document.removeEventListener('visibilitychange', refresh)
        }
      }, [enabled, model])
      if (!enabled) return null
      const view = presentation(data)
      return h('span', {
        className: 'paratera-balance', role: 'status', title: view.title,
        'aria-label': `清华算力 ${view.text}`, tabIndex: 0,
        style: { display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
          fontSize: '12px', fontWeight: 600, fontVariantNumeric: 'tabular-nums',
          color: 'inherit', opacity: 0.8 },
      }, view.text)
    }

    const card = {
      border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))',
      borderRadius: '12px',
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      maxWidth: '640px',
    }
    const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }
    const muted = { fontSize: '12px', opacity: 0.7, lineHeight: '18px' }
    const button = {
      minHeight: '30px', padding: '0 12px', borderRadius: '8px', cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))',
      background: 'transparent', color: 'inherit', fontSize: '13px',
    }
    const codeInputStyle = {
      minHeight: '30px', padding: '0 8px', width: '150px', borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))',
      background: 'transparent', color: 'inherit', fontSize: '13px',
    }
    const twoFactorBox = {
      display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px',
      borderRadius: '8px', border: '1px solid rgba(181,71,8,.35)', background: 'rgba(181,71,8,.06)',
    }

    function friendlyError(error) {
      const code = String(error?.message || error || 'unknown-error')
      const messages = {
        'key-quota-exceeded': '密钥配额已满，请先在控制台删除旧密钥或申请提额',
        'key-not-found': '未找到该密钥，请重新加载密钥列表',
        'key-name-ambiguous': '存在同名密钥，请重新加载列表后选择对应密钥',
        'console-not-connected': '控制台尚未连接，请先点击「连接控制台」',
        'console-session-missing': '控制台尚未连接，请先点击「连接控制台」',
        'easycompute-login-required': '请先登录清华算力平台，再连接控制台',
        'console-auth-failed': '控制台认证失败，请重新登录后再连接控制台',
        'second-factor-pending': '请先在上方完成二次认证，再重试操作',
        'refresh-busy': '正在登录或刷新会话，请稍候再试',
        'console-invalid-response': '控制台返回了无效数据，请稍后重试',
        'console-api-error': '控制台未能完成操作，请检查控制台状态后重试',
        'console-timeout': '控制台请求超时，请稍后重试',
        'console-network-error': '无法连接控制台，请检查网络后重试',
        'console-session-expired': '控制台会话已过期，请重新连接控制台',
        'session-expired': '会话已过期，请重新登录并连接控制台',
        'login-required': '请先登录并连接控制台',
        'credential-read-failed': '无法读取现有 DSH 凭据，密钥尚未导入，请检查宿主状态后重试',
        'credential-backup-failed': '旧密钥备份失败，未覆盖现有密钥，请检查宿主状态后重试',
        'credential-write-failed': '密钥未能写入 DSH 凭据，请检查宿主状态后重试',
        'model-not-available': '所选模型当前不可用，请更新支持模型并重新加载密钥列表',
        'settings-unavailable': '宿主模型设置服务暂不可用，请稍后重试',
        'provider-config-unavailable': '无法读取 Paratera 模型配置，请检查宿主设置后重试',
        'provider-config-invalid': '现有 Paratera 模型配置格式不受支持，请检查宿主设置后重试',
        'model-config-write-failed': '模型配置保存失败，请检查宿主设置后重试',
        'model-config-read-failed': '模型配置读取失败，请检查宿主设置后重试',
        'invalid-model-settings': '模型设置无效：名称不能为空，上下文窗口需在 1–4,000,000，最大输出需在 1–1,000,000',
        'credentials-unavailable': '宿主凭据服务不可用，密钥尚未导入，请稍后重试',
        'invalid-key': '平台返回的密钥格式无效，请重新加载或新建密钥',
        'key-list-failed': '读取密钥列表失败，请重新连接控制台后重试',
        'key-import-failed': '密钥导入未完成，请检查宿主与控制台状态后重试',
        'invalid-import-request': '导入请求无效，请重新加载密钥列表后选择',
        'row-not-found': '控制台未找到该密钥，请更新密钥列表后重试',
        'ambiguous-key-name': '控制台中存在同名密钥，无法安全读取，请先重命名后重试',
        'secret-not-revealed': '控制台未能显示完整密钥，请确认密钥状态后重试',
        'key-reveal-failed': '无法读取完整密钥，请重新连接控制台后重试',
        'no-eye': '未找到密钥显示按钮，请检查控制台页面是否已更新',
        'keys-table-not-ready': '控制台密钥列表尚未加载完成，请稍后重试',
        'keys-invalid-response': '控制台返回了无效的密钥列表，请稍后重试',
        'keys-pagination-stalled': '控制台密钥列表翻页未成功，请稍后重试',
        'keys-pagination-limit': '密钥列表页数过多，未能找到该密钥，请在控制台确认后重试',
        'cdp-closed': '专用浏览器连接已断开，请重新连接控制台',
        'cdp-timeout': '专用浏览器操作超时，请重新连接控制台后重试',
        'untrusted-console-page': '专用浏览器当前页面不是受信任控制台，请重新连接控制台',
        'config-conflict': '模型配置已被其他操作更新，请重新加载后重试',
        'key-disabled': '该密钥已禁用，请先启用再导入',
        'key-import-busy': '已有密钥导入正在进行，请稍候再试',
        'invalid-models': '模型选择无效，请重新加载密钥列表后选择',
        'verify-invalid-response': '密钥验证服务未返回有效模型列表，请稍后重试',
        'config-not-found': '未找到 DSH 模型配置，请检查当前 profile 的配置',
        'models-block-not-found': '未找到可写入的模型配置区块，请检查 Paratera provider 配置',
        'provider-not-found': '未找到 Paratera provider，请先配置 provider',
        'verify-failed': '密钥验证失败，请检查网络后重试',
        'invalid-response': '服务返回了无效数据，请稍后重试',
        'request-timeout': '请求超时，请稍后重试',
        'import-timeout': '导入请求超时，操作结果未知；请勿重复导入，稍后检查宿主状态。中止请求不会撤销宿主端的写入。',
        'network-error': '网络连接失败，请检查网络后重试',
        'name-required': '请输入密钥名称，不能只包含空白',
        'invalid-arguments': '密钥信息无效，请重新加载列表后重试',
        'model-directory-unavailable': '密钥与模型配置已保存，但宿主模型列表暂不可用；请稍后检查「模型 → Paratera」或重启 DSH',
        'model-directory-missing-models': '密钥与模型配置已保存，但部分模型尚未出现在宿主列表；请稍后检查「模型 → Paratera」或重启 DSH',
        'provider-not-registered': '密钥与模型配置已保存，但 Paratera 尚未出现在宿主模型列表；请重启 DSH 后检查',
        'no-available-models': '密钥验证后没有可用模型，请检查平台授权；也可选择「仅保存密钥」',
        'model-selection-required': '可用模型超过 200 个，请更新支持模型、重新加载列表并明确选择最多 200 个模型',
      }
      if (messages[code]) return messages[code]
      if (/^(?:HTTP |verify-http-)(401|403)$/.test(code)) return '身份验证失败，请重新登录或连接控制台后重试'
      if (/^verify-http-/.test(code)) return '密钥验证服务暂不可用，请稍后重试'
      if (/^HTTP |^console-http-/.test(code)) return '服务暂时不可用，请稍后重试'
      if (/^[a-z][a-z0-9-]+$/.test(code)) return `操作失败（${code}），请检查连接后重试`
      return code
    }

    function modelIds(models) {
      if (!Array.isArray(models)) return []
      return [...new Set(models.map((model) => {
        if (typeof model === 'string') return model.trim()
        if (!model || typeof model !== 'object') return ''
        for (const key of ['modelId', 'id', 'model', 'modelName', 'name']) {
          if (typeof model[key] === 'string' && model[key].trim()) return model[key].trim()
        }
        return ''
      }).filter(Boolean))]
    }

    function importNotice(result) {
      if (result.credentialImported !== true && !result.ok) return `导入失败：${friendlyError(result.error)}`
      if (result.credentialImported === false) return `导入失败：${friendlyError(result.error || 'credential-write-failed')}`
      const details = ['密钥已导入 DSH']
      if (result.fingerprint) details.push(`指纹 ${result.fingerprint}`)
      if (typeof result.verifiedModels === 'number') details.push(`已验证 ${result.verifiedModels} 个可用模型`)
      if (result.modelError) details.push(result.modelConfigUpdated
        ? `模型配置已保存；模型列表确认未完成：${friendlyError(result.modelError)}`
        : `模型导入失败：${friendlyError(result.modelError)}（密钥已保存，可修复配置后重试导入模型）`)
      else if (Array.isArray(result.modelsAdded)) details.push(`新增 ${result.modelsAdded.length} 个模型`)
      else if (Number.isSafeInteger(result.modelsAddedCount) && result.modelsAddedCount >= 0) details.push(`新增 ${result.modelsAddedCount} 个模型`)
      if (Array.isArray(result.modelsSkipped) && result.modelsSkipped.length) details.push(`跳过 ${result.modelsSkipped.length} 个平台接口未列出的模型`)
      else if (Number.isSafeInteger(result.modelsSkippedCount) && result.modelsSkippedCount > 0) details.push(`跳过 ${result.modelsSkippedCount} 个平台接口未列出的模型`)
      if (result.modelsReplaced) details.push(`已按本次选择替换 Paratera 模型列表${Number.isSafeInteger(result.modelsRemoved) && result.modelsRemoved > 0 ? `，移除 ${result.modelsRemoved} 个` : ''}`)
      if (result.providerRegistered && result.modelsAvailable === true) details.push('已添加到模型列表：Paratera（在「模型 → Paratera」中查看）')
      else if (result.providerRegistered) details.push('Paratera 供应商已登记，模型可用性尚未确认')
      if (result.modelsAvailable === false && !result.modelError) details.push('所选模型尚未全部出现在宿主列表，请稍后检查或重启 DSH')
      if (!result.ok && !result.modelError) details.push(`部分操作失败：${friendlyError(result.error)}`)
      if (result.needsRestart) details.push('请完全退出并重启 DSH，使配置生效')
      return details.join('；')
    }

    const importStages = {
      listing: '正在查找密钥', revealing: '正在读取完整密钥', verifying: '正在验证可用模型',
      backup: '正在备份旧凭据', saving: '正在保存密钥', models: '正在写入模型配置',
      subscription: '正在确认模型列表可用', completed: '导入已结束', failed: '导入未完成',
    }

    function Section() {
      const lifecycle = React.useRef(null)
      React.useEffect(() => {
        const scope = { disposed: false, controllers: new Set(), timeouts: new Set(), waits: new Map(), keysBusy: false, busy: '', statusBusy: false, twoFactorBusy: false, importGeneration: 0, remoteImportBusy: false }
        lifecycle.current = scope
        return () => {
          scope.disposed = true
          for (const controller of scope.controllers) controller.abort()
          for (const timeout of scope.timeouts) clearTimeout(timeout)
          scope.timeouts.clear()
          for (const [timer, resolve] of scope.waits) { clearTimeout(timer); resolve(false) }
          scope.waits.clear()
        }
      }, [])
      const request = React.useCallback(async (path, method, body, scope = lifecycle.current) => {
        if (!scope || scope.disposed) throw new DOMException('Unmounted', 'AbortError')
        const controller = new AbortController()
        scope.controllers.add(controller)
        if (path === '/paratera-balance/api/keys/import/status') scope.importStatusController = controller
        let timedOut = false
        // Browser authentication/reveal has several independently bounded stages.
        const deadline = path === '/paratera-balance/api/keys/import' ? 300000
          : path === '/paratera-balance/api/console/connect' ? 240000 : 30000
        const timeout = setTimeout(() => { timedOut = true; controller.abort() }, deadline)
        scope.timeouts.add(timeout)
        if (path === '/paratera-balance/api/keys/import/status') scope.importStatusTimeout = timeout
        try {
          const response = await fetch(path, {
            method, credentials: 'same-origin', signal: controller.signal,
            headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
          const result = await response.json().catch(() => null)
          if (scope.disposed || controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
          if (!response.ok) {
            const error = new Error(result?.error || `HTTP ${response.status}`)
            error.result = result
            throw error
          }
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid-response')
          return result
        } catch (error) {
          if (timedOut) throw new Error(path === '/paratera-balance/api/keys/import' ? 'import-timeout' : 'request-timeout')
          if (error instanceof TypeError || error?.name === 'TypeError') throw new Error('network-error')
          throw error
        } finally {
          clearTimeout(timeout); scope.timeouts.delete(timeout); scope.controllers.delete(controller)
          if (scope.importStatusController === controller) { scope.importStatusController = null; scope.importStatusTimeout = null }
        }
      }, [])
      const wait = (scope, ms) => new Promise((resolve) => {
        if (scope.disposed) return resolve(false)
        const timer = setTimeout(() => { scope.waits.delete(timer); resolve(!scope.disposed) }, ms)
        scope.waits.set(timer, resolve)
      })
      const post = (path, body = {}, scope) => request(path, 'POST', body, scope)
      const [status, setStatus] = React.useState(null)
      const [consoleState, setConsoleState] = React.useState(null)
      const [keys, setKeys] = React.useState(null)
      const [keysBusy, setKeysBusy] = React.useState('')
      const [keysNotice, setKeysNotice] = React.useState(null)
      const [keyEditor, setKeyEditor] = React.useState(null)
      // The ref rejects stale form callbacks before React has rerendered.
      const editorRef = React.useRef(null)
      const updateEditor = (next) => { editorRef.current = next; setKeyEditor(next) }
      const [importMode, setImportMode] = React.useState('')
      const [importProgress, setImportProgress] = React.useState(null)
      const [importing, setImporting] = React.useState(null)
      const [importFilter, setImportFilter] = React.useState('')
      const [credSaved, setCredSaved] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [tab, setTab] = React.useState('account')
      const [notice, setNotice] = React.useState('')
      const [twoFactor, setTwoFactor] = React.useState(null)
      const [twoFactorCode, setTwoFactorCode] = React.useState('')
      const [twoFactorBusy, setTwoFactorBusy] = React.useState('')
      const load = React.useCallback(async () => {
        const scope = lifecycle.current
        if (!scope || scope.disposed || scope.statusBusy) return
        scope.statusBusy = true
        try {
          try { const value = await request('/paratera-balance/api/status', 'GET', undefined, scope); if (!scope.disposed) setStatus(value) }
          catch (error) { if (!scope.disposed) setNotice(friendlyError(error)) }
          if (scope.disposed) return
          try { const value = await request('/paratera-balance/api/console/status', 'GET', undefined, scope); if (!scope.disposed) setConsoleState(value) } catch {}
          if (scope.disposed) return
          try { const value = await request('/paratera-balance/api/credentials/status', 'GET', undefined, scope); if (!scope.disposed) setCredSaved(Boolean(value.saved)) } catch {}
          if (scope.disposed) return
          try { const value = await request('/paratera-balance/api/2fa/status', 'GET', undefined, scope); if (!scope.disposed) setTwoFactor(value) } catch {}
        } finally { scope.statusBusy = false }
      }, [request])
      const loadKeys = React.useCallback(async (scope = lifecycle.current) => {
        try {
          const result = await request('/paratera-balance/api/keys', 'GET', undefined, scope)
          if (typeof result.ok !== 'boolean' || (result.ok && (!Array.isArray(result.keys) || result.keys.some((key) => !key || typeof key !== 'object' || Array.isArray(key))))) throw new Error('invalid-response')
          const next = result.ok ? { ...result, keys: result.keys.map((key) => ({ ...key, models: modelIds(key.models) })) }
            : { ...result, error: friendlyError(result.error || 'key-list-failed') }
          if (!scope.disposed) setKeys(next)
          return next
        } catch (error) {
          if (!scope.disposed) setKeys({ ok: false, error: friendlyError(error) })
          throw error
        }
      }, [request])
      React.useEffect(() => {
        load()
        const timer = setInterval(load, STATUS_MS)
        return () => clearInterval(timer)
      }, [load])

      const stopImportTracking = (scope) => {
        scope.importGeneration += 1
        scope.importStatusController?.abort()
        if (scope.importStatusTimeout) {
          clearTimeout(scope.importStatusTimeout)
          scope.timeouts.delete(scope.importStatusTimeout)
        }
        if (scope.importWait) {
          clearTimeout(scope.importWait)
          scope.waits.get(scope.importWait)?.(false)
          scope.waits.delete(scope.importWait)
          scope.importWait = null
        }
      }
      const trackImport = React.useCallback(async (scope, generation, task = null, immediate = false) => {
        let operationId = task?.operationId || null
        let operationStartedAt = null
        let first = true
        while (!scope.disposed && generation === scope.importGeneration) {
          if ((task && !immediate) || !first) {
            const ready = await new Promise((resolve) => {
              const timer = setTimeout(() => { scope.waits.delete(timer); scope.importWait = null; resolve(true) }, 2000)
              scope.importWait = timer
              scope.waits.set(timer, resolve)
            })
            if (!ready || scope.disposed || generation !== scope.importGeneration) return
          }
          first = false
          if (task?.uncertain) setImportProgress((current) => current ? { ...current, checking: true } : current)
          try {
            const value = await request('/paratera-balance/api/keys/import/status', 'GET', undefined, scope)
            if (scope.disposed || generation !== scope.importGeneration) return
            if (task?.uncertain) setImportProgress((current) => current ? { ...current, checking: false } : current)
            if (typeof value.running !== 'boolean') {
              if (task || scope.remoteImportBusy) {
                setImportProgress((current) => current?.running ? { ...current, statusError: true } : current)
                continue
              }
              return // Older hosts may not expose progress.
            }
            if (task) {
              // Until the POST settles it owns the final result. After transport
              // failure only this operation may resolve the unknown outcome.
              if (typeof value.startedAt !== 'number' || value.startedAt < task.startedAt - 2000 || value.operationId === task.previousOperationId) {
                if (task.uncertain) setImportProgress((current) => current ? { ...current, statusError: true } : current)
                continue
              }
              if (operationId && value.operationId !== operationId) continue
              if (!value.running && (!task.uncertain || !value.result || typeof value.result.ok !== 'boolean')) continue
            } else if (operationId && value.operationId !== operationId && !(typeof value.startedAt === 'number' && value.startedAt > operationStartedAt)) continue
            operationId = value.operationId || operationId
            operationStartedAt = value.startedAt
            scope.lastImportOperationId = operationId
            if (task) task.operationId = operationId
            const wasRunning = scope.remoteImportBusy
            scope.remoteImportBusy = value.running
            setImportProgress({ ...value, uncertain: value.running && Boolean(task?.uncertain) })
            if (!value.running) {
              if (value.result && (wasRunning || !scope.keyNoticeTouched)) {
                scope.noticeRevision = (scope.noticeRevision || 0) + 1
                const failed = !value.result.ok || value.result.credentialImported === false || value.result.modelsAvailable === false || Boolean(value.result.modelError)
                setKeysNotice({ text: importNotice(value.result), error: failed })
                if (task && !failed) { setImporting(null); setImportFilter('') }
              }
              if (task && scope.importTask === task) scope.importTask = null
              return
            }
          } catch {
            if (scope.disposed || generation !== scope.importGeneration) return
            // Progress is advisory; do not turn a polling failure into a failed POST.
            if (!task && !scope.remoteImportBusy) return
            setImportProgress((current) => current?.running ? { ...current, statusError: true } : current)
          }
        }
      }, [request])
      React.useEffect(() => {
        const scope = lifecycle.current
        trackImport(scope, scope.importGeneration)
        return () => stopImportTracking(scope)
      }, [trackImport])

      const endpoints = {
        refresh: '/paratera-balance/api/refresh',
        login: '/paratera-balance/api/login',
        credentials: '/paratera-balance/api/credentials',
        console: '/paratera-balance/api/console/connect',
      }
      const run = async (kind) => {
        const scope = lifecycle.current
        if (!scope || scope.disposed || scope.busy || (kind === 'console' && (scope.keysBusy || scope.remoteImportBusy))) return
        scope.busy = kind
        setBusy(kind)
        setNotice('')
        try {
          const result = await request(endpoints[kind], 'POST', undefined, scope)
          if (scope.disposed) return
          if (!result.ok) setNotice(friendlyError(result.error || result.result?.error || '操作失败'))
          else if (kind === 'login') setNotice(result.hint || '已打开登录窗口')
          else if (kind === 'credentials') {
            setNotice('已打开凭据窗口，保存后会自动尝试登录…')
            let settled = false
            for (let i = 0; i < 180; i += 1) {
              if (!await wait(scope, 1000)) return
              const c = await request('/paratera-balance/api/credentials/status', 'GET', undefined, scope).catch(() => null)
              if (scope.disposed) return
              if (c?.saved) {
                setCredSaved(true)
                const login = await request('/paratera-balance/api/refresh', 'POST', undefined, scope).catch(() => null)
                if (scope.disposed) return
                setNotice(login?.ok ? '凭据已保存，登录成功' : (login?.error || '凭据已保存，但登录未成功，可点「重新登录」'))
                settled = true
                break
              }
              if (c && c.dialog === false) {
                setNotice('凭据窗口已关闭，未保存')
                settled = true
                break
              }
            }
            if (!settled) setNotice('等待凭据窗口超时，可再次点击「保存凭据」')
          }
          else if (kind === 'console') setNotice('控制台会话已就绪')
          else setNotice('已刷新')
          if (!scope.disposed) await load()
        } catch (error) {
          if (!scope.disposed) setNotice(friendlyError(error))
        } finally { scope.busy = ''; if (!scope.disposed) setBusy('') }
      }

      const keyAction = async (label, operation, options = {}) => {
        const scope = lifecycle.current
        if (!scope || scope.disposed || scope.keysBusy || scope.busy === 'console' || (scope.remoteImportBusy && label !== 'load')) return
        if (options.editor && editorRef.current !== options.editor) return
        scope.keysBusy = true
        scope.keyNoticeTouched = true
        setKeysBusy(label)
        setKeysNotice(null)
        if (label === 'import') {
          stopImportTracking(scope)
          setImportMode(options.withModels ? 'models' : 'keyonly')
          setImportProgress({ running: true, stage: 'listing' })
          trackImport(scope, scope.importGeneration, { startedAt: Date.now() })
        }
        try {
          const result = label === 'load' ? await loadKeys(scope) : await operation(scope)
          if (scope.disposed) return
          if (typeof result.ok !== 'boolean') throw new Error('invalid-response')
          let failed = !result.ok || (label === 'import' && (result.credentialImported === false || result.modelsAvailable === false || Boolean(result.modelError)))
          let message = label === 'import' ? importNotice(result)
            : result.ok ? (label === 'load' ? '密钥列表已加载' : '操作完成') : friendlyError(result.error || '操作失败')
          if (options.editor) {
            if (result.ok) updateEditor(null)
            else updateEditor({ ...options.editor, error: message })
          }
          if (label === 'import') {
            stopImportTracking(scope)
            scope.remoteImportBusy = false
            setImportProgress(null)
            if (!failed) { setImporting(null); setImportFilter('') }
          }
          // A load is already the list request; mutations refresh the list once only.
          if (label !== 'load') {
            try {
              const refreshed = await loadKeys(scope)
              if (!refreshed.ok) { failed = true; message += `；密钥列表刷新失败：${friendlyError(refreshed.error)}` }
            } catch (error) { failed = true; message += `；密钥列表刷新失败：${friendlyError(error)}` }
          }
          if (!scope.disposed) setKeysNotice({ text: message, error: failed })
        } catch (error) {
          if (!scope.disposed) {
            const message = label === 'import' && error.result?.credentialImported
              ? importNotice(error.result) : `${label === 'import' && error.message !== 'import-timeout' ? '导入失败：' : ''}${friendlyError(error)}`
            setKeysNotice({ text: message, error: true })
            if (options.editor) updateEditor({ ...options.editor, error: message })
          }
        } finally {
          scope.keysBusy = false
          if (label === 'import') {
            stopImportTracking(scope)
            scope.remoteImportBusy = false
            if (!scope.disposed) { setImportProgress(null); setImportMode('') }
          }
          if (!scope.disposed) setKeysBusy('')
        }
      }
      const canEditKeys = () => {
        const scope = lifecycle.current
        return scope && !scope.disposed && !scope.keysBusy && !scope.remoteImportBusy && scope.busy !== 'console'
      }
      const openEditor = (kind, key) => {
        if (!canEditKeys()) return
        setImporting(null)
        setImportFilter('')
        setKeysNotice(null)
        updateEditor({ kind, uuid: key?.uuid, originalName: key?.name || '', value: kind === 'rename' ? key.name || '' : '', error: '' })
      }
      const cancelEditor = (expected) => { if (canEditKeys() && editorRef.current === expected) updateEditor(null) }
      const submitEditor = (event, expected) => {
        event.preventDefault()
        const editor = editorRef.current
        if (!editor || editor !== expected || !canEditKeys()) return
        const name = editor.value.trim()
        let error = ''
        if (editor.kind !== 'create' && (typeof editor.uuid !== 'string' || !editor.uuid.trim())) error = '密钥标识缺失，请重新加载列表后重试'
        else if (editor.kind !== 'delete' && !name) error = '请输入密钥名称，不能只包含空白'
        else if (editor.kind !== 'delete' && /[\u0000-\u001f\u007f]/.test(name)) error = '密钥名称不能包含换行或控制字符'
        else if (editor.kind === 'rename' && name === editor.originalName.trim()) error = '请输入与原名称不同的新名称'
        if (error) { updateEditor({ ...editor, error }); return }
        const path = editor.kind === 'create' ? 'create' : editor.kind === 'rename' ? 'update' : 'delete'
        const body = editor.kind === 'create' ? { name } : editor.kind === 'rename' ? { uuid: editor.uuid, name } : { uuid: editor.uuid }
        return keyAction(editor.kind, (scope) => post(`/paratera-balance/api/keys/${path}`, body, scope), { editor })
      }
      const importKey = (withModels) => {
        if (!importing || (withModels && importing.models.length > 0 && importing.selected.length === 0)) return
        const body = {
          ...(importing.uuid ? { uuid: importing.uuid } : { name: importing.name }),
          ...(withModels ? (importing.models.length ? { models: importing.selected } : { autoModels: true }) : {}),
          ...(withModels && importing.replace ? { replaceModels: true } : {}),
        }
        return keyAction('import', (scope) => post('/paratera-balance/api/keys/import', body, scope), { withModels })
      }
      const secondFactorAction = async (kind, body, success, busyLabel = kind) => {
        const scope = lifecycle.current
        if (!scope || scope.disposed || scope.twoFactorBusy) return
        scope.twoFactorBusy = true
        setTwoFactorBusy(busyLabel)
        try {
          const result = await post(`/paratera-balance/api/2fa/${kind}`, body, scope)
          if (scope.disposed) return
          setNotice(result.ok ? success(result) : friendlyError(result.error || '二次认证操作失败'))
          if (result.ok && kind === 'code') setTwoFactorCode('')
          await load()
        } catch (error) { if (!scope.disposed) setNotice(friendlyError(error)) }
        finally { scope.twoFactorBusy = false; if (!scope.disposed) setTwoFactorBusy('') }
      }
      const pickSecondFactor = (method) => secondFactorAction('choose', { method }, () => `验证码已发送，请在${method === 'mobile' ? '短信' : '企业微信'}中查收`, method)
      const sendSecondFactorCode = () => secondFactorAction('code', { code: twoFactorCode }, (result) => result.trustedDevice
        ? '二次认证通过，并已把本机记为信任浏览器（180 天内免验证）' : '二次认证通过，已取得余额')
      const cancelSecondFactor = () => secondFactorAction('cancel', {}, () => '已取消本次二次认证')

      const expires = status?.tokenExpiresAt ? new Date(status.tokenExpiresAt) : null
      const valid = status?.tokenValid
      const consoleConnected = Boolean(consoleState?.connected)
      const keysDisabled = keysBusy !== '' || busy === 'console' || Boolean(importProgress?.running)
      const matchesFilter = (model) => !importFilter || model.toLowerCase().includes(importFilter.toLowerCase())
      const visibleModels = importing ? importing.models.filter(matchesFilter).slice(0, 200) : []
      const allVisibleSelected = visibleModels.length > 0 && visibleModels.every((model) => importing.selected.includes(model))
      // Select-all follows the current filter: narrowing the list then selecting
      // must not silently take the other ninety models as well.
      const toggleAllModels = () => {
        if (!canEditKeys()) return
        setImporting((current) => {
          if (!current) return current
          const visible = current.models.filter(matchesFilter).slice(0, 200)
          if (!visible.length) return current
          if (visible.every((model) => current.selected.includes(model))) {
            return { ...current, selected: current.selected.filter((model) => !visible.includes(model)) }
          }
          const merged = [...current.selected]
          for (const model of visible) if (!merged.includes(model) && merged.length < 200) merged.push(model)
          return { ...current, selected: merged }
        })
      }
      const editorTitle = keyEditor?.kind === 'create' ? '新建密钥' : keyEditor?.kind === 'rename' ? '重命名密钥' : '删除密钥'
      const accountPanel = h('div', { key: 'account', style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, [
        h('h2', { key: 'title', style: { fontSize: '16px', margin: 0 } }, '清华算力余额'),
        h('div', { key: 'card', style: card }, [
          h('div', { key: 'state', style: row }, [
            h('strong', { key: 'label', style: { fontSize: '13px' } }, '登录状态'),
            h('span', { key: 'value', style: { fontSize: '13px', color: valid ? '#1a7f37' : '#b54708' } },
              !status ? '读取中…' : valid ? '已登录' : '需要登录'),
          ]),
          h('div', { key: 'exp', style: muted },
            expires ? `会话有效期至：${expires.toLocaleString()}` : '尚未取得清华算力平台会话'),
          status?.snapshot?.couponFree != null ? h('div', { key: 'bal', style: muted },
            `算力券余额 ¥${Number(status.snapshot.couponFree).toFixed(2)}（已用 ¥${Number(status.snapshot.couponUsed ?? 0).toFixed(2)}${status.snapshot.couponTotal != null ? ` / 总额 ¥${Number(status.snapshot.couponTotal).toFixed(2)}` : ''}）`) : null,
          h('div', { key: 'src', style: muted },
            '数据源：清华算力平台用户信息接口'),
          status?.lastRefreshAt ? h('div', { key: 'last', style: muted },
            `最近自动刷新：${new Date(status.lastRefreshAt).toLocaleString()}`) : null,
          status?.lastError ? h('div', { key: 'err', style: { ...muted, color: '#b54708' } },
            `最近错误：${status.lastErrorMessage || status.lastError}`) : null,
          !valid && credSaved === false ? h('div', { key: 'onboard', style: { ...muted, color: '#b54708' } },
            '首次使用：建议先点「保存凭据」填一次账号密码，之后由插件静默登录，不必再开窗口。') : null,
          h('div', { key: 'actions', style: { ...row, justifyContent: 'flex-start' } }, [
            h('button', { key: 'refresh', type: 'button', style: button, disabled: busy !== '', onClick: () => run('refresh') },
              busy === 'refresh' ? '刷新中…' : '立即刷新'),
            h('button', { key: 'login', type: 'button', style: button, disabled: busy !== '', onClick: () => run('login') },
              busy === 'login' ? '启动中…' : '重新登录'),
            h('button', { key: 'cred', type: 'button', disabled: busy !== '', onClick: () => run('credentials'),
              style: !valid && credSaved === false ? { ...button, border: '1px solid #1a7f37', color: '#1a7f37', fontWeight: 600 } : button },
              busy === 'credentials' ? '等待窗口…' : '保存凭据'),
          ]),
          notice ? h('div', { key: 'notice', role: 'status', 'aria-live': 'polite', style: muted }, notice) : null,
          twoFactor?.pending ? h('div', { key: '2fa', style: twoFactorBox }, [
            h('div', { key: 'title', style: { fontSize: '13px', fontWeight: 600 } }, '需要二次认证'),
            h('div', { key: 'hint', style: muted },
              twoFactor.stage === 'choose'
                ? '请选择一种方式接收验证码：'
                : (twoFactor.hint || twoFactor.phoneHint || '请输入收到的验证码')),
            twoFactor.stage === 'choose'
              ? h('div', { key: 'methods', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                (twoFactor.methods || []).map((method) => h('button', {
                  key: method.id,
                  type: 'button',
                  style: button,
                  disabled: twoFactorBusy !== '',
                  onClick: () => pickSecondFactor(method.id),
                }, twoFactorBusy === method.id ? '发送中…' : (method.label || method.id))))
              : h('div', { key: 'code', style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [
                h('input', {
                  key: 'input',
                  type: 'text',
                  inputMode: 'numeric',
                  placeholder: '输入验证码',
                  value: twoFactorCode,
                  onChange: (event) => setTwoFactorCode(event.target.value),
                  style: codeInputStyle,
                }),
                h('button', { key: 'submit', type: 'button', style: button, disabled: twoFactorBusy !== '', onClick: sendSecondFactorCode },
                  twoFactorBusy === 'code' ? '验证中…' : '提交验证码'),
              ]),
            h('button', { key: 'cancel', type: 'button', style: { ...button, alignSelf: 'flex-start' }, disabled: twoFactorBusy !== '', onClick: cancelSecondFactor },
              '取消本次二次认证'),
          ]) : null,
        ]),
        h('div', { key: 'console', style: card }, [
          h('div', { key: 'title', style: row }, [
            h('strong', { key: 'label', style: { fontSize: '13px' } }, '控制台会话'),
            h('span', { key: 'value', style: { fontSize: '13px', color: consoleConnected ? '#1a7f37' : '#b54708' } },
              !consoleState ? '读取中…' : consoleConnected ? '已连接' : '未连接'),
          ]),
          consoleState?.expiresAt ? h('div', { key: 'exp', style: muted },
            `有效期至：${new Date(consoleState.expiresAt).toLocaleString()}`) : null,
          h('div', { key: 'note', style: muted },
            '用于读取 API 密钥与可用模型；由清华 SSO 的 accessCode 自动换取，不需要额外的控制台密码。'),
          h('div', { key: 'actions', style: { ...row, justifyContent: 'flex-start' } }, [
            h('button', { key: 'connect', type: 'button', style: button, disabled: busy !== '' || keysDisabled, onClick: () => run('console') },
              busy === 'console' ? '连接中…' : '连接控制台'),
          ]),
        ]),
        h('div', { key: 'keys', style: card }, [
          h('div', { key: 'head', style: row }, [
            h('strong', { key: 'label', style: { fontSize: '13px' } }, 'API 密钥'),
            h('span', { key: 'count', style: muted }, keys?.keys ? `${keys.keys.length} 把` : '未加载'),
          ]),
          h('div', { key: 'actions', style: { ...row, justifyContent: 'flex-start', flexWrap: 'wrap' } }, [
            h('button', { key: 'load', type: 'button', style: button, disabled: keysBusy !== '' || busy === 'console', onClick: () => keyAction('load') }, keysBusy === 'load' ? '加载中…' : '加载密钥'),
            h('button', { key: 'create', type: 'button', style: button, disabled: keysDisabled, onClick: () => openEditor('create') }, '新建'),
            h('button', { key: 'models', type: 'button', style: button, disabled: keysDisabled, onClick: () => keyAction('models', () => post('/paratera-balance/api/keys/refresh-models')) }, '更新支持模型'),
          ]),
          importProgress?.running ? h('div', { key: 'import-progress', role: 'status', 'aria-live': 'polite', style: muted },
            importProgress.statusError ? '进度暂不可用，正在重试状态查询；请勿重复导入。' : `${importStages[importProgress.stage] || '导入处理中'}…可能需要数分钟，请勿重复导入。`) : null,
          keysNotice ? h('div', { key: 'key-notice', role: keysNotice.error ? 'alert' : 'status', 'aria-live': keysNotice.error ? 'assertive' : 'polite', style: { ...muted, opacity: 1, color: keysNotice.error ? '#b54708' : 'inherit', whiteSpace: 'pre-wrap' } }, keysNotice.text) : null,
          keyEditor ? h('form', { key: 'key-editor', 'aria-label': editorTitle, noValidate: true, onSubmit: (event) => submitEditor(event, keyEditor), onKeyDown: (event) => { if (event.key === 'Escape') { event.preventDefault(); cancelEditor(keyEditor) } }, style: twoFactorBox }, [
            h('strong', { key: 'title', style: { fontSize: '13px' } }, editorTitle),
            keyEditor.kind === 'delete'
              ? h('div', { key: 'warning', style: muted }, `确定删除「${keyEditor.originalName || '(未命名)'}」？删除后无法恢复，且会立即拒绝该密钥的所有请求。`)
              : h('label', { key: 'name-label', htmlFor: 'paratera-key-name', style: muted }, [
                '密钥名称/描述',
                h('input', { key: 'key-name', id: 'paratera-key-name', type: 'text', autoFocus: true, autoComplete: 'off', required: true, value: keyEditor.value, disabled: keysDisabled,
                  'aria-invalid': Boolean(keyEditor.error), 'aria-describedby': keyEditor.error ? 'paratera-key-editor-error' : undefined,
                  onChange: (event) => { if (!canEditKeys() || editorRef.current !== keyEditor) return; updateEditor({ ...keyEditor, value: event.target.value, error: '' }) },
                  style: { ...codeInputStyle, width: '100%', boxSizing: 'border-box', marginTop: '4px' } }),
              ]),
            keyEditor.error ? h('div', { key: 'editor-error', id: 'paratera-key-editor-error', role: 'alert', style: { ...muted, opacity: 1, color: '#b54708' } }, keyEditor.error) : null,
            h('div', { key: 'editor-actions', style: { ...row, justifyContent: 'flex-start' } }, [
              h('button', { key: 'editor-submit', type: 'submit', style: button, disabled: keysDisabled }, keysBusy === keyEditor.kind ? '提交中…' : keyEditor.kind === 'delete' ? '确认删除' : '保存'),
              h('button', { key: 'editor-cancel', type: 'button', style: button, disabled: keysDisabled, onClick: () => cancelEditor(keyEditor) }, '取消'),
            ]),
          ]) : null,
          keys?.ok && keys.keys ? h('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            keys.keys.map((k) => h('div', { key: k.uuid, style: { ...row, ...muted, borderTop: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))', paddingTop: '6px' } }, [
              h('span', { key: 'name', title: k.masked || '', style: { fontSize: '13px', color: 'inherit', opacity: 1 } }, k.name || '(未命名)'),
              h('span', { key: 'meta', style: muted }, `${k.status === 'valid' ? '已启用' : '已禁用'} · ${k.models.length} 模型 · ${k.created || ''}`),
              h('span', { key: 'ops', style: { display: 'flex', gap: '6px' } }, [
                h('a', { key: 'rename', href: '#', 'aria-disabled': keysDisabled, onClick: (e) => { e.preventDefault(); openEditor('rename', k) } }, '改名'),
                h('a', { key: 'import', href: '#', 'aria-disabled': keysDisabled || ['invalid', 'disabled'].includes(k.status), title: ['invalid', 'disabled'].includes(k.status) ? '该密钥已禁用，请先启用再导入' : undefined, onClick: (e) => { e.preventDefault(); if (!canEditKeys()) return; if (['invalid', 'disabled'].includes(k.status)) { setKeysNotice({ text: friendlyError('key-disabled'), error: true }); return }; updateEditor(null); setKeysNotice(null); const models = modelIds(k.models); setImporting({ uuid: k.uuid, name: k.name, models, selected: [], replace: false }); setImportFilter('') } }, '导入'),
                h('a', { key: 'toggle', href: '#', 'aria-disabled': keysDisabled, onClick: (e) => { e.preventDefault(); keyAction('toggle', () => post('/paratera-balance/api/keys/update', { uuid: k.uuid, status: k.status === 'valid' ? 'invalid' : 'valid' })) } }, k.status === 'valid' ? '禁用' : '启用'),
                h('a', { key: 'del', href: '#', 'aria-disabled': keysDisabled, onClick: (e) => { e.preventDefault(); openEditor('delete', k) } }, '删除'),
              ]),
            ]))) : (keys && !keys.ok ? h('div', { key: 'err', style: muted }, `读取失败：${keys.error}`) : null),
          importing ? h('div', { key: 'picker', style: { display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))', paddingTop: '8px' } }, [
            h('div', { key: 't', style: { fontSize: '13px' } }, `导入「${importing.name || '(未命名)'}」：添加到 DSH 模型列表`),
            importing.models.length === 0 ? h('div', { key: 'empty', style: muted }, '暂无可选模型；「导入并添加到模型列表」会验证密钥并自动发现可用模型。') : null,
            importing.models.length > 200 ? h('div', { key: 'limit', style: muted }, '最多导入 200 个模型；可过滤后逐个勾选，或用「全选」选中前 200 个。') : null,
            h('div', { key: 'bulk', style: { ...row, justifyContent: 'flex-start', gap: '8px' } }, [
              h('button', { key: 'all', type: 'button', style: button, disabled: keysDisabled || visibleModels.length === 0, onClick: toggleAllModels },
                allVisibleSelected ? '取消全选' : importFilter ? `全选筛选（${visibleModels.length}）` : `全选（${visibleModels.length}）`),
              h('span', { key: 'picked', style: muted }, importing.models.length === 0 ? '未选择模型'
                : `已选 ${importing.selected.length} / ${Math.min(importing.models.length, 200)}${importFilter ? `，当前筛选 ${visibleModels.length} 个` : ''}`),
            ]),
            h('input', { key: 'f', type: 'text', 'aria-label': '过滤模型', placeholder: '过滤模型…', value: importFilter, disabled: keysDisabled, onChange: (e) => { if (canEditKeys()) setImportFilter(e.target.value) }, style: { padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))', background: 'transparent', color: 'inherit' } }),
            h('button', { key: 'replace', type: 'button', 'aria-pressed': Boolean(importing.replace), title: '替换会移除未勾选的模型；若当前默认模型不在其中，需要在「模型」页重新选择默认模型', style: button, disabled: keysDisabled, onClick: () => { if (!canEditKeys()) return; setImporting((current) => current ? { ...current, replace: !current.replace } : current) } },
              importing.replace ? '替换模式：开（移除未勾选的模型）' : '替换模式：关（仅追加）'),
            h('div', { key: 'list', style: { maxHeight: '220px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' } },
              visibleModels.map((m) => h('label', { key: m, style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px' } }, [
                h('input', { type: 'checkbox', disabled: keysDisabled || (!importing.selected.includes(m) && importing.selected.length >= 200), checked: importing.selected.includes(m), onChange: () => { if (!canEditKeys()) return; setImporting((current) => current ? { ...current, selected: current.selected.includes(m) ? current.selected.filter((x) => x !== m) : current.selected.length < 200 ? [...current.selected, m] : current.selected } : current) } }),
                h('span', null, m),
              ]))),
            h('div', { key: 'a', style: { ...row, justifyContent: 'flex-start' } }, [
              h('button', { key: 'cancel', type: 'button', style: button, disabled: keysDisabled, onClick: () => { if (!canEditKeys()) return; setImporting(null); setImportFilter('') } }, '取消'),
              h('button', { key: 'go', type: 'button', style: button, disabled: keysDisabled || (importing.models.length > 0 && importing.selected.length === 0), onClick: () => importKey(true) }, keysBusy === 'import' && importMode === 'models' ? '正在导入并添加模型…' : `导入并添加到模型列表${importing.models.length ? `（${importing.selected.length} 个）` : ''}`),
              h('button', { key: 'keyonly', type: 'button', style: button, disabled: keysDisabled, onClick: () => importKey(false) }, keysBusy === 'import' && importMode === 'keyonly' ? '正在保存密钥…' : '仅保存密钥（不添加模型）'),
            ]),
          ]) : null,
          h('div', { key: 'note', style: muted }, '导入会读取完整密钥并写入 DSH 凭据（旧值备份到 PARATERA_API_KEY_BACKUP）。默认只向 Paratera 追加模型；勾选「替换」后以本次勾选为准。API key 不是付费订阅；添加模型成功后请在「模型 → Paratera」中查看。仅保存密钥不会添加模型或订阅条目。'),
        ]),
        h('div', { key: 'hint', style: muted },
          '登录使用本机专用浏览器会话（不影响日常 Chrome）。清华 SSO 会话为 24 小时滑动续期，登录一次后由宿主自动维持，通常无需再次操作。'),
      ])
      const tabButton = (id, label) => h('button', {
        key: 'tab-' + id, type: 'button', role: 'tab', 'aria-selected': tab === id, 'aria-pressed': tab === id,
        style: { ...button, ...(tab === id ? { fontWeight: 600, borderBottom: '2px solid currentColor' } : { opacity: 0.65 }) },
        onClick: () => setTab(id),
      }, label)
      return h('section', { className: 'paratera-balance-settings', style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, [
        h('div', { key: 'tabs', role: 'tablist', style: { display: 'flex', gap: '8px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))', paddingBottom: '6px' } }, [
          tabButton('account', '账号登录'),
          tabButton('models', '模型设置'),
        ]),
        tab === 'models' ? h(ModelsPanel, { key: 'models-panel' }) : accountPanel,
      ])
    }

    // 「模型设置」 tab: fine-tune the imported Paratera catalog without leaving
    // the plugin. The host validates and writes through the revisioned Settings
    // API, so this panel never touches the profile file itself.
    function ModelsPanel() {
      const scopeRef = React.useRef(null)
      const [state, setState] = React.useState({ status: 'loading', models: [], revision: null, notice: null })
      const [saving, setSaving] = React.useState(false)
      React.useEffect(() => {
        const scope = { disposed: false, controller: null }
        scopeRef.current = scope
        return () => { scope.disposed = true; try { scope.controller?.abort() } catch {} }
      }, [])
      const call = React.useCallback(async (path, method = 'GET', body) => {
        const scope = scopeRef.current
        if (!scope || scope.disposed) throw new DOMException('Unmounted', 'AbortError')
        const controller = new AbortController()
        scope.controller = controller
        const timeout = setTimeout(() => controller.abort(), 30000)
        try {
          const response = await fetch(path, {
            method, credentials: 'same-origin', signal: controller.signal,
            headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
          const result = await response.json().catch(() => null)
          if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`)
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid-response')
          return result
        } finally {
          clearTimeout(timeout)
          if (scope.controller === controller) scope.controller = null
        }
      }, [])
      const load = React.useCallback(async () => {
        setState((current) => ({ ...current, status: 'loading', notice: null }))
        try {
          const result = await call('/paratera-balance/api/models')
          if (scopeRef.current?.disposed) return
          if (!result.ok) { setState({ status: 'error', models: [], revision: null, notice: { text: friendlyError(result.error), error: true } }); return }
          // Legacy `reasoningEfforts: false` rows read as "no levels checked",
          // i.e. no override; saving them drops the fake "thinking off" state.
          const models = (Array.isArray(result.models) ? result.models : []).map((model) => ({
            ...model,
            reasoningEfforts: model.reasoningEfforts && model.reasoningEfforts !== false ? model.reasoningEfforts : undefined,
          }))
          setState({ status: 'ready', models, revision: result.revision ?? null, notice: null })
        } catch (error) {
          if (scopeRef.current?.disposed) return
          setState({ status: 'error', models: [], revision: null, notice: { text: friendlyError(error), error: true } })
        }
      }, [call])
      React.useEffect(() => { load() }, [load])
      const edit = (index, patch) => setState((current) => ({ ...current, models: current.models.map((model, at) => (at === index ? { ...model, ...patch } : model)) }))
      const remove = (index) => setState((current) => ({ ...current, models: current.models.filter((_, at) => at !== index) }))
      const reset = (index) => setState((current) => ({
        ...current,
        models: current.models.map((model, at) => (at === index
          ? { ...model, name: model.recommended.name, contextWindow: model.recommended.contextWindow, maxTokens: model.recommended.maxTokens, input: [...model.recommended.input] }
          : model)),
      }))
      const invalid = (models) => models.some((model) => !String(model.name || '').trim()
        || !Number.isInteger(model.contextWindow) || model.contextWindow < 1 || model.contextWindow > 4000000
        || !Number.isInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > 1000000)
      const save = async (override) => {
        if (saving) return
        const source = Array.isArray(override) ? override : state.models
        if (invalid(source)) { setState((current) => ({ ...current, notice: { text: friendlyError('invalid-model-settings'), error: true } })); return }
        setSaving(true)
        try {
          const models = source.map((model) => {
            const efforts = model.reasoningEfforts
            const reasoning = efforts && efforts !== false && Object.keys(efforts).some((level) => level !== 'off') ? efforts : undefined
            return {
              id: model.id, name: String(model.name).trim(), contextWindow: model.contextWindow,
              maxTokens: model.maxTokens, input: model.input,
              ...(reasoning === undefined ? {} : { reasoningEfforts: reasoning }),
            }
          })
          const result = await call('/paratera-balance/api/models', 'POST', { models, revision: state.revision })
          if (scopeRef.current?.disposed) return
          if (!result.ok) { setState((current) => ({ ...current, notice: { text: friendlyError(result.error), error: true } })); return }
          await load()
          if (!scopeRef.current?.disposed) setState((current) => ({ ...current, notice: { text: `已保存 ${result.models.length} 个模型设置`, error: false } }))
        } catch (error) {
          if (!scopeRef.current?.disposed) setState((current) => ({ ...current, notice: { text: friendlyError(error), error: true } }))
        } finally { if (!scopeRef.current?.disposed) setSaving(false) }
      }
      // One click: every row adopts its catalog最大值 (context + output cap) and
      // is persisted immediately, so the user never edits rows by hand.
      const applyMax = () => {
        if (saving || !state.models.length) return
        const models = state.models.map((model) => ({
          ...model,
          contextWindow: model.recommended.contextWindow,
          maxTokens: model.recommended.maxTokens,
        }))
        setState((current) => ({ ...current, models }))
        return save(models)
      }
      const numberInput = (value, min, max, disabled, onChange, field, id) => h('input', {
        type: 'number', min, max, step: 1, value, disabled, 'data-field': field, 'data-model': id,
        onChange: (event) => onChange(Number(event.target.value)),
        style: { ...codeInputStyle, width: '100%', boxSizing: 'border-box', marginTop: '4px' },
      })
      const rows = state.models.map((model, index) => h('div', { key: model.id, style: { ...card, padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' } }, [
        h('div', { key: 'head', style: row }, [
          h('strong', { key: 'id', style: { fontSize: '13px', wordBreak: 'break-all' } }, model.id),
          h('div', { key: 'ops', style: { display: 'flex', gap: '6px' } }, [
            h('button', { key: 'reset', type: 'button', style: button, disabled: saving, onClick: () => reset(index) }, '恢复推荐值'),
            h('button', { key: 'del', type: 'button', style: button, disabled: saving, onClick: () => remove(index) }, '删除'),
          ]),
        ]),
        h('label', { key: 'name', style: { ...muted, display: 'flex', flexDirection: 'column', gap: '0px' } }, [
          '名称（模型选择器里显示）',
          h('input', {
            type: 'text', value: model.name, disabled: saving, maxLength: 120, 'data-field': 'name', 'data-model': model.id,
            onChange: (event) => edit(index, { name: event.target.value }),
            style: { ...codeInputStyle, width: '100%', boxSizing: 'border-box', marginTop: '4px' },
          }),
        ]),
        h('div', { key: 'nums', style: { display: 'flex', gap: '10px' } }, [
          h('label', { key: 'ctx', style: { ...muted, flex: 1 } }, ['上下文窗口', numberInput(model.contextWindow, 1, 4000000, saving, (value) => edit(index, { contextWindow: value }), 'contextWindow', model.id)]),
          h('label', { key: 'max', style: { ...muted, flex: 1 } }, ['最大输出 token', numberInput(model.maxTokens, 1, 1000000, saving, (value) => edit(index, { maxTokens: value }), 'maxTokens', model.id)]),
        ]),
        h('div', { key: 'modalities', style: { ...row, justifyContent: 'flex-start', gap: '10px' } }, [
          h('span', { key: 'label', style: muted }, '输入类型'),
          h('label', { key: 'text', style: { ...muted, display: 'flex', gap: '4px', alignItems: 'center' } }, [
            h('input', { type: 'checkbox', checked: true, disabled: true }), '文本',
          ]),
          h('label', { key: 'image', style: { ...muted, display: 'flex', gap: '4px', alignItems: 'center' } }, [
            h('input', {
              type: 'checkbox', checked: model.input.includes('image'), disabled: saving, 'data-field': 'image', 'data-model': model.id,
              onChange: () => edit(index, { input: model.input.includes('image') ? ['text'] : ['text', 'image'] }),
            }), '图片',
          ]),
        ]),
        h('div', { key: 'reasoning', style: { ...row, justifyContent: 'flex-start', gap: '10px', flexWrap: 'wrap' } }, [
          h('span', { key: 'label', style: muted }, '思考挡位'),
          ...THINKING_LEVELS.map((level) => h('label', {
            key: 'lvl-' + level,
            style: { ...muted, display: 'flex', gap: '3px', alignItems: 'center' },
          }, [
            h('input', {
              type: 'checkbox', checked: Boolean(model.reasoningEfforts?.[level]), disabled: saving,
              'data-field': 'level-' + level, 'data-model': model.id,
              onChange: () => {
                if (saving) return
                const next = { ...(model.reasoningEfforts && model.reasoningEfforts !== false ? model.reasoningEfforts : { off: null }) }
                if (next[level]) delete next[level]
                else next[level] = level
                const keepsThinking = Object.keys(next).some((key) => key !== 'off')
                // No level checked means "do not override": the host keeps the
                // model's own capability. There is no fake "thinking off" state:
                // the composer's Off simply sends no effort, and a model that
                // always reasons still will.
                edit(index, { reasoningEfforts: keepsThinking ? next : undefined })
              },
            }),
            level,
          ])),
          h('span', { key: 'note', style: muted }, model.reasoningEfforts && model.reasoningEfforts !== false ? '自定义挡位' : '未勾选＝跟随模型原生'),
          model.supportsReasoning ? h('span', { key: 'tag', style: muted }, '平台标注为推理模型') : null,
        ]),
      ]))
      return h('div', { className: 'paratera-models-settings', style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, [
        h('div', { key: 'actions', style: { ...row, justifyContent: 'flex-start', flexWrap: 'wrap' } }, [
          h('button', { key: 'max-all', type: 'button', style: button, disabled: saving || state.status !== 'ready' || state.models.length === 0, onClick: applyMax },
            '一键最大值（上下文 + 输出）'),
          h('button', { key: 'save-models', type: 'button', style: button, disabled: saving || state.status !== 'ready', onClick: () => save() },
            saving ? '保存中…' : '保存模型设置'),
          h('button', { key: 'reload-models', type: 'button', style: button, disabled: saving, onClick: () => { if (!saving) load() } }, '重新读取'),
        ]),
        h('div', { key: 'note', style: muted },
          '上下文取自平台模型广场，最大输出取自匹配到的在线模型目录（未收录时按窗口一半、上限 128K）。「一键最大值」会把每行设为该模型的最大上下文与最大输出并立即保存。思考挡位：勾选任意挡位即为该模型自定义可选项（写入 reasoningEfforts），全部不勾选则跟随模型原生；输入栏的 Off 只是“不指定挡位”，不会强制模型停止思考。'),
        state.notice ? h('div', { key: 'notice', role: state.notice.error ? 'alert' : 'status', 'aria-live': state.notice.error ? 'assertive' : 'polite', style: { ...muted, opacity: 1, color: state.notice.error ? '#b54708' : '#1a7f37' } }, state.notice.text) : null,
        state.models.some((model) => /\(待校准\)\s*$/.test(model.name))
          ? h('div', { key: 'legacy', style: muted }, '检测到旧版本写入的「(待校准)」名称：点「恢复推荐值」更新，或在下一次导入时自动迁移。') : null,
        state.status === 'loading' ? h('div', { key: 'loading', style: muted }, '读取中…') : null,
        state.status === 'ready' && state.models.length === 0
          ? h('div', { key: 'empty', style: muted }, '当前没有 Paratera 模型。请先在「账号登录」里导入密钥并选择模型。') : null,
        h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, rows),
      ])
    }

    const plugin = {
      inject: ['slots', 'modelDirectories'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right', id: 'paratera-balance', order: 16,
          inject(sessionId) {
            return {
              directory: ctx.get('modelDirectories').directoryFor(sessionId).store,
            }
          },
        }, Balance))

        try {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section', id: 'paratera-balance', order: 30,
            label: () => '清华算力余额',
            inject: () => ({}),
          }, Section))
        } catch { /* older hosts without settings.section keep the chip only */ }
      },
    }
    // Headless section tests reach the components here; the host only reads
    // `inject`/`apply`, and a non-enumerable key cannot leak into serialization.
    Object.defineProperty(plugin, 'components', { value: { Balance, Section, ModelsPanel } })
    return plugin
  },
})
