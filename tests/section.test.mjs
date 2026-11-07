import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const tick = () => new Promise((resolve) => setImmediate(resolve))
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
const key = (overrides = {}) => ({ uuid: 'uuid-one', name: 'same-name', status: 'valid', models: ['model-a'], ...overrides })

// Hook/element fixture only: no real React server, session, profile, or network.
function fixture(handler = () => undefined, options = {}) {
  let entry, component, cursor = 0, unmounted = false, writesAfterUnmount = 0, timerId = 0, nativeDialogCalls = 0
  const sections = new Map()
  const hooks = [], effects = [], requests = [], intervals = new Map(), timers = new Map()
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props: props || {}, children }),
    useState(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: initial }
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
    window: {
      __ModuleLoader__: { load: (value) => { entry = value } },
      prompt: () => { nativeDialogCalls += 1; throw new Error('window.prompt is not supported in Electron') },
      confirm: () => { nativeDialogCalls += 1; throw new Error('window.confirm must not be used') },
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
      if (url === '/tsinghua-paratera/api/keys') return response({ ok: true, keys: [key()] })
      if (url === '/tsinghua-paratera/api/credentials/status') return response({ saved: false })
      if (url === '/tsinghua-paratera/api/keys/import/status') return response({ ok: true, running: false, stage: 'idle', startedAt: null, operationId: null, result: null })
      return response({ ok: true })
    },
  })
  const plugin = entry.factory(() => React)
  plugin.apply({ slots: {
    inject: (_, fn) => fn(),
    register: (spec, value) => { if (spec.name === 'settings.section') sections.set(spec.id, value) },
  } })
  component = options.component === 'models' ? plugin.components.ModelsPanel : sections.get('tsinghua-paratera')
  const fixture = {
    plugin, requests, intervals, timers, sections,
    section(id) { return sections.get(id) },
    render() { cursor = 0; return component() },
    mount() { fixture.render(); for (const effect of effects.splice(0)) effect.cleanup = effect.fn() },
    replayEffects() {
      const mounted = hooks.filter((hook) => hook?.fn && hook?.cleanup)
      for (const hook of mounted) hook.cleanup()
      for (const hook of mounted) hook.cleanup = hook.fn()
    },
    dispose() { unmounted = true; for (const hook of hooks) hook?.cleanup?.() },
    get writesAfterUnmount() { return writesAfterUnmount },
    get nativeDialogCalls() { return nativeDialogCalls },
    submit() { return fixture.byKey('key-editor').props.onSubmit({ preventDefault() {} }) },
    name(value) { fixture.byKey('key-name').props.onChange({ target: { value } }) },
    fireTimer(ms) {
      const entry = [...timers.entries()].find(([, timer]) => timer.ms === ms)
      assert.ok(entry, `missing ${ms}ms timer`)
      timers.delete(entry[0]); entry[1].fn()
    },
    find(predicate) { return walk(fixture.render()).find(predicate) },
    byKey(name) { const node = fixture.find((value) => value.props.key === name); assert.ok(node, `missing node ${name}`); return node },
    click(name) { return fixture.byKey(name).props.onClick({ preventDefault() {} }) },
    text() { return text(fixture.render()) },
  }
  fixture.mount()
  return fixture
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
async function loaded(handler) { const f = fixture(handler); await tick(); await f.click('load'); return f }
const keyRequests = (f) => f.requests.filter((r) => r.url === '/tsinghua-paratera/api/keys')
const importRequests = (f) => f.requests.filter((r) => r.url === '/tsinghua-paratera/api/keys/import')
function picker(f) { return f.find((node) => node.props.key === 'picker') }
function select(f, index = 0) { const checkboxes = walk(f.render()).filter((node) => node.props.type === 'checkbox'); if (!checkboxes[index].props.checked) checkboxes[index].props.onChange() }
function clearSelection(f) { for (const checkbox of walk(f.render()).filter((node) => node.props.type === 'checkbox' && node.props.checked)) checkbox.props.onChange() }

test('load keys makes exactly one request and reports a truthful success', async () => {
  const f = await loaded()
  assert.equal(keyRequests(f).length, 1)
  assert.match(f.text(), /密钥列表已加载/)
  assert.equal(keyRequests(f)[0].options.credentials, 'same-origin')
  f.dispose()
})

for (const [name, handler, expected] of [
  ['application failure', () => response({ ok: false, error: 'console-not-connected' }), /控制台尚未连接/],
  ['HTTP authentication failure', () => response({ error: 'HTTP 401' }, 401), /身份验证失败/],
  ['invalid JSON', () => ({ ok: true, json: async () => { throw new Error('bad JSON') } }), /无效数据/],
  ['malformed keys', () => response({ ok: true }), /无效数据/],
  ['malformed key row', () => response({ ok: true, keys: [null] }), /无效数据/],
  ['nonboolean success', () => response({ ok: 'false', keys: [] }), /无效数据/],
  ['network failure', () => { throw new TypeError('Failed to fetch') }, /网络连接失败/],
]) {
  test(`load keys never reports success on ${name}`, async () => {
    const f = await loaded((r) => r.url.endsWith('/keys') ? handler() : undefined)
    assert.equal(keyRequests(f).length, 1)
    assert.match(f.text(), expected)
    assert.doesNotMatch(f.text(), /操作完成|密钥列表已加载/)
    f.dispose()
  })
}

test('object modelScale entries normalize, filter and import string IDs using uuid', async () => {
  const models = [' model-a ', { modelId: 'model-b', name: 'Display' }, { id: 'model-c' }, { model: 'model-d' }, { modelName: 'model-e' }, { name: 'model-f' }, { modelId: 'model-b' }, null, 3, {}, { id: 4 }]
  const f = await loaded((r) => {
    if (r.url.endsWith('/keys')) return response({ ok: true, keys: [key({ models })] })
    if (r.url.endsWith('/keys/import')) return response({ ok: true, credentialImported: true, verifiedModels: 6, modelsAdded: ['model-b'], needsRestart: false, fingerprint: 'mock****print' })
  })
  f.click('import')
  assert.equal(walk(f.render()).filter((node) => node.props.type === 'checkbox').length, 6)
  clearSelection(f)
  f.byKey('f').props.onChange({ target: { value: 'MODEL-B' } })
  assert.equal(walk(f.render()).filter((node) => node.props.type === 'checkbox').length, 1)
  select(f)
  await f.click('go')
  assert.deepEqual(importRequests(f)[0].body, { uuid: 'uuid-one', models: ['model-b'] })
  assert.match(f.text(), /密钥已导入 DSH.*指纹 mock\*\*\*\*print.*已验证 6 个可用模型.*新增 1 个模型/)
  assert.doesNotMatch(f.text(), /重启/)
  assert.equal(picker(f), undefined)
  assert.equal(keyRequests(f).length, 2)
  f.dispose()
})

