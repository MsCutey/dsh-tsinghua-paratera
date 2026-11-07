import os from 'node:os';
import path from 'node:path';

export function platformPaths(platform = process.platform, home = os.homedir(), env = process.env) {
  const dshHome = path.resolve(env.DSH_HOME || path.join(home, '.dsh'));
  const mac = platform === 'darwin';
  const chromeCandidates = mac ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ] : platform === 'win32' ? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ] : [];
  return {
    dshHome,
    sessionFile: path.join(dshHome, 'easycompute-session.json'),
    stateFile: path.join(dshHome, 'easycompute-state.json'),
    profileDir: dshHome !== path.resolve(path.join(home, '.dsh')) ? path.join(dshHome, 'browser-profile') : mac
      ? path.join(home, 'Library', 'Application Support', 'DSH Paratera Balance', 'Chrome')
      : path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'dsh-paratera-profile'),
    chromeCandidates,
  };
}

/**
 * How a given platform installs and maintains the plugin.
 * @returns {{supported: boolean, task: {kind: 'powershell'|'node', script: string}|null, credentialHelper: 'dpapi'|'keychain'|null, reason?: string}}
 */
export function resolveInstallPlan(platform = process.platform) {
  if (platform === 'win32') {
    return {
      supported: true,
      task: { kind: 'powershell', script: 'scripts/setup-windows-task.ps1' },
      credentialHelper: 'dpapi',
    };
  }
  if (platform === 'darwin') {
    return {
      supported: true,
      task: { kind: 'node', script: 'scripts/setup-macos-task.mjs' },
      credentialHelper: 'keychain',
    };
  }
  return { supported: false, task: null, credentialHelper: null, reason: 'unsupported-platform' };
}
