import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyAgent, agentLabel, LABEL } from '../scripts/setup-macos-task.mjs';

test('custom homes use stable distinct labels without replacing the desktop agent', () => {
  assert.equal(agentLabel(path.join(os.homedir(), '.dsh')), LABEL);
  assert.equal(agentLabel('/tmp/home-a'), agentLabel('/tmp/home-a'));
  assert.notEqual(agentLabel('/tmp/home-a'), LABEL);
  assert.notEqual(agentLabel('/tmp/home-a'), agentLabel('/tmp/home-b'));
});

function fixture(t, { loaded = true, bootoutFails = false, bootstrapFails = false, lintFails = false } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-agent-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const plistPath = path.join(folder, 'agent.plist');
  fs.writeFileSync(plistPath, 'previous-config');
  const calls = [];
  const run = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === '-lint') return { status: lintFails ? 1 : 0 };
    if (args[0] === 'print') return { status: loaded ? 0 : 113 };
    if (args[0] === 'bootout') { if (bootoutFails) return { status: 1 }; loaded = false; return { status: 0 }; }
    if (args[0] === 'bootstrap') {
      if (bootstrapFails && fs.readFileSync(plistPath, 'utf8') !== 'previous-config') return { status: 1 };
      loaded = true; return { status: 0 };
    }
    throw Error('unexpected command');
  };
  return { plistPath, domain: 'gui/501', content: 'new-config', run, calls, loaded: () => loaded };
}

test('agent removal unloads the running label before deleting its plist', (t) => {
  const f = fixture(t);
  applyAgent({ ...f, remove: true });
  assert.equal(f.loaded(), false);
  assert.equal(fs.existsSync(f.plistPath), false);
  assert.match(f.calls.find((call) => call[1] === 'bootout')[2], /^gui\/501\//);
});

test('failed unload keeps both the running task and its configuration', (t) => {
  const f = fixture(t, { bootoutFails: true });
  assert.throws(() => applyAgent({ ...f, remove: true }), /bootout-failed/);
  assert.equal(f.loaded(), true);
  assert.equal(fs.readFileSync(f.plistPath, 'utf8'), 'previous-config');
});

test('invalid replacement is rejected before disturbing the existing task', (t) => {
  const f = fixture(t, { lintFails: true });
  assert.throws(() => applyAgent(f), /invalid-plist/);
  assert.equal(f.loaded(), true);
  assert.equal(fs.readFileSync(f.plistPath, 'utf8'), 'previous-config');
  assert.equal(f.calls.some((call) => call[1] === 'bootout'), false);
});

test('failed replacement restores and reactivates the old agent', (t) => {
  const f = fixture(t, { bootstrapFails: true });
  assert.throws(() => applyAgent(f), /previous configuration restored/);
  assert.equal(f.loaded(), true);
  assert.equal(fs.readFileSync(f.plistPath, 'utf8'), 'previous-config');
});

test('a valid replacement is active and its plist is private', (t) => {
  const f = fixture(t);
  applyAgent(f);
  assert.equal(f.loaded(), true);
  assert.equal(fs.readFileSync(f.plistPath, 'utf8'), 'new-config');
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.plistPath).mode & 0o777, 0o600);
});
