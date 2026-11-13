import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const tick = () => new Promise((resolve) => setImmediate(resolve))
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
const key = (overrides = {}) => ({ uuid: 'uuid-one', name: 'test-key', status: 'valid', models: ['model-a'], ...overrides })
const session = (overrides = {}) => ({ operationId: 'operation-one', name: 'DESKTOP-TEST', stage: 'awaiting-selection', models: ['alpha-a', 'alpha-b', 'beta'], selectedModels: [], expiresAt: Date.now() + 600000, fingerprint: 'sha256:fixture', canCommit: true, canCancel: true, cleanupRequired: false, ...overrides })
const snapshot = (value, extra = {}) => response({ ok: true, session: value, ...extra })

// Isolated React hook/element fixture: no native dialog, profile, server or network.
function fixture(handler = () => undefined, options = {}) {
  let entry, component, cursor = 0, unmounted = false, writesAfterUnmount = 0, timerId = 0, nativeDialogCalls = 0
  const sections = new Map()
  const hooks = [], effects = [], requests = [], intervals = new Map(), timers = new Map()
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props: props || {}, children }),
    useState(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[index].value, (value) => {
        if (unmounted) writesAfterUnmount += 1
        hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value
      }]
    },
    useRef(initial) { const index = cursor++; if (!hooks[index]) hooks[index] = { current: initial }; return hooks[index] },
    useCallback(fn, deps) {
      const index = cursor++
      if (!hooks[index] || deps.some((value, i) => value !== hooks[index].deps[i])) hooks[index] = { fn, deps }
      return hooks[index].fn
    },
    useEffect(fn, deps) {
      const index = cursor++
      if (!hooks[index] || deps.some((value, i) => value !== hooks[index].deps[i])) {
        hooks[index]?.cleanup?.()
        hooks[index] = { fn, deps }
        effects.push(hooks[index])
      }
    },
  }
  vm.runInNewContext(source, {
    ...(options.crypto ? { crypto: options.crypto } : {}),
    window: {
      __ModuleLoader__: { load: (value) => { entry = value } },
      prompt: () => { nativeDialogCalls += 1; throw new Error('Native prompt forbidden') },
      confirm: () => { nativeDialogCalls += 1; throw new Error('Native confirm forbidden') },
    },
    AbortController, DOMException,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn) => { const id = ++timerId; intervals.set(id, fn); return id },
    clearInterval: (id) => intervals.delete(id),
    fetch: async (url, options) => {
      const request = { url, options, body: options.body ? JSON.parse(options.body) : undefined }
      requests.push(request)
      const result = await handler(request)
      if (result !== undefined) return result
      if (url.endsWith('/keys')) return response({ ok: true, keys: [key()] })
      if (url.endsWith('/keys/defaults')) return response({ ok: true, name: 'DESKTOP-TEST' })
      if (url.endsWith('/credentials/status')) return response({ saved: false })
      if (url.endsWith('/keys/create-import/status')) return snapshot(null)
      return response({ ok: true })
    },
  })
  const plugin = entry.factory(() => React)
  plugin.apply({ slots: {
    inject: (_, fn) => fn(),
    register: (spec, value) => { if (spec.name === 'settings.section') sections.set(spec.id, value) },
  } })
  component = options.component === 'models' ? plugin.components.ModelsPanel : sections.get('tsinghua-paratera')
  const f = {
    plugin, requests, intervals, timers, sections,
    render() { cursor = 0; return component() },
    mount() { f.render(); for (const effect of effects.splice(0)) effect.cleanup = effect.fn() },
    replayEffects() {
      const mounted = hooks.filter((hook) => hook?.fn && hook?.cleanup)
      for (const hook of mounted) hook.cleanup()
      for (const hook of mounted) hook.cleanup = hook.fn()
    },
    dispose() { unmounted = true; for (const hook of hooks) hook?.cleanup?.() },
    get writesAfterUnmount() { return writesAfterUnmount },
    get nativeDialogCalls() { return nativeDialogCalls },
    submit() { return f.byKey('key-editor').props.onSubmit({ preventDefault() {} }) },
    name(value) { f.byKey('key-name').props.onChange({ target: { value } }) },
    filter(value) { f.byKey('f').props.onChange({ target: { value } }) },
    fireTimer(ms) {
      const entry = [...timers.entries()].find(([, timer]) => timer.ms === ms)
      assert.ok(entry, `missing ${ms}ms timer`)
      timers.delete(entry[0]); entry[1].fn()
    },
    find(predicate) { return walk(f.render()).find(predicate) },
    byKey(name) { const node = f.find((value) => value.props.key === name); assert.ok(node, `missing node ${name}`); return node },
    click(name) { return f.byKey(name).props.onClick({ preventDefault() {} }) },
    text() { return text(f.render()) },
    sent(suffix) { return requests.filter((r) => r.url.endsWith(suffix)) },
    checks() { return walk(f.render()).filter((node) => node.props.type === 'checkbox') },
  }
  f.mount()
  return f
}
function walk(value) {
  if (Array.isArray(value)) return value.flatMap(walk)
  if (!value || typeof value !== 'object') return []
  return [value, ...walk(value.children)]
}
function text(value) {
  if (Array.isArray(value)) return value.map(text).join(' ')
  if (!value || typeof value === 'boolean') return ''
  return typeof value === 'object' ? text(value.children) : String(value)
}
async function loaded(handler, options) { const f = fixture(handler, options); await tick(); await f.click('load'); return f }
async function restored(value = session(), handler) {
  return loaded((r) => handler?.(r) ?? (r.url.endsWith('/create-import/status') ? snapshot(value) : undefined))
}
function assertNoLegacy(f) { assert.equal(f.requests.some((r) => /\/keys\/import(?:\/|$)/.test(r.url)), false) }

