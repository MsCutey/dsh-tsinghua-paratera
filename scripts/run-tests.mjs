#!/usr/bin/env node
// Ordinary tests never inherit the user's live DSH profile or browser storage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'paratera-test-isolation-'));
try {
  const files = fs.readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join(root, 'tests', name));
  const result = spawnSync(process.execPath, ['--test', '--test-force-exit', ...process.argv.slice(2), ...files], {
    cwd: root, stdio: 'inherit', timeout: 240000,
    env: { ...process.env, DSH_HOME: home, LOCALAPPDATA: path.join(home, 'local-app-data') },
  });
  if (result.error) console.error('test-runner-failed:', result.error.code || 'unknown');
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
}
