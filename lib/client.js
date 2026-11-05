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
      const [consoleState, setConsoleState] = React.useState(null)
      const [keys, setKeys] = React.useState(null)
      const [keysBusy, setKeysBusy] = React.useState('')
      const [importing, setImporting] = React.useState(null)
      const [importFilter, setImportFilter] = React.useState('')
      const [credSaved, setCredSaved] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const load = React.useCallback(async () => {
        try { setStatus(await call('/paratera-balance/api/status', 'GET')) } catch (error) { setNotice(String(error.message || error)) }
        try { setConsoleState(await call('/paratera-balance/api/console/status', 'GET')) } catch {}
        try { const c = await call('/paratera-balance/api/credentials/status', 'GET'); setCredSaved(Boolean(c.saved)) } catch {}
      }, [])
      const loadKeys = React.useCallback(async () => {
        try { const r = await call('/paratera-balance/api/keys', 'GET'); setKeys(r) } catch { setKeys({ ok: false, error: '读取失败' }) }
      }, [])
      React.useEffect(() => {
        load()
        const timer = setInterval(load, STATUS_MS)
        return () => clearInterval(timer)
      }, [load])

      const endpoints = {
        refresh: '/paratera-balance/api/refresh',
        login: '/paratera-balance/api/login',
        credentials: '/paratera-balance/api/credentials',
        console: '/paratera-balance/api/console/connect',
      }
      const run = async (kind) => {
        setBusy(kind)
        setNotice('')
        try {
          const result = await call(endpoints[kind], 'POST')
          if (!result.ok) setNotice(result.error || result.result?.error || '操作失败')
          else if (kind === 'login') setNotice(result.hint || '已打开登录窗口')
          else if (kind === 'credentials') {
            setNotice('已打开凭据窗口，保存后会自动尝试登录…')
            let settled = false
            for (let i = 0; i < 180; i += 1) {
              await new Promise((r) => setTimeout(r, 1000))
              const c = await call('/paratera-balance/api/credentials/status', 'GET').catch(() => null)
              if (c?.saved) {
                setCredSaved(true)
                const login = await call('/paratera-balance/api/refresh', 'POST').catch(() => null)
                setNotice(login?.ok ? '凭据已保存，登录成功' : '凭据已保存，但登录未成功，可点「重新登录」')
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
          await load()
        } catch (error) {
          setNotice(String(error.message || error))
        } finally { setBusy('') }
      }

      const keyAction = async (label, run) => {
        setKeysBusy(label)
        try {
          const r = await run()
          if (!r.ok) setNotice(r.error === 'key-quota-exceeded' ? '密钥配额已满，请先在控制台删除旧密钥或申请提额' : (r.error || '操作失败'))
          else setNotice('操作完成')
          await loadKeys()
        }
        catch (error) { setNotice(String(error.message || error)) }
        finally { setKeysBusy('') }
      }
      const post = (path, body) => fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body || {}) }).then(async (r) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || r.status); return b })

      const expires = status?.tokenExpiresAt ? new Date(status.tokenExpiresAt) : null
      const valid = status?.tokenValid
      const consoleConnected = Boolean(consoleState?.connected)
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
          notice ? h('div', { key: 'notice', style: muted }, notice) : null,
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
            h('button', { key: 'connect', type: 'button', style: button, disabled: busy !== '', onClick: () => run('console') },
              busy === 'console' ? '连接中…' : '连接控制台'),
          ]),
        ]),
        h('div', { key: 'keys', style: card }, [
          h('div', { key: 'head', style: row }, [
            h('strong', { key: 'label', style: { fontSize: '13px' } }, 'API 密钥'),
            h('span', { key: 'count', style: muted }, keys?.keys ? `${keys.keys.length} 把` : '未加载'),
          ]),
          h('div', { key: 'actions', style: { ...row, justifyContent: 'flex-start', flexWrap: 'wrap' } }, [
            h('button', { key: 'load', type: 'button', style: button, disabled: keysBusy !== '', onClick: () => keyAction('load', async () => { await loadKeys(); return { ok: true } }) }, '加载密钥'),
            h('button', { key: 'create', type: 'button', style: button, disabled: keysBusy !== '', onClick: () => {
              const name = window.prompt('新密钥名称/描述（如 DSH-mac）')
              if (name) keyAction('create', () => post('/paratera-balance/api/keys/create', { name }))
            } }, '新建'),
            h('button', { key: 'models', type: 'button', style: button, disabled: keysBusy !== '', onClick: () => keyAction('models', () => post('/paratera-balance/api/keys/refresh-models')) }, '更新支持模型'),
          ]),
          keys?.ok && keys.keys ? h('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            keys.keys.map((k) => h('div', { key: k.uuid, style: { ...row, ...muted, borderTop: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))', paddingTop: '6px' } }, [
              h('span', { key: 'name', title: k.masked || '', style: { fontSize: '13px', color: 'inherit', opacity: 1 } }, k.name || '(未命名)'),
              h('span', { key: 'meta', style: muted }, `${k.status === 'valid' ? '已启用' : '已禁用'} · ${k.models.length} 模型 · ${k.created || ''}`),
              h('span', { key: 'ops', style: { display: 'flex', gap: '6px' } }, [
                h('a', { key: 'rename', href: '#', onClick: (e) => { e.preventDefault(); const n = window.prompt('重命名', k.name || ''); if (n) keyAction('rename', () => post('/paratera-balance/api/keys/update', { uuid: k.uuid, name: n })) } }, '改名'),
                h('a', { key: 'import', href: '#', onClick: (e) => { e.preventDefault(); setImporting({ name: k.name, models: k.models, selected: [] }); setImportFilter('') } }, '导入'),
                h('a', { key: 'toggle', href: '#', onClick: (e) => { e.preventDefault(); keyAction('toggle', () => post('/paratera-balance/api/keys/update', { uuid: k.uuid, status: k.status === 'valid' ? 'invalid' : 'valid' })) } }, k.status === 'valid' ? '禁用' : '启用'),
                h('a', { key: 'del', href: '#', onClick: (e) => { e.preventDefault(); if (window.confirm(`确定删除「${k.name}」？删除后无法恢复，且会立即拒绝该密钥的所有请求。`)) keyAction('delete', () => post('/paratera-balance/api/keys/delete', { uuid: k.uuid })) } }, '删除'),
              ]),
            ]))) : (keys && !keys.ok ? h('div', { key: 'err', style: muted }, `读取失败：${keys.error}`) : null),
          importing ? h('div', { key: 'picker', style: { display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))', paddingTop: '8px' } }, [
            h('div', { key: 't', style: { fontSize: '13px' } }, `导入「${importing.name}」：勾选要写入 DSH 配置的模型`),
            h('input', { key: 'f', type: 'text', placeholder: '过滤模型…', value: importFilter, onChange: (e) => setImportFilter(e.target.value), style: { padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))', background: 'transparent', color: 'inherit' } }),
            h('div', { key: 'list', style: { maxHeight: '220px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' } },
              importing.models.filter((m) => !importFilter || m.toLowerCase().includes(importFilter.toLowerCase())).slice(0, 200).map((m) => h('label', { key: m, style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px' } }, [
                h('input', { type: 'checkbox', checked: importing.selected.includes(m), onChange: () => setImporting({ ...importing, selected: importing.selected.includes(m) ? importing.selected.filter((x) => x !== m) : [...importing.selected, m] }) }),
                h('span', null, m),
              ]))),
            h('div', { key: 'a', style: { ...row, justifyContent: 'flex-start' } }, [
              h('button', { key: 'cancel', type: 'button', style: button, onClick: () => { setImporting(null); setImportFilter('') } }, '取消'),
              h('button', { key: 'keyonly', type: 'button', style: button, disabled: keysBusy !== '', onClick: () => keyAction('import', () => post('/paratera-balance/api/keys/import', { name: importing.name })) }, '只导入密钥'),
              h('button', { key: 'go', type: 'button', style: button, disabled: keysBusy !== '' || importing.selected.length === 0, onClick: () => keyAction('import', () => post('/paratera-balance/api/keys/import', { name: importing.name, models: importing.selected })) }, `导入 ${importing.selected.length} 个模型`),
            ]),
          ]) : null,
          h('div', { key: 'note', style: muted }, '导入会读取完整密钥并写入 DSH 凭据（旧值备份到 PARATERA_API_KEY_BACKUP）。'),
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
