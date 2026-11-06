// Host-version compatibility check.
//
// The plugin has no static @deepseek-ai imports: it talks to the host through
// cordis services and to the web UI through slots. That keeps it portable, but
// a renamed service or a changed manifest contract still breaks it silently.
// This module makes the boundary explicit: it reports which DSH build the
// plugin is running inside and whether that build is one the test suite covers,
// so a broken upgrade shows up as "未验证的宿主版本" instead of a blank panel.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** DSH releases this build was actually exercised against. */
export const TESTED_DSH_RANGE = { min: '0.2.0', max: '0.3.0' };

const PLUGIN_PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

/** Plugin version, read once from its own package.json. */
export function pluginVersion() {
  try { return JSON.parse(fs.readFileSync(PLUGIN_PACKAGE, 'utf8')).version ?? null }
  catch { return null }
}

/** "0.2.1-rc.5" → [0, 2, 1]; null when it does not start with three numbers. */
export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/** Installed DSH version, read from the packaged app; null when unavailable. */
export function hostVersion({ resources = process.resourcesPath, read = fs.readFileSync } = {}) {
  if (!resources) return null;
  const candidates = [
    path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    path.join(resources, 'app.asar', 'dsh', 'package.json'),
    path.join(resources, 'app.asar', 'package.json'),
  ];
  for (const file of candidates) {
    try {
      const version = JSON.parse(read(file, 'utf8')).version;
      if (typeof version === 'string' && parseVersion(version)) return version;
    } catch { /* try the next layout */ }
  }
  return null;
}

/**
 * Classify a host version against the tested range.
 * `ok: null` means the version could not be determined, which is not a failure.
 */
export function compatibility(version, range = TESTED_DSH_RANGE) {
  const tested = `${range.min} – ${range.max} (不含 ${range.max})`;
  if (!version) return { ok: null, reason: 'unknown-host-version', tested };
  const parsed = parseVersion(version);
  if (!parsed) return { ok: null, reason: 'unparsable-host-version', tested };
  const above = compareVersions(parsed, parseVersion(range.min)) >= 0;
  const below = compareVersions(parsed, parseVersion(range.max)) < 0;
  return above && below
    ? { ok: true, version, tested }
    : { ok: false, reason: 'untested-host-version', version, tested };
}