for (const [label, result, expected] of [
  ['success', () => response({ ok: true, keys: [key()] }), /密钥列表已加载/],
  ['application failure', () => response({ ok: false, error: 'console-not-connected' }), /控制台尚未连接/],
  ['auth failure', () => response({}, 401), /身份验证失败/],
  ['malformed', () => response({ ok: true, keys: [null] }), /无效数据/],
  ['network failure', () => { throw new TypeError('fixture network') }, /网络连接失败/],
]) test(`list ${label} is truthful and requested once`, async () => {
  const f = await loaded((r) => r.url.endsWith('/keys') ? result() : undefined)
  assert.equal(f.sent('/keys').length, 1)
  assert.match(f.text(), expected)
  assert.equal(f.sent('/keys')[0].options.credentials, 'same-origin')
  assert.equal(f.find((n) => n.props.key === 'import'), undefined)
  assertNoLegacy(f); f.dispose()
})

test('new creation uses host default, editable name and crypto UUID, deduplicates synchronous double submit', async () => {
  const pending = deferred()
  const f = await loaded((r) => r.url.endsWith('/prepare') ? pending.promise : undefined, { crypto: { randomUUID: () => '12345678-1234-4567-89ab-123456789abc' } })
  f.click('create')
  assert.equal(f.byKey('key-name').props.value, 'DESKTOP-TEST')
  assert.match(f.text(), /不代表已关联平台设备/)
  f.name(' my-laptop ')
  const submit = f.byKey('key-editor').props.onSubmit
  const one = submit({ preventDefault() {} }), two = submit({ preventDefault() {} })
  assert.equal(f.sent('/prepare').length, 1)
  assert.deepEqual(f.sent('/prepare')[0].body, { name: 'my-laptop', requestId: '12345678-1234-4567-89ab-123456789abc' })
  assert.equal(f.byKey('create').props.disabled, true)
  f.click('create'); f.click('editor-cancel')
  assert.equal(f.byKey('key-name').props.value, ' my-laptop ')
  pending.resolve(snapshot(session({ name: 'my-laptop' }))); await Promise.all([one, two])
  assert.equal(f.checks().filter((n) => n.props.checked).length, 0)
  assert.match(f.text(), /1 创建设备密钥.*2 筛选模型.*3 导入完成/)
  assert.equal(f.byKey('create').props.disabled, true)
  assert.equal(f.nativeDialogCalls, 0)
  assert.equal(f.byKey('steps').props['aria-label'], '创建导入步骤')
  assert.equal(f.find((n) => n.props['aria-current'] === 'step').children[0], '2 筛选模型')
  assertNoLegacy(f); f.dispose()
})

test('failed status with no created key or cleanup does not permanently lock creating', async () => {
  const f = await restored(session({ stage: 'failed', models: [], canCommit: false, canCancel: false, cleanupRequired: false, error: 'key-quota-exceeded' }))
  assert.equal(f.byKey('create').props.disabled, false)
  f.click('create'); f.name('retry-draft')
  assert.equal(f.byKey('key-name').props.value, 'retry-draft')
  f.dispose()
})