test('duplicate key names select the correct uuid and key-only import omits models', async () => {
  const f = await loaded((r) => {
    if (r.url.endsWith('/keys')) return response({ ok: true, keys: [key(), key({ uuid: 'uuid-two' })] })
    if (r.url.endsWith('/keys/import')) return response({ ok: true, credentialImported: true, modelsAdded: [], needsRestart: true })
  })
  const links = walk(f.render()).filter((node) => node.props.key === 'import')
  links[1].props.onClick({ preventDefault() {} })
  await f.click('keyonly')
  assert.deepEqual(importRequests(f)[0].body, { uuid: 'uuid-two' })
  assert.match(f.text(), /完全退出并重启 DSH/)
  f.dispose()
})

test('legacy key entries without uuid retain name import compatibility', async () => {
  const f = await loaded((r) => r.url.endsWith('/keys') ? response({ ok: true, keys: [key({ uuid: null })] })
    : r.url.endsWith('/keys/import') ? response({ ok: true, credentialImported: true }) : undefined)
  f.click('import'); await f.click('keyonly')
  assert.deepEqual(importRequests(f)[0].body, { name: 'same-name' })
  f.dispose()
})

for (const ok of [true, false]) {
  test(`modelError is explicit partial success even when ok=${ok}`, async () => {
    const f = await loaded((r) => r.url.endsWith('/keys/import') ? response({ ok, credentialImported: true, error: 'model-import-failed', modelError: 'settings-unavailable', modelsAdded: [], needsRestart: false }) : undefined)
    f.click('import'); select(f); await f.click('go')
    assert.match(f.text(), /密钥已导入 DSH.*模型导入失败.*设置服务暂不可用.*密钥已保存/)
    assert.doesNotMatch(f.text(), /操作完成|新增 0/)
    assert.ok(picker(f), 'keep selected models so the user can retry')
    f.dispose()
  })
}

test('credential failure is not presented as an imported key', async () => {
  const f = await loaded((r) => r.url.endsWith('/keys/import') ? response({ ok: false, credentialImported: false, error: 'credential-backup-failed' }) : undefined)
  f.click('import'); await f.click('keyonly')
  assert.match(f.text(), /导入失败.*旧密钥备份失败.*未覆盖现有密钥/)
  assert.doesNotMatch(f.text(), /密钥已导入 DSH|操作完成/)
  assert.ok(picker(f)); f.dispose()
})

test('partial success information survives an HTTP error body', async () => {
  const f = await loaded((r) => r.url.endsWith('/keys/import') ? response({ ok: false, credentialImported: true, modelError: 'config-conflict', needsRestart: true }, 500) : undefined)
  f.click('import'); await f.click('keyonly')
  assert.match(f.text(), /密钥已导入 DSH.*模型导入失败.*其他操作更新.*重启 DSH/)
  f.dispose()
})

test('a refresh failure does not erase successful credential import', async () => {
  let loads = 0
  const f = await loaded((r) => {
    if (r.url.endsWith('/keys') && ++loads > 1) return response({ ok: false, error: 'console-session-expired' })
    if (r.url.endsWith('/keys/import')) return response({ ok: true, credentialImported: true, modelsAdded: ['model-a'], needsRestart: false })
  })
  f.click('import'); await f.click('keyonly')
  assert.match(f.text(), /密钥已导入 DSH.*密钥列表刷新失败.*会话已过期/)
  f.dispose()
})

test('synchronous double-click load is deduplicated before React rerenders', async () => {
  const pending = deferred()
  const f = fixture((r) => r.url.endsWith('/keys') ? pending.promise : undefined)
  await tick()
  const click = f.byKey('load').props.onClick
  const one = click(), two = click()
  assert.equal(keyRequests(f).length, 1)
  assert.equal(f.byKey('load').props.disabled, true)
  pending.resolve(response({ ok: true, keys: [] })); await Promise.all([one, two])
  assert.equal(keyRequests(f).length, 1)
  assert.equal(f.byKey('load').props.disabled, false)
  f.dispose()
})

test('import blocks concurrent import/mutation and protects picker selection', async () => {
  const pending = deferred()
  const f = await loaded((r) => r.url.endsWith('/keys/import') ? pending.promise : undefined)
  f.click('import'); select(f)
  const run = f.byKey('go').props.onClick
  const one = run(), two = run()
  await f.click('models')
  assert.equal(importRequests(f).length, 1)
  assert.equal(f.requests.filter((r) => r.url.endsWith('/refresh-models')).length, 0)
  assert.equal(f.byKey('connect').props.disabled, true)
  await f.click('connect')
  assert.equal(f.requests.filter((r) => r.url.endsWith('/console/connect')).length, 0)
  const cancel = walk(picker(f)).find((node) => node.props.key === 'cancel')
  assert.equal(cancel.props.disabled, true)
  cancel.props.onClick()
  assert.ok(picker(f))
  assert.equal(walk(f.render()).find((node) => node.props.type === 'checkbox').props.disabled, true)
  pending.resolve(response({ ok: true, credentialImported: true })); await Promise.all([one, two])
  assert.equal(keyRequests(f).length, 2)
  f.dispose()
})

test('unmount aborts import and prevents refreshes and state writes even if fetch ignores abort', async () => {
  const pending = deferred()
  const f = await loaded((r) => r.url.endsWith('/keys/import') ? pending.promise : undefined)
  f.click('import'); const task = f.click('keyonly')
  f.dispose()
  assert.equal(importRequests(f)[0].options.signal.aborted, true)
  assert.equal(f.timers.size, 0, 'request deadlines clear immediately, even if fetch ignores abort')
  pending.resolve(response({ ok: true, credentialImported: true })); await task
  assert.equal(keyRequests(f).length, 1)
  assert.equal(f.writesAfterUnmount, 0)
  assert.equal(f.timers.size, 0)
  assert.equal(f.intervals.size, 0)
})

test('status polling is nonoverlapping and stops its chain on unmount', async () => {
  const pending = deferred()
  const f = fixture((r) => r.url.endsWith('/api/status') ? pending.promise : undefined)
  const tracked = (r) => !r.url.endsWith('/import/status') && !/\/diagnostics(\/hello)?$/.test(r.url)
  await Promise.all([...f.intervals.values()].map((fn) => fn()))
  assert.equal(f.requests.filter(tracked).length, 1)
  f.dispose()
  assert.equal(f.requests.find((r) => r.url.endsWith('/api/status')).options.signal.aborted, true)
  pending.resolve(response({ ok: true })); await tick()
  assert.equal(f.requests.filter(tracked).length, 1)
  assert.equal(f.writesAfterUnmount, 0)
})

