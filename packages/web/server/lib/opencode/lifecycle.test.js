import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();
const recordStartupPerformanceMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));
vi.mock('./startup-performance.js', () => ({
  recordStartupPerformance: recordStartupPerformanceMock,
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;
const originalManagedProcessRegistry = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  recordStartupPerformanceMock.mockReset();
  vi.unstubAllGlobals();
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


// main's signature, which adds env overrides, over this branch's extracted state.
const createRuntime = (overrides = {}, stateOverrides = {}, envOverrides = {}) => {
  // Passed by reference when a caller supplies one: those tests assert that the runtime
  // mutated their object, which a copy would silently defeat.
  const state = overrides.state ?? {
    ...createLifecycleState(),
    ...stateOverrides,
  };

  const runtime = createOpenCodeLifecycleRuntime({
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: 45678,
      ENV_CONFIGURED_OPENCODE_HOST: null,
      ENV_EFFECTIVE_PORT: 3001,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ENV_SKIP_OPENCODE_START: false,
      ...envOverrides,
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
  runtime.testState = state;
  return runtime;
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

  it.each([
    {
      name: 'timeout',
      expectedClass: 'timeout',
      fetchResult: () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      },
    },
    {
      name: 'connection refusal',
      expectedClass: 'connection_refused',
      fetchResult: () => {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:45678');
        error.code = 'ECONNREFUSED';
        throw error;
      },
    },
    {
      name: 'invalid JSON',
      expectedClass: 'invalid_response',
      fetchResult: () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }),
    },
  ])('classifies and stores a counted $name health failure', async ({ expectedClass, fetchResult }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(fetchResult);
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: process.pid,
        exitCode: null,
        signalCode: null,
        close: vi.fn(async () => {}),
      },
      isOpenCodeReady: true,
    });

    await runtime.triggerHealthCheck();

    expect(runtime.testState.lastOpenCodeHealthFailure).toEqual({
      class: expectedClass,
      detail: expect.any(String),
      at: expect.any(String),
      source: 'immediate',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`class=${expectedClass}`));
    warn.mockRestore();
  });

  it('does not mistake a live managed process wrapper for an exited child', async () => {
    const close = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: process.pid,
        close,
      },
      isOpenCodeReady: true,
    });

    await runtime.triggerHealthCheck();

    expect(close).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(1/20)'));
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

  it('calls onOpenCodeRestarted after a successful managed restart', async () => {
    const close = vi.fn(async () => {});
    const replacement = createMockChild();
    const onOpenCodeRestarted = vi.fn();
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
    const runtime = createRuntime({ onOpenCodeRestarted }, {
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
    // The restart completed on a (possibly new) port — the event-stream
    // upstreams must rebind so the UI keeps receiving events (#2638).
    expect(onOpenCodeRestarted).toHaveBeenCalledTimes(1);
  });

  it('retains post-listen stderr and exited process diagnostics across restart', async () => {
    const firstChild = createMockChild();
    const replacement = createMockChild();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return replacement;
    });
    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = server;

    firstChild.stderr.emit(
      'data',
      `${'x'.repeat(40 * 1024)}\ntoken=runtime-secret\nruntime worker failed after startup\n`,
    );
    firstChild.exitCode = 7;
    firstChild.emit('exit', 7, null);

    expect(server.exitCode).toBe(7);
    expect(Buffer.byteLength(server.stderrTail)).toBeLessThanOrEqual(32 * 1024);
    expect(server.stderrTail).not.toContain('runtime-secret');
    expect(server.stderrTail).toContain('runtime worker failed after startup');

    await runtime.triggerHealthCheck();

    expect(runtime.testState.lastOpenCodeRestartDiagnostics).toEqual({
      reason: 'immediate-process-exited',
      healthFailure: null,
      process: {
        pid: 12345,
        exitCode: 7,
        signalCode: null,
        stderrTail: expect.stringContaining('runtime worker failed after startup'),
        alive: false,
      },
      busySessionCount: 0,
      at: expect.any(String),
    });
    expect(runtime.testState.lastManagedOpenCodeProcess).toEqual({
      pid: 12345,
      exitCode: 7,
      signalCode: null,
      stderrTail: expect.stringContaining('runtime worker failed after startup'),
    });

    await runtime.testState.openCodeProcess.close();
    warn.mockRestore();
  });

  it('redacts Authorization scheme credentials from stderr diagnostics', async () => {
    const firstChild = createMockChild();
    const replacement = createMockChild();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return replacement;
    });
    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = server;

    firstChild.stderr.emit(
      'data',
      'request rejected: Authorization: Basic dXNlcjpwYXNz\n'
      + 'authorization: basic bG93ZXI6Y2FzZQ==\n'
      + 'Authorization: Bearer fake-bearer-token-value\n'
      + 'falling back to basic health monitor\n'
      + 'runtime worker failed after startup\n',
    );
    firstChild.exitCode = 7;
    firstChild.emit('exit', 7, null);

    expect(server.stderrTail).not.toContain('dXNlcjpwYXNz');
    expect(server.stderrTail).not.toContain('bG93ZXI6Y2FzZQ');
    expect(server.stderrTail).not.toContain('fake-bearer-token-value');
    expect(server.stderrTail).toContain('falling back to basic health monitor');
    expect(server.stderrTail).toContain('runtime worker failed after startup');

    await runtime.triggerHealthCheck();

    const diagnosticsTail = runtime.testState.lastOpenCodeRestartDiagnostics.process.stderrTail;
    expect(diagnosticsTail).not.toContain('dXNlcjpwYXNz');
    expect(diagnosticsTail).not.toContain('bG93ZXI6Y2FzZQ');
    expect(diagnosticsTail).not.toContain('fake-bearer-token-value');
    expect(diagnosticsTail).toContain('falling back to basic health monitor');
    expect(diagnosticsTail).toContain('runtime worker failed after startup');

    await runtime.testState.openCodeProcess.close();
    warn.mockRestore();
  });

  it('does not call onOpenCodeRestarted when a managed restart fails', async () => {
    const close = vi.fn(async () => {});
    const onOpenCodeRestarted = vi.fn();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => {
        child.emit('error', new Error('spawn failed'));
      });
      return child;
    });
    const runtime = createRuntime({ onOpenCodeRestarted }, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: null,
        exitCode: 1,
        signalCode: null,
        close,
      },
    });

    // triggerHealthCheck logs instead of rethrowing; call restartOpenCode
    // directly to observe the failure result.
    await expect(runtime.restartOpenCode()).rejects.toThrow();

    expect(onOpenCodeRestarted).not.toHaveBeenCalled();
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
    expect(options.env.OPENCODE_EXPERIMENTAL_WORKSPACES).toBe('true');
    expect(server.exitCode).toBeNull();
    expect(server.signalCode).toBeNull();

    await server.close();
    expect(server.signalCode).toBe('SIGTERM');
  });

  it('launches managed OpenCode on the configured bind hostname', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://0.0.0.0:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({}, {}, { ENV_CONFIGURED_OPENCODE_HOSTNAME: '0.0.0.0' });
    const server = await runtime.startOpenCode();
    const [binary, args] = spawnMock.mock.calls[0];

    expect(binary).toBe('opencode');
    expect(args).toEqual(['serve', '--hostname', '0.0.0.0', '--port', '45678']);

    await server.close();
    expect(server.signalCode).toBe('SIGTERM');
  });

  it('strips AppImage ARGV0 from managed OpenCode launch env', async () => {
    delete process.env.OPENCODE_BINARY;
    const previousArgv0 = process.env.ARGV0;
    process.env.ARGV0 = '/path/to/OpenChamber/OpenChamber-1.17.2-linux-x86_64.AppImage';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    try {
      const runtime = createRuntime({
        getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
          PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
          ARGV0: '/leaked/from/shell/snapshot.AppImage',
          SHELL_ONLY: 'yes',
        })),
      });
      const server = await runtime.startOpenCode();
      const [, , options] = spawnMock.mock.calls[0];

      expect(options.env).not.toHaveProperty('ARGV0');
      expect(options.env.SHELL_ONLY).toBe('yes');
      expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');

      await server.close();
    } finally {
      if (previousArgv0 === undefined) delete process.env.ARGV0;
      else process.env.ARGV0 = previousArgv0;
    }
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

  it('passes an isolated OpenCode data root to the managed process', async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    const runtime = createRuntime({
      getManagedOpenCodeEnv: vi.fn(async () => ({
        XDG_DATA_HOME: '/tmp/openchamber-profile/opencode-data',
      })),
    });

    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.XDG_DATA_HOME).toBe('/tmp/openchamber-profile/opencode-data');

    await server.close();
  });

  it('mirrors Google credential env aliases into the managed OpenCode environment', async () => {
    const previousGemini = process.env.GEMINI_API_KEY;
    const previousGoogleGen = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const previousGoogle = process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = 'AIza-from-gemini';
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    try {
      const child = createMockChild();
      spawnMock.mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
        });
        return child;
      });

      const runtime = createRuntime();
      const server = await runtime.startOpenCode();
      const [, , options] = spawnMock.mock.calls[0];

      expect(options.env.GEMINI_API_KEY).toBe('AIza-from-gemini');
      expect(options.env.GOOGLE_API_KEY).toBe('AIza-from-gemini');
      expect(options.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('AIza-from-gemini');

      await server.close();
    } finally {
      if (typeof previousGemini === 'string') {
        process.env.GEMINI_API_KEY = previousGemini;
      } else {
        delete process.env.GEMINI_API_KEY;
      }
      if (typeof previousGoogleGen === 'string') {
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = previousGoogleGen;
      } else {
        delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      }
      if (typeof previousGoogle === 'string') {
        process.env.GOOGLE_API_KEY = previousGoogle;
      } else {
        delete process.env.GOOGLE_API_KEY;
      }
    }
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