test('verification retry after refresh reuses server requestId and never generates another create identifier', async () => {
  const pending = deferred()
  const requestId = '12345678-1234-4567-89ab-123456789abc'
  const f = await restored(session({ stage: 'failed', canCommit: false, canRetryVerification: true, requestId, models: [], cleanupRequired: true, error: 'verify-failed' }), (r) => r.url.endsWith('/prepare') ? pending.promise : undefined)
  assert.equal(f.byKey('create').props.disabled, true)
  const retry = f.byKey('retry-verification').props.onClick
  const one = retry(), two = retry()
  assert.equal(f.sent('/prepare').length, 1)
  assert.deepEqual(f.sent('/prepare')[0].body, { name: 'DESKTOP-TEST', requestId })
  assert.match(f.text(), /正在验证可用模型/)
  pending.resolve(snapshot(session({ requestId, canRetryVerification: false }))); await Promise.all([one, two])
  assert.equal(f.checks().length, 3)
  assert.equal(f.byKey('keyonly').props.disabled, false)
  assert.equal(f.find((n) => n.props.key === 'retry-verification'), undefined)
  assert.equal(f.sent('/prepare').length, 1)
  f.dispose()
})

test('awaiting selection communicates ten-minute expiry and refresh versus restart recovery', async () => {
  const f = await restored()
  assert.match(text(f.byKey('expiry')), /请在.*前完成导入（创建后 10 分钟）.*刷新页面可恢复；重启 DSH 无法恢复一次性密钥/)
  f.dispose()
})

test('cleanupRequired on an awaiting selection is not presented as expired', async () => {
  const f = await restored(session({ cleanupRequired: true }))
  assert.match(f.text(), /若放弃导入，需要删除刚创建的密钥/)
  assert.doesNotMatch(f.text(), /明文已过期|明文.*不可用/)
  assert.equal(f.byKey('keyonly').props.disabled, false)
  f.dispose()
})

test('fixture-safe UUID fallback and failed prepare preserve editable draft', async () => {
  const f = await loaded((r) => r.url.endsWith('/prepare') ? response({ ok: false, session: null, error: 'key-quota-exceeded' }) : undefined)
  f.click('create'); f.name('draft-name'); await f.submit()
  assert.match(f.sent('/prepare')[0].body.requestId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
  assert.equal(f.byKey('key-name').props.value, 'draft-name')
  assert.match(text(f.byKey('editor-error')), /配额已满/)
  assert.equal(f.byKey('editor-submit').props.disabled, false)
  f.dispose()
})

test('selection starts empty, search is case-insensitive, filtered bulk selection never selects hidden models', async () => {
  const f = await restored()
  assert.equal(f.checks().filter((n) => n.props.checked).length, 0)
  assert.equal(f.byKey('go').props.disabled, true)
  f.filter(' ALPHA '); f.click('all')
  assert.equal(f.checks().length, 2)
  assert.equal(f.checks().filter((n) => n.props.checked).length, 2)
  f.filter('beta'); assert.equal(f.checks()[0].props.checked, false)
  f.click('all'); f.click('clear-filtered'); f.filter('')
  assert.equal(f.checks().filter((n) => n.props.checked).length, 2)
  assert.match(text(f.byKey('picked')), /已选 2 \/ 总数 3/)
  f.filter('alpha'); f.click('all')
  assert.equal(f.checks().filter((n) => n.props.checked).length, 0)
  f.dispose()
})

test('all candidates remain searchable beyond 200 while explicit selection caps at 200', async () => {
  const models = Array.from({ length: 225 }, (_, i) => `fixture-model-${String(i).padStart(3, '0')}`)
  let committed
  const f = await restored(session({ models }), (r) => {
    if (!r.url.endsWith('/commit')) return
    committed = r.body.models
    return snapshot(session({ models, stage: 'completed', canCommit: false, canCancel: false, result: { ok: true, credentialImported: true, modelsAdded: committed } }))
  })
  assert.equal(f.checks().length, 225)
  f.click('all'); assert.equal(f.checks().filter((n) => n.props.checked).length, 200)
  assert.match(text(f.byKey('picked')), /已选 200 \/ 总数 225/)
  f.filter('224'); assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].props.disabled, true)
  f.checks()[0].props.onChange(); assert.match(text(f.byKey('picked')), /已选 200/)
  f.filter(''); f.click('clear-filtered'); f.filter('224'); f.click('all')
  await f.click('go')
  assert.deepEqual(committed, ['fixture-model-224'])
  assert.equal(f.sent('/prepare').length, 0)
  assert.match(f.text(), /密钥已导入 DSH.*新增 1 个模型/)
  assertNoLegacy(f); f.dispose()
})

