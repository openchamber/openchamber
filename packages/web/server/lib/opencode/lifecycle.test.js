import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const recordStartupPerformanceMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: vi.fn(),
}));
vi.mock('./startup-performance.js', () => ({
  recordStartupPerformance: recordStartupPerformanceMock,
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;

afterEach(() => {
  spawnMock.mockReset();
  recordStartupPerformanceMock.mockReset();
  globalThis.fetch = originalFetch;
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

const createRuntime = (overrides = {}, stateOverrides = {}) => {
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
    ...stateOverrides,
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
  it('records an authoritative ready terminal event for external startup', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ healthy: true }),
    }));
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
    });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(recordStartupPerformanceMock).toHaveBeenCalledWith('opencode.bootstrap.ready', {
      totalDurationMs: expect.any(Number),
      outcome: 'ready',
    });
    expect(recordStartupPerformanceMock).not.toHaveBeenCalledWith(
      'opencode.bootstrap.error',
      expect.anything(),
    );
    const terminalEvents = recordStartupPerformanceMock.mock.calls.filter(([phase]) => (
      phase === 'opencode.bootstrap.ready' || phase === 'opencode.bootstrap.error'
    ));
    expect(terminalEvents).toHaveLength(1);
  });

  it('warms recently used directories after a successful bootstrap', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ healthy: true }),
    }));
    globalThis.fetch = fetchMock;
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => ['/tmp/worktree-a', '/tmp/project-b']),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const warmupUrls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/session/status'));
    expect(warmupUrls).toEqual([
      'http://127.0.0.1:45678/session/status?directory=%2Ftmp%2Fworktree-a',
      'http://127.0.0.1:45678/session/status?directory=%2Ftmp%2Fproject-b',
    ]);
  });

  it('records an authoritative error terminal event when bootstrap fails', async () => {
    const runtime = createRuntime({
      syncFromHmrState: vi.fn(() => {
        throw new Error('bootstrap failed');
      }),
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
    });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(recordStartupPerformanceMock).toHaveBeenCalledWith('opencode.bootstrap.error', {
      totalDurationMs: expect.any(Number),
      outcome: 'error',
    });
    expect(recordStartupPerformanceMock).not.toHaveBeenCalledWith(
      'opencode.bootstrap.ready',
      expect.anything(),
    );
    const terminalEvents = recordStartupPerformanceMock.mock.calls.filter(([phase]) => (
      phase === 'opencode.bootstrap.ready' || phase === 'opencode.bootstrap.error'
    ));
    expect(terminalEvents).toHaveLength(1);
  });

  it('does not count rapid transport-triggered checks as independent health failures', async () => {
    const close = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 1;
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    const runtime = createRuntime({ now: () => now }, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: null,
        exitCode: null,
        signalCode: null,
        close,
      },
      isOpenCodeReady: true,
    });

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await runtime.triggerHealthCheck();
    }

    expect(close).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);

    now += 15_000;
    await runtime.triggerHealthCheck();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('(2/20)'));
    warn.mockRestore();
  });

  it('restarts an exited managed process without waiting for the failure interval', async () => {
    const close = vi.fn(async () => {});
    const replacement = createMockChild();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return replacement;
    });
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: null,
        exitCode: 1,
        signalCode: null,
        close,
      },
    });

    await runtime.triggerHealthCheck();

    expect(close).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
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

  it('adds managed OpenChamber tool environment without allowing it to replace launch invariants', async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    const getManagedOpenCodeEnv = vi.fn(async () => ({
      OPENCODE_CONFIG_CONTENT: '{"plugin":["file:///tool.js"]}',
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'ephemeral',
      PATH: '/untrusted/path',
      OPENCODE_SERVER_PASSWORD: 'untrusted-password',
    }));

    const runtime = createRuntime({ getManagedOpenCodeEnv });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(getManagedOpenCodeEnv).toHaveBeenCalledOnce();
    expect(options.env.OPENCODE_CONFIG_CONTENT).toBe('{"plugin":["file:///tool.js"]}');
    expect(options.env.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('ephemeral');
    expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
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
