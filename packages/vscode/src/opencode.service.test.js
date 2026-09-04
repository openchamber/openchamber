import { afterAll, afterEach, beforeEach, describe, mock, test } from 'bun:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let apiUrl = '';
let binaryPath = '';
let fetchCalls = [];
let spawnCalls = [];
let childKills = 0;
let portAllocations = 0;
let passwordGenerations = 0;
let registryRegistrations = 0;
let registryUnregistrations = 0;
let registryReaps = 0;
let serviceDiscoveries = 0;
let serviceStops = 0;
let serviceEndpoints = [];
let root = '';
let nextPid = 4100;

mock.module('vscode', () => ({
  Disposable: class {
    constructor(dispose) {
      this.dispose = dispose;
    }
  },
  l10n: {
    t: (value, ...args) => args.reduce((message, arg, index) => message.replace(`{${index}}`, String(arg)), value),
  },
  workspace: {
    get workspaceFolders() {
      return [{ uri: { fsPath: root } }];
    },
    getConfiguration: () => ({
      get: (key) => key === 'apiUrl' ? apiUrl : key === 'opencodeBinary' ? binaryPath : '',
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
      if (args.at(-2) === 'service' && args.at(-1) === 'start') {
        child.emit('exit', 0, null);
      } else {
        child.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:47821\n'));
      }
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

mock.module('@opencode-ai/client/service', () => ({
  Service: {
    discover: async () => {
      serviceDiscoveries += 1;
      return serviceEndpoints.shift();
    },
    stop: async () => { serviceStops += 1; },
    headers: (endpoint) => endpoint.auth
      ? { authorization: `Basic ${Buffer.from(`${endpoint.auth.username}:${endpoint.auth.password}`).toString('base64')}` }
      : undefined,
  },
}));

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const opencode = await import('./opencode');

const createExecutable = (name) => {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const filePath = path.join(root, `${name}${extension}`);
  fs.writeFileSync(filePath, '');
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o755);
  return filePath;
};

const createContext = () => ({
  globalStorageUri: { fsPath: path.join(root, 'storage') },
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-service-'));
  apiUrl = '';
  binaryPath = '';
  fetchCalls = [];
  spawnCalls = [];
  childKills = 0;
  portAllocations = 0;
  passwordGenerations = 0;
  registryRegistrations = 0;
  registryUnregistrations = 0;
  registryReaps = 0;
  serviceDiscoveries = 0;
  serviceStops = 0;
  serviceEndpoints = [];
  delete process.env.OPENCODE_BINARY;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  delete process.env.OPENCODE_SERVER_USERNAME;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
    return Response.json({ healthy: true, version: '1.18.18' });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe('OpenCode V2 global service lifecycle', () => {
  test('starts the effective service command and stores discovered endpoint auth without private ownership', async () => {
    binaryPath = createExecutable('opencode2');
    process.env.GEMINI_API_KEY = 'provider-secret';
    process.env.OPENCODE_SERVER_USERNAME = 'extension-user';
    process.env.OPENCODE_SERVER_PASSWORD = 'extension-password';
    serviceEndpoints.push({
      url: 'http://127.0.0.1:55221/',
      auth: { type: 'basic', username: 'service-user', password: 'service-password' },
    });
    const manager = opencode.createOpenCodeManager(createContext());

    await manager.start();

    const launch = opencode.resolveWindowsLaunchSpec(binaryPath, []);
    assert.deepEqual(
      { binary: spawnCalls[0].binary, args: spawnCalls[0].args },
      { binary: launch.binary, args: [...launch.args, 'service', 'start'] },
    );
    assert.equal(manager.getApiUrl(), 'http://127.0.0.1:55221');
    assert.deepEqual(manager.getOpenCodeAuthHeaders(), {
      Authorization: `Basic ${Buffer.from('service-user:service-password').toString('base64')}`,
    });
    assert.equal(manager.getProtocol(), 'opencode2');
    assert.equal(manager.getStatus(), 'connected');
    assert.equal(serviceDiscoveries, 1);
    assert.equal(portAllocations, 0);
    assert.equal(passwordGenerations, 0);
    assert.equal(process.env.OPENCODE_SERVER_PASSWORD, 'extension-password');
    assert.equal(spawnCalls[0].options.env.OPENCODE_SERVER_PASSWORD, undefined);
    assert.equal(spawnCalls[0].options.env.OPENCODE_SERVER_USERNAME, undefined);
    assert.equal(spawnCalls[0].options.env.GEMINI_API_KEY, 'provider-secret');
    assert.equal(spawnCalls[0].options.env.GOOGLE_GENERATIVE_AI_API_KEY, undefined);
    assert.equal(registryReaps, 0);
    assert.equal(registryRegistrations, 0);

    await manager.stop();

    assert.equal(manager.getStatus(), 'disconnected');
    assert.equal(manager.getApiUrl(), null);
    assert.equal(serviceStops, 0);
    assert.equal(childKills, 0);
  });

  test('restart reconnects to a changed discovered endpoint without stopping the global service', async () => {
    binaryPath = createExecutable('opencode2');
    serviceEndpoints.push(
      { url: 'http://127.0.0.1:55221', auth: undefined },
      { url: 'http://127.0.0.1:55222', auth: { type: 'basic', username: 'next', password: 'secret' } },
    );
    const manager = opencode.createOpenCodeManager(createContext());
    const transitions = [];
    manager.onStatusChange((status) => transitions.push({ status, url: manager.getApiUrl() }));
    await manager.start();
    transitions.length = 0;

    await manager.restart();

    assert.deepEqual(transitions, [
      { status: 'disconnected', url: null },
      { status: 'connecting', url: null },
      { status: 'connected', url: 'http://127.0.0.1:55222' },
    ]);
    assert.equal(spawnCalls.length, 2);
    assert.equal(serviceDiscoveries, 2);
    assert.equal(serviceStops, 0);
    assert.equal(manager.getApiUrl(), 'http://127.0.0.1:55222');
    assert.equal(portAllocations, 0);
    assert.equal(passwordGenerations, 0);
    assert.equal(registryReaps, 0);
  });

  test('fails clearly when the global service has no compatible discoverable endpoint', async () => {
    binaryPath = createExecutable('opencode2');
    serviceEndpoints.push(undefined);
    const manager = opencode.createOpenCodeManager(createContext());

    await manager.start();

    assert.equal(manager.getStatus(), 'error');
    assert.match(manager.getDebugInfo().lastError, /healthy compatible endpoint/);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].args.includes('serve'), false);
    assert.equal(portAllocations, 0);
    assert.equal(passwordGenerations, 0);
    assert.equal(registryReaps, 0);
    assert.equal(registryRegistrations, 0);
  });
});

describe('unchanged OpenCode lifecycle modes', () => {
  test('legacy managed CLI retains private serve, password, registry, and cleanup behavior', async () => {
    binaryPath = createExecutable('opencode');
    const manager = opencode.createOpenCodeManager(createContext());

    await manager.start();

    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0].args.slice(-5), ['serve', '--hostname', '127.0.0.1', '--port', '47821']);
    assert.equal(manager.getApiUrl(), 'http://127.0.0.1:47821');
    assert.equal(manager.getProtocol(), 'legacy');
    assert.equal(portAllocations, 1);
    assert.equal(passwordGenerations, 1);
    assert.equal(registryReaps, 1);
    assert.equal(registryRegistrations, 1);
    assert.equal(serviceDiscoveries, 0);
    assert.ok(fetchCalls[0].authorization?.startsWith('Basic '));

    await manager.stop();

    assert.equal(childKills, 1);
    assert.equal(registryUnregistrations, 1);
    assert.equal(manager.getStatus(), 'disconnected');
  });

  test('configured external URL remains authoritative and bypasses service discovery', async () => {
    apiUrl = 'http://external.test:4096/';
    binaryPath = createExecutable('opencode2');
    process.env.OPENCODE_SERVER_USERNAME = 'external-user';
    process.env.OPENCODE_SERVER_PASSWORD = 'external-password';
    const manager = opencode.createOpenCodeManager(createContext());

    await manager.start();

    assert.equal(manager.getApiUrl(), 'http://external.test:4096');
    assert.deepEqual(manager.getOpenCodeAuthHeaders(), {
      Authorization: `Basic ${Buffer.from('external-user:external-password').toString('base64')}`,
    });
    assert.equal(manager.getProtocol(), 'legacy');
    assert.equal(spawnCalls.length, 0);
    assert.equal(serviceDiscoveries, 0);
    assert.equal(portAllocations, 0);
    assert.equal(passwordGenerations, 0);
    assert.equal(registryReaps, 0);

    await manager.stop();
    assert.equal(manager.getStatus(), 'connected');
  });
});
