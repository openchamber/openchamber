import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Outcome for the next spawned helper: 'spawned' resolves true, 'error' resolves false.
let nextSpawnOutcome = 'spawned';
let lastSpawnArgs = null;

const spawn = mock((_helper, args, _opts) => {
  lastSpawnArgs = args;
  const handlers = {};
  queueMicrotask(() => {
    if (nextSpawnOutcome === 'spawned' && handlers.spawn) handlers.spawn();
    if (nextSpawnOutcome === 'error' && handlers.error) handlers.error(new Error('spawn failed'));
  });
  return {
    once: (event, handler) => {
      handlers[event] = handler;
    },
    unref: () => undefined,
  };
});

mock.module('child_process', () => ({ spawn }));

mock.module('vscode', () => ({
  window: {
    get state() {
      return { focused: false };
    },
    showInformationMessage: mock(async () => undefined),
    showWarningMessage: mock(async () => undefined),
    showErrorMessage: mock(async () => undefined),
  },
  commands: { executeCommand: mock(async () => undefined) },
}));

const { resolveSnoreToastPath, tryShowOsToast } = await import('./osToast.ts');

const makeExtensionDir = (withExe, withIcon) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'och-toast-test-'));
  if (withExe) {
    const vendor = path.join(dir, 'vendor', 'snoreToast');
    fs.mkdirSync(vendor, { recursive: true });
    fs.writeFileSync(path.join(vendor, `snoretoast-${withExe}.exe`), 'dummy');
  }
  if (withIcon) {
    const assets = path.join(dir, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, 'app-icon.png'), 'dummy');
  }
  return dir;
};

describe('OS toast helper resolution', () => {
  test('non-Windows platforms resolve to null', () => {
    expect(resolveSnoreToastPath('/ext', 'darwin', 'arm64')).toBeNull();
    expect(resolveSnoreToastPath('/ext', 'linux', 'x64')).toBeNull();
  });

  test('missing extension path or binary resolves to null', () => {
    expect(resolveSnoreToastPath('', 'win32', 'x64')).toBeNull();
    expect(resolveSnoreToastPath('/definitely/not/here', 'win32', 'x64')).toBeNull();
  });

  test('win32 picks the exe matching the arch', () => {
    const dir = makeExtensionDir('x64', false);
    expect(resolveSnoreToastPath(dir, 'win32', 'x64')).toBe(
      path.join(dir, 'vendor', 'snoreToast', 'snoretoast-x64.exe'),
    );
    expect(resolveSnoreToastPath(dir, 'win32', 'arm64')).toBe(
      path.join(dir, 'vendor', 'snoreToast', 'snoretoast-x64.exe'),
    );
    expect(resolveSnoreToastPath(dir, 'win32', 'ia32')).toBeNull();
  });
});

describe('OS toast delivery', () => {
  beforeEach(() => {
    spawn.mockClear();
    lastSpawnArgs = null;
    nextSpawnOutcome = 'spawned';
  });

  test('no spawn happens off Windows', async () => {
    const shown = await tryShowOsToast({ title: 't', body: 'b', extensionPath: '/ext' });
    expect(shown).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('successful spawn returns true with title/message/appId args', async () => {
    const dir = makeExtensionDir('x64', false);
    const shown = await tryShowOsToast({ title: 'Ready', body: 'done', extensionPath: dir });
    expect(shown).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    // NB: SnoreToast has no `-a` shorthand; `-appid` is the only valid flag.
    expect(lastSpawnArgs).toContain('-t');
    expect(lastSpawnArgs).toContain('Ready');
    expect(lastSpawnArgs).toContain('-m');
    expect(lastSpawnArgs).toContain('done');
    expect(lastSpawnArgs).toContain('-appid');
    expect(lastSpawnArgs).not.toContain('-a');
    expect(lastSpawnArgs).not.toContain('-p');
  });

  test('icon is attached when the extension ships one', async () => {
    const dir = makeExtensionDir('x64', true);
    await tryShowOsToast({ title: 'Ready', body: 'done', extensionPath: dir });
    expect(lastSpawnArgs).toContain('-p');
    expect(lastSpawnArgs).toContain(path.join(dir, 'assets', 'app-icon.png'));
  });

  test('spawn failure returns false so the caller falls back', async () => {
    nextSpawnOutcome = 'error';
    const dir = makeExtensionDir('x64', false);
    const shown = await tryShowOsToast({ title: 'Ready', body: 'done', extensionPath: dir });
    expect(shown).toBe(false);
  });
});
