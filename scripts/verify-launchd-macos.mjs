#!/usr/bin/env node
// Run a harmless marker-writing task under a temporary, separately named agent.
// The actual session refresh entry and user credentials are never used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { makePlist, applyAgent, agentLabel } from './setup-macos-task.mjs';

assert.equal(process.platform, 'darwin');
const artifacts = fileURLToPath(new URL('../.artifacts/', import.meta.url));
fs.mkdirSync(artifacts, { recursive: true });
const folder = fs.mkdtempSync(path.join(artifacts, 'launchd-check-'));
const home = path.join(folder, 'home');
const label = agentLabel(home);
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', label + '.plist');
const domain = `gui/${process.getuid()}`;
const marker = path.join(folder, 'marker.json');
assert.equal(fs.existsSync(plistPath), false);
fs.mkdirSync(path.join(folder, 'lib'), { recursive: true });
fs.writeFileSync(path.join(folder, 'lib', 'scheduled.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({home:process.env.DSH_HOME}));`);
const content = makePlist({ pluginDir: folder, dshHome: home, label });
const options = { plistPath, domain, label, content };
try {
  applyAgent(options);
  for (let attempt = 0; attempt < 80 && !fs.existsSync(marker); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).home, home);
  applyAgent(options); // repeat registration must safely replace the test agent
  applyAgent({ ...options, remove: true });
  assert.equal(fs.existsSync(plistPath), false);
  assert.notEqual(spawnSync('/bin/launchctl', ['print', `${domain}/${label}`]).status, 0);
  const summary = { ok: true, registered: true, taskExecuted: true, replaced: true, removed: true, realAccountUsed: false };
  fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, evidence: path.join(folder, 'result.json') }));
} finally {
  applyAgent({ ...options, remove: true });
}