test('only-save is an explicit empty models commit, never automatic discovery', async () => {
  const f = await restored(session({ models: [] }), (r) => r.url.endsWith('/commit') ? snapshot(session({ stage: 'completed', canCommit: false, canCancel: false, result: { ok: true, credentialImported: true, modelsAdded: [] } })) : undefined)
  await f.click('go'); assert.equal(f.sent('/commit').length, 0)
  await f.click('keyonly')
  assert.deepEqual(f.sent('/commit')[0].body, { operationId: 'operation-one', models: [] })
  assert.match(f.text(), /密钥已导入 DSH.*未添加模型/)
  assertNoLegacy(f); f.dispose()
})

test('pending recovery blocks a second create, polls without overlap and restores awaiting selection', async () => {
  let reads = 0
  const pending = deferred()
  const f = await restored(session({ stage: 'verifying', canCommit: false }), (r) => {
    if (r.url.endsWith('/create-import/status') && ++reads > 1) return pending.promise
  })
  assert.match(f.text(), /正在验证可用模型/)
  assert.equal(f.byKey('create').props.disabled, true)
  f.click('create'); assert.equal(f.find((n) => n.props.key === 'key-editor'), undefined)
  f.fireTimer(2000); await tick()
  assert.equal([...f.timers.values()].filter((t) => t.ms === 2000).length, 0)
  assert.equal(f.sent('/create-import/status').length, 2)
  pending.resolve(snapshot(session())); await tick()
  assert.equal(f.byKey('go').props.disabled, true)
  assert.equal(f.byKey('keyonly').props.disabled, false)
  assert.equal([...f.timers.values()].some((t) => t.ms === 2000), false)
  assert.equal(f.sent('/prepare').length, 0)
  f.dispose()
})

test('failed commit preserves selection, search and retry uses same operation, not prepare', async () => {
  const f = await restored(session(), (r) => r.url.endsWith('/commit') ? response({ ok: false, session: session({ stage: 'failed', selectedModels: r.body.models }), error: 'credential-backup-failed' }) : undefined)
  f.filter('alpha'); f.click('all'); await f.click('go')
  assert.equal(f.byKey('f').props.value, 'alpha')
  assert.equal(f.checks().filter((n) => n.props.checked).length, 2)
  assert.match(f.text(), /旧密钥备份失败/)
  await f.click('go')
  assert.equal(f.sent('/commit').length, 2)
  assert.equal(f.sent('/prepare').length, 0)
  assert.deepEqual(f.sent('/commit')[1].body.models, ['alpha-a', 'alpha-b'])
  f.dispose()
})

for (const httpStatus of [200, 500]) test(`credential partial result survives HTTP ${httpStatus} without offering deletion or re-creation`, async () => {
  const partial = session({ stage: 'failed', canCommit: false, canCancel: false, result: { ok: false, credentialImported: true, modelConfigUpdated: true, modelError: 'model-directory-unavailable' } })
  const f = await restored(session(), (r) => r.url.endsWith('/commit') ? response({ ok: false, session: { ...partial, selectedModels: r.body.models }, result: partial.result, error: 'model-import-failed' }, httpStatus) : undefined)
  f.click('all'); await f.click('go')
  assert.match(f.text(), /密钥已导入 DSH.*模型配置已保存/)
  assert.match(f.text(), /不要再创建密钥/)
  assert.equal(f.find((n) => n.props.key === 'cancel'), undefined)
  assert.equal(f.byKey('create').props.disabled, true)
  assert.equal(f.byKey('go').props.disabled, true)
  assert.equal(f.checks().filter((n) => n.props.checked).length, 3)
  f.dispose()
})

test('expired operation honestly requests cleanup instead of claiming platform key deletion', async () => {
  const f = await restored(session({ stage: 'expired', canCommit: false, canCancel: true, cleanupRequired: true }))
  assert.match(f.text(), /会话已过期.*平台密钥未确认删除/)
  assert.equal(f.byKey('go').props.disabled, true)
  assert.equal(f.byKey('create').props.disabled, true)
  assert.equal(f.sent('/cancel').length, 0)
  f.dispose()
})