test('credential polling wait is cancelled on unmount without later requests', async () => {
  const f = fixture(); await tick()
  const task = f.click('cred'); await tick()
  assert.ok([...f.timers.values()].some((timer) => timer.ms === 1000))
  const count = f.requests.length
  f.dispose(); await task
  assert.equal(f.requests.length, count)
  assert.equal(f.timers.size, 0)
  assert.equal(f.writesAfterUnmount, 0)
})

test('existing credentials do not trigger login until the Mac credential window closes', async () => {
  let dialog = true
  const f = fixture((r) => r.url.endsWith('/credentials/status') ? response({ saved: true, dialog, dialogResult: dialog ? null : 'saved' }) : undefined)
  await tick()
  const task = f.click('cred'); await tick()
  f.fireTimer(1000); await tick()
  assert.equal(f.requests.some((r) => r.url.endsWith('/api/refresh')), false)
  dialog = false
  f.fireTimer(1000); await task
  assert.equal(f.requests.filter((r) => r.url.endsWith('/api/refresh')).length, 1)
  f.dispose()
})

test('cancelling Mac credential rotation preserves the old credential without automatic login', async () => {
  const f = fixture((r) => r.url.endsWith('/credentials/status') ? response({ saved: true, dialog: false, dialogResult: 'cancelled' }) : undefined)
  await tick()
  const task = f.click('cred'); await tick()
  f.fireTimer(1000); await task
  assert.match(f.text(), /已取消，原有凭据保持不变/)
  assert.equal(f.requests.some((r) => r.url.endsWith('/api/refresh')), false)
  f.dispose()
})

test('StrictMode effect replay does not allow an aborted status request to overwrite current state', async () => {
  const pending = deferred()
  let statuses = 0
  const f = fixture((r) => r.url.endsWith('/api/status') ? (++statuses === 1 ? pending.promise : response({ ok: true, tokenValid: true })) : undefined)
  f.replayEffects(); await tick()
  assert.equal(f.requests.find((r) => r.url.endsWith('/api/status')).options.signal.aborted, true)
  assert.match(f.text(), /已登录/)
  assert.equal(f.timers.size, 0)
  pending.resolve(response({ ok: true, tokenValid: false })); await tick()
  assert.match(f.text(), /已登录/)
  assert.equal(f.requests.filter((r) => r.url.endsWith('/console/status')).length, 1)
  assert.equal(f.intervals.size, 1)
  f.dispose()
})

for (const status of ['invalid', 'disabled']) {
  test(`a known ${status} key cannot open the import picker or send an import`, async () => {
    const f = await loaded((r) => r.url.endsWith('/keys') ? response({ ok: true, keys: [key({ status })] }) : undefined)
    assert.equal(f.byKey('import').props['aria-disabled'], true)
    f.click('import')
    assert.equal(picker(f), undefined)
    assert.equal(importRequests(f).length, 0)
    assert.match(f.text(), /该密钥已禁用，请先启用再导入/)
    f.dispose()
  })
}

test('empty model lists discover verified models with autoModels while key-only remains explicit', async () => {
  const f = await loaded((r) => r.url.endsWith('/keys') ? response({ ok: true, keys: [key({ models: [null, {}, 42] })] }) : undefined)
  f.click('import')
  assert.match(f.text(), /暂无可选模型.*自动发现可用模型/)
  assert.match(text(f.byKey('keyonly')), /仅保存密钥/)
  assert.equal(f.byKey('go').props.disabled, false)
  await f.click('go')
  assert.deepEqual(importRequests(f)[0].body, { uuid: 'uuid-one', autoModels: true })
  f.dispose()
})

for (const [code, expected] of [
  ['credential-write-failed', /密钥未能写入 DSH 凭据/],
  ['model-not-available', /所选模型当前不可用/],
  ['key-disabled', /该密钥已禁用/],
  ['console-session-missing', /先点击「连接控制台」/],
  ['verify-invalid-response', /未返回有效模型列表/],
  ['provider-config-invalid', /配置格式不受支持/],
  ['key-import-busy', /已有密钥导入正在进行/],
  ['no-available-models', /没有可用模型.*检查平台授权/],
  ['model-selection-required', /超过 200 个.*最多 200 个模型/],
]) {
  test(`import failure ${code} provides a friendly actionable message`, async () => {
    const f = await loaded((r) => r.url.endsWith('/keys/import') ? response({ ok: false, credentialImported: false, error: code }) : undefined)
    f.click('import'); await f.click('keyonly')
    assert.match(f.text(), expected)
    assert.doesNotMatch(f.text(), /操作完成|密钥已导入 DSH/)
    assert.ok(picker(f))
    f.dispose()
  })
}

test('an explicit credentialImported false is not hidden by an inconsistent ok true', async () => {
  const f = await loaded((r) => r.url.endsWith('/keys/import') ? response({ ok: true, credentialImported: false }) : undefined)
  f.click('import'); await f.click('keyonly')
  assert.match(f.text(), /导入失败.*密钥未能写入/)
  assert.ok(picker(f)); f.dispose()
})

test('ordinary status and key-list requests retain 30-second deadlines', async () => {
  const status = deferred(), keys = deferred()
  const f = fixture((r) => r.url.endsWith('/api/status') ? status.promise : r.url.endsWith('/keys') ? keys.promise : undefined)
  assert.deepEqual([...f.timers.values()].map((timer) => timer.ms), [30000, 30000])
  status.resolve(response({ ok: true })); await tick()
  const task = f.click('load')
  assert.deepEqual([...f.timers.values()].map((timer) => timer.ms), [30000])
  keys.resolve(response({ ok: true, keys: [] })); await task
  f.dispose()
})

for (const [operation, deadline] of [['connect', 240000], ['keyonly', 300000]]) {
  test(`${operation} uses its browser-operation deadline of ${deadline}ms`, async () => {
    const pending = deferred()
    const endpoint = operation === 'connect' ? '/console/connect' : '/keys/import'
    const f = await loaded((r) => r.url.endsWith(endpoint) ? pending.promise : undefined)
    if (operation === 'keyonly') f.click('import')
    const task = f.click(operation)
    assert.deepEqual([...f.timers.values()].map((timer) => timer.ms).filter((ms) => ms !== 2000), [deadline])
    pending.resolve(response({ ok: true, credentialImported: true })); await task
    f.dispose()
  })
}

