import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;
const originalManagedProcessRegistry = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;

afterEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  vi.unstubAllGlobals();
  if (typeof originalOpencodeBinary === 'string') {
    process.env.OPENCODE_BINARY = originalOpencodeBinary;
  } else {
    delete process.env.OPENCODE_BINARY;
  }

  if (typeof originalPath === 'string') {
    process.env.PATH = originalPath;
  } else {
    delete process.env.PATH;
  }

  if (typeof originalManagedProcessRegistry === 'string') {
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = originalManagedProcessRegistry;
  } else {
    delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
  }
});

const createMockChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.kill = vi.fn(() => {
    child.signalCode = 'SIGTERM';
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  return child;
};

const createLifecycleState = () => ({
  openCodeWorkingDirectory: '/tmp/project',
  openCodeProcess: null,
  openCodePort: null,
  openCodeBaseUrl: null,
  currentRestartPromise: null,
  isRestartingOpenCode: false,
  openCodeApiPrefix: '',
  openCodeApiPrefixDetected: false,
  openCodeApiDetectionTimer: null,
  lastOpenCodeError: null,
  lastOpenCodeLaunchDiagnostics: null,
  isOpenCodeReady: false,
  openCodeNotReadySince: 0,
  isExternalOpenCode: false,
  isShuttingDown: false,
  healthCheckInterval: null,
  expressApp: null,
  useWslForOpencode: false,
  resolvedWslBinary: null,
  resolvedWslOpencodePath: null,
  resolvedWslDistro: null,
});

const createRuntime = (overrides = {}) => {
  const state = overrides.state ?? createLifecycleState();

  return createOpenCodeLifecycleRuntime({
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: 45678,
      ENV_CONFIGURED_OPENCODE_HOST: null,
      ENV_EFFECTIVE_PORT: 3001,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ENV_SKIP_OPENCODE_START: false,
    },
    syncToHmrState: vi.fn(),
    syncFromHmrState: vi.fn(),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:45678${route}`,
    waitForReady: vi.fn(async () => true),
    normalizeApiPrefix: vi.fn(() => ''),
    applyOpencodeBinaryFromSettings: vi.fn(async () => null),
    ensureOpencodeCliEnv: vi.fn(),
    ensureLocalOpenCodeServerPassword: vi.fn(async () => 'password'),
    resolveManagedOpenCodeLaunchSpec: vi.fn((binary) => ({ binary, args: [], wrapperType: null })),
    setOpenCodePort: vi.fn((port) => {
      state.openCodePort = port;
    }),
    setDetectedOpenCodeApiPrefix: vi.fn(),
    setupProxy: vi.fn(),
    ensureOpenCodeApiPrefix: vi.fn(),
    clearResolvedOpenCodeBinary: vi.fn(),
    buildAugmentedPath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    buildManagedOpenCodePath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
      PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
      SHELL_ONLY: 'yes',
      OPENCODE_SERVER_PASSWORD: 'shell-password',
    })),
    ...overrides,
  });
};

describe('OpenCode lifecycle', () => {
  it('uses only the configured external target in skip-start mode, ahead of HMR reuse', async () => {
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = `/tmp/openchamber-lifecycle-test-${process.pid}-configured`;
    const managedProcess = { close: vi.fn(async () => {}) };
    const state = createLifecycleState();
    state.openCodeProcess = managedProcess;
    state.openCodePort = 4096;
    state.isOpenCodeReady = true;
    state.lastOpenCodeLaunchDiagnostics = { binary: 'opencode' };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ healthy: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createRuntime({
      state,
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 4999,
        ENV_CONFIGURED_OPENCODE_HOST: { origin: 'https://external.example:7443', port: 7443 },
        ENV_EFFECTIVE_PORT: 7443,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      buildOpenCodeUrl: (route) => `${state.openCodeBaseUrl}${route}`,
    });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(managedProcess.close).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://external.example:7443/global/health');
    expect(state.openCodeProcess).toBeNull();
    expect(state.openCodePort).toBe(7443);
    expect(state.openCodeBaseUrl).toBe('https://external.example:7443');
    expect(state.isExternalOpenCode).toBe(true);
    expect(state.isOpenCodeReady).toBe(true);
    expect(state.openCodeNotReadySince).toBe(0);
    expect(state.lastOpenCodeError).toBeNull();
    expect(state.lastOpenCodeLaunchDiagnostics).toBeNull();
  });

  it('keeps OpenCode unavailable without waiting or spawning when skip-start has no target', async () => {
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = `/tmp/openchamber-lifecycle-test-${process.pid}-unconfigured`;
    const managedProcess = { close: vi.fn(async () => {}) };
    const state = createLifecycleState();
    state.openCodeProcess = managedProcess;
    state.openCodePort = 4096;
    state.isOpenCodeReady = true;
    state.lastOpenCodeLaunchDiagnostics = { binary: 'opencode' };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createRuntime({
      state,
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: null,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: null,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
    });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(managedProcess.close).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.openCodeProcess).toBeNull();
    expect(state.openCodePort).toBeNull();
    expect(state.openCodeBaseUrl).toBeNull();
    expect(state.isExternalOpenCode).toBe(false);
    expect(state.isOpenCodeReady).toBe(false);
    expect(state.openCodeNotReadySince).toBeGreaterThan(0);
    expect(state.lastOpenCodeError).toBe('OpenCode is unavailable: skip-start mode requires OPENCODE_HOST or OPENCODE_PORT');
    expect(state.lastOpenCodeLaunchDiagnostics).toBeNull();
  });

  it('launches managed OpenCode with the managed PATH', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    const [binary, args, options] = spawnMock.mock.calls[0];

    expect(binary).toBe('opencode');
    expect(args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '45678']);
    expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.SHELL_ONLY).toBe('yes');
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBe('password');

    await server.close();
  });

  it('falls back to buildAugmentedPath when buildManagedOpenCodePath is not provided', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: vi.fn(() => '/home/user/.cargo/bin:/usr/local/bin'),
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/home/user/.cargo/bin:/usr/local/bin');

    await server.close();
  });

  it('falls back to process.env.PATH when neither build function is provided', async () => {
    delete process.env.OPENCODE_BINARY;
    process.env.PATH = '/usr/bin:/bin';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: undefined,
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/usr/bin:/bin');

    await server.close();
  });

  it('reports the binary when managed OpenCode exits before becoming ready', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.emit('exit', null, 'SIGTERM');
      });
      return secondChild;
    });

    const runtime = createRuntime();

    await expect(runtime.startOpenCode()).rejects.toThrow('OpenCode process exited before serving with signal SIGTERM. Binary used: opencode. No stdout/stderr captured');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry managed startup when the configured OpenCode binary is invalid', async () => {
    delete process.env.OPENCODE_BINARY;
    const error = new Error('Configured OpenCode binary not found: /missing/opencode');
    error.code = 'OPENCODE_BINARY_INVALID';
    const applyOpencodeBinaryFromSettings = vi.fn(async () => {
      throw error;
    });

    const runtime = createRuntime({ applyOpencodeBinaryFromSettings });

    await expect(runtime.startOpenCode()).rejects.toThrow('Configured OpenCode binary not found: /missing/opencode');
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledTimes(1);
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledWith({ strict: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('retries managed OpenCode startup once after a pre-ready exit', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return secondChild;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    await server.close();
  });
});
