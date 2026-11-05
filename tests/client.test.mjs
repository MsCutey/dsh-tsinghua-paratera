import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function fixture(provider = 'paratera') {
  let entry, registration, settingsRegistration, effect, deps, state = null, cleanup
  const snapshot = { current: { provider, model: 'test-model' } }
  const requests = [], intervals = new Map(), listeners = new Map()
  const document = { visibilityState: 'visible', addEventListener: (k,v) => listeners.set(k,v), removeEventListener: k => listeners.delete(k) }
  let id = 0
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useSyncExternalStore: (_, get) => get(),
    useState: () => [state, v => { state = v }],
    useEffect: (fn, next) => { if (!deps || next.some((v,i) => v !== deps[i])) { effect = fn; deps = next } },
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: v => { entry = v } } },
    document, AbortController, setTimeout, clearTimeout,
    setInterval: fn => { intervals.set(++id, fn); return id }, clearInterval: key => intervals.delete(key),
    fetch: async (url, opts) => { requests.push({url,opts}); return {ok:true,json:async()=>({ok:true,balance:983.02,availableQuota:983.02,calculationVerified:false,calculationNote:'估算'})} },
  })
  const plugin = entry.factory(name => { assert.equal(name,'react'); return React })
  const stores = new Map()
  plugin.apply({
    get: name => name === 'modelDirectories' ? { directoryFor: id => { stores.set(id,true); return { store: { subscribe:()=>()=>{},getSnapshot:()=>snapshot } } } } : undefined,
    slots: {
      inject: (name, fn) => { assert.ok(['conversation.input.right','settings.section'].includes(name)); return fn() },
      register: (spec, component) => {
        if (spec.name === 'conversation.input.right') registration = { spec, component }
        else settingsRegistration = { spec, component }
        return () => {}
      },
    },
  })
  const props = registration.spec.inject('session-a')
  return { registration, settingsRegistration, snapshot, requests, document, intervals, listeners, stores,
    render: () => registration.component(props),
    runEffect() { if (effect) { cleanup?.(); const fn=effect; effect=null; cleanup=fn() } },
    dispose() { cleanup?.() },
  }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('uses native quota slot and session-specific model store', () => {
  const f=fixture(); assert.equal(f.registration.spec.id,'paratera-balance'); assert.equal(f.registration.spec.order,16)
  assert.ok(f.stores.has('session-a')); assert.equal(f.render().children[0],'余额…'); f.dispose()
})
test('fetches balance, exposes calculation caveat, and polls only while visible', async () => {
  const f=fixture(); f.render(); f.runEffect(); await settle()
  assert.equal(f.requests.length,1); assert.equal(f.requests[0].opts.credentials,'same-origin')
  const view=f.render(); assert.equal(view.children[0],'¥983.02'); assert.match(view.props.title,/估算/)
  f.document.visibilityState='hidden'; await [...f.intervals.values()][0](); assert.equal(f.requests.length,1)
  f.document.visibilityState='visible'; await f.listeners.get('visibilitychange')(); assert.equal(f.requests.length,2)
  f.dispose(); assert.equal(f.intervals.size,0); assert.equal(f.listeners.size,0)
})
test('other providers render nothing and make no requests', () => {
  const f=fixture('openai-codex'); assert.equal(f.render(),null); f.runEffect()
  assert.equal(f.requests.length,0); assert.equal(f.intervals.size,0)
})
test('switching models refreshes and switching away removes polling', async () => {
  const f=fixture(); f.render(); f.runEffect(); await settle()
  f.snapshot.current.model='second'; f.render(); f.runEffect(); await settle(); assert.equal(f.requests.length,2)
  f.snapshot.current.provider='openai-codex'; assert.equal(f.render(),null); f.runEffect()
  assert.equal(f.intervals.size,0); assert.equal(f.listeners.size,0)
})
test('unmount aborts in-flight request and removes all lifecycle resources', () => {
  const f=fixture(); f.render(); f.runEffect(); f.dispose()
  assert.equal(f.requests[0].opts.signal.aborted,true); assert.equal(f.intervals.size,0)
})
