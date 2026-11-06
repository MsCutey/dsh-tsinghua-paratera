import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  parseVersion, compareVersions, compatibility, hostVersion, pluginVersion, TESTED_DSH_RANGE,
} from '../lib/compat.mjs';

test('versions parse, compare and classify against the tested range', () => {
  assert.deepEqual(parseVersion('0.2.1-rc.5'), [0, 2, 1]);
  assert.deepEqual(parseVersion('v1.2.3'), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(compareVersions([0, 2, 1], [0, 2, 0]), 1);
  assert.equal(compareVersions([0, 2, 1], [0, 2, 1]), 0);
  assert.equal(compatibility('0.2.1-rc.5').ok, true);
  assert.equal(compatibility(TESTED_DSH_RANGE.min).ok, true);
  assert.equal(compatibility(TESTED_DSH_RANGE.max).ok, false);
  assert.equal(compatibility('0.1.9').ok, false);
  assert.equal(compatibility('0.1.9').reason, 'untested-host-version');
  assert.deepEqual(compatibility(null), { ok: null, reason: 'unknown-host-version', tested: '0.2.0 – 0.3.0 (不含 0.3.0)' });
  assert.equal(compatibility('not-a-version').ok, null);
});

test('hostVersion reads the packaged DSH manifest from any known layout', () => {
  const resources = path.join(path.parse(process.cwd()).root, 'DSH test', 'resources');
  const read = (file) => {
    if (file === path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')) return JSON.stringify({ version: '0.2.4' });
    throw Object.assign(Error('missing'), { code: 'ENOENT' });
  };
  assert.equal(hostVersion({ resources, read }), '0.2.4');
  const fallback = (file) => {
    if (file === path.join(resources, 'app.asar', 'dsh', 'package.json')) return JSON.stringify({ version: '0.2.9' });
    throw Object.assign(Error('missing'), { code: 'ENOENT' });
  };
  assert.equal(hostVersion({ resources, read: fallback }), '0.2.9');
  assert.equal(hostVersion({ resources, read: () => { throw Error('nope') } }), null);
  assert.equal(hostVersion({ resources: '', read: () => '{}' }), null);
});

test('pluginVersion reports this package version', () => {
  assert.match(pluginVersion(), /^\d+\.\d+\.\d+/);
});