test('a timed-out import has an unknown result, not a claim that host writes were cancelled', async () => {
  let finishHost, hostSaved = false
  const f = await loaded((r) => {
    if (!r.url.endsWith('/keys/import')) return
    return new Promise((resolve, reject) => {
      r.options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      finishHost = () => { hostSaved = true; resolve(response({ ok: true, credentialImported: true })) }
    })
  })
  f.click('import'); const task = f.click('keyonly')
  const timeout = [...f.timers.values()].find((timer) => timer.ms === 300000)
  assert.ok(timeout); timeout.fn(); await task
  assert.equal(importRequests(f)[0].options.signal.aborted, true)
  assert.match(f.text(), /操作结果未知.*请勿重复导入.*稍后检查宿主状态/)
  assert.match(f.text(), /中止请求不会撤销宿主端的写入/)
  assert.doesNotMatch(f.text(), /导入失败|未保存|未能写入|密钥已导入 DSH|操作完成/)
  const before = f.byKey('key-notice').children.join('')
  finishHost(); await tick()
  assert.equal(hostSaved, true, 'host may still commit after the HTTP client aborts')
  assert.equal(f.byKey('key-notice').children.join(''), before)
  assert.ok(picker(f))
  assert.equal(keyRequests(f).length, 1, 'no automatic retry or refresh after uncertain import')
  f.dispose()
})

test('console connection disables key actions and rejects even stale callbacks before rerender', async () => {
  const pending = deferred()
  const f = await loaded((r) => r.url.endsWith('/console/connect') ? pending.promise : undefined)
  const staleImport = f.byKey('import').props.onClick
  const staleLoad = f.byKey('load').props.onClick
  const staleModels = f.byKey('models').props.onClick
  const task = f.click('connect')
  assert.equal(f.byKey('load').props.disabled, true)
  assert.equal(f.byKey('create').props.disabled, true)
  assert.equal(f.byKey('models').props.disabled, true)
  assert.equal(f.byKey('import').props['aria-disabled'], true)
  staleImport({ preventDefault() {} }); await staleLoad(); await staleModels()
  assert.equal(picker(f), undefined)
  assert.equal(keyRequests(f).length, 1)
  assert.equal(f.requests.filter((r) => r.url.endsWith('/refresh-models')).length, 0)
  pending.resolve(response({ ok: true })); await task
  assert.equal(f.byKey('load').props.disabled, false)
  f.dispose()
})

test('timed-out key requests show a usable error and release the busy lock', async () => {
  const pending = deferred()
  const f = fixture((r) => r.url.endsWith('/keys') ? pending.promise : undefined); await tick()
  const task = f.click('load')
  const timeout = [...f.timers.values()].find((timer) => timer.ms === 30000)
  assert.ok(timeout); timeout.fn()
  assert.equal(keyRequests(f)[0].options.signal.aborted, true)
  pending.resolve(response({ ok: true, keys: [] })); await task
  assert.match(f.text(), /请求超时.*重试/)
  assert.equal(f.byKey('load').props.disabled, false)
  f.dispose()
})

for (const [kind, link, endpoint] of [['create', 'create', '/keys/create'], ['rename', 'rename', '/keys/update']]) {
  test(`${kind} uses a controlled native-submit form with local validation, cancellation and no native dialogs`, async () => {
    const f = await loaded()
    f.click(link)
    assert.equal(f.byKey('key-editor').tag, 'form', 'Enter in the input submits this form natively')
    assert.equal(f.byKey('editor-submit').props.type, 'submit')
    assert.equal(f.byKey('key-name').props.value, kind === 'rename' ? 'same-name' : '')
    for (const value of ['   ', 'bad\nname', ...(kind === 'rename' ? ['same-name'] : [])]) {
      f.name(value); await f.submit()
      assert.equal(f.byKey('editor-error').props.role, 'alert')
      assert.equal(f.byKey('key-name').props['aria-invalid'], true)
    }
    assert.equal(f.requests.filter((r) => r.url.endsWith(endpoint)).length, 0)
    f.name('  mock-new-name  ')
    assert.equal(f.byKey('key-name').props.value, '  mock-new-name  ')
    assert.equal(f.find((n) => n.props.key === 'editor-error'), undefined)
    await f.submit()
    const sent = f.requests.find((r) => r.url.endsWith(endpoint))
    assert.deepEqual(sent.body, kind === 'rename' ? { uuid: 'uuid-one', name: 'mock-new-name' } : { name: 'mock-new-name' })
    assert.equal(f.find((n) => n.props.key === 'key-editor'), undefined)
    assert.match(text(f.byKey('key-notice')), /操作完成/)
    f.click(link); f.name('cancel-me'); f.click('editor-cancel')
    assert.equal(f.find((n) => n.props.key === 'key-editor'), undefined)
    f.click(link)
    f.byKey('key-editor').props.onKeyDown({ key: 'Escape', preventDefault() {} })
    assert.equal(f.find((n) => n.props.key === 'key-editor'), undefined)
    assert.equal(f.requests.filter((r) => r.url.endsWith(endpoint)).length, 1)
    assert.equal(f.nativeDialogCalls, 0)
    f.dispose()
  })
}

for (const [label, handler] of [
  ['application', () => response({ ok: false, error: 'key-quota-exceeded' })],
  ['HTTP', () => response({ error: 'console-session-expired' }, 403)],
  ['network', () => { throw new TypeError('mock network failure') }],
  ['malformed success', () => response({ ok: 'false' })],
]) {
  test(`rename ${label} failure keeps its draft and displays a local error`, async () => {
    const f = await loaded((r) => r.url.endsWith('/keys/update') ? handler() : undefined)
    await f.click('refresh')
    f.click('rename'); f.name('keep-my-draft'); await f.submit()
    assert.equal(f.byKey('key-name').props.value, 'keep-my-draft')
    assert.equal(f.byKey('editor-error').props.role, 'alert')
    assert.equal(f.byKey('key-notice').props.role, 'alert')
    assert.match(text(f.byKey('notice')), /已刷新/, 'key errors no longer hide above the key card')
    assert.ok(text(f.byKey('keys')).includes(text(f.byKey('key-notice'))), 'the notice is inside the API key card')
    assert.equal(f.byKey('editor-submit').props.disabled, false)
    assert.equal(f.nativeDialogCalls, 0)
    f.dispose()
  })
}

for (const kind of ['create', 'rename', 'delete']) {
  test(`${kind} form deduplicates submits and blocks cancellation, edits and other mutations while pending`, async () => {
    const pending = deferred()
    const endpoint = kind === 'create' ? '/keys/create' : kind === 'rename' ? '/keys/update' : '/keys/delete'
    const f = await loaded((r) => r.url.endsWith(endpoint) ? pending.promise : undefined)
    f.click(kind === 'delete' ? 'del' : kind)
    if (kind !== 'delete') f.name('mock-pending')
    else {
      assert.match(text(f.byKey('key-editor')), /不可恢复.*请求会立即被拒绝/)
      assert.equal(f.requests.filter((r) => r.url.endsWith(endpoint)).length, 0, 'opening confirmation never deletes')
    }
    const submit = f.byKey('key-editor').props.onSubmit
    const one = submit({ preventDefault() {} }), two = submit({ preventDefault() {} })
    assert.equal(f.requests.filter((r) => r.url.endsWith(endpoint)).length, 1)
    assert.equal(f.byKey('editor-submit').props.disabled, true)
    assert.equal(f.byKey('editor-cancel').props.disabled, true)
    f.click('editor-cancel'); f.click('create'); f.click('del'); f.click('import'); await f.click('models')
    assert.equal(f.byKey('key-editor').props['aria-label'], kind === 'create' ? '新建密钥' : kind === 'rename' ? '重命名密钥' : '删除密钥')
    assert.equal(picker(f), undefined)
    pending.resolve(response({ ok: true })); await Promise.all([one, two])
    assert.equal(f.find((n) => n.props.key === 'key-editor'), undefined)
    assert.equal(f.nativeDialogCalls, 0)
    assert.equal(f.timers.size, 0)
    f.dispose()
  })
}

