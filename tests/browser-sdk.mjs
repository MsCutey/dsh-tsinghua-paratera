// Load the installed browser's own React, Cordis and SlotCore without booting
// DSH or touching a user session. The only DOM is a disposable jsdom document.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export async function browserSdk(sdkRoot) {
  const { JSDOM } = await import('jsdom');
  const page = new JSDOM('<!doctype html><html><head></head><body><div id="test"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map();
  const set = (key, value) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent']) set(key, key === 'window' ? page.window : page.window[key]);
  for (const key of ['requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'addEventListener', 'removeEventListener']) set(key, page.window[key].bind(page.window));
  page.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'paratera-browser-sdk-'));
  const dispose = () => {
    page.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    fs.rmSync(folder, { recursive: true, force: true });
  };
  try {
    const require = createRequire(path.join(sdkRoot, '@deepseek-ai/dsh-web-app/lib/index.js'));
    const assets = path.join(path.dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'assets');
    fs.writeFileSync(path.join(folder, 'package.json'), '{"type":"module"}');
    let entry;
    for (const name of fs.readdirSync(assets).filter((name) => name.endsWith('.js'))) {
      let source = fs.readFileSync(path.join(assets, name), 'utf8');
      const modules = source.match(/function (\w+)\(\)\{return\{react:/);
      const boot = /const \w+=globalThis\.dshDesktopBoot/.exec(source);
      if (modules && boot) {
        source = source.slice(0, boot.index) + `\nexport const staticModules = ${modules[1]}();\n`;
        entry = name;
      }
      fs.writeFileSync(path.join(folder, name), source);
    }
    if (!entry) throw Error('installed browser static-module layout is unsupported');
    const { staticModules } = await import(pathToFileURL(path.join(folder, entry)).href);
    return { modules: staticModules, page, dispose };
  } catch (error) { dispose(); throw error; }
}