test('cancel requires in-page second confirmation and continues selection without sending a request', async () => {
  const f = await restored()
  f.click('all'); f.click('cancel')
  assert.match(text(f.byKey('cancel-confirm')), /删除刚创建的.*不是只关闭此界面/)
  assert.equal(f.sent('/cancel').length, 0)
  f.click('cancel-keep')
  assert.equal(f.find((n) => n.props.key === 'cancel-confirm'), undefined)
  assert.equal(f.checks().filter((n) => n.props.checked).length, 3)
  assert.equal(f.nativeDialogCalls, 0)
  f.dispose()
})

test('confirmed cancellation sends one explicit deletion, failure retains the draft and does not claim removed', async () => {
  const pending = deferred()
  const f = await restored(session(), (r) => r.url.endsWith('/cancel') ? pending.promise : undefined)
  f.filter('alpha'); f.click('all'); f.click('cancel')
  const click = f.byKey('cancel-delete').props.onClick
  const one = click(), two = click()
  assert.equal(f.sent('/cancel').length, 1)
  assert.deepEqual(f.sent('/cancel')[0].body, { operationId: 'operation-one', confirmDelete: true })
  pending.resolve(response({ ok: false, session: session({ stage: 'failed', error: 'key-delete-unconfirmed', cleanupRequired: true }), removed: false, error: 'key-delete-unconfirmed' })); await Promise.all([one, two])
  assert.equal(f.checks().filter((n) => n.props.checked).length, 2)
  assert.equal(f.byKey('f').props.value, 'alpha')
  assert.match(f.text(), /删除结果尚未确认/)
  assert.doesNotMatch(f.text(), /已删除|已取消/)
  f.dispose()
})

for (const removed of [true, false]) test(`successful cancellation removed=${removed} is truthful and terminal`, async () => {
  const f = await restored(session(), (r) => r.url.endsWith('/cancel') ? snapshot(session({ stage: 'cancelled', canCommit: false, canCancel: false }), { removed }) : undefined)
  f.click('cancel'); await f.click('cancel-delete')
  assert.match(f.text(), removed ? /刚创建密钥已删除，流程已取消/ : /已核实无需清理，流程已取消/)
  if (!removed) assert.doesNotMatch(f.text(), /密钥已删除/)
  assert.equal(f.byKey('create').props.disabled, false)
  assert.equal(f.find((n) => n.props.key === 'go'), undefined)
  f.dispose()
})

for (const kind of ['prepare', 'commit']) test(`${kind} timeout recovers status first, never resubmits or erases selections`, async () => {
  let reads = 0
  const f = await loaded((r) => {
    if (r.url.endsWith('/create-import/status')) return snapshot(++reads === 1 && kind === 'prepare' ? null : session())
    if (r.url.endsWith(`/${kind}`)) return new Promise((_, reject) => r.options.signal.addEventListener('abort', () => reject(new DOMException('fixture abort', 'AbortError'))))
  })
  let task
  if (kind === 'prepare') { f.click('create'); f.name('timeout-draft'); task = f.submit() }
  else { f.click('all'); task = f.click('go') }
  f.fireTimer(30000); await task; await tick()
  assert.equal(f.sent(`/${kind}`).length, 1)
  assert.equal(f.sent('/create-import/status').length, 2)
  assert.equal(f.byKey('create').props.disabled, true)
  if (kind === 'commit') assert.equal(f.checks().filter((n) => n.props.checked).length, 3)
  assertNoLegacy(f); f.dispose()
})

test('unknown creation with null status keeps draft locked and never auto-retries prepare', async () => {
  const f = await loaded((r) => r.url.endsWith('/prepare') ? Promise.reject(new TypeError('fixture offline')) : undefined)
  f.click('create'); f.name('unknown-draft'); await f.submit(); await tick()
  assert.equal(f.byKey('key-name').props.value, 'unknown-draft')
  assert.match(f.text(), /结果尚未确认.*不要重复创建/)
  assert.equal(f.byKey('create').props.disabled, true)
  assert.equal(f.sent('/prepare').length, 1)
  await f.submit(); assert.equal(f.sent('/prepare').length, 1)
  f.dispose()
})

for (const selectedModels of [['beta'], []]) test(`other-tab submitted selection is authoritative: ${JSON.stringify(selectedModels)}`, async () => {
  let reads = 0
  const f = await restored(session(), (r) => r.url.endsWith('/create-import/status') && ++reads > 1 ? snapshot(session({ stage: 'models', canCommit: false, canCancel: false, selectedModels })) : undefined)
  f.filter('alpha'); f.click('all')
  await tick()
  const refresh = f.click('session-refresh'); await tick()
  assert.match(text(f.byKey('picked')), new RegExp(`已选 ${selectedModels.length}`))
  f.filter('')
  assert.equal(f.byKey('go').props.disabled, true)
  f.dispose(); await refresh
})