test('delete failure retains the explicit confirmation and cancellation never deletes', async () => {
  const f = await loaded((r) => r.url.endsWith('/keys/delete') ? response({ ok: false, error: 'key-not-found' }) : undefined)
  f.click('del'); f.click('editor-cancel')
  assert.equal(f.requests.filter((r) => r.url.endsWith('/keys/delete')).length, 0)
  f.click('del'); await f.submit()
  assert.match(text(f.byKey('editor-error')), /未找到该密钥/)
  assert.match(text(f.byKey('key-editor')), /same-name/)
  assert.equal(f.nativeDialogCalls, 0)
  f.dispose()
})

test('stale form callbacks cannot submit or close a newer form', async () => {
  const f = await loaded()
  f.click('create'); f.name('old-draft')
  const staleSubmit = f.byKey('key-editor').props.onSubmit
  const staleCancel = f.byKey('editor-cancel').props.onClick
  const staleChange = f.byKey('key-name').props.onChange
  f.click('editor-cancel'); f.click('rename')
  await staleSubmit({ preventDefault() {} }); staleCancel(); staleChange({ target: { value: 'stale' } })
  assert.equal(f.byKey('key-name').props.value, 'same-name')
  assert.equal(f.requests.filter((r) => /\/keys\/(create|update)$/.test(r.url)).length, 0)
  f.dispose()
})

test('unmount aborts a form mutation with no late refresh or draft writes', async () => {
  const pending = deferred()
  const f = await loaded((r) => r.url.endsWith('/keys/update') ? pending.promise : undefined)
  f.click('rename'); f.name('mock-draft'); const task = f.submit()
  const sent = f.requests.find((r) => r.url.endsWith('/keys/update'))
  f.dispose(); assert.equal(sent.options.signal.aborted, true)
  pending.resolve(response({ ok: false, error: 'console-timeout' })); await task
  assert.equal(f.writesAfterUnmount, 0)
  assert.equal(keyRequests(f).length, 1)
  assert.equal(f.timers.size, 0)
})

test('model import starts empty, offers a select-all toggle, and caps explicit selection at 200', async () => {
  const models = Array.from({ length: 201 }, (_, i) => `mock-model-${i}`)
  const f = await loaded((r) => r.url.endsWith('/keys') ? response({ ok: true, keys: [key({ models })] }) : undefined)
  f.click('import')
  assert.equal(walk(f.render()).filter((n) => n.props.type === 'checkbox' && n.props.checked).length, 0)
  assert.match(text(f.byKey('picked')), /已选 0 \/ 200/)
  assert.match(text(f.byKey('all')), /^全选（200）$/)
  assert.equal(f.byKey('go').props.disabled, true)
  await f.click('go'); assert.equal(importRequests(f).length, 0)
  f.click('all')
  assert.equal(walk(f.render()).filter((n) => n.props.type === 'checkbox' && n.props.checked).length, 200)
  assert.match(text(f.byKey('all')), /取消全选/)
  assert.match(text(f.byKey('picked')), /已选 200 \/ 200/)
  assert.match(text(f.byKey('go')), /导入并添加（200）/)
  f.byKey('f').props.onChange({ target: { value: 'mock-model-200' } })
  assert.equal(walk(f.render()).find((n) => n.props.type === 'checkbox').props.disabled, true)
  f.byKey('f').props.onChange({ target: { value: '' } })
  f.click('all')
  assert.equal(walk(f.render()).filter((n) => n.props.type === 'checkbox' && n.props.checked).length, 0)
  assert.equal(f.byKey('go').props.disabled, true)
  assert.equal(f.byKey('keyonly').props.disabled, false)
  f.click('all'); await f.click('go')
  assert.deepEqual(importRequests(f)[0].body, { uuid: 'uuid-one', models: models.slice(0, 200) })
  f.dispose()
})

test('import picker appends and no longer offers a replace mode', async () => {
  const f = await loaded((r) => r.url.endsWith('/keys/import') ? response({ ok: true, credentialImported: true, modelsAdded: ['model-a'] }) : undefined)
  f.click('import'); f.click('all')
  assert.doesNotMatch(f.text(), /替换模式/)
  await f.click('go')
  assert.deepEqual(importRequests(f)[0].body, { uuid: 'uuid-one', models: ['model-a'] })
  f.dispose()
})

test('successful model registration points to the actual model list, not a paid subscription', async () => {
  const f = await loaded((r) => r.url.endsWith('/keys/import') ? response({ ok: true, credentialImported: true, providerRegistered: true, modelsAvailable: true, modelsAdded: ['model-a'] }) : undefined)
  f.click('import'); f.click('all'); await f.click('go')
  assert.deepEqual(importRequests(f)[0].body, { uuid: 'uuid-one', models: ['model-a'] })
  assert.match(text(f.byKey('key-notice')), /已加入模型列表：Paratera/)
  assert.match(f.text(), /API key 不是付费订阅/)
  assert.equal(picker(f), undefined)
  f.dispose()
})

for (const code of ['model-directory-unavailable', 'model-directory-missing-models', 'provider-not-registered']) {
  test(`directory check ${code} accurately preserves saved configuration as partial success`, async () => {
    const f = await loaded((r) => r.url.endsWith('/keys/import') ? response({ ok: false, credentialImported: true, modelConfigUpdated: true, modelError: code }) : undefined)
    f.click('import'); f.click('all'); await f.click('go')
    assert.match(text(f.byKey('key-notice')), /密钥已导入 DSH.*模型配置已保存.*模型列表确认未完成/)
    assert.ok(picker(f)); assert.equal(f.byKey('key-notice').props.role, 'alert')
    f.dispose()
  })
}

