import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('temporary Mac profile installs, verifies, reinstalls, and uninstalls through real pnpm', { skip: process.platform !== 'darwin' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-install-中文 '));
  const profile = path.join(home, 'profiles', 'desktop');
  const manifestPath = path.join(profile, 'package.json');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ name: 'temporary-test-profile', private: true, dependencies: {}, dsh: { profile: { bundles: ['existing-bundle'] } }, preserved: { test: true } }));
  const script = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
  const run = (...args) => {
    const child = spawnSync(process.execPath, [script, '--dsh-home', home, ...args], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, npm_config_store_dir: path.join(home, 'store'), XDG_CACHE_HOME: path.join(home, 'cache'), CI: 'true' },
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return JSON.parse(child.stdout);
  };
  try {
    const dryRun = run('--dry-run');
    assert.equal(dryRun.wouldWrite, true);
    assert.equal(JSON.parse(fs.readFileSync(manifestPath)).dependencies['dsh-paratera-balance'], undefined);
    const installed = run();
    assert.equal(installed.ok, true);
    assert.equal(installed.state.moduleLinked, true);
    assert.equal(fs.statSync(installed.backup).mode & 0o777, 0o600);
    assert.equal(run('--verify').ok, true);
    assert.equal(run().changed, false);
    assert.equal(run('--uninstall').ok, true);
    const restored = JSON.parse(fs.readFileSync(manifestPath));
    assert.deepEqual(restored.dsh.profile.bundles, ['existing-bundle']);
    assert.deepEqual(restored.preserved, { test: true });
    assert.equal(fs.existsSync(path.join(profile, 'node_modules', 'dsh-paratera-balance')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