test('late status cannot overwrite a committed result and active request is aborted', async () => {
  let reads = 0
  const late = deferred()
  const f = await restored(session(), (r) => {
    if (r.url.endsWith('/create-import/status') && ++reads > 1) return late.promise
    if (r.url.endsWith('/commit')) return snapshot(session({ stage: 'completed', canCommit: false, canCancel: false, result: { ok: true, credentialImported: true } }))
  })
  const refresh = f.click('session-refresh'); await tick()
  const active = f.sent('/create-import/status').at(-1)
  await f.click('keyonly')
  assert.equal(active.options.signal.aborted, true)
  late.resolve(snapshot(session({ stage: 'verifying', canCommit: false }))); await refresh
  assert.match(f.text(), /导入完成.*密钥已导入 DSH/)
  assert.equal(f.byKey('create').props.disabled, false)
  f.dispose()
})

test('StrictMode replay aborts all stale requests and only current snapshot updates the card', async () => {
  const stale = deferred()
  let reads = 0
  const f = fixture((r) => r.url.endsWith('/create-import/status') ? ++reads === 1 ? stale.promise : snapshot(session()) : undefined)
  const first = [...f.requests]
  f.replayEffects(); await tick()
  assert.ok(first.filter((r) => r.options.signal).every((r) => r.options.signal.aborted))
  stale.resolve(snapshot(session({ stage: 'completed', canCommit: false }))); await tick()
  assert.match(f.text(), /请选择模型/)
  assert.equal(f.byKey('keyonly').props.disabled, false)
  f.dispose(); assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0)
})

for (const mode of ['mutation', 'status', 'wait']) test(`unmount cleans ${mode} requests/timers and rejects late state writes`, async () => {
  const pending = deferred()
  let f, task
  if (mode === 'mutation') {
    f = await restored(session(), (r) => r.url.endsWith('/commit') ? pending.promise : undefined)
    task = f.click('keyonly')
  } else if (mode === 'status') {
    f = fixture((r) => r.url.endsWith('/create-import/status') ? pending.promise : undefined)
  } else f = await restored(session({ stage: 'saving', canCommit: false, canCancel: false }))
  const before = f.requests.length
  f.dispose()
  if (mode === 'mutation') assert.equal(f.sent('/commit').at(-1).options.signal.aborted, true)
  if (mode === 'status') assert.equal(f.sent('/create-import/status').at(-1).options.signal.aborted, true)
  pending.resolve(snapshot(session({ stage: 'completed', canCommit: false })))
  await task; await tick()
  assert.equal(f.requests.length, before)
  assert.equal(f.writesAfterUnmount, 0)
  assert.equal(f.timers.size, 0)
  assert.equal(f.intervals.size, 0)
})

test('session projections render no secret fields and requests never carry plaintext', async () => {
  const marker = 'sk-fictional-secret-never-display'
  const f = await restored(session({ secret: marker, apiKey: marker, error: marker, result: { ok: false, credentialImported: false, secret: marker, error: marker } }))
  assert.doesNotMatch(f.text(), new RegExp(marker))
  assert.equal(JSON.stringify(f.requests.map((r) => r.body)).includes(marker), false)
  assertNoLegacy(f); f.dispose()
})

test('management retains rename, enable/disable and explicit delete without any import entry', async () => {
  const f = await loaded()
  f.click('rename'); f.name('renamed'); await f.submit()
  assert.deepEqual(f.sent('/keys/update')[0].body, { uuid: 'uuid-one', name: 'renamed' })
  await f.click('toggle')
  assert.deepEqual(f.sent('/keys/update')[1].body, { uuid: 'uuid-one', status: 'invalid' })
  f.click('del'); f.click('editor-cancel'); assert.equal(f.sent('/keys/delete').length, 0)
  f.click('del'); await f.submit()
  assert.deepEqual(f.sent('/keys/delete')[0].body, { uuid: 'uuid-one' })
  assert.equal(f.find((n) => n.props.key === 'import'), undefined)
  f.dispose()
})

test('stale form handlers cannot mutate or close a later management draft', async () => {
  const f = await loaded()
  f.click('create'); f.name('old-draft')
  const old = f.byKey('key-editor').props.onSubmit, cancel = f.byKey('editor-cancel').props.onClick
  f.click('editor-cancel'); f.click('rename')
  await old({ preventDefault() {} }); cancel()
  assert.equal(f.byKey('key-name').props.value, 'test-key')
  assert.equal(f.sent('/prepare').length, 0)
  f.dispose()
})

