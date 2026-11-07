import os from 'node:os';
import path from 'node:path';

export function platformPaths(platform = process.platform, home = os.homedir(), env = process.env) {
  // Use the target platform's semantics even when the installer/tests run on a
  // different OS. Windows home comparisons are case-insensitive.
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const dshHome = paths.resolve(env.DSH_HOME || paths.join(home, '.dsh'));
  const defaultHome = paths.resolve(paths.join(home, '.dsh'));
  const customHome = platform === 'win32' ? dshHome.toLowerCase() !== defaultHome.toLowerCase() : dshHome !== defaultHome;
  const mac = platform === 'darwin';
  const chromeCandidates = mac ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    paths.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ] : platform === 'win32' ? [
    paths.join(env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    paths.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ] : [];
  return {
    dshHome,
    sessionFile: paths.join(dshHome, 'easycompute-session.json'),
    stateFile: paths.join(dshHome, 'easycompute-state.json'),
    profileDir: customHome ? paths.join(dshHome, 'browser-profile') : mac
      ? paths.join(home, 'Library', 'Application Support', 'DSH Tsinghua Paratera', 'Chrome')
      : paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'dsh-tsinghua-paratera-profile'),
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
