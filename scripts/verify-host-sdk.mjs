#!/usr/bin/env node
// Exercise the installed carrier SDK in Electron's Node mode. This does not
// launch the GUI/server, log in, or touch the actual DSH profile/credentials.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/verify-host-sdk.mjs --electron <DSH executable> [--sdk-root <installed dsh/node_modules>]');
    return;
  }
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--electron', '--sdk-root'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('invalid arguments; use --help');
    values[args[i]] = args[i + 1];
  }
  const executable = values['--electron'] || process.env.DSH_ELECTRON_BIN;
  if (!executable || !fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) throw Error('provide the installed DSH executable using --electron');
  const resources = process.platform === 'darwin'
    ? path.resolve(path.dirname(executable), '..', 'Resources')
    : path.join(path.dirname(executable), 'resources');
  const sdk = values['--sdk-root'] || path.join(resources, 'app.asar', 'dsh', 'node_modules');
  if (!values['--sdk-root'] && !fs.existsSync(path.join(resources, 'app.asar'))) throw Error('installed DSH app.asar was not found; specify --sdk-root if needed');
  const result = spawnSync(executable, ['--test', '--test-force-exit', fileURLToPath(new URL('../tests/host-sdk.test.mjs', import.meta.url))], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_SDK_NODE_MODULES: sdk },
  });
  if (result.error) throw Error('could not start the installed SDK test');
  process.exitCode = result.status ?? 1;
}
try { main(); } catch (error) { console.error(`Host SDK verification: ${error.message}`); process.exitCode = 1; }
