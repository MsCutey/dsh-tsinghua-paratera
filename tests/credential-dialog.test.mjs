// Regression tests for the Windows credential-dialog launcher.
//
// 0.8.1 spawned powershell.exe with `detached: true`. A detached console host
// exits (code 0) before running the script, so the WinForms dialog never
// appeared and the settings page sat on「启动中」until its polling gave up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openCredentialDialog, credentialDialogOpen } from '../lib/refresh.mjs';

const script = 'C:/plugin/scripts/store-easycompute-credentials.ps1';
const scriptExists = () => true;

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => { child.unrefCalled = true; };
  return child;
}

test('dialog host is spawned attached, console hidden, dialog window left visible', async () => {
  const child = fakeChild();
  let call;
  const result = await openCredentialDialog({
    platform: 'win32',
    script,
    scriptExists,
    spawnImpl: (exe, args, options) => {
      call = { exe, args, options };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(call.exe, 'powershell.exe');
  // `detached` is the 0.8.1 bug: the console host dies before the script runs.
  assert.equal(call.options.detached, undefined);
  // `windowsHide` hides the WinForms dialog together with the console.
  assert.notEqual(call.options.windowsHide, true);
  // -WindowStyle Hidden removes the console window without touching the dialog.
  const style = call.args.indexOf('-WindowStyle');
  assert.notEqual(style, -1);
  assert.equal(call.args[style + 1], 'Hidden');
  assert.equal(call.args.at(-1), script);
  assert.equal(child.unrefCalled, true);
  assert.equal(credentialDialogOpen(), true);

  // The user closes the window: the host must stop reporting it as open.
  child.exitCode = 0;
  child.emit('exit', 0);
  assert.equal(credentialDialogOpen(), false);
});

test('a host that dies at startup is reported instead of leaving the UI waiting', async () => {
  const child = fakeChild();
  const result = await openCredentialDialog({
    platform: 'win32',
    script,
    scriptExists,
    spawnImpl: () => {
      queueMicrotask(() => {
        child.emit('spawn');
        setTimeout(() => child.emit('exit', 0), 60);
      });
      return child;
    },
  });

  assert.deepEqual(result, { ok: false, error: 'credential-dialog-failed' });
  assert.equal(credentialDialogOpen(), false);
});

test('spawn failure, missing script and foreign platforms surface distinct errors', async () => {
  const broken = await openCredentialDialog({
    platform: 'win32',
    script,
    scriptExists,
    spawnImpl: () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('error', new Error('ENOENT')));
      return child;
    },
  });
  assert.deepEqual(broken, { ok: false, error: 'credential-dialog-failed' });

  const missing = await openCredentialDialog({
    platform: 'win32',
    script,
    scriptExists: () => false,
    spawnImpl: () => { throw new Error('must not spawn without a script'); },
  });
  assert.deepEqual(missing, { ok: false, error: 'script-missing' });

  const foreign = await openCredentialDialog({
    platform: 'linux',
    script,
    scriptExists,
    spawnImpl: () => { throw new Error('must not spawn on other platforms'); },
  });
  assert.deepEqual(foreign, { ok: false, error: 'unsupported-platform' });
});
