#!/usr/bin/env node
// Opt-in per-user launchd agent. Never requires sudo or changes system daemons.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const LABEL = 'cn.edu.tsinghua.dsh-paratera-balance.refresh';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const xml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

export function agentLabel(dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  const resolved = path.resolve(dshHome);
  return resolved === path.join(os.homedir(), '.dsh') ? LABEL
    : `${LABEL}.${createHash('sha256').update(resolved).digest('hex').slice(0, 12)}`;
}

export function makePlist({ node = process.execPath, pluginDir = ROOT, dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), interval = 21600, label = agentLabel(dshHome) } = {}) {
  if (!Number.isSafeInteger(interval) || interval < 300) throw new Error('interval must be an integer >= 300 seconds');
  if (![node, pluginDir, dshHome].every(path.isAbsolute)) throw new Error('all paths must be absolute');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(node)}</string><string>${xml(path.join(pluginDir, 'lib', 'scheduled.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(pluginDir)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>DSH_HOME</key><string>${xml(dshHome)}</string>
    <key>PATH</key><string>${xml(path.dirname(node))}:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict></plist>
`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--dry-run', '--remove'].includes(arg))) throw new Error('usage: node scripts/setup-macos-task.mjs [--dry-run|--remove]');
  if (process.platform !== 'darwin') throw new Error('macos-only');
  const label = agentLabel();
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', label + '.plist');
  const domain = `gui/${process.getuid()}`;
  const remove = args.includes('--remove');
  const content = makePlist();
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify({ ok: true, dryRun: true, remove, plistPath, domain, plist: remove ? undefined : content }, null, 2));
    return;
  }
  applyAgent({ plistPath, domain, content, remove, label });
  console.log(JSON.stringify({ ok: true, ...(remove ? { removed: true } : { label, intervalSeconds: 21600 }), plistPath }));
}

export function applyAgent({ plistPath, domain, content, label = LABEL, remove = false, run = (file, args) => spawnSync(file, args, { encoding: 'utf8' }) }) {
  const target = `${domain}/${label}`;
  const probe = () => run('/bin/launchctl', ['print', target]);
  const initial = probe();
  if (initial.error) throw new Error('launchctl-unavailable');
  const wasLoaded = initial.status === 0;
  const previous = fs.existsSync(plistPath) ? fs.readFileSync(plistPath) : null;

  const unload = () => {
    if (!wasLoaded) return;
    const result = run('/bin/launchctl', ['bootout', target]);
    if (result.status !== 0 || probe().status === 0) throw new Error('launchctl-bootout-failed; existing agent left unchanged');
  };
  if (remove) {
    unload();
    // Only remove the plist once the running job has actually been unloaded.
    fs.rmSync(plistPath, { force: true });
    return;
  }

  fs.mkdirSync(path.dirname(plistPath), { recursive: true, mode: 0o700 });
  const staging = `${plistPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(staging, content, { mode: 0o600 });
    fs.chmodSync(staging, 0o600);
    if (run('/usr/bin/plutil', ['-lint', staging]).status !== 0) throw new Error('invalid-plist; existing agent left unchanged');
    unload();
    fs.renameSync(staging, plistPath);
    const result = run('/bin/launchctl', ['bootstrap', domain, plistPath]);
    if (result.status === 0 && probe().status === 0) return;
    run('/bin/launchctl', ['bootout', target]);
    // Restore the previous configuration and activation if replacement failed.
    if (previous) {
      fs.writeFileSync(plistPath, previous, { mode: 0o600 });
      fs.chmodSync(plistPath, 0o600);
      if (wasLoaded && run('/bin/launchctl', ['bootstrap', domain, plistPath]).status !== 0) {
        throw new Error('launchctl-bootstrap-failed; previous plist restored but could not reactivate');
      }
    } else fs.rmSync(plistPath, { force: true });
    throw new Error('launchctl-bootstrap-failed; previous configuration restored');
  } finally { fs.rmSync(staging, { force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