test('initial import status restores a safe completed result in the API key card', async () => {
  const f = fixture((r) => r.url.endsWith('/import/status') ? response({ ok: true, running: false, stage: 'completed', startedAt: 100, operationId: 'mock-old', result: { ok: true, credentialImported: true, modelsAddedCount: 2, providerRegistered: true, modelsAvailable: true } }) : undefined)
  await tick()
  assert.match(text(f.byKey('keys')), /密钥已导入 DSH.*新增 2 个模型.*已加入模型列表：Paratera/)
  assert.equal(importRequests(f).length, 0)
  assert.equal(f.timers.size, 0)
  f.dispose()
})

test('a recovered running import blocks mutations and console navigation, permits list loading, and polls to its final result', async () => {
  let reads = 0
  const f = fixture((r) => r.url.endsWith('/import/status') ? response(++reads === 1
    ? { ok: true, running: true, stage: 'verifying', startedAt: 100, operationId: 'mock-running' }
    : { ok: true, running: false, stage: 'completed', startedAt: 100, operationId: 'mock-running', result: { ok: true, credentialImported: true, modelsAddedCount: 1 } }) : undefined)
  await tick()
  assert.match(text(f.byKey('import-progress')), /正在验证可用模型.*请勿重复导入/)
  assert.equal(f.byKey('load').props.disabled, false)
  assert.equal(f.byKey('create').props.disabled, true)
  assert.equal(f.byKey('connect').props.disabled, true)
  f.click('create'); await f.click('models'); await f.click('connect')
  await f.click('load')
  f.click('import'); f.click('rename'); f.click('del')
  assert.equal(picker(f), undefined)
  assert.equal(f.find((n) => n.props.key === 'key-editor'), undefined)
  f.fireTimer(2000); await tick()
  assert.match(text(f.byKey('key-notice')), /密钥已导入 DSH.*新增 1 个模型/)
  assert.equal(f.find((n) => n.props.key === 'import-progress'), undefined)
  assert.equal(f.byKey('create').props.disabled, false)
  assert.equal(f.timers.size, 0)
  assert.equal(importRequests(f).length, 0)
  f.dispose()
})

test('local import displays phase progress, ignores old completion, and stops polls when the POST settles', async () => {
  const pending = deferred()
  let reads = 0
  const f = await loaded((r) => {
    if (r.url.endsWith('/keys/import')) return pending.promise
    if (r.url.endsWith('/import/status')) return response(++reads < 3
      ? { ok: true, running: false, stage: 'completed', startedAt: 1, operationId: 'mock-old', result: { ok: true, credentialImported: true } }
      : { ok: true, running: true, stage: 'saving', startedAt: Date.now(), operationId: 'mock-new' })
  })
  f.click('import'); f.click('all'); const task = f.click('go')
  assert.match(text(f.byKey('go')), /正在导入/)
  assert.match(text(f.byKey('keyonly')), /仅保存密钥/)
  f.fireTimer(2000); await tick()
  assert.match(text(f.byKey('import-progress')), /正在查找密钥/)
  assert.equal(f.find((n) => n.props.key === 'key-notice'), undefined)
  f.fireTimer(2000); await tick()
  assert.match(text(f.byKey('import-progress')), /正在保存密钥/)
  pending.resolve(response({ ok: true, credentialImported: true, modelsAdded: ['model-a'] })); await task
  assert.match(text(f.byKey('key-notice')), /密钥已导入 DSH.*新增 1 个模型/)
  assert.equal(f.find((n) => n.props.key === 'import-progress'), undefined)
  assert.equal(f.timers.size, 0)
  assert.equal(importRequests(f).length, 1)
  f.dispose()
})

test('progress requests never overlap and late status responses cannot overwrite the POST result', async () => {
  const post = deferred(), progress = deferred()
  let reads = 0
  const f = await loaded((r) => r.url.endsWith('/keys/import') ? post.promise : r.url.endsWith('/import/status') && ++reads > 1 ? progress.promise : undefined)
  f.click('import'); const task = f.click('keyonly')
  f.fireTimer(2000); await tick()
  assert.equal([...f.timers.values()].filter((t) => t.ms === 2000).length, 0, 'next poll waits for the previous fetch')
  const active = f.requests.filter((r) => r.url.endsWith('/import/status')).at(-1)
  post.resolve(response({ ok: false, credentialImported: false, error: 'credential-write-failed' })); await task
  assert.equal(active.options.signal.aborted, true)
  assert.equal(f.timers.size, 0)
  progress.resolve(response({ ok: true, running: true, stage: 'verifying', operationId: 'mock-late', startedAt: Date.now() })); await tick()
  assert.match(text(f.byKey('key-notice')), /导入失败.*未能写入/)
  assert.equal(f.find((n) => n.props.key === 'import-progress'), undefined)
  f.dispose()
})

test('an inconsistent modelsAvailable false result cannot close the picker as full success', async () => {
  const f = await loaded((r) => r.url.endsWith('/keys/import') ? response({ ok: true, credentialImported: true, modelConfigUpdated: true, providerRegistered: true, modelsAvailable: false }) : undefined)
  f.click('import'); f.click('all'); await f.click('go')
  assert.ok(picker(f))
  assert.match(text(f.byKey('key-notice')), /密钥已导入 DSH.*部分模型未出现在宿主列表/)
  assert.equal(f.byKey('key-notice').props.role, 'alert')
  f.dispose()
})

test('recovering progress retries network or malformed status without unlocking or claiming a failed import', async () => {
  let reads = 0
  const f = fixture((r) => {
    if (!r.url.endsWith('/import/status')) return
    reads += 1
    if (reads === 2) throw new TypeError('mock progress network error')
    if (reads === 3) return response({ ok: true, running: 'invalid' })
    return response({ ok: true, running: reads < 4, stage: reads < 4 ? 'subscription' : 'completed', startedAt: 100, operationId: 'mock-progress', result: reads < 4 ? null : { ok: true, credentialImported: true, modelsAddedCount: 3 } })
  })
  await tick()
  assert.match(text(f.byKey('import-progress')), /正在确认模型列表可用/)
  f.fireTimer(2000); await tick()
  assert.match(text(f.byKey('import-progress')), /进度暂不可用.*正在重试/)
  assert.equal(f.byKey('create').props.disabled, true)
  f.fireTimer(2000); await tick()
  assert.match(text(f.byKey('import-progress')), /进度暂不可用/)
  assert.equal(f.byKey('create').props.disabled, true)
  f.fireTimer(2000); await tick()
  assert.match(text(f.byKey('key-notice')), /密钥已导入 DSH.*新增 3 个模型/)
  assert.equal(f.byKey('create').props.disabled, false)
  f.dispose()
})