test('credential dialog waits for closure before login and preserves old credentials on cancel', async () => {
  for (const cancelled of [false, true]) {
    let dialog = true
    const f = fixture((r) => r.url.endsWith('/credentials/status') ? response({ saved: true, dialog, dialogResult: dialog ? null : cancelled ? 'cancelled' : 'saved' }) : undefined)
    await tick()
    const task = f.click('cred'); await tick()
    f.fireTimer(1000); await tick()
    assert.equal(f.sent('/api/refresh').length, 0)
    dialog = false
    f.fireTimer(1000); await task
    assert.equal(f.sent('/api/refresh').length, cancelled ? 0 : 1)
    if (cancelled) assert.match(f.text(), /原有凭据保持不变/)
    f.dispose()
  }
})

test('unmount cancels credential window waits without further requests', async () => {
  const f = fixture(); await tick()
  const task = f.click('cred'); await tick()
  const count = f.requests.length
  assert.ok([...f.timers.values()].some((t) => t.ms === 1000))
  f.dispose(); await task
  assert.equal(f.requests.length, count)
  assert.equal(f.timers.size, 0)
  assert.equal(f.writesAfterUnmount, 0)
})

for (const saved of [false, true]) test(`password removal requires explicit capability (saved=${saved})`, async () => {
  const f = fixture((r) => r.url.endsWith('/credentials/status') ? response({ saved, canRemove: 'true' }) : undefined)
  await tick()
  assert.equal(f.find((n) => n.props.key === 'forget'), undefined)
  f.dispose()
})

test('account login and optional saved password deletion keep explicit in-page confirmation', async () => {
  const f = await loaded((r) => r.url.endsWith('/credentials/status') ? response({ saved: true, canRemove: true }) : undefined)
  await f.click('login'); assert.equal(f.sent('/login').length, 1)
  f.click('forget'); assert.equal(f.sent('/credentials').length, 0)
  const group = f.byKey('forget-confirm')
  walk(group).find((n) => n.props.key === 'no').props.onClick()
  assert.equal(f.sent('/credentials').length, 0)
  f.click('forget'); await walk(f.byKey('forget-confirm')).find((n) => n.props.key === 'yes').props.onClick()
  assert.deepEqual(f.sent('/credentials')[0].body, { confirm: true })
  assert.equal(f.sent('/credentials')[0].options.method, 'DELETE')
  assert.equal(f.nativeDialogCalls, 0)
  f.dispose()
})

test('two-factor choice, code and opt-in trust remain available', async () => {
  let chosen = false
  const f = await loaded((r) => {
    if (r.url.endsWith('/2fa/status')) return response({ pending: true, stage: chosen ? 'code' : 'choose', methods: [{ id: 'mobile', label: '短信' }] })
    if (r.url.endsWith('/2fa/choose')) { chosen = true; return response({ ok: true }) }
  })
  await f.click('mobile')
  f.byKey('input').props.onChange({ target: { value: '123456' } })
  assert.equal(f.byKey('trust').props.checked, false)
  f.byKey('trust').props.onChange({ target: { checked: true } })
  await f.click('submit')
  assert.deepEqual(f.sent('/2fa/code')[0].body, { code: '123456', trustDevice: true })
  f.dispose()
})

test('models panel tab and host diagnostics remain intact', async () => {
  const f = await loaded((r) => r.url.endsWith('/diagnostics') ? response({ ok: true, host: { version: 'fixture-host' }, plugin: { version: 'fixture-plugin' } }) : undefined)
  assert.match(f.text(), /宿主 DSH fixture-host.*插件 fixture-plugin/)
  f.click('tab-models')
  assert.ok(f.find((n) => n.tag === f.plugin.components.ModelsPanel))
  f.dispose()
})

