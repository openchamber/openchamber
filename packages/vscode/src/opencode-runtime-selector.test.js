import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The extension host provides the `vscode` module at runtime; tests mock it
// the same way bridge-config-runtime.test.js does. The manager under test
// reads only workspaceFolders/globalStorageUri/configuration from it.
let root = '';
let apiUrl = '';
let binaryPath = '';
let spawnCalls = [];
let childKills = 0;
let portAllocations = 0;
let passwordGenerations = 0;
let registryRegistrations = 0;
let registryUnregistrations = 0;
let registryReaps = 0;
let nextPid = 4100;

mock.module('vscode', () => ({
  Disposable: class {
    dispose() {}
  },
  l10n: {
    t: (value, ...args) => args.reduce((message, arg, index) => message.replace(`{${index}}`, String(arg)), value),
  },
  workspace: {
    get workspaceFolders() {
      return [{ uri: { fsPath: root } }];
    },
    getConfiguration: () => ({
      get: (key) => (key === 'apiUrl' ? apiUrl : key === 'opencodeBinary' ? binaryPath : ''),
    }),
  },
  window: {
    createOutputChannel: () => ({ appendLine() {} }),
    showErrorMessage: async () => undefined,
  },
  env: { openExternal: async () => undefined },
  Uri: { parse: (value) => value },
}));

mock.module('child_process', () => ({
  execSync: () => '',
  spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
  spawn: (binary, args, options) => {
    spawnCalls.push({ binary, args: [...args], options });
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      childKills += 1;
      return true;
    };
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:47821\n'));
    });
    return child;
  },
}));

mock.module('net', () => ({
  createServer: () => {
    portAllocations += 1;
    const server = new EventEmitter();
    server.address = () => ({ port: 47821 });
    server.close = (callback) => queueMicrotask(callback);
    server.listen = () => queueMicrotask(() => server.emit('listening'));
    return server;
  },
}));

mock.module('crypto', () => ({
  randomBytes: () => {
    passwordGenerations += 1;
    return Buffer.alloc(32, 7);
  },
}));

mock.module('./opencodeProcessRegistry', () => ({
  registerManagedProcess: async () => { registryRegistrations += 1; },
  unregisterManagedProcess: async () => { registryUnregistrations += 1; },
  reapOrphanedProcesses: async () => {
    registryReaps += 1;
    return { inspected: 0, reaped: 0 };
  },
}));

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const { createOpenCodeManager, __setOpenChamberSettingsPathForTest } = await import('./opencode');

// SAFETY: the manager under test reads only globalStorageUri from its
// context; the returned stub satisfies that single surface.
const createContext = () => ({
  globalStorageUri: { fsPath: path.join(root, 'storage') },
});

// The manager reads its runtime selector from ~/.config/openchamber/
// settings.json. Each test points that read at a temp file via the module's
// test seam so the real user file is never touched.
const writeSelector = (value) => {
  const configDir = path.join(root, 'home', '.config', 'openchamber');
  fs.mkdirSync(configDir, { recursive: true });
  const settingsPath = path.join(configDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ opencodeRuntime: value }), 'utf8');
  __setOpenChamberSettingsPathForTest(settingsPath);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-runtime-'));
  process.env.HOME = path.join(root, 'home');
  process.env.USERPROFILE = path.join(root, 'home');
  __setOpenChamberSettingsPathForTest(null);
  apiUrl = '';
  binaryPath = '';
  spawnCalls = [];
  childKills = 0;
  portAllocations = 0;
  passwordGenerations = 0;
  registryRegistrations = 0;
  registryUnregistrations = 0;
  registryReaps = 0;
  delete process.env.OPENCODE_BINARY;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  delete process.env.OPENCODE_SERVER_USERNAME;
  delete process.env.OPENCODE_PATH;
  delete process.env.OPENCHAMBER_OPENCODE_PATH;
  delete process.env.OPENCHAMBER_OPENCODE_BIN;
  // SAFETY: the stub answers the health-probe URL shapes the legacy ready
  // cycle issues; each call is recorded for the assertions.
  globalThis.fetch = (async (input, init) => {
    return Response.json({ healthy: true, version: '1.18.18' });
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setOpenChamberSettingsPathForTest(null);
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe('VS Code OpenCode runtime selector', () => {
  test('beta selection fails explicitly when V2 compatibility infrastructure is absent', async () => {
    writeSelector('beta');
    const manager = createOpenCodeManager(createContext());

    await manager.start();

    // startInternal reports failures through status/lastError instead of
    // rejecting; the beta gate must surface the dependency message and must
    // never fall back to the legacy spawn.
    expect(manager.getStatus()).toBe('error');
    expect(manager.getDebugInfo().lastError ?? '').toContain('Beta');
    expect(manager.getDebugInfo().lastError ?? '').toContain('not available');
    expect(spawnCalls.length).toBe(0);
    expect(portAllocations).toBe(0);
    expect(passwordGenerations).toBe(0);
    expect(registryRegistrations).toBe(0);
  });

  test('stable selection keeps the legacy managed path', async () => {
    writeSelector('stable');
    const manager = createOpenCodeManager(createContext());

    await manager.start();

    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].args.slice(-5)).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '47821']);
    expect(manager.getStatus()).toBe('connected');
    expect(manager.getApiUrl()).toBe('http://127.0.0.1:47821');
    expect(portAllocations).toBe(1);
    expect(passwordGenerations).toBe(1);

    await manager.stop();
    expect(manager.getStatus()).toBe('disconnected');
  });

  test('missing selector defaults to the stable legacy path', async () => {
    // No settings file at all: an old doc without the field must never enable
    // the beta path.
    const manager = createOpenCodeManager(createContext());

    await manager.start();

    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].args.slice(-5)).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '47821']);
    expect(manager.getStatus()).toBe('connected');
    expect(manager.getApiUrl()).toBe('http://127.0.0.1:47821');

    await manager.stop();
    expect(manager.getStatus()).toBe('disconnected');
  });
});
