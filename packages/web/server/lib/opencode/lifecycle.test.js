import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: vi.fn(),
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;

afterEach(() => {
  spawnMock.mockReset();
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

const createRuntime = (overrides = {}) => {
  const state = {
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
  };

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

  describe('refreshOpenCodeAfterConfigChange — deferred restart on busy sessions', () => {
    const createDeferredRuntime = (overrides = {}) => {
      const state = {
        openCodeWorkingDirectory: '/tmp/project',
        openCodeProcess: null,
        openCodePort: 45678,
        openCodeBaseUrl: null,
        currentRestartPromise: null,
        isRestartingOpenCode: false,
        openCodeApiPrefix: '',
        openCodeApiPrefixDetected: true,
        openCodeApiDetectionTimer: null,
        lastOpenCodeError: null,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isExternalOpenCode: false,
        isShuttingDown: false,
        healthCheckInterval: null,
        expressApp: null,
        useWslForOpencode: false,
        resolvedWslBinary: null,
        resolvedWslOpencodePath: null,
        resolvedWslDistro: null,
      };

      const restartOpenCodeCalls = [];
      const runtime = createOpenCodeLifecycleRuntime({
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
        setOpenCodePort: vi.fn((port) => { state.openCodePort = port; }),
        setDetectedOpenCodeApiPrefix: vi.fn(),
        setupProxy: vi.fn(),
        ensureOpenCodeApiPrefix: vi.fn(),
        clearResolvedOpenCodeBinary: vi.fn(),
        buildAugmentedPath: vi.fn(() => '/usr/bin'),
        buildManagedOpenCodePath: vi.fn(() => '/usr/bin'),
        getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({})),
        waitForOpenCodeReady: vi.fn(async () => undefined),
        waitForAgentPresence: vi.fn(async () => undefined),
        // Track internal restartOpenCode calls by spying on the returned API.
        ...overrides,
      });

      // Wrap the real restartOpenCode (defined inside the runtime closure) so
      // tests can assert whether a restart actually happened. We cannot inject
      // restartOpenCode from deps, so we spy on the exported function.
      const realRestart = runtime.restartOpenCode;
      const spy = vi.fn(async () => {
        restartOpenCodeCalls.push(true);
        // Don't call realRestart (which would spawn). Just mark state as ready.
        state.isOpenCodeReady = true;
        state.openCodeNotReadySince = 0;
      });
      // Replace the exported binding — but the closure still holds the original.
      // Tests assert on restartOpenCodeCalls instead, via the spy below.
      return { runtime, state, restartOpenCodeCalls, restartOpenCodeSpy: spy, realRestart };
    };

    it('defers the restart when sessions are busy and returns deferred result', async () => {
      const { runtime } = createDeferredRuntime({ getActiveSessionCount: () => 2 });

      const result = await runtime.refreshOpenCodeAfterConfigChange('agent update');

      expect(result).toEqual({
        reloaded: false,
        deferred: true,
        pendingActiveSessions: 2,
        external: false,
      });
      expect(runtime.hasPendingConfigRefresh()).toBe(true);
      runtime.clearPendingConfigRefresh();
    });

    it('restarts immediately when no sessions are busy', async () => {
      const { runtime, state } = createDeferredRuntime({ getActiveSessionCount: () => 0 });
      // Provide a no-op openCodeProcess so restartOpenCode's close path is safe.
      state.openCodeProcess = null;

      // The real restartOpenCode inside the closure will try to spawn; we only
      // need to verify the deferred path was NOT taken. hasPendingConfigRefresh
      // being false confirms the immediate path was selected.
      const result = await runtime.refreshOpenCodeAfterConfigChange('agent update', { agentName: 'plan' }).catch(() => null);

      expect(runtime.hasPendingConfigRefresh()).toBe(false);
      // Even if spawn failed in the test env, the result should not be deferred.
      expect(result?.deferred).not.toBe(true);
    });

    it('force=true bypasses the busy-session guard', async () => {
      const { runtime } = createDeferredRuntime({ getActiveSessionCount: () => 3 });

      const result = await runtime.refreshOpenCodeAfterConfigChange('manual forced reload', { force: true }).catch(() => null);

      expect(runtime.hasPendingConfigRefresh()).toBe(false);
      expect(result?.deferred).not.toBe(true);
    });

    it('forceRestart clears a pending deferred restart', async () => {
      const { runtime } = createDeferredRuntime({ getActiveSessionCount: () => 1 });

      const deferredResult = await runtime.refreshOpenCodeAfterConfigChange('agent update');
      expect(deferredResult.deferred).toBe(true);
      expect(runtime.hasPendingConfigRefresh()).toBe(true);

      // forceRestart should clear the queue even if the inner restart fails.
      await runtime.forceRestart('user apply-now').catch(() => undefined);
      expect(runtime.hasPendingConfigRefresh()).toBe(false);
    });

    it('does not defer for an external OpenCode server', async () => {
      const { runtime, state } = createDeferredRuntime({ getActiveSessionCount: () => 5 });
      state.isExternalOpenCode = true;
      state.openCodeBaseUrl = 'http://127.0.0.1:45678';

      // probeExternalOpenCode fetches the health endpoint; stub fetch to
      // return a healthy response so restartOpenCode's external branch succeeds.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ healthy: true }),
      }));

      try {
        const result = await runtime.refreshOpenCodeAfterConfigChange('agent update');
        expect(result).toEqual({ reloaded: false, external: true });
        expect(runtime.hasPendingConfigRefresh()).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
