import test from 'node:test'
import assert from 'node:assert/strict'
import { planManifest, PACKAGE_NAME } from '../scripts/install.mjs'
import { resolveInstallPlan } from '../lib/platform.mjs'

const PLUGIN = 'F:\\Vibe Coding\\插件开发\\dsh-paratera-balance'

test('adds the link dependency and bundle entry', () => {
  const plan = planManifest({ name: 'p', private: true, dependencies: { other: '1.0.0' }, dsh: { profile: { bundles: ['some-plugin'] } } }, PLUGIN)
  assert.equal(plan.changed, true)
  assert.equal(plan.manifest.dependencies[PACKAGE_NAME], 'link:F:/Vibe Coding/插件开发/dsh-paratera-balance')
  assert.deepEqual(plan.manifest.dsh.profile.bundles, ['some-plugin', PACKAGE_NAME])
  assert.equal(plan.manifest.dependencies.other, '1.0.0')
})

test('is idempotent', () => {
  const first = planManifest({ dependencies: {}, dsh: { profile: { bundles: [] } } }, PLUGIN)
  const second = planManifest(first.manifest, PLUGIN)
  assert.equal(second.changed, false)
  assert.equal(second.hadDependency, true)
  assert.equal(second.hadBundle, true)
  assert.deepEqual(second.manifest.dsh.profile.bundles, [PACKAGE_NAME])
})

test('creates missing manifest sections', () => {
  const plan = planManifest({ name: 'empty' }, PLUGIN)
  assert.deepEqual(plan.manifest.dsh.profile.bundles, [PACKAGE_NAME])
  assert.equal(plan.manifest.dependencies[PACKAGE_NAME].startsWith('link:'), true)
})

test('uninstall removes dependency and bundle entry without touching others', () => {
  const installed = planManifest({ dependencies: { a: '1' }, dsh: { profile: { bundles: ['a'] } } }, PLUGIN).manifest
  const removed = planManifest(installed, PLUGIN, { uninstall: true })
  assert.equal(removed.changed, true)
  assert.equal(removed.manifest.dependencies[PACKAGE_NAME], undefined)
  assert.deepEqual(removed.manifest.dsh.profile.bundles, ['a'])
  assert.equal(removed.manifest.dependencies.a, '1')
})

test('does not mutate the input manifest', () => {
  const input = { dependencies: {}, dsh: { profile: { bundles: [] } } }
  planManifest(input, PLUGIN)
  assert.deepEqual(input, { dependencies: {}, dsh: { profile: { bundles: [] } } })
})


test('platform plan selects the native task mechanism', () => {
  assert.deepEqual(resolveInstallPlan('win32'), {
    supported: true,
    task: { kind: 'powershell', script: 'scripts/setup-windows-task.ps1' },
    credentialHelper: 'dpapi',
  })
  assert.deepEqual(resolveInstallPlan('darwin'), {
    supported: true,
    task: { kind: 'node', script: 'scripts/setup-macos-task.mjs' },
    credentialHelper: 'keychain',
  })
})

test('unsupported platforms fail loudly instead of installing partially', () => {
  const plan = resolveInstallPlan('linux')
  assert.equal(plan.supported, false)
  assert.equal(plan.reason, 'unsupported-platform')
  assert.equal(plan.task, null)
})
