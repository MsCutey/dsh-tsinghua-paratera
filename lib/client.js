/** Native composer quota slot, matching dsh-codex-subscription's ComposerRight. */
window.__ModuleLoader__.load({
  id: 'dsh-tsinghua-paratera',
  factory(require) {
    const imported = require('react')
    const React = imported.createElement ? imported : imported.default
    const h = React.createElement
    const REFRESH_MS = 60000
    const STATUS_MS = 15000
    // Levels a hand-declared paratera model may offer; "off" is implicit (no
    // parameter sent) and always available when the model reasons at all.
    const THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

    /** One line of host/plugin provenance for the settings footer. */
    function diagnosticsText(data) {
      if (!data?.ok) return null
      // Without a real version there is nothing worth showing (and tests / older
      // hosts answering `{ ok: true }` must not grow a footer out of nothing).
      if (!data.host?.version && !data.plugin?.version) return null
      const parts = [
        data.host?.version ? `宿主 DSH ${data.host.version}` : '宿主版本未知',
        data.plugin?.version ? `插件 ${data.plugin.version}` : null,
        '客户端已连接',
      ].filter(Boolean)
      if (data.host?.compatibility?.ok === false) parts.push(`未在 ${data.host.compatibility.tested} 验证`)
      return parts.join(' · ')
    }

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
      const lines = ['清华算力平台', `算力券余额 ¥${value.toFixed(2)}`]
      const detail = data.detail || {}
      if (typeof detail.couponUsed === 'number') lines.push(`已用 ¥${detail.couponUsed.toFixed(2)}${typeof detail.couponTotal === 'number' ? ` / 总额 ¥${detail.couponTotal.toFixed(2)}` : ''}`)
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
            const response = await fetch('/tsinghua-paratera/api/balance', {
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
        className: 'tsinghua-paratera', role: 'status', title: view.title,
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
      width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box',
    }
    const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', minWidth: 0 }
    const muted = { fontSize: '12px', opacity: 0.7, lineHeight: '18px' }
    const button = {
      minHeight: '30px', padding: '0 12px', borderRadius: '8px', cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))',
      background: 'transparent', color: 'inherit', fontSize: '13px',
    }
    const primaryButton = { ...button, fontWeight: 600, background: 'var(--dsw-alias-bg-brand, #2563eb)', color: 'var(--dsw-alias-text-on-brand, #fff)', borderColor: 'transparent' }
    const codeInputStyle = {
      minHeight: '30px', padding: '0 8px', width: '150px', borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))',
      background: 'transparent', color: 'inherit', fontSize: '13px',
    }
    const twoFactorBox = {
      display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px',
      borderRadius: '8px', border: '1px solid rgba(181,71,8,.35)', background: 'rgba(181,71,8,.06)',
    }

    const flowBox = { ...twoFactorBox, borderColor: 'var(--dsw-alias-border-l2, rgba(0,0,0,.12))', background: 'rgba(37,99,235,.035)', minWidth: 0 }

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
        'keys-invalid-response': '控制台返回了无效的密钥列表，请稍后重试',
        'keys-pagination-stalled': '控制台密钥列表翻页未成功，请稍后重试',
        'keys-pagination-limit': '密钥列表页数过多，请在控制台核实',
        'create-import-busy': '已有创建导入流程，请刷新创建状态继续',
        'create-import-expired': '待导入明文已过期，请核实并清理刚创建的密钥',
        'create-import-not-found': '创建流程已不可用，请刷新状态并核实平台密钥',
        'create-import-not-ready': '创建流程尚未就绪，请刷新状态',
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
        'network-error': '网络连接失败，请检查网络后重试',
        'name-required': '请输入密钥名称，不能只包含空白',
        'invalid-arguments': '密钥信息无效，请重新加载列表后重试',
        'model-directory-unavailable': '密钥与模型配置已保存，但宿主模型列表暂不可用；请稍后检查「模型 → Paratera」或重启 DSH',
        'model-directory-missing-models': '密钥与模型配置已保存，但部分模型尚未出现在宿主列表；请稍后检查「模型 → Paratera」或重启 DSH',
        'provider-not-registered': '密钥与模型配置已保存，但 Paratera 尚未出现在宿主模型列表；请重启 DSH 后检查',
        'no-available-models': '密钥验证后没有可用模型，请检查平台授权；也可选择「仅保存密钥」',
        'model-selection-required': '可用模型超过 200 个，请更新支持模型、重新加载列表并明确选择最多 200 个模型',
        'ambiguous-key-row': '控制台中匹配到多行同名密钥，已中止；请重新加载列表后重试',
        'key-name-column-not-found': '控制台页面结构与预期不同，暂时无法定位密钥行；请刷新控制台后重试',
        'model-import-failed': '模型导入未完成，密钥不受影响；可稍后重试导入模型',
        'credential-dialog-failed': '凭据窗口启动失败，请检查系统权限后重试',
        'script-missing': '缺少安装脚本，请重新解压发行包',
        'unsupported-platform': '当前系统不在支持范围（macOS / Windows）',
        'invalid-console-path': '控制台地址校验失败，已中止请求',
        'key-create-unconfirmed': '新建结果尚未确认，请先刷新列表按刚填写的名称核实，不要直接重复新建',
        'key-create-secret-missing': '密钥已创建，但平台没有返回完整密钥，无法导入。请到平台控制台按刚填写的名称删除后重试',
        'key-delete-rejected': '尚未确认删除，请先刷新密钥列表检查状态，或前往平台控制台核实',
        'key-delete-not-deleted': '删除后的完整列表仍显示该密钥，尚未确认删除。请先刷新列表检查状态',
        'key-delete-unconfirmed': '删除结果尚未确认，请先刷新列表检查状态，不要直接重复删除；必要时到平台控制台核实',
        'delete-confirmation-required': '请先在页面确认删除刚创建的密钥',
        'key-delete-unsafe': '无法唯一确认刚创建的密钥，未执行删除；请到控制台按名称核实并清理',
        'key-already-imported': '此密钥已保存到 DSH，不可在此取消删除；请检查模型设置',
        'key-import-deprecated': '平台已有密钥不能再次读取，请为本机创建设备密钥',
        'credential-dialog-open': '请先关闭凭据窗口，再删除已保存密码',
        'credential-remove-failed': '未能删除已保存密码，请关闭凭据窗口并检查文件权限后重试',
      }
      if (messages[code]) return messages[code]
      if (/^(?:HTTP |verify-http-)(401|403)$/.test(code)) return '身份验证失败，请重新登录或连接控制台后重试'
      if (/^verify-http-/.test(code)) return '密钥验证服务暂不可用，请稍后重试'
      if (/^HTTP |^console-http-/.test(code)) return '服务暂时不可用，请稍后重试'
      // Only mapped codes are user-facing; unknown server/transport text may
      // contain upstream details and must never become a secret-bearing alert.
      return '操作未完成，请刷新状态或检查连接'
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
      if (typeof result.verifiedModels === 'number') details.push(`已验证 ${result.verifiedModels} 个可用模型`)
      if (result.modelError) details.push(result.modelConfigUpdated
        ? `模型配置已保存；模型列表确认未完成：${friendlyError(result.modelError)}`
        : `模型导入失败：${friendlyError(result.modelError)}（密钥已保存，可修复配置后重试导入模型）`)
      else if (Array.isArray(result.modelsAdded)) details.push(result.modelsAdded.length ? `新增 ${result.modelsAdded.length} 个模型` : '未添加模型')
      else if (Number.isSafeInteger(result.modelsAddedCount) && result.modelsAddedCount >= 0) details.push(result.modelsAddedCount ? `新增 ${result.modelsAddedCount} 个模型` : '未添加模型')
      if (Array.isArray(result.modelsSkipped) && result.modelsSkipped.length) details.push(`跳过 ${result.modelsSkipped.length} 个平台接口未列出的模型`)
      else if (Number.isSafeInteger(result.modelsSkippedCount) && result.modelsSkippedCount > 0) details.push(`跳过 ${result.modelsSkippedCount} 个平台接口未列出的模型`)
      if (result.providerRegistered && result.modelsAvailable === true) details.push('已加入模型列表：Paratera')
      else if (result.providerRegistered) details.push('Paratera 供应商已登记，模型可用性尚未确认')
      if (result.modelsAvailable === false && !result.modelError) details.push('部分模型未出现在宿主列表，可稍后检查或重启 DSH')
      if (!result.ok && !result.modelError) details.push(`部分操作失败：${friendlyError(result.error)}`)
      if (result.needsRestart) details.push('请完全退出并重启 DSH，使配置生效')
      return details.join('；')
    }

    const pendingStages = new Set(['creating', 'verifying', 'saving', 'models', 'subscription', 'cancelling'])
    const sessionStages = new Set([...pendingStages, 'awaiting-selection', 'completed', 'failed', 'expired', 'cancelled'])
    function createRequestId() {
      if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
      // Fixture/older embedded runtimes: an operation identifier, never a credential.
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.floor(Math.random() * 16)
        return (c === 'x' ? r : (r & 3) | 8).toString(16)
      })
    }

    const importStages = {
      creating: '正在创建设备密钥', verifying: '正在验证可用模型', 'awaiting-selection': '请选择模型',
      saving: '正在保存密钥', models: '正在写入模型配置', subscription: '正在确认模型列表',
      completed: '导入完成', failed: '部分步骤未完成', expired: '会话已过期', cancelled: '已取消', cancelling: '正在删除刚创建的密钥',
    }

    function Section() {
      const lifecycle = React.useRef(null)
      React.useEffect(() => {
        const scope = { disposed: false, controllers: new Set(), timeouts: new Set(), waits: new Map(), keysBusy: false, busy: '', statusBusy: false, twoFactorBusy: false, importGeneration: 0, remoteImportBusy: true, sessionReady: false, session: null, uncertain: false }
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
        const sessionStatus = path === '/tsinghua-paratera/api/keys/create-import/status'
        if (sessionStatus) scope.importStatusController = controller
        let timedOut = false
        const deadline = path === '/tsinghua-paratera/api/console/connect' ? 240000 : 30000
        const timeout = setTimeout(() => { timedOut = true; controller.abort() }, deadline)
        scope.timeouts.add(timeout)
        if (sessionStatus) scope.importStatusTimeout = timeout
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
          if (timedOut) throw new Error('request-timeout')
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
      const [importing, setImporting] = React.useState(null)
      const [importFilter, setImportFilter] = React.useState('')
      const [sessionNotice, setSessionNotice] = React.useState('正在恢复创建状态…')
      const [sessionBlocked, setSessionBlocked] = React.useState(true)
      const [cancelConfirm, setCancelConfirm] = React.useState(false)
      const [createStep, setCreateStep] = React.useState('')
      const [credSaved, setCredSaved] = React.useState(null)
      const [defaultKeyName, setDefaultKeyName] = React.useState('')
      const [canRemoveCredentials, setCanRemoveCredentials] = React.useState(false)
      const [forgetCredentialConfirm, setForgetCredentialConfirm] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [tab, setTab] = React.useState('account')
      const [notice, setNotice] = React.useState('')
      const [twoFactor, setTwoFactor] = React.useState(null)
      const [twoFactorCode, setTwoFactorCode] = React.useState('')
      const [trustDevice, setTrustDevice] = React.useState(false)
      const [twoFactorBusy, setTwoFactorBusy] = React.useState('')
      const [diagnostics, setDiagnostics] = React.useState(null)
      // Host/plugin versions come from the host itself: when DSH is upgraded to
      // a build this plugin was not tested against, the footer says so instead
      // of leaving a silently misbehaving panel.
      React.useEffect(() => {
        const scope = lifecycle.current
        request('/tsinghua-paratera/api/diagnostics', 'GET', undefined, scope)
          .then((result) => { if (!scope.disposed && result?.ok) setDiagnostics(result) })
          .catch(() => {})
        return () => {}
      }, [])
      const load = React.useCallback(async () => {
        const scope = lifecycle.current
        if (!scope || scope.disposed || scope.statusBusy) return
        scope.statusBusy = true
        try {
          try { const value = await request('/tsinghua-paratera/api/status', 'GET', undefined, scope); if (!scope.disposed) setStatus(value) }
          catch (error) { if (!scope.disposed) setNotice(friendlyError(error)) }
          if (scope.disposed) return
          try { const value = await request('/tsinghua-paratera/api/console/status', 'GET', undefined, scope); if (!scope.disposed) setConsoleState(value) } catch {}
          if (scope.disposed) return
          try { const value = await request('/tsinghua-paratera/api/credentials/status', 'GET', undefined, scope); if (!scope.disposed) { setCredSaved(Boolean(value.saved)); setCanRemoveCredentials(value.canRemove === true) } } catch {}
          if (scope.disposed) return
          try { const value = await request('/tsinghua-paratera/api/keys/defaults', 'GET', undefined, scope); if (!scope.disposed && typeof value.name === 'string') setDefaultKeyName(value.name) } catch {}
          if (scope.disposed) return
          try { const value = await request('/tsinghua-paratera/api/2fa/status', 'GET', undefined, scope); if (!scope.disposed) setTwoFactor(value) } catch {}
        } finally { scope.statusBusy = false }
      }, [request])
      const loadKeys = React.useCallback(async (scope = lifecycle.current) => {
        try {
          const result = await request('/tsinghua-paratera/api/keys', 'GET', undefined, scope)
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
      const applySession = (scope, value) => {
        if (typeof value.ok !== 'boolean') throw new Error('invalid-response')
        if (!Object.prototype.hasOwnProperty.call(value, 'session')) throw new Error('invalid-response')
        const next = value.session
        if (next !== null && (!next || typeof next.operationId !== 'string' || !sessionStages.has(next.stage) || !Array.isArray(next.models) || !Array.isArray(next.selectedModels) || typeof next.canCommit !== 'boolean' || typeof next.canCancel !== 'boolean' || typeof next.cleanupRequired !== 'boolean')) throw new Error('invalid-response')
        if (scope.disposed) return
        if (!next && scope.uncertain) {
          setSessionNotice('操作结果尚未确认；请刷新状态或到控制台按名称核实，不要重复创建。')
          return
        }
        const same = next && scope.session?.operationId === next.operationId
        const models = modelIds(next?.models)
        const result = value.result || next?.result
        const serverSelected = modelIds(next?.selectedModels).filter((id) => models.includes(id)).slice(0, 200)
        // Unsubmitted drafts belong to this tab. Once a commit starts, the host
        // snapshot owns the submitted selection, including an explicit key-only [].
        const committedSelection = next && (['saving', 'models', 'subscription', 'completed'].includes(next.stage) || (next.stage === 'failed' && (serverSelected.length > 0 || result?.credentialImported || scope.lastMutation === 'commit')))
        const selected = same && !committedSelection ? scope.session.selected.filter((id) => models.includes(id)) : serverSelected
        scope.session = next ? { ...next, models, selected, result, removed: typeof value.removed === 'boolean' ? value.removed : next.removed } : null
        scope.sessionReady = true
        scope.uncertain = false
        scope.remoteImportBusy = Boolean(next && !['completed', 'cancelled'].includes(next.stage) && (pendingStages.has(next.stage) || next.canCommit || next.canCancel || next.canRetryVerification || next.cleanupRequired || scope.session.result?.credentialImported))
        setSessionBlocked(scope.remoteImportBusy)
        setImporting(scope.session)
        setCreateStep('')
        setSessionNotice(value.error ? friendlyError(value.error) : '')
        if (!same) { setImportFilter(''); setCancelConfirm(false) }
        if (next) updateEditor((editorRef.current?.kind === 'create') ? null : editorRef.current)
      }
      const trackImport = React.useCallback(async (scope, generation) => {
        let first = true
        while (!scope.disposed && generation === scope.importGeneration) {
          if (!first) {
            const ready = await new Promise((resolve) => {
              const timer = setTimeout(() => { scope.waits.delete(timer); scope.importWait = null; resolve(true) }, 2000)
              scope.importWait = timer
              scope.waits.set(timer, resolve)
            })
            if (!ready || scope.disposed || generation !== scope.importGeneration) return
          }
          first = false
          try {
            const value = await request('/tsinghua-paratera/api/keys/create-import/status', 'GET', undefined, scope)
            if (scope.disposed || generation !== scope.importGeneration) return
            if (value.ok !== true) throw new Error(value.error || 'invalid-response')
            applySession(scope, value)
            if (!pendingStages.has(scope.session?.stage)) return
          } catch {
            if (scope.disposed || generation !== scope.importGeneration) return
            setSessionNotice('创建状态暂不可用；请刷新状态，勿重复创建或导入。')
            // Only a known pending operation needs automatic, non-overlapping polling.
            if (!pendingStages.has(scope.session?.stage)) return
          }
        }
      }, [request])
      React.useEffect(() => {
        const scope = lifecycle.current
        trackImport(scope, scope.importGeneration)
        return () => stopImportTracking(scope)
      }, [trackImport])

      const endpoints = {
        refresh: '/tsinghua-paratera/api/refresh',
        login: '/tsinghua-paratera/api/login',
        credentials: '/tsinghua-paratera/api/credentials',
        forgetCredentials: '/tsinghua-paratera/api/credentials',
        console: '/tsinghua-paratera/api/console/connect',
      }
      const run = async (kind) => {
        const scope = lifecycle.current
        if (!scope || scope.disposed || scope.busy || (kind === 'console' && (scope.keysBusy || scope.remoteImportBusy))) return
        scope.busy = kind
        setBusy(kind)
        setNotice('')
        try {
          const result = await request(endpoints[kind], kind === 'forgetCredentials' ? 'DELETE' : 'POST', kind === 'forgetCredentials' ? { confirm: true } : undefined, scope)
          if (scope.disposed) return
          if (!result.ok) setNotice(friendlyError(result.error || result.result?.error || '操作失败'))
          else if (kind === 'forgetCredentials') {
            setCredSaved(false)
            setForgetCredentialConfirm(false)
            setNotice('已删除本机保存的登录密码；现有登录会话和 API 密钥未撤销')
          }
          else if (kind === 'login') setNotice(result.hint || '已打开登录窗口')
          else if (kind === 'credentials') {
            setNotice('已打开凭据窗口，保存后会自动尝试登录…')
            let settled = false
            for (let i = 0; i < 180; i += 1) {
              if (!await wait(scope, 1000)) return
              const c = await request('/tsinghua-paratera/api/credentials/status', 'GET', undefined, scope).catch(() => null)
              if (scope.disposed) return
              if (c?.dialog) continue
              if (c?.dialogResult === 'cancelled' || c?.dialogResult === 'failed') {
                setCredSaved(Boolean(c.saved))
                setNotice(c.dialogResult === 'cancelled' ? '已取消，原有凭据保持不变' : '凭据未保存，请检查原生窗口提示后重试')
                settled = true
                break
              }
              if (c?.saved) {
                setCredSaved(true)
                const login = await request('/tsinghua-paratera/api/refresh', 'POST', undefined, scope).catch(() => null)
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
        setKeysBusy(label)
        setKeysNotice(null)
        try {
          const result = label === 'load' ? await loadKeys(scope) : await operation(scope)
          if (scope.disposed) return
          if (typeof result.ok !== 'boolean') throw new Error('invalid-response')
          let failed = !result.ok
          let message = result.ok ? (label === 'load' ? '密钥列表已加载' : '操作完成') : friendlyError(result.error || '操作失败')
          if (options.editor) {
            if (result.ok) updateEditor(null)
            else updateEditor({ ...options.editor, error: message })
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
            const message = label === 'delete' && ['request-timeout', 'network-error', 'invalid-response'].includes(error.message)
              ? friendlyError('key-delete-unconfirmed') : friendlyError(error)
            setKeysNotice({ text: message, error: true })
            if (options.editor) updateEditor({ ...options.editor, error: message })
          }
        } finally {
          scope.keysBusy = false
          if (!scope.disposed) setKeysBusy('')
        }
      }
      const canEditKeys = () => {
        const scope = lifecycle.current
        return scope && !scope.disposed && !scope.keysBusy && !scope.remoteImportBusy && scope.busy !== 'console'
      }
      const openEditor = (kind, key) => {
        if (!canEditKeys()) return
        if (kind === 'create' && !lifecycle.current.sessionReady) return
        setKeysNotice(null)
        if (kind === 'create') setImporting(null)
        updateEditor({ kind, uuid: key?.uuid, originalName: key?.name || '', value: kind === 'rename' ? key.name || '' : kind === 'create' ? defaultKeyName : '', requestId: kind === 'create' ? createRequestId() : undefined, error: '' })
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
        if (editor.kind === 'create') return sessionAction('prepare', { name, requestId: editor.requestId }, editor)
        const path = editor.kind === 'rename' ? 'update' : 'delete'
        const body = editor.kind === 'rename' ? { uuid: editor.uuid, name } : { uuid: editor.uuid }
        return keyAction(editor.kind, (scope) => post(`/tsinghua-paratera/api/keys/${path}`, body, scope), { editor })
      }
      const refreshSession = () => {
        const scope = lifecycle.current
        if (!scope || scope.disposed || scope.keysBusy) return
        stopImportTracking(scope)
        return trackImport(scope, scope.importGeneration)
      }
      const sessionAction = async (kind, body, editor) => {
        const scope = lifecycle.current
        if (!scope || scope.disposed || scope.keysBusy || scope.busy === 'console') return
        const session = scope.session
        if (kind === 'prepare' && (!scope.sessionReady || scope.remoteImportBusy || editorRef.current !== editor)) return
        if (kind === 'retry' && (!session?.canRetryVerification || typeof session.requestId !== 'string' || body.requestId !== session.requestId || body.name !== session.name || pendingStages.has(session.stage) || scope.uncertain)) return
        if (!['prepare', 'retry'].includes(kind) && body.operationId !== session?.operationId) return
        if (kind === 'commit' && (!session?.canCommit || pendingStages.has(session.stage) || scope.uncertain)) return
        if (kind === 'cancel' && (!session?.canCancel || !cancelConfirm || pendingStages.has(session.stage) || scope.uncertain)) return
        scope.keysBusy = true
        scope.remoteImportBusy = true
        scope.lastMutation = kind
        setSessionBlocked(true)
        setKeysBusy(kind)
        setSessionNotice('')
        setCreateStep(kind === 'prepare' ? 'creating' : kind === 'retry' ? 'verifying' : kind === 'commit' ? 'saving' : 'cancelling')
        stopImportTracking(scope)
        let recover = false
        try {
          const result = await post(`/tsinghua-paratera/api/keys/create-import/${kind === 'retry' ? 'prepare' : kind}`, body, scope)
          if (scope.disposed) return
          if (!result.session && ['key-create-unconfirmed', 'key-create-secret-missing'].includes(result.error)) throw new Error(result.error)
          applySession(scope, result)
          if (!result.ok && editor && !result.session) updateEditor({ ...editor, error: friendlyError(result.error) })
          setCancelConfirm(false)
        } catch (error) {
          if (scope.disposed) return
          if (error.result && Object.prototype.hasOwnProperty.call(error.result, 'session') && !(!error.result.session && ['key-create-unconfirmed', 'key-create-secret-missing'].includes(error.result.error))) {
            try { applySession(scope, error.result) } catch { recover = true }
          } else recover = true
          if (recover) {
            scope.uncertain = true
            setSessionNotice('请求结果尚未确认，正在恢复状态；不会重复创建或提交。')
          }
        } finally {
          scope.keysBusy = false
          if (!scope.disposed) {
            setKeysBusy('')
            if (recover || pendingStages.has(scope.session?.stage)) trackImport(scope, scope.importGeneration)
          }
        }
      }
      const canSelectModels = () => {
        const scope = lifecycle.current
        return scope && !scope.disposed && !scope.keysBusy && !scope.uncertain && scope.session?.canCommit === true && !pendingStages.has(scope.session.stage)
      }
      const updateSelection = (selected) => {
        const scope = lifecycle.current
        if (!canSelectModels()) return
        scope.session = { ...scope.session, selected }
        setImporting(scope.session)
      }
      const importKey = (withModels) => {
        const session = lifecycle.current?.session
        if (!canSelectModels() || (withModels && !session.selected.length)) return
        return sessionAction('commit', { operationId: session.operationId, models: withModels ? session.selected : [] })
      }
      const secondFactorAction = async (kind, body, success, busyLabel = kind) => {
        const scope = lifecycle.current
        if (!scope || scope.disposed || scope.twoFactorBusy) return
        scope.twoFactorBusy = true
        setTwoFactorBusy(busyLabel)
        try {
          const result = await post(`/tsinghua-paratera/api/2fa/${kind}`, body, scope)
          if (scope.disposed) return
          setNotice(result.ok ? success(result) : friendlyError(result.error || '二次认证操作失败'))
          if (result.ok && kind === 'code') setTwoFactorCode('')
          await load()
        } catch (error) { if (!scope.disposed) setNotice(friendlyError(error)) }
        finally { scope.twoFactorBusy = false; if (!scope.disposed) setTwoFactorBusy('') }
      }
      const pickSecondFactor = (method) => secondFactorAction('choose', { method }, () => `验证码已发送，请在${method === 'mobile' ? '短信' : '企业微信'}中查收`, method)
      const sendSecondFactorCode = () => secondFactorAction('code', { code: twoFactorCode, trustDevice }, (result) => result.trustedDevice
        ? '二次认证通过，并已把本机记为信任浏览器（180 天内免验证）' : '二次认证通过，已取得余额')
      const cancelSecondFactor = () => secondFactorAction('cancel', {}, () => '已取消本次二次认证')

      const expires = status?.tokenExpiresAt ? new Date(status.tokenExpiresAt) : null
      const valid = status?.tokenValid
      const consoleConnected = Boolean(consoleState?.connected)
      const keysDisabled = keysBusy !== '' || busy === 'console' || sessionBlocked
      const selectingDisabled = !importing?.canCommit || keysBusy !== '' || Boolean(createStep) || pendingStages.has(importing?.stage)
      const matchesFilter = (model) => !importFilter.trim() || model.toLowerCase().includes(importFilter.trim().toLowerCase())
      const visibleModels = importing ? importing.models.filter(matchesFilter) : []
      const allVisibleSelected = visibleModels.length > 0 && visibleModels.every((model) => importing.selected.includes(model))
      const toggleAllModels = (clear = false) => {
        if (!canSelectModels()) return
        const current = lifecycle.current.session
        const visible = current.models.filter(matchesFilter)
        if (clear || visible.every((model) => current.selected.includes(model))) return updateSelection(current.selected.filter((id) => !visible.includes(id)))
        const merged = [...current.selected]
        for (const model of visible) if (!merged.includes(model) && merged.length < 200) merged.push(model)
        updateSelection(merged)
      }
      const editorTitle = keyEditor?.kind === 'create' ? '新建并导入' : keyEditor?.kind === 'rename' ? '重命名密钥' : '删除密钥'
      const accountPanel = h('div', { key: 'account', style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, [
        h('div', { key: 'card', style: card }, [
          h('div', { key: 'state', style: row }, [
            h('strong', { key: 'label', style: { fontSize: '13px' } }, '登录状态'),
            h('span', { key: 'value', style: { fontSize: '13px', color: valid ? '#1a7f37' : '#b54708' } },
              !status ? '读取中…' : valid ? '已登录' : '需要登录'),
          ]),
          h('div', { key: 'exp', style: muted },
            expires ? `会话有效期至：${expires.toLocaleString()}` : '尚未取得平台会话'),
          status?.snapshot?.couponFree != null ? h('div', { key: 'bal', style: muted },
            `算力券余额 ¥${Number(status.snapshot.couponFree).toFixed(2)}（已用 ¥${Number(status.snapshot.couponUsed ?? 0).toFixed(2)}${status.snapshot.couponTotal != null ? ` / 总额 ¥${Number(status.snapshot.couponTotal).toFixed(2)}` : ''}）`) : null,
          status?.lastRefreshAt ? h('div', { key: 'last', style: muted },
            `最近自动刷新：${new Date(status.lastRefreshAt).toLocaleString()}`) : null,
          status?.lastError ? h('div', { key: 'err', style: { ...muted, color: '#b54708' } },
            `最近错误：${status.lastErrorMessage || status.lastError}`) : null,
          !valid && credSaved === false ? h('div', { key: 'onboard', style: { ...muted, color: '#b54708' } },
            '可在专用窗口手动登录；需要自动登录时，再选择保存凭据。保存密码和信任浏览器均为可选。') : null,
          h('div', { key: 'actions', style: { ...row, justifyContent: 'flex-start' } }, [
            h('button', { key: 'refresh', type: 'button', style: button, disabled: busy !== '', onClick: () => run('refresh') },
              busy === 'refresh' ? '刷新中…' : '立即刷新'),
            h('button', { key: 'login', type: 'button', style: button, disabled: busy !== '', onClick: () => run('login') },
              busy === 'login' ? '启动中…' : '重新登录'),
            h('button', { key: 'cred', type: 'button', disabled: busy !== '', onClick: () => run('credentials'),
              style: button },
              busy === 'credentials' ? '等待窗口…' : '保存凭据'),
            canRemoveCredentials && credSaved ? h('button', { key: 'forget', type: 'button', style: button, disabled: busy !== '', onClick: () => setForgetCredentialConfirm(true) }, '删除已保存密码') : null,
          ]),
          forgetCredentialConfirm && canRemoveCredentials && credSaved ? h('div', { key: 'forget-confirm', role: 'group', style: muted }, [
            h('div', { key: 'hint' }, '仅删除本机保存的登录密码，不会退出平台会话或撤销 API 密钥。确认删除？'),
            h('button', { key: 'yes', type: 'button', style: button, disabled: busy !== '', onClick: () => run('forgetCredentials') }, '确认删除已保存密码'),
            h('button', { key: 'no', type: 'button', style: button, disabled: busy !== '', onClick: () => setForgetCredentialConfirm(false) }, '取消删除密码'),
          ]) : null,
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
                  type: 'password',
                  autoComplete: 'one-time-code',
                  maxLength: 8,
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
            h('label', { key: 'trust-choice', style: muted }, [
              h('input', { key: 'trust', type: 'checkbox', checked: trustDevice, onChange: (event) => setTrustDevice(event.target.checked) }),
              ' 在本机信任此浏览器（最长 180 天；共享设备勿选）',
            ]),
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
            '使用已有清华登录连接，用于创建和管理平台密钥。'),
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
            h('button', { key: 'create', type: 'button', style: { ...primaryButton, opacity: keysDisabled ? 0.5 : 1 }, disabled: keysDisabled, onClick: () => openEditor('create') }, '新建并导入'),
            h('button', { key: 'models', type: 'button', style: button, disabled: keysDisabled, onClick: () => keyAction('models', () => post('/tsinghua-paratera/api/keys/refresh-models')) }, '更新支持模型'),
          ]),
          h('ol', { key: 'steps', 'aria-label': '创建导入步骤', style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '6px', margin: 0, padding: 0, listStyle: 'none' } }, ['创建设备密钥', '筛选模型', '导入完成'].map((label, i) => {
            const current = importing?.stage === 'completed' ? 2 : importing && !['creating', 'verifying', 'cancelled'].includes(importing.stage) ? 1 : 0
            return h('li', { key: label, 'aria-current': current === i ? 'step' : undefined, style: { ...muted, padding: '8px', borderRadius: '8px', fontWeight: current === i ? 600 : 400, opacity: current === i ? 1 : 0.6, background: current === i ? 'rgba(37,99,235,.10)' : 'transparent', overflowWrap: 'anywhere' } }, `${i + 1} ${label}`)
          })),
          sessionNotice ? h('div', { key: 'session-notice', role: 'status', style: muted }, sessionNotice) : null,
          h('button', { key: 'session-refresh', type: 'button', style: { ...button, alignSelf: 'flex-start' }, disabled: keysBusy !== '', onClick: refreshSession }, '刷新创建状态'),
          createStep ? h('div', { key: 'import-progress', role: 'status', style: muted }, importStages[createStep]) : null,
          keysNotice ? h('div', { key: 'key-notice', role: keysNotice.error ? 'alert' : 'status', 'aria-live': keysNotice.error ? 'assertive' : 'polite', style: { ...muted, opacity: 1, color: keysNotice.error ? '#b54708' : 'inherit', whiteSpace: 'pre-wrap' } }, keysNotice.text) : null,
          keyEditor ? h('form', { key: 'key-editor', 'aria-label': editorTitle, noValidate: true, onSubmit: (event) => submitEditor(event, keyEditor), onKeyDown: (event) => { if (event.key === 'Escape') { event.preventDefault(); cancelEditor(keyEditor) } }, style: keyEditor.kind === 'delete' ? twoFactorBox : flowBox }, [
            h('strong', { key: 'title', style: { fontSize: '13px' } }, editorTitle),
            keyEditor.kind === 'delete'
              ? h('div', { key: 'warning', style: muted }, `删除「${keyEditor.originalName || '(未命名)'}」？不可恢复，使用它的请求会立即被拒绝。`)
              : h('label', { key: 'name-label', htmlFor: 'paratera-key-name', style: muted }, [
                '密钥名称/描述',
                h('input', { key: 'key-name', id: 'paratera-key-name', type: 'text', autoFocus: true, autoComplete: 'off', required: true, value: keyEditor.value, disabled: keysDisabled,
                  'aria-label': '密钥名称/描述', 'aria-invalid': Boolean(keyEditor.error), 'aria-describedby': keyEditor.error ? 'paratera-key-editor-error' : undefined,
                  onChange: (event) => { if (!canEditKeys() || editorRef.current !== keyEditor) return; updateEditor({ ...keyEditor, value: event.target.value, error: '' }) },
                  style: { ...codeInputStyle, width: '100%', boxSizing: 'border-box', marginTop: '4px' } }),
              ]),
            keyEditor.error ? h('div', { key: 'editor-error', id: 'paratera-key-editor-error', role: 'alert', style: { ...muted, opacity: 1, color: '#b54708' } }, keyEditor.error) : null,
            keyEditor.kind === 'create' ? h('div', { key: 'create-hint', style: muted },
              '名称默认使用本机设备名，可修改；仅作名称建议，不代表已关联平台设备。创建后先选模型，完整密钥不进入页面。') : null,
            h('div', { key: 'editor-actions', style: { ...row, justifyContent: 'flex-start' } }, [
              h('button', { key: 'editor-submit', type: 'submit', style: keyEditor.kind === 'create' ? { ...primaryButton, opacity: keysDisabled ? 0.5 : 1 } : keyEditor.kind === 'delete' ? { ...button, color: '#b42318' } : button, disabled: keysDisabled }, keysBusy === 'prepare' || keysBusy === keyEditor.kind ? '提交中…' : keyEditor.kind === 'delete' ? '确认删除' : keyEditor.kind === 'create' ? '创建设备密钥' : '保存'),
              h('button', { key: 'editor-cancel', type: 'button', style: button, disabled: keysDisabled, onClick: () => cancelEditor(keyEditor) }, '取消'),
            ]),
          ]) : null,
          keys?.ok && keys.keys ? h('details', { key: 'manage-keys' }, [
            h('summary', { key: 'summary', style: { ...muted, cursor: 'pointer' } }, `管理已有密钥（${keys.keys.length}）`),
            h('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' } },
              keys.keys.map((k) => h('div', { key: k.uuid, style: { ...row, ...muted, borderTop: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))', paddingTop: '8px' } }, [
                h('span', { key: 'name', style: { fontSize: '13px', opacity: 1, overflowWrap: 'anywhere' } }, k.name || '(未命名)'),
                h('span', { key: 'meta', style: muted }, `${k.status === 'valid' ? '已启用' : '已禁用'}${k.created ? ` · ${k.created}` : ''}`),
                h('span', { key: 'ops', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
                  h('button', { key: 'rename', type: 'button', style: button, disabled: keysDisabled, onClick: () => openEditor('rename', k) }, '改名'),
                  h('button', { key: 'toggle', type: 'button', style: button, disabled: keysDisabled, onClick: () => keyAction('toggle', () => post('/tsinghua-paratera/api/keys/update', { uuid: k.uuid, status: k.status === 'valid' ? 'invalid' : 'valid' })) }, k.status === 'valid' ? '禁用' : '启用'),
                  h('button', { key: 'del', type: 'button', style: button, disabled: keysDisabled, onClick: () => openEditor('delete', k) }, '删除'),
                ]),
              ]))),
          ]) : (keys && !keys.ok ? h('div', { key: 'err', style: muted }, `读取失败：${keys.error}`) : null),
          importing ? h('div', { key: 'create-session', role: 'group', 'aria-label': '模型选择', style: ['failed', 'expired'].includes(importing.stage) ? { ...twoFactorBox, minWidth: 0 } : flowBox }, [
            h('strong', { key: 'session-title', style: { fontSize: '13px', overflowWrap: 'anywhere' } }, `${importing.name || '(未命名)'} · ${importStages[importing.stage]}`),
            importing.fingerprint ? h('div', { key: 'fingerprint', style: { ...muted, overflowWrap: 'anywhere' } }, `指纹 ${importing.fingerprint}`) : null,
            importing.canCommit && ['awaiting-selection', 'failed'].includes(importing.stage) && importing.expiresAt && Number.isFinite(new Date(importing.expiresAt).getTime()) ? h('div', { key: 'expiry', style: muted }, [
              h('div', { key: 'deadline' }, `请在 ${new Date(importing.expiresAt).toLocaleTimeString()} 前完成导入（创建后 10 分钟）。`),
              h('div', { key: 'recovery' }, '刷新页面可恢复；重启 DSH 无法恢复一次性密钥。'),
            ]) : null,
            importing.result ? h('div', { key: 'result', role: importing.result.ok ? 'status' : 'alert', style: muted }, importNotice(importing.result)) : null,
            importing.error ? h('div', { key: 'session-error', role: 'alert', style: muted }, friendlyError(importing.error)) : null,
            importing.canRetryVerification === true && typeof importing.requestId === 'string' ? h('button', { key: 'retry-verification', type: 'button', style: { ...button, alignSelf: 'flex-start' }, disabled: keysBusy !== '' || Boolean(createStep) || pendingStages.has(importing.stage), onClick: () => sessionAction('retry', { name: importing.name, requestId: importing.requestId }) }, '重新校验') : null,
            importing.result?.credentialImported && importing.stage !== 'completed' ? h('div', { key: 'partial', style: muted }, '密钥已保存，请修复模型配置或检查宿主模型列表；不要再创建密钥，也不能删除此密钥。') : null,
            importing.stage === 'expired' ? h('div', { key: 'cleanup', role: 'alert', style: muted }, '待导入明文已过期；平台密钥未确认删除，请在控制台按名称核实并清理。') : importing.cleanupRequired ? h('div', { key: 'cleanup', style: muted }, '此密钥尚未保存到 DSH；若放弃导入，需要删除刚创建的密钥。') : null,
            importing.stage === 'cancelled' ? h('div', { key: 'cancel-result', role: 'status', style: muted }, importing.removed === true ? '刚创建密钥已删除，流程已取消。' : importing.removed === false ? '已核实无需清理，流程已取消。' : '流程已取消；平台密钥状态请以清理核实结果为准。') : null,
            !['completed', 'cancelled'].includes(importing.stage) ? h('div', { key: 'selection', style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
              h('input', { key: 'f', type: 'search', 'aria-label': '过滤模型', placeholder: '搜索模型', value: importFilter, disabled: selectingDisabled, onChange: (e) => { if (canSelectModels()) setImportFilter(e.target.value) }, style: { ...codeInputStyle, width: '100%', boxSizing: 'border-box' } }),
              h('div', { key: 'bulk', style: { ...row, justifyContent: 'flex-start', flexWrap: 'wrap' } }, [
                h('button', { key: 'all', type: 'button', style: button, disabled: selectingDisabled || !visibleModels.length, onClick: () => toggleAllModels() }, allVisibleSelected ? '取消筛选全选' : '全选筛选'),
                h('button', { key: 'clear-filtered', type: 'button', style: button, disabled: selectingDisabled || !visibleModels.some((id) => importing.selected.includes(id)), onClick: () => toggleAllModels(true) }, '取消筛选选择'),
                h('span', { key: 'picked', style: muted }, `已选 ${importing.selected.length} / 总数 ${importing.models.length}；筛选 ${visibleModels.length}；最多 200`),
              ]),
              !importing.models.length ? h('div', { key: 'empty', style: muted }, '暂无可选模型；仍可明确选择仅保存密钥。') : null,
              h('div', { key: 'list', style: { maxHeight: '240px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' } }, visibleModels.map((m) => h('label', { key: m, style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', overflowWrap: 'anywhere' } }, [
                h('input', { type: 'checkbox', 'aria-label': m, disabled: selectingDisabled || (!importing.selected.includes(m) && importing.selected.length >= 200), checked: importing.selected.includes(m), onChange: () => { const current = lifecycle.current?.session; if (!canSelectModels()) return; updateSelection(current.selected.includes(m) ? current.selected.filter((id) => id !== m) : current.selected.length < 200 ? [...current.selected, m] : current.selected) } }),
                h('span', null, m),
              ]))),
              h('div', { key: 'selection-actions', style: { ...row, justifyContent: 'flex-start', flexWrap: 'wrap' } }, [
                h('button', { key: 'go', type: 'button', style: { ...primaryButton, opacity: selectingDisabled || !importing.selected.length ? 0.5 : 1 }, disabled: selectingDisabled || !importing.selected.length, onClick: () => importKey(true) }, `导入所选模型（${importing.selected.length}）`),
                h('button', { key: 'keyonly', type: 'button', style: button, disabled: selectingDisabled, onClick: () => importKey(false) }, '仅保存密钥'),
                importing.canCancel ? h('button', { key: 'cancel', type: 'button', style: button, disabled: keysBusy !== '' || Boolean(createStep) || pendingStages.has(importing.stage), onClick: () => { const scope = lifecycle.current; if (!scope.keysBusy && !scope.uncertain && scope.session?.canCancel && !pendingStages.has(scope.session.stage)) setCancelConfirm(true) } }, '取消并删除新密钥') : null,
              ]),
            ]) : null,
            cancelConfirm && importing.canCancel ? h('div', { key: 'cancel-confirm', role: 'group', 'aria-label': '确认取消导入', style: muted }, [
              h('div', { key: 'warning' }, `取消导入将删除刚创建的「${importing.name}」密钥；不是只关闭此界面。确认删除？`),
              h('button', { key: 'cancel-delete', type: 'button', style: { ...button, color: '#b42318' }, disabled: keysBusy !== '', onClick: () => sessionAction('cancel', { operationId: importing.operationId, confirmDelete: true }) }, '确认删除刚创建的密钥'),
              h('button', { key: 'cancel-keep', type: 'button', style: button, disabled: keysBusy !== '', onClick: () => setCancelConfirm(false) }, '继续筛选'),
            ]) : null,
          ]) : null,
          h('div', { key: 'note', style: muted }, '每台设备建议单独创建密钥。完整密钥仅由宿主保存，旧凭据会备份；平台已有密钥无法再次读取。创建密钥不代表购买订阅。'),
        ]),
        h('div', { key: 'hint', style: muted },
          '登录仅使用专用浏览器，不影响日常 Chrome。'),
      ])
      const tabButton = (id, label) => h('button', {
        key: 'tab-' + id, type: 'button', role: 'tab', 'aria-selected': tab === id, 'aria-pressed': tab === id,
        style: { ...button, ...(tab === id ? { fontWeight: 600, borderBottom: '2px solid currentColor' } : { opacity: 0.65 }) },
        onClick: () => setTab(id),
      }, label)
      return h('section', { className: 'tsinghua-paratera-settings', style: { display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', overflowWrap: 'anywhere' } }, [
        h('div', { key: 'tabs', role: 'tablist', style: { display: 'flex', gap: '8px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))', paddingBottom: '6px' } }, [
          tabButton('account', '账号登录'),
          tabButton('models', '模型设置'),
        ]),
        tab === 'models' ? h(ModelsPanel, { key: 'models-panel' }) : accountPanel,
        diagnosticsText(diagnostics) === null ? null : h('div', {
          key: 'diagnostics',
          style: { ...muted, fontSize: '11px', opacity: 0.65, color: diagnostics?.host?.compatibility?.ok === false ? '#b54708' : undefined },
        }, diagnosticsText(diagnostics)),
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
          const result = await call('/tsinghua-paratera/api/models')
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
          ? { ...model, name: model.recommended.name, contextWindow: model.recommended.contextWindow, maxTokens: model.recommended.maxTokens, input: [...model.recommended.input], reasoningEfforts: model.recommended.reasoningEfforts }
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
          const result = await call('/tsinghua-paratera/api/models', 'POST', { models, revision: state.revision })
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
          '名称（选择器显示）',
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
                const declared = Object.keys(next).some((key) => key !== 'off')
                if (!declared) {
                  // First tick starts from the common native trio instead of a
                  // single lonely level; the clicked level is always included.
                  next.low = 'low'
                  next.high = 'high'
                  next.max = 'max'
                  if (!next[level]) next[level] = level
                  edit(index, { reasoningEfforts: next })
                  return
                }
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
          model.supportsReasoning ? h('span', { key: 'tag', style: muted }, '推理模型') : null,
        ]),
      ]))
      return h('div', { className: 'paratera-models-settings', style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, [
        h('div', { key: 'actions', style: { ...row, justifyContent: 'flex-start', flexWrap: 'wrap' } }, [
          h('button', { key: 'max-all', type: 'button', style: button, disabled: saving || state.status !== 'ready' || state.models.length === 0, onClick: applyMax },
            '一键最大值'),
          h('button', { key: 'save-models', type: 'button', style: button, disabled: saving || state.status !== 'ready', onClick: () => save() },
            saving ? '保存中…' : '保存'),
          h('button', { key: 'reload-models', type: 'button', style: button, disabled: saving, onClick: () => { if (!saving) load() } }, '重新读取'),
        ]),
        h('div', { key: 'note', style: muted },
          '上下文来自模型广场，最大输出来自在线目录（未收录按窗口一半、上限 128K）；「一键最大值」一次写满并保存。挡位勾选即自定义，全部取消跟随原生，Off 只是不发参数。'),
        state.notice ? h('div', { key: 'notice', role: state.notice.error ? 'alert' : 'status', 'aria-live': state.notice.error ? 'assertive' : 'polite', style: { ...muted, opacity: 1, color: state.notice.error ? '#b54708' : '#1a7f37' } }, state.notice.text) : null,
        state.models.some((model) => /\(待校准\)\s*$/.test(model.name))
          ? h('div', { key: 'legacy', style: muted }, '旧版本写入的「(待校准)」名称：点「恢复推荐值」更新，导入时也会自动迁移。') : null,
        state.status === 'loading' ? h('div', { key: 'loading', style: muted }, '读取中…') : null,
        state.status === 'ready' && state.models.length === 0
          ? h('div', { key: 'empty', style: muted }, '还没有 Paratera 模型。先到「账号登录」导入密钥并选择模型。') : null,
        h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, rows),
      ])
    }

    const plugin = {
      // Only `slots` is required: the model-directory service is resolved
      // defensively below, so a renamed/removed service cannot stop the whole
      // client bundle from loading.
      inject: ['slots'],
      apply(ctx) {
        const warn = (label, error) => { try { console.warn(`[tsinghua-paratera] ${label} 不可用`, error) } catch {} }

        // The composer chip needs the session's model-directory store. When the
        // host does not provide it, fall back to an empty store: the chip simply
        // stays hidden instead of throwing during slot injection.
        const EMPTY_SNAPSHOT = Object.freeze({})
        const EMPTY_STORE = { subscribe: () => () => {}, getSnapshot: () => EMPTY_SNAPSHOT }
        const directoryFor = (scope, sessionId) => {
          try {
            const store = scope.get?.('modelDirectories')?.directoryFor?.(sessionId)?.store
            if (store && typeof store.subscribe === 'function' && typeof store.getSnapshot === 'function') return store
          } catch (error) { warn('modelDirectories', error) }
          return EMPTY_STORE
        }

        // Register each slot on its own: if DSH renames one of them, the other
        // keeps working (the settings page must survive a composer-slot change).
        const register = (scope, name, spec, component) => {
          try {
            scope.slots.inject(name, () => {
              try { return scope.slots.register(spec, component) } catch (error) { warn(name, error) }
            })
          } catch (error) { warn(name, error) }
        }

        register(ctx, 'settings.section', {
          name: 'settings.section', id: 'tsinghua-paratera', order: 30,
          label: () => '清华算力余额',
          inject: () => ({}),
        }, Section)

        const registerBalance = (scope) => register(scope, 'conversation.input.right', {
          name: 'conversation.input.right', id: 'tsinghua-paratera', order: 16,
          inject: (sessionId) => ({ directory: directoryFor(scope, sessionId) }),
        }, Balance)
        // The model-directory store is reached through the session/remote chain:
        // injecting only `modelDirectories` made the chip disappear in the real
        // host SDK test, so these are transitive requirements, not unused extras.
        // A missing one still only costs the chip (the settings page stays).
        if (typeof ctx.inject === 'function') {
          try { ctx.inject(['modelDirectories', 'sessions', 'remote', 'remote.session'], registerBalance) } catch (error) { warn('modelDirectories', error) }
        } else registerBalance(ctx)

        // Heartbeat: lets /api/diagnostics tell "client loaded" from "client
        // bundle failed to load". Fire-and-forget, never blocks the UI.
        try {
          fetch('/tsinghua-paratera/api/diagnostics/hello', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' }, body: '{}',
          }).catch(() => {})
        } catch {}
      },
    }
    // Headless section tests reach the components here; the host only reads
    // `inject`/`apply`, and a non-enumerable key cannot leak into serialization.
    Object.defineProperty(plugin, 'components', { value: { Balance, Section, ModelsPanel } })
    return plugin
  },
})
