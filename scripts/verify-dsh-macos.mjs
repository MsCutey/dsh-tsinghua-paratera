#!/usr/bin/env node
// Real installed DSH carrier, fresh home, no account login or balance requests.
// No browser opens. A watchdog stops the carrier well before its renewal timer.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { recommendedModel } from '../lib/models.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.DSH_CLI || '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const check = (condition, message) => { if (!condition) throw new Error(message); };

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function main() {
  check(process.platform === 'darwin', 'macos-only');
  check(fs.existsSync(cli), 'DSH CLI not found; set DSH_CLI to the installed carrier');
  const artifacts = path.join(root, '.artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const folder = fs.mkdtempSync(path.join(artifacts, 'dsh-runtime-check-'));
  const home = path.join(folder, 'home');
  const agents = path.join(folder, 'agents');
  fs.mkdirSync(agents, { recursive: true });
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: agents, npm_config_store_dir: path.join(folder, 'store') };
  await exec(cli, ['--profile', 'macos-check', '--from-default-profile', 'web', '--dump-config'], { env, cwd: folder, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  await exec(process.execPath, [path.join(root, 'scripts', 'install.mjs'), '--dsh-home', home, '--profile', 'macos-check', '--no-task'], { env, cwd: folder, timeout: 120000 });
  const child = spawn(cli, ['--profile', 'macos-check', '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, cwd: folder, stdio: ['ignore', 'pipe', 'pipe'] });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 45000);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', () => {});
  try {
    const launch = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DSH startup timed out')), 20000);
      const inspect = () => {
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\S*/);
        if (match) { clearTimeout(timer); child.stdout.off('data', inspect); resolve(match[0]); }
      };
      child.once('error', () => { clearTimeout(timer); reject(new Error('DSH could not start')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('DSH exited before verification')); });
      child.stdout.on('data', inspect);
      inspect();
    });
    const base = new URL(launch).origin;
    const request = (endpoint, options = {}) => fetch(base + endpoint, { redirect: 'manual', signal: AbortSignal.timeout(5000), ...options });
    const endpoint = '/paratera-balance/api/status';
    const anonymous = await request(endpoint);
    check(anonymous.status === 401, 'unauthenticated status request must be 401');
    const foreign = await request(endpoint, { headers: { origin: 'https://untrusted.invalid' } });
    check(foreign.status === 403, 'cross-origin status request must be 403');
    const connect = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    check(connect.status === 303, 'test launch URL must establish a session');
    const cookie = connect.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
    check(Boolean(cookie), 'DSH did not establish its test cookie');
    const headers = { cookie, origin: base };
    const status = await request(endpoint, { headers });
    const body = await status.json();
    check(status.status === 200 && body.ok && body.source === 'easycompute', 'plugin did not return its status');
    check(body.configured === false && body.snapshot === null, 'isolated home must not contain a real session');
    const hello = await request('/paratera-balance/api/diagnostics/hello', { method: 'POST', headers });
    check(hello.status === 200, 'diagnostics hello failed');
    const diagnostics = await (await request('/paratera-balance/api/diagnostics', { headers })).json();
    check(diagnostics.ok && diagnostics.host.platform === 'darwin' && diagnostics.host.compatibility.ok === true, 'Mac host compatibility was not recognised');
    check(diagnostics.services.settings && diagnostics.services.llm && Number.isFinite(diagnostics.client.ageMs), 'new host services or heartbeat are unavailable');
    const modelState = await (await request('/paratera-balance/api/models', { headers })).json();
    check(modelState.ok && Array.isArray(modelState.models) && modelState.models.length === 0, 'isolated model list was not empty');
    const sample = recommendedModel('test-only/mac-model');
    const writeModels = (revision) => request('/paratera-balance/api/models', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ models: [sample], revision }),
    }).then((reply) => reply.json());
    const savedModels = await writeModels(modelState.revision);
    check(savedModels.ok, 'real Mac Settings write failed');
    const persistedModels = await (await request('/paratera-balance/api/models', { headers })).json();
    check(persistedModels.models?.some((model) => model.id === sample.id && model.reasoningEfforts?.max === 'max'), 'Mac model settings did not round-trip');
    const staleModels = await writeModels(modelState.revision);
    check(!staleModels.ok && staleModels.error === 'config-conflict', 'real Mac Settings did not reject a stale revision');
    for (const route of ['credentials/status', 'keys', 'keys/import/status', 'models', 'diagnostics', '2fa/status']) {
      check((await request('/paratera-balance/api/' + route)).status === 401, `${route} must require authentication`);
    }
    const index = await request('/', { headers });
    const html = await index.text();
    check(index.status === 200, 'DSH index did not load');
    const match = html.match(/"id":"dsh-paratera-balance","url":"([^"]+)"/);
    check(Boolean(match), 'plugin client was not registered');
    const client = await request('/' + match[1], { headers });
    const code = await client.text();
    check(client.status === 200 && code.includes('conversation.input.right') && code.includes('paratera-balance-settings'), 'plugin client code was not served');
    for (const route of ['refresh', 'login', 'credentials']) {
      const result = await request('/paratera-balance/api/' + route, { headers });
      check(result.status === 405, `${route} must reject GET without performing the action`);
    }
    check(!fs.existsSync(path.join(home, 'easycompute-session.json')), 'verification must not obtain an account session');
    const summary = { ok: true, hostLoaded: true, clientServed: true, pluginVersion: diagnostics.plugin.version, hostVersion: diagnostics.host.version,
      diagnostics: true, modelSettingsRoundTrip: true, staleRevisionRejected: true,
      authenticatedStatus: 200, unauthenticatedStatus: 401, crossOriginStatus: 403, wrongMethods: 405, realAccountUsed: false };
    fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ ...summary, evidence: path.join(folder, 'result.json') }, null, 2));
  } finally {
    clearTimeout(watchdog);
    await stop(child);
  }
}

main().catch(() => { console.error(JSON.stringify({ ok: false, error: 'DSH isolated verification failed; check CLI availability and loopback permissions' })); process.exitCode = 1; });
