/** Native composer quota slot, matching dsh-codex-subscription's ComposerRight. */
window.__ModuleLoader__.load({
  id: 'dsh-paratera-balance',
  factory(require) {
    const imported = require('react')
    const React = imported.createElement ? imported : imported.default
    const h = React.createElement
    const REFRESH_MS = 60000
    const STATUS_MS = 15000

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

    async function call(path, method) {
      const response = await fetch(path, { method, credentials: 'same-origin', headers: { accept: 'application/json' } })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    function Section() {
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const load = React.useCallback(async () => {
        try { setStatus(await call('/paratera-balance/api/status', 'GET')) } catch (error) { setNotice(String(error.message || error)) }
      }, [])
      React.useEffect(() => {
        load()
        const timer = setInterval(load, STATUS_MS)
        return () => clearInterval(timer)
      }, [load])

      const endpoints = { refresh: '/paratera-balance/api/refresh', login: '/paratera-balance/api/login', credentials: '/paratera-balance/api/credentials' }
      const run = async (kind) => {
        setBusy(kind)
        setNotice('')
        try {
          const result = await call(endpoints[kind], 'POST')
          if (kind === 'login') setNotice(result.hint || '已打开登录窗口')
          else if (kind === 'credentials') setNotice(result.hint || '已打开凭据窗口')
          else if (!result.ok) setNotice(result.result?.error || '刷新失败')
          else setNotice('已刷新')
          await load()
        } catch (error) {
          setNotice(String(error.message || error))
        } finally { setBusy('') }
      }

      const expires = status?.tokenExpiresAt ? new Date(status.tokenExpiresAt) : null
      const valid = status?.tokenValid
      return h('section', { className: 'paratera-balance-settings', style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, [
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
            `最近错误：${status.lastError}`) : null,
          h('div', { key: 'actions', style: { ...row, justifyContent: 'flex-start' } }, [
            h('button', { key: 'refresh', type: 'button', style: button, disabled: busy !== '', onClick: () => run('refresh') },
              busy === 'refresh' ? '刷新中…' : '立即刷新'),
            h('button', { key: 'login', type: 'button', style: button, disabled: busy !== '', onClick: () => run('login') },
              busy === 'login' ? '启动中…' : '重新登录'),
            h('button', { key: 'cred', type: 'button', style: button, disabled: busy !== '', onClick: () => run('credentials') },
              busy === 'credentials' ? '启动中…' : '保存凭据'),
          ]),
          notice ? h('div', { key: 'notice', style: muted }, notice) : null,
        ]),
        h('div', { key: 'hint', style: muted },
          '登录使用本机专用浏览器会话（不影响日常 Chrome）。清华 SSO 会话为 24 小时滑动续期，登录一次后由宿主自动维持，通常无需再次操作。'),
      ])
    }

    return {
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
  },
})
