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
    profileDir: mac
      ? path.join(home, 'Library', 'Application Support', 'DSH Paratera Balance', 'Chrome')
      : path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'dsh-paratera-profile'),
    chromeCandidates,
  };
}