test('a recovered operation ignores an older mismatched result and continues polling', async () => {
  let reads = 0
  const f = fixture((r) => {
    if (!r.url.endsWith('/import/status')) return
    reads += 1
    if (reads === 2) return response({ ok: true, running: false, stage: 'completed', startedAt: 1, operationId: 'mock-older', result: { ok: true, credentialImported: true } })
    return response({ ok: true, running: reads < 3, stage: reads < 3 ? 'saving' : 'completed', startedAt: 100, operationId: 'mock-current', result: reads < 3 ? null : { ok: false, credentialImported: false, error: 'credential-write-failed' } })
  })
  await tick(); f.fireTimer(2000); await tick()
  assert.equal(f.byKey('create').props.disabled, true)
  assert.equal(f.find((n) => n.props.key === 'key-notice'), undefined)
  f.fireTimer(2000); await tick()
  assert.match(text(f.byKey('key-notice')), /导入失败.*未能写入/)
  assert.equal(f.byKey('create').props.disabled, false)
  f.dispose()
})

test('StrictMode replay aborts stale progress status and prevents it from locking the new scope', async () => {
  const pending = deferred()
  let reads = 0
  const f = fixture((r) => r.url.endsWith('/import/status') ? (++reads === 1 ? pending.promise : response({ ok: true, running: false, stage: 'idle', result: null })) : undefined)
  const first = f.requests.find((r) => r.url.endsWith('/import/status'))
  f.replayEffects(); await tick()
  assert.equal(first.options.signal.aborted, true)
  pending.resolve(response({ ok: true, running: true, stage: 'saving', operationId: 'mock-stale', startedAt: 100 })); await tick()
  assert.equal(f.byKey('create').props.disabled, false)
  assert.equal(f.find((n) => n.props.key === 'import-progress'), undefined)
  assert.equal(f.timers.size, 0)
  f.dispose()
})

test('unmount aborts an active progress request even when its fetch ignores abort', async () => {
  const pending = deferred()
  let reads = 0
  const f = fixture((r) => r.url.endsWith('/import/status') ? (++reads === 1
    ? response({ ok: true, running: true, stage: 'saving', startedAt: 100, operationId: 'mock-current' }) : pending.promise) : undefined)
  await tick(); f.fireTimer(2000); await tick()
  const last = f.requests.filter((r) => r.url.endsWith('/import/status')).at(-1)
  f.dispose()
  assert.equal(last.options.signal.aborted, true)
  assert.equal(f.timers.size, 0)
  const count = f.requests.length
  pending.resolve(response({ ok: true, running: false, stage: 'completed', result: { ok: true, credentialImported: true } })); await tick()
  assert.equal(f.requests.length, count)
  assert.equal(f.writesAfterUnmount, 0)
})

test('unmount cancels recovered import progress waits and prevents further status requests', async () => {
  const f = fixture((r) => r.url.endsWith('/import/status') ? response({ ok: true, running: true, stage: 'revealing', operationId: 'mock-running', startedAt: 100 }) : undefined)
  await tick()
  assert.ok([...f.timers.values()].some((t) => t.ms === 2000))
  const count = f.requests.length
  f.dispose(); await tick()
  assert.equal(f.requests.length, count)
  assert.equal(f.timers.size, 0)
  assert.equal(f.writesAfterUnmount, 0)
})

test('select-all follows the active filter instead of the whole catalog', async () => {
  const models = ['Kimi-K3', 'Kimi-K3.1-Pro', 'Qwen3.8-Max', 'GLM-5']
  const f = await loaded((r) => r.url.endsWith('/keys') ? response({ ok: true, keys: [key({ models })] }) : undefined)
  f.click('import')
  assert.equal(walk(f.render()).filter((n) => n.props.type === 'checkbox' && n.props.checked).length, 0)
  f.byKey('f').props.onChange({ target: { value: 'kimi' } })
  assert.match(text(f.byKey('all')), /全选筛选（2）/)
  f.click('all')
  assert.equal(walk(f.render()).filter((n) => n.props.type === 'checkbox' && n.props.checked).length, 2)
  assert.match(text(f.byKey('picked')), /已选 2 \/ 4，当前筛选 2 个/)
  f.byKey('f').props.onChange({ target: { value: '' } })
  assert.equal(walk(f.render()).filter((n) => n.props.type === 'checkbox' && n.props.checked).length, 2)
  f.click('all')
  assert.equal(walk(f.render()).filter((n) => n.props.type === 'checkbox' && n.props.checked).length, 4)
  f.click('all')
  assert.equal(walk(f.render()).filter((n) => n.props.type === 'checkbox' && n.props.checked).length, 0)
  f.dispose()
})

