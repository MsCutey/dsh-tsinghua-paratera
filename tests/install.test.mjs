import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { planManifest, PACKAGE_NAME, runBackgroundTask } from '../scripts/install.mjs'
import { resolveInstallPlan } from '../lib/platform.mjs'

const PLUGIN = 'F:\\Vibe Coding\\插件开发\\dsh-tsinghua-paratera'

test('adds the link dependency and bundle entry', () => {
  const plan = planManifest({ name: 'p', private: true, dependencies: { other: '1.0.0' }, dsh: { profile: { bundles: ['some-plugin'] } } }, PLUGIN)
  assert.equal(plan.changed, true)
  assert.equal(plan.manifest.dependencies[PACKAGE_NAME], 'link:F:/Vibe Coding/插件开发/dsh-tsinghua-paratera')
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

test('Mac task installation and removal preserve the selected DSH_HOME', () => {
  const dshHome = path.join(path.parse(process.cwd()).root, 'tmp', 'test dsh')
  for (const uninstall of [false, true]) {
    let call
    const result = runBackgroundTask({ plan: resolveInstallPlan('darwin'), dshHome, uninstall,
      run: (file, args, options) => { call = { file, args, options }; return { status: 0, stdout: '{"ok":true}' } },
    })
    assert.equal(result.ok, true)
    assert.equal(call.options.env.DSH_HOME, dshHome)
    assert.equal(call.args.includes('--remove'), uninstall)
  }
})

test('a failed task registration is exposed to the installer summary', () => {
  const result = runBackgroundTask({ plan: resolveInstallPlan('darwin'), dshHome: '/tmp/test dsh',
    run: () => ({ status: 1, stderr: 'test-only bootstrap failure' }),
  })
  assert.equal(result.ok, false)
  assert.match(result.tail, /bootstrap failure/)
})