const modelRow = (overrides = {}) => ({
  id: 'Kimi-K3', name: 'Kimi-K3', contextWindow: 262144, maxTokens: 8192, input: ['text'],
  recommended: { id: 'Kimi-K3', name: 'Kimi-K3', contextWindow: 1024000, maxTokens: 943718, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
  ...overrides,
})
function modelsFixture(options = {}) {
  return fixture((r) => {
    if (!r.url.endsWith('/api/models')) return response({ ok: true })
    if (r.options.method === 'POST') return response({ ok: true, revision: 9, models: r.body.models })
    return response({ ok: true, revision: 8, models: options.rows ?? [modelRow()] })
  }, { component: 'models' })
}

test('模型设置 loads host models, edits input/name/context and saves exact revisioned data', async () => {
  const f = modelsFixture(); await tick()
  assert.match(f.text(), /Kimi-K3.*恢复推荐值/)
  f.find((n) => n.props['data-field'] === 'contextWindow').props.onChange({ target: { value: '200000' } })
  f.find((n) => n.props['data-field'] === 'image').props.onChange()
  f.find((n) => n.props['data-field'] === 'name').props.onChange({ target: { value: 'Kimi K3' } })
  await f.click('save-models')
  const posts = f.sent('/api/models').filter((r) => r.options.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body, { revision: 8, models: [{ id: 'Kimi-K3', name: 'Kimi K3', contextWindow: 200000, maxTokens: 8192, input: ['text', 'image'] }] })
  assert.match(f.text(), /已保存 1 个模型设置/)
  f.dispose()
})

for (const level of ['max', 'medium']) test(`first thinking tick ${level} seeds native low/high/max`, async () => {
  const f = modelsFixture(); await tick()
  assert.match(f.text(), /未勾选＝跟随模型原生/)
  assert.equal(f.find((n) => n.props['data-field'] === 'reasoning-mode'), undefined)
  f.find((n) => n.props['data-field'] === 'level-' + level).props.onChange()
  for (const item of ['low', 'high', 'max']) assert.equal(f.find((n) => n.props['data-field'] === 'level-' + item).props.checked, true)
  await f.click('save-models')
  const post = f.sent('/api/models').find((r) => r.options.method === 'POST')
  assert.deepEqual(post.body.models[0].reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max', ...(level === 'medium' ? { medium: 'medium' } : {}) })
  f.dispose()
})

test('clearing all thinking levels restores native behavior', async () => {
  const f = modelsFixture({ rows: [modelRow({ reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } })] }); await tick()
  for (const level of ['low', 'high', 'max']) f.find((n) => n.props['data-field'] === 'level-' + level).props.onChange()
  assert.match(f.text(), /未勾选＝跟随模型原生/)
  await f.click('save-models')
  assert.equal(f.sent('/api/models').find((r) => r.options.method === 'POST').body.models[0].reasoningEfforts, undefined)
  f.dispose()
})

test('thinking levels remain individually editable', async () => {
  const f = modelsFixture({ rows: [modelRow({ reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } })] }); await tick()
  f.find((n) => n.props['data-field'] === 'level-medium').props.onChange()
  f.find((n) => n.props['data-field'] === 'level-low').props.onChange()
  await f.click('save-models')
  assert.deepEqual(f.sent('/api/models').find((r) => r.options.method === 'POST').body.models[0].reasoningEfforts, { off: null, medium: 'medium', high: 'high', max: 'max' })
  f.dispose()
})

test('maximum recommended model parameters save immediately without changing input type', async () => {
  const f = modelsFixture(); await tick(); await f.click('max-all')
  const post = f.sent('/api/models').find((r) => r.options.method === 'POST')
  assert.deepEqual(post.body.models, [{ id: 'Kimi-K3', name: 'Kimi-K3', contextWindow: 1024000, maxTokens: 943718, input: ['text'] }])
  assert.match(f.text(), /已保存 1 个模型设置/)
  f.dispose()
})

test('invalid model edits do not POST and reset/delete remain available', async () => {
  const f = modelsFixture(); await tick()
  f.find((n) => n.props['data-field'] === 'contextWindow').props.onChange({ target: { value: '0' } })
  await f.click('save-models')
  assert.equal(f.sent('/api/models').filter((r) => r.options.method === 'POST').length, 0)
  assert.match(f.text(), /模型设置无效/)
  f.click('reset')
  assert.equal(f.find((n) => n.props['data-field'] === 'contextWindow').props.value, 1024000)
  f.click('del'); await f.click('save-models')
  assert.deepEqual(f.sent('/api/models').find((r) => r.options.method === 'POST').body.models, [])
  f.dispose()
})

test('model settings still load and handle unavailable Settings service safely', async () => {
  const f = fixture((r) => r.url.endsWith('/models') ? response({ ok: false, error: 'settings-unavailable' }) : undefined, { component: 'models' })
  await tick()
  assert.match(f.text(), /设置服务暂不可用/)
  f.dispose()
})