const modelRow = (overrides = {}) => ({
  id: 'Kimi-K3', name: 'Kimi-K3', contextWindow: 262144, maxTokens: 8192, input: ['text'],
  recommended: { id: 'Kimi-K3', name: 'Kimi-K3', contextWindow: 1024000, maxTokens: 943718, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
  ...overrides,
})

function modelsFixture(handler, options = {}) {
  return fixture(handler ?? ((r) => {
    if (r.url !== '/tsinghua-paratera/api/models') return response({ ok: true })
    if (r.options.method === 'POST') return response({ ok: true, revision: 9, models: r.body.models })
    return response({ ok: true, revision: 8, models: options.rows ?? [modelRow()] })
  }), { component: 'models' })
}

test('the settings section survives a missing or broken composer slot', () => {
  const sections = new Map()
  const ctx = {
    slots: {
      inject(name, fn) {
        if (name === 'conversation.input.right') throw Error('slot renamed upstream')
        return fn()
      },
      register(spec, value) { if (spec.name === 'settings.section') sections.set(spec.id, value) },
    },
  }
  fixture().plugin.apply(ctx)
  assert.deepEqual([...sections.keys()], ['tsinghua-paratera'])
})

test('the composer slot falls back to an empty store when modelDirectories is gone', () => {
  let injected
  const ctx = {
    slots: {
      inject(name, fn) { fn() },
      register(spec) {
        if (spec.name === 'conversation.input.right') injected = spec.inject({ id: 'session-1' })
      },
    },
  }
  fixture().plugin.apply(ctx)
  const store = injected.directory
  assert.equal(Object.keys(store.getSnapshot()).length, 0)
  assert.equal(store.getSnapshot(), store.getSnapshot(), 'useSyncExternalStore requires a cached fallback snapshot')
  let notified = 0
  const off = store.subscribe(() => { notified += 1 })
  off()
  assert.equal(notified, 0)
})

test('diagnostics footer reports host, plugin and compatibility', async () => {
  const f = fixture((r) => r.url.endsWith('/diagnostics') ? response({
    ok: true,
    plugin: { version: '9.9.9', startedAt: 1 },
    host: { version: '0.2.1-rc.5', compatibility: { ok: true, version: '0.2.1-rc.5', tested: '0.2.0 – 0.3.0 (不含 0.3.0)' } },
    services: {},
    client: { lastSeenAt: null, ageMs: null },
  }) : undefined)
  await tick()
  assert.match(f.text(), /宿主 DSH 0\.2\.1-rc\.5/)
  assert.match(f.text(), /插件 9\.9\.9/)
  assert.match(f.text(), /客户端已连接/)
  f.dispose()
})


test('the plugin page registers one section whose second tab mounts the models panel', async () => {
  const f = fixture()
  assert.deepEqual([...f.sections.keys()], ['tsinghua-paratera'])
  assert.equal(f.byKey('tab-account').props['aria-selected'], true)
  assert.equal(f.byKey('tab-models').props['aria-selected'], false)
  assert.equal(walk(f.render()).some((n) => typeof n.tag === 'function'), false)
  f.click('tab-models')
  assert.equal(f.byKey('tab-models').props['aria-selected'], true)
  assert.equal(walk(f.render()).some((n) => typeof n.tag === 'function'), true)
  f.click('tab-account')
  assert.equal(f.byKey('tab-account').props['aria-selected'], true)
  assert.equal(walk(f.render()).some((n) => typeof n.tag === 'function'), false)
  f.dispose()
})

test('模型设置 loads the host list, edits fields and saves the exact model list', async () => {
  const f = modelsFixture()
  await tick()
  assert.match(f.text(), /Kimi-K3/)
  assert.match(f.text(), /恢复推荐值/)
  f.find((n) => n.props['data-field'] === 'contextWindow').props.onChange({ target: { value: '200000' } })
  f.find((n) => n.props['data-field'] === 'image').props.onChange()
  f.find((n) => n.props['data-field'] === 'name').props.onChange({ target: { value: 'Kimi K3' } })
  await f.click('save-models')
  const posts = f.requests.filter((r) => r.url === '/tsinghua-paratera/api/models' && r.options.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body.models, [{ id: 'Kimi-K3', name: 'Kimi K3', contextWindow: 200000, maxTokens: 8192, input: ['text', 'image'] }])
  assert.equal(posts[0].body.revision, 8)
  assert.match(f.text(), /已保存 1 个模型设置/)
  f.dispose()
})

test('思考挡位 is one control: unchecked means follow the model, first tick seeds low/high/max', async () => {
  const f = modelsFixture()
  await tick()
  assert.equal(f.find((n) => n.props['data-field'] === 'reasoning-mode'), undefined)
  assert.match(f.text(), /未勾选＝跟随模型原生/)
  assert.equal(f.find((n) => n.props['data-field'] === 'level-low').props.checked, false)
  f.find((n) => n.props['data-field'] === 'level-max').props.onChange()
  for (const level of ['low', 'high', 'max']) assert.equal(f.find((n) => n.props['data-field'] === 'level-' + level).props.checked, true)
  assert.match(f.text(), /自定义挡位/)
  await f.click('save-models')
  const post = f.requests.find((r) => r.url === '/tsinghua-paratera/api/models' && r.options.method === 'POST')
  assert.deepEqual(post.body.models[0].reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' })
  f.dispose()
})

test('first tick on a middle level keeps the trio and adds it', async () => {
  const f = modelsFixture()
  await tick()
  f.find((n) => n.props['data-field'] === 'level-medium').props.onChange()
  await f.click('save-models')
  const post = f.requests.find((r) => r.url === '/tsinghua-paratera/api/models' && r.options.method === 'POST')
  assert.deepEqual(post.body.models[0].reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max', medium: 'medium' })
  f.dispose()
})

test('clearing every thinking level returns to following the model', async () => {
  const f = modelsFixture(undefined, { rows: [modelRow({ reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } })] })
  await tick()
  assert.match(f.text(), /自定义挡位/)
  for (const level of ['low', 'high', 'max']) f.find((n) => n.props['data-field'] === 'level-' + level).props.onChange()
  assert.match(f.text(), /未勾选＝跟随模型原生/)
  await f.click('save-models')
  const post = f.requests.find((r) => r.url === '/tsinghua-paratera/api/models' && r.options.method === 'POST')
  assert.equal(post.body.models[0].reasoningEfforts, undefined)
  f.dispose()
})

test('模型设置 edits the offered levels one by one', async () => {
  const f = modelsFixture(undefined, { rows: [modelRow({ reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } })] })
  await tick()
  f.find((n) => n.props['data-field'] === 'level-medium').props.onChange()
  assert.equal(f.find((n) => n.props['data-field'] === 'level-medium').props.checked, true)
  f.find((n) => n.props['data-field'] === 'level-low').props.onChange()
  assert.equal(f.find((n) => n.props['data-field'] === 'level-low').props.checked, false)
  await f.click('save-models')
  const post = f.requests.find((r) => r.url === '/tsinghua-paratera/api/models' && r.options.method === 'POST')
  assert.deepEqual(post.body.models[0].reasoningEfforts, { off: null, medium: 'medium', high: 'high', max: 'max' })
  f.dispose()
})

test('一键最大值 applies each model recommendation and saves it immediately', async () => {
  const f = modelsFixture()
  await tick()
  await f.click('max-all')
  const post = f.requests.find((r) => r.url === '/tsinghua-paratera/api/models' && r.options.method === 'POST')
  assert.deepEqual(post.body.models, [{
    id: 'Kimi-K3', name: 'Kimi-K3', contextWindow: 1024000, maxTokens: 943718, input: ['text'],
  }])
  assert.match(f.text(), /已保存 1 个模型设置/)
  f.dispose()
})

test('模型设置 rejects invalid edits before the POST and can reset or delete a row', async () => {
  const f = modelsFixture()
  await tick()
  f.find((n) => n.props['data-field'] === 'contextWindow').props.onChange({ target: { value: '0' } })
  await f.click('save-models')
  assert.equal(f.requests.filter((r) => r.url === '/tsinghua-paratera/api/models' && r.options.method === 'POST').length, 0)
  assert.match(f.text(), /模型设置无效/)
  f.click('reset')
  assert.equal(f.find((n) => n.props['data-field'] === 'contextWindow').props.value, 1024000)
  assert.equal(f.find((n) => n.props['data-field'] === 'name').props.value, 'Kimi-K3')
  f.click('del')
  assert.doesNotMatch(f.text(), /恢复推荐值/)
  await f.click('save-models')
  const posts = f.requests.filter((r) => r.url === '/tsinghua-paratera/api/models' && r.options.method === 'POST')
  assert.deepEqual(posts[0].body.models, [])
  f.dispose()
})

test('模型设置 shows a friendly error when the host has no Settings service', async () => {
  const f = modelsFixture((r) => r.url === '/tsinghua-paratera/api/models' ? response({ ok: false, error: 'settings-unavailable' }) : response({ ok: true }))
  await tick()
  assert.match(f.text(), /宿主模型设置服务暂不可用/)
  assert.equal(f.byKey('save-models').props.disabled, true)
  f.dispose()
})
