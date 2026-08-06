import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const {
  createOpenCodeLifecycleRuntime,
  __test__: lifecycleTest,
} = await import('./lifecycle.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;
const originalRegistry = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
const originalFetch = globalThis.fetch;
const STARTUP_CAPTURE_LIMIT = 16 * 1024;

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

  if (typeof originalRegistry === 'string') {
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = originalRegistry;
  } else {
    delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
  }
  vi.useRealTimers();
});

const createMockChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.destroy = vi.fn();
  child.stderr.destroy = vi.fn();
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

const createRuntime = (overrides = {}, stateOverrides = {}, envOverrides = {}) => {
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
  // Test-only state access for assertions about the lifecycle's stored
  // startup diagnostic. The production runtime does not expose this field.
  runtime.__testState = state;
  return runtime;
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

  it('does not send auth headers through generic readiness for a guardian-managed child', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ healthy: true }),
    }));
    globalThis.fetch = fetchMock;
    const waitForReady = vi.fn(async () => true);
    const guardianHealth = vi.fn(async () => ({
      healthy: false,
      reason: 'managed OpenCode health proof failed',
    }));
    const runtime = createRuntime({ waitForReady, getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic should-not-send' }) }, {
      openCodePort: 45678,
      openCodeProcess: {
        isGuardianManaged: true,
        health: guardianHealth,
      },
    });

    await expect(runtime.waitForOpenCodeReady(0, 0)).rejects.toThrow(/managed OpenCode health proof failed/);
    expect(guardianHealth).toHaveBeenCalledOnce();
    expect(waitForReady).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(firstChild.kill).toHaveBeenCalled();
    expect(secondChild.kill).toHaveBeenCalled();
  });

  it('redacts managed credentials from direct startup output, errors, logs, and lastOpenCodeError', async () => {
    delete process.env.OPENCODE_BINARY;
    const password = 'direct-managed-startup-secret';
    const agentToken = 'managed-agent-tool-token';
    const encodedBasic = Buffer.from(`opencode:${password}`, 'utf8').toString('base64');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {});

    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => {
        child.stdout.emit('data', `child stdout password=${password} token=${agentToken}\n`);
        child.stderr.emit('data', `Authorization: Basic ${encodedBasic}\nBearer ${agentToken}\nchild stderr password=${password}\n`);
        child.emit('exit', 1, null);
      });
      return child;
    });

    try {
      const runtime = createRuntime({
        ensureLocalOpenCodeServerPassword: vi.fn(async () => password),
        getManagedOpenCodeEnv: vi.fn(async () => ({
          OPENCHAMBER_AGENT_TOOL_TOKEN: agentToken,
        })),
      });

      const thrown = await runtime.startOpenCode().catch((error) => error);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toContain('[REDACTED]');
      expect(thrown.message).not.toContain(password);
      expect(thrown.message).not.toContain(encodedBasic);
      expect(thrown.message).not.toContain(agentToken);

      const logged = [
        ...errorLog.mock.calls.flat(),
        ...warningLog.mock.calls.flat(),
      ].join('\n');
      expect(logged).toContain('stdout:');
      expect(logged).toContain('stderr:');
      expect(logged).not.toContain(password);
      expect(logged).not.toContain(encodedBasic);
      expect(logged).not.toContain(agentToken);
      expect(runtime.__testState.lastOpenCodeError).not.toContain(password);
      expect(runtime.__testState.lastOpenCodeError).not.toContain(encodedBasic);
      expect(runtime.__testState.lastOpenCodeError).not.toContain(agentToken);
    } finally {
      errorLog.mockRestore();
      warningLog.mockRestore();
    }
  });

  it('preserves ambiguity metadata while sanitizing startup errors', () => {
    const error = Object.assign(new Error('guardian request outcome is unknown'), {
      code: 'GUARDIAN_REQUEST_AMBIGUOUS',
      ambiguous: true,
      retryable: false,
      originalCode: 'connection_closed',
    });
    const sanitized = lifecycleTest.createRedactedStartupError(
      error,
      lifecycleTest.createManagedStartupOutputFormatter(),
    );

    expect(sanitized).toMatchObject({
      code: 'GUARDIAN_REQUEST_AMBIGUOUS',
      ambiguous: true,
      retryable: false,
      originalCode: 'connection_closed',
    });
  });

  it('preserves originalCode when an ambiguous structured error omits code', () => {
    const error = Object.assign(new Error('guardian request outcome is unknown'), {
      ambiguous: true,
      retryable: false,
      originalCode: 'connection_closed',
    });
    const sanitized = lifecycleTest.createRedactedStartupError(
      error,
      lifecycleTest.createManagedStartupOutputFormatter(),
    );

    expect(sanitized).toMatchObject({
      code: 'GUARDIAN_REQUEST_AMBIGUOUS',
      ambiguous: true,
      retryable: false,
      originalCode: 'connection_closed',
    });
  });

  it.each([
    {
      label: 'password',
      password: 'boundary-password-secret',
      output: ({ password }) => password,
    },
    {
      label: 'agent token',
      password: 'boundary-password-for-token',
      token: 'boundary-agent-token-secret',
      output: ({ token }) => token,
    },
    {
      label: 'encoded Basic auth',
      password: 'boundary-basic-auth-password',
      output: ({ password }) => `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`,
    },
  ])('redacts a $label secret split across startup chunks and the capture limit', async ({
    password,
    token,
    output: buildOutput,
  }) => {
    delete process.env.OPENCODE_BINARY;
    const secret = buildOutput({ password, token });
    const prefixLength = STARTUP_CAPTURE_LIMIT - Math.ceil(secret.length / 2);
    const prefix = 'useful-startup-diagnostic-'.repeat(
      Math.ceil(prefixLength / 'useful-startup-diagnostic-'.length),
    ).slice(0, prefixLength);
    const outputText = `${prefix}${secret}\n`;
    const splitAt = prefixLength + Math.ceil(secret.length / 2);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => {
        child.stdout.emit('data', outputText.slice(0, splitAt));
        child.stdout.emit('data', outputText.slice(splitAt));
        child.emit('exit', 1, null);
      });
      return child;
    });

    try {
      const runtime = createRuntime({
        ensureLocalOpenCodeServerPassword: vi.fn(async () => password),
        ...(token ? {
          getManagedOpenCodeEnv: vi.fn(async () => ({ OPENCHAMBER_AGENT_TOOL_TOKEN: token })),
        } : {}),
      });
      const thrown = await runtime.startOpenCode().catch((error) => error);
      const logged = [
        ...errorLog.mock.calls.flat(),
        ...warningLog.mock.calls.flat(),
        ...infoLog.mock.calls.flat(),
      ].join('\n');
      const diagnostics = [
        thrown.message,
        runtime.__testState.lastOpenCodeError,
        logged,
      ].join('\n');
      const fragments = [
        secret.slice(0, Math.min(8, secret.length - 1)),
        secret.slice(-Math.min(8, secret.length - 1)),
      ];

      expect(diagnostics).toContain('stdout:');
      expect(diagnostics).toContain('[REDACTED]');
      expect(diagnostics).toContain('startup output truncated');
      expect(diagnostics).not.toContain(secret);
      for (const fragment of fragments) expect(diagnostics).not.toContain(fragment);
    } finally {
      errorLog.mockRestore();
      warningLog.mockRestore();
      infoLog.mockRestore();
    }
  });

  it('does not reconstruct a secret from an adversarial prefix/suffix placement', () => {
    const password = 'adversarial-password';
    const secret = `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
    const formatter = lifecycleTest.createManagedStartupOutputFormatter({
      OPENCODE_SERVER_PASSWORD: password,
    });
    const redactor = formatter.createStreamingRedactor();
    const first = `${'safe-diagnostic-'.repeat(20)}x${secret.slice(0, -1)}`;
    const second = `${secret.slice(-1)}y`;
    const emissions = [redactor.push(first), redactor.push(second), redactor.flush()];

    expect(emissions.join('')).not.toContain(secret);
    expect(emissions.join('')).not.toContain(secret.slice(0, 8));
    expect(emissions.join('')).not.toContain(secret.slice(-8));
    expect(emissions).toContainEqual(expect.stringContaining('[REDACTED]'));
  });

  it.each([
    {
      label: 'password',
      password: 'cross-stream-password-7c9e1a4b',
      output: ({ password }) => password,
    },
    {
      label: 'token',
      password: 'cross-stream-password-for-token-6b2d8f',
      token: 'cross-stream-agent-token-4f8a2c',
      output: ({ token }) => token,
    },
    {
      label: 'encoded Basic auth',
      password: 'cross-stream-basic-password-91e4d0',
      output: ({ password }) => `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`,
    },
  ])('redacts a $label split across stdout/stderr and the capture boundary in either stream order', async ({
    password,
    token,
    output: buildOutput,
  }) => {
    delete process.env.OPENCODE_BINARY;
    const secret = buildOutput({ password, token });
    const splitAt = Math.ceil(secret.length / 2);
    const prefixLength = STARTUP_CAPTURE_LIMIT - splitAt + 64;
    const prefix = 'capture-boundary-diagnostic-'.repeat(
      Math.ceil(prefixLength / 'capture-boundary-diagnostic-'.length),
    ).slice(0, prefixLength);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      for (const [firstStream, secondStream] of [['stdout', 'stderr'], ['stderr', 'stdout']]) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          spawnMock.mockImplementationOnce(() => {
            const child = createMockChild();
            queueMicrotask(() => {
              child[firstStream].emit('data', `${prefix}${secret.slice(0, splitAt)}`);
              child[secondStream].emit('data', `${secret.slice(splitAt)}\n`);
              child.emit('exit', 1, null);
            });
            return child;
          });
        }

        const runtime = createRuntime({
          ensureLocalOpenCodeServerPassword: vi.fn(async () => password),
          ...(token ? {
            getManagedOpenCodeEnv: vi.fn(async () => ({ OPENCHAMBER_AGENT_TOOL_TOKEN: token })),
          } : {}),
        });
        const thrown = await runtime.startOpenCode().catch((error) => error);
        const logged = [
          ...errorLog.mock.calls.flat(),
          ...warningLog.mock.calls.flat(),
          ...infoLog.mock.calls.flat(),
        ].join('\n');
        const diagnostics = [
          thrown.message,
          runtime.__testState.lastOpenCodeError,
          logged,
        ].join('\n');

        expect(diagnostics).toContain('stdout:');
        expect(diagnostics).toContain('stderr:');
        expect(diagnostics).toContain('startup output truncated');
        expect(diagnostics).not.toContain(secret);
        expect(diagnostics).not.toContain(secret.slice(0, 8));
        expect(diagnostics).not.toContain(secret.slice(-8));
      }
    } finally {
      errorLog.mockRestore();
      warningLog.mockRestore();
      infoLog.mockRestore();
    }
  });

  it('does not emit xpasswordx as raw fragments across a candidate boundary', () => {
    const formatter = lifecycleTest.createManagedStartupOutputFormatter({
      OPENCODE_SERVER_PASSWORD: 'password',
    });
    const redactor = formatter.createStreamingRedactor();

    const first = redactor.push('xpass');
    const second = redactor.push('wordx');
    const output = `${first}${second}${redactor.flush()}`;

    // The leading raw span is held until the candidate boundary is known;
    // callers must never be able to concatenate emitted fragments into the
    // managed password.
    expect(first).toBe('');
    expect(output).toBe('x[REDACTED]x');
    expect(output).not.toContain('password');
  });

  it.each([
    {
      label: 'password',
      env: { OPENCODE_SERVER_PASSWORD: 'chunk-password-secret' },
      secret: 'chunk-password-secret',
    },
    {
      label: 'token',
      env: { OPENCHAMBER_AGENT_TOOL_TOKEN: 'chunk-agent-token-secret' },
      secret: 'chunk-agent-token-secret',
    },
    {
      label: 'Basic value',
      env: { OPENCODE_SERVER_PASSWORD: 'chunk-basic-secret' },
      secret: `Basic ${Buffer.from('opencode:chunk-basic-secret', 'utf8').toString('base64')}`,
    },
  ])('keeps the $label redacted across chunk and capture boundaries', ({ env, secret }) => {
    const formatter = lifecycleTest.createManagedStartupOutputFormatter(env);
    const capture = lifecycleTest.createManagedStartupCapture(formatter);
    const prefixLength = lifecycleTest.MANAGED_STARTUP_CAPTURE_LIMIT - Math.ceil(secret.length / 2);
    const prefix = 'capture-boundary-diagnostic-'.repeat(
      Math.ceil(prefixLength / 'capture-boundary-diagnostic-'.length),
    ).slice(0, prefixLength);
    const splitAt = Math.ceil(secret.length / 2);

    capture.append(`${prefix}${secret.slice(0, splitAt)}`);
    capture.append(`${secret.slice(splitAt)}\n`);
    const result = capture.finish();

    expect(result.truncated).toBe(true);
    expect(result.value).not.toContain(secret);
    expect(result.value).not.toContain(secret.slice(0, Math.min(8, secret.length - 1)));
    expect(result.value).not.toContain(secret.slice(-Math.min(8, secret.length - 1)));
  });

  it('does not include raw malformed URL startup output in lifecycle errors', async () => {
    delete process.env.OPENCODE_BINARY;
    const password = 'malformed-url-secret';
    const children = [];
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      children.push(child);
      queueMicrotask(() => {
        child.stdout.emit('data', `opencode server listening password=${password}\n`);
        child.emit('exit', 1, null);
      });
      return child;
    });

    const runtime = createRuntime({
      ensureLocalOpenCodeServerPassword: vi.fn(async () => password),
    });
    const thrown = await runtime.startOpenCode().catch((error) => error);

    expect(thrown.message).toContain('Failed to parse server url from OpenCode startup output');
    expect(thrown.message).not.toContain('opencode server listening');
    expect(thrown.message).not.toContain(password);
    expect(runtime.__testState.lastOpenCodeError).not.toContain('opencode server listening');
    expect(runtime.__testState.lastOpenCodeError).not.toContain(password);
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.kill).toHaveBeenCalled();
      expect(child.stdout.destroy).toHaveBeenCalled();
      expect(child.stderr.destroy).toHaveBeenCalled();
    }
  });

  it('fails closed without retrying when a detached startup child survives escalation', async () => {
    vi.useFakeTimers();
    const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-lifecycle-registry-'));
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = registryRoot;
    const child = createMockChild();
    child.pid = 2_147_483_647;
    child.kill = vi.fn();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    });

    try {
      const startup = createRuntime().startOpenCode().then(
        () => null,
        (error) => error,
      );
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(startup).resolves.toMatchObject({
        code: 'OPENCODE_CHILD_STILL_RUNNING',
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalled();
      expect(child.stdout.destroy).toHaveBeenCalled();
      expect(child.stderr.destroy).toHaveBeenCalled();
      // A surviving detached child remains in the existing recovery registry;
      // only confirmed exit permits lifecycle cleanup to unregister it.
      expect(fs.existsSync(path.join(registryRoot, `${child.pid}.json`))).toBe(true);
    } finally {
      fs.rmSync(registryRoot, { recursive: true, force: true });
    }
  });

  it('does not spawn a restart successor when direct child cleanup is uncertain', async () => {
    const close = vi.fn(async () => {
      throw Object.assign(
        new Error('OpenCode child process is still running after termination escalation'),
        { code: 'OPENCODE_CHILD_STILL_RUNNING' },
      );
    });
    const runtime = createRuntime({}, {
      openCodeProcess: { pid: 2_147_483_646, close },
      openCodePort: 45678,
      isOpenCodeReady: true,
    });

    await expect(runtime.restartOpenCode()).rejects.toMatchObject({
      code: 'OPENCODE_CHILD_STILL_RUNNING',
    });
    expect(close).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('terminates every child when the announced URL is syntactically malformed after startup', async () => {
    delete process.env.OPENCODE_BINARY;
    const children = [];
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      children.push(child);
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://[invalid\n');
      });
      return child;
    });

    const runtime = createRuntime();
    await expect(runtime.startOpenCode()).rejects.toThrow(/Invalid URL/);
    expect(children).toHaveLength(2);
    for (const child of children) expect(child.kill).toHaveBeenCalled();
  });

  it('terminates a registered child when readiness fails before returning the server instance', async () => {
    delete process.env.OPENCODE_BINARY;
    const children = [];
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      children.push(child);
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({ waitForReady: vi.fn(async () => false) });
    await expect(runtime.startOpenCode()).rejects.toThrow(/health check failed/);
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.kill).toHaveBeenCalled();
      expect(child.stdout.destroy).toHaveBeenCalled();
      expect(child.stderr.destroy).toHaveBeenCalled();
    }
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
    expect(firstChild.kill).toHaveBeenCalled();
    await server.close();
  });

  it('retires rotated startup-secret leases after confirmed child cleanup', async () => {
    delete process.env.OPENCODE_BINARY;
    const passwords = Array.from({ length: 6 }, (_, index) => (
      `rotated-startup-password-${index}-${'x'.repeat(index + 1)}`
    ));
    let rotation = 0;
    const children = [];
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      children.push(child);
      const password = passwords[Math.max(0, rotation - 1)];
      queueMicrotask(() => {
        child.stdout.emit('data', `startup password=${password.slice(0, Math.ceil(password.length / 2))}\n`);
        child.stderr.emit('data', `${password.slice(Math.ceil(password.length / 2))}\n`);
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      ensureLocalOpenCodeServerPassword: vi.fn(async () => passwords[rotation++]),
      waitForPortRelease: vi.fn(async () => true),
    });
    const firstServer = await runtime.startOpenCode();
    runtime.__testState.openCodeProcess = firstServer;
    runtime.__testState.openCodePort = 45678;
    runtime.__testState.isOpenCodeReady = true;
    const initial = runtime.__testManagedStartupSecretState();
    expect(initial.leaseCount).toBe(1);

    for (let attempt = 1; attempt < passwords.length; attempt += 1) {
      await runtime.restartOpenCode();
      expect(runtime.__testManagedStartupSecretState()).toEqual(initial);
    }

    await runtime.__testState.openCodeProcess.close();
    expect(runtime.__testManagedStartupSecretState()).toEqual({
      leaseCount: 0,
      secretCount: 0,
    });
    expect(children).toHaveLength(passwords.length);
  });

  it('keeps the active secret lease through failed cleanup and redacts its value', async () => {
    delete process.env.OPENCODE_BINARY;
    const password = 'active-secret-retained-during-cleanup';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      ensureLocalOpenCodeServerPassword: vi.fn(async () => password),
      waitForPortRelease: vi.fn(async () => true),
    });
    const server = await runtime.startOpenCode();
    runtime.__testState.openCodeProcess = server;
    runtime.__testState.openCodePort = 45678;
    runtime.__testState.isOpenCodeReady = true;
    const originalClose = server.close;
    server.close = vi.fn(async () => {
      throw Object.assign(new Error(`cleanup failed for ${password}`), {
        code: 'OPENCODE_CHILD_STILL_RUNNING',
      });
    });

    await expect(runtime.restartOpenCode()).rejects.toMatchObject({
      code: 'OPENCODE_CHILD_STILL_RUNNING',
    });
    expect(runtime.__testState.lastOpenCodeError).toContain('[REDACTED]');
    expect(runtime.__testState.lastOpenCodeError).not.toContain(password);
    expect(runtime.__testManagedStartupSecretState().leaseCount).toBe(1);

    server.close = originalClose;
    await originalClose();
    expect(runtime.__testManagedStartupSecretState()).toEqual({
      leaseCount: 0,
      secretCount: 0,
    });
  });
});
