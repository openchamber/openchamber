import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { injectedEnvKeys } from '../injected-env.js';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();
const recordStartupPerformanceMock = vi.fn();
// The managed-servers read verifies recorded pids through an async `ps`
// read (execFile in lifecycle.js). Tests steer it by setting
// `recordedProcessCommand`; the callback shape matches the real execFile,
// so lifecycle's async wrapper resolves with this stdout.
let recordedProcessCommand = '';
const execFileMock = vi.fn((file, args, options, callback) => callback(null, recordedProcessCommand, ''));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
  // `managed-process-registry.js` (imported transitively via lifecycle.js)
  // calls `promisify(execFile)` at module load, so the mock must expose a
  // function here.
  execFile: execFileMock,
}));
vi.mock('./startup-performance.js', () => ({
  recordStartupPerformance: recordStartupPerformanceMock,
}));

const {
  createOpenCodeLifecycleRuntime,
  getBoundedTextTail,
  parsePositiveInt,
  resolveHealthCheckIntervalOverrideMs,
  resolveHealthCheckTimeoutMs,
} = await import('./lifecycle.js');
const { createServerDiagnosticJournal } = await import('../diagnostics/server-journal.js');

describe('getBoundedTextTail', () => {
  it('returns the value whole when it fits', () => {
    expect(getBoundedTextTail(String.fromCharCode(0x20ac) + 'z'.repeat(100), 103)).toBe(String.fromCharCode(0x20ac) + 'z'.repeat(100));
    expect(getBoundedTextTail('short', 32 * 1024)).toBe('short');
  });

  it('aligns the byte cut to a UTF-8 boundary, losing at most the straddling character (#2033)', () => {
    const value = 'a'.repeat(50) + String.fromCharCode(0x20ac) + 'b'.repeat(50);
    // Byte length 103; a 52-byte tail starts on the euro sign's second
    // byte, a 53-byte tail starts exactly on its lead byte.
    expect(getBoundedTextTail(value, 52)).toBe('b'.repeat(50));
    expect(getBoundedTextTail(value, 52)).not.toContain(String.fromCharCode(0xfffd));
    expect(getBoundedTextTail(value, 53)).toBe(String.fromCharCode(0x20ac) + 'b'.repeat(50));
  });
});

describe('health-check timer readers', () => {
  it('accepts the timer maximum and ordinary values for the timeout reader', () => {
    expect(resolveHealthCheckTimeoutMs({})).toBe(5000);
    expect(resolveHealthCheckTimeoutMs({ OPENCHAMBER_OPENCODE_HEALTH_TIMEOUT_MS: '250' })).toBe(250);
    expect(resolveHealthCheckTimeoutMs({ OPENCHAMBER_OPENCODE_HEALTH_TIMEOUT_MS: '2147483647' })).toBe(2_147_483_647);
  });

  it('falls back to the default above the timer maximum and for unsafe integers (timeout reader)', () => {
    expect(resolveHealthCheckTimeoutMs({ OPENCHAMBER_OPENCODE_HEALTH_TIMEOUT_MS: '3000000000' })).toBe(5000);
    expect(resolveHealthCheckTimeoutMs({ OPENCHAMBER_OPENCODE_HEALTH_TIMEOUT_MS: '9007199254740993' })).toBe(5000);
  });

  it("keeps positive-only semantics for the timeout reader: '0' falls back to the default", () => {
    expect(resolveHealthCheckTimeoutMs({ OPENCHAMBER_OPENCODE_HEALTH_TIMEOUT_MS: '0' })).toBe(5000);
  });

  it('accepts the timer maximum and an explicit zero for the interval override reader', () => {
    expect(resolveHealthCheckIntervalOverrideMs({})).toBe(0);
    expect(resolveHealthCheckIntervalOverrideMs({ OPENCHAMBER_OPENCODE_HEALTH_INTERVAL_MS: '0' })).toBe(0);
    expect(resolveHealthCheckIntervalOverrideMs({ OPENCHAMBER_OPENCODE_HEALTH_INTERVAL_MS: '1000' })).toBe(1000);
    expect(resolveHealthCheckIntervalOverrideMs({ OPENCHAMBER_OPENCODE_HEALTH_INTERVAL_MS: '2147483647' })).toBe(
      2_147_483_647
    );
  });

  it('falls back to zero above the timer maximum and for unsafe integers (interval override reader)', () => {
    expect(resolveHealthCheckIntervalOverrideMs({ OPENCHAMBER_OPENCODE_HEALTH_INTERVAL_MS: '3000000000' })).toBe(0);
    expect(resolveHealthCheckIntervalOverrideMs({ OPENCHAMBER_OPENCODE_HEALTH_INTERVAL_MS: '9007199254740993' })).toBe(0);
  });
});

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;
const tempDataDirs = [];
let activeLogPath = null;

afterEach(async () => {
  spawnMock.mockReset();
  activeLogPath = null;
  await Promise.all(tempDataDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  spawnSyncMock.mockReset();
  recordedProcessCommand = '';
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

const routeToLogFile = (stream) => {
  const emit = stream.emit.bind(stream);
  stream.emit = (event, chunk) => {
    if (event === 'data' && activeLogPath) {
      fsSync.mkdirSync(path.dirname(activeLogPath), { recursive: true });
      fsSync.appendFileSync(activeLogPath, chunk);
    }
    return emit(event, chunk);
  };
};

// The managed child starts through /bin/sh, which closes the inherited socket fd before exec.
const unwrapLaunch = (command, args) => (command === '/bin/sh'
  ? { binary: args[2], args: args.slice(3) }
  : { binary: command, args });

const createMockChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  routeToLogFile(child.stdout);
  routeToLogFile(child.stderr);
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
  const dataDir = overrides.dataDir ?? fsSync.mkdtempSync(path.join(os.tmpdir(), 'opencode-lifecycle-test-'));
  if (!overrides.dataDir) tempDataDirs.push(dataDir);
  activeLogPath = path.join(dataDir, 'managed-opencode', 'opencode.log');
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
    lastOpenCodeHealthFailure: null,
    lastManagedOpenCodeProcess: null,
    lastOpenCodeRestartDiagnostics: null,
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
    dataDir,
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
    checkOpenCodeBinary: async () => '2.0.19',
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
    // Never let a test touch the real `~/.local/share/opencode/opencode.db`.
    topUpV1SessionMigration: vi.fn(() => ({ status: 'skipped', missing: 0, revisited: 0, reason: 'no-database' })),
    getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
      PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
      SHELL_ONLY: 'yes',
      OPENCODE_PASSWORD: 'shell-password',
      OPENCODE_SERVER_PASSWORD: 'shell-password',
    })),
    ...overrides,
  });
  runtime.testState = state;
  return runtime;
};

describe('OpenCode lifecycle', () => {
  it('uses the resolved binary directly on startup and managed restart without an env override', async () => {
    delete process.env.OPENCODE_BINARY;
    const binaries = ['/bundle one/opencode-cli/opencode', '/bundle two/opencode-cli/opencode'];
    const ensureOpencodeCliEnv = vi.fn()
      .mockReturnValueOnce(binaries[0])
      .mockReturnValueOnce(binaries[1]);
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    const runtime = createRuntime({ ensureOpencodeCliEnv });
    const firstServer = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = firstServer;
    try {
      await runtime.restartOpenCode();
      expect(firstServer.signalCode).toBe('SIGTERM');
      expect(spawnMock.mock.calls.map(([command, args]) => unwrapLaunch(command, args).binary)).toEqual(binaries);
      expect(runtime.testState.lastOpenCodeLaunchDiagnostics.sourceBinary).toBe(binaries[1]);
      expect(process.env.OPENCODE_BINARY).toBeUndefined();
      for (const [, , options] of spawnMock.mock.calls) {
        expect(options.env).not.toHaveProperty('OPENCODE_BINARY');
      }
      // Credential reads take variable keys from the environment the current process got.
      expect(runtime.getManagedOpenCodeProcessEnv()).toBe(spawnMock.mock.calls[1][2].env);
      expect(runtime.getManagedOpenCodeProcessEnv()).toMatchObject({ SHELL_ONLY: 'yes' });
    } finally {
      await runtime.testState.openCodeProcess.close();
    }
  });

  it('readiness follows the child when another server rotates the log mid-startup', async () => {
    spawnMock.mockImplementation(() => createMockChild());
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    const runtime = createRuntime();
    const started = runtime.startOpenCode();
    await vi.waitFor(() => {
      expect(fsSync.existsSync(activeLogPath)).toBe(true);
    });
    // A second server sharing the data dir crosses the cap and rotates the
    // log; the starting child keeps writing to the renamed file via its fd.
    fsSync.renameSync(activeLogPath, `${activeLogPath}.1`);
    fsSync.appendFileSync(`${activeLogPath}.1`, 'opencode server listening on http://127.0.0.1:45678\n');
    const server = await started;
    runtime.testState.openCodeProcess = server;
    try {
      expect(server).toBeTruthy();
    } finally {
      await runtime.testState.openCodeProcess.close();
    }
  });

  it('does not pair a replacement process with its predecessor version in the managed-servers read', async () => {
    const pids = [process.pid, process.ppid];
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      child.pid = pids.shift() ?? child.pid;
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => Response.json({ version: '2.0.19' }));
    const runtime = createRuntime();
    const firstServer = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = firstServer;
    try {
      await runtime.triggerHealthCheck();
      const before = await runtime.getManagedServersSnapshot();
      expect(before.servers.find((server) => server.pid === process.pid)?.version).toBe('2.0.19');

      await runtime.restartOpenCode();

      const after = await runtime.getManagedServersSnapshot();
      const replacement = after.servers.find((server) => server.pid === process.ppid);
      expect(replacement?.status).toBe('ready');
      expect(replacement?.version).toBeNull();
    } finally {
      await runtime.testState.openCodeProcess.close();
    }
  });

  it('verifies recorded-pid identity in the managed-servers read (#638)', async () => {
    const entry = { pid: process.pid, port: 5001, binary: '/bin/opencode', startedAt: '2026-10-28T00:30:00.000Z' };
    const runtime = createRuntime({ readRegistryEntries: async () => [entry] });
    try {
      // Recycled pid: the live process at the recorded pid is unrelated.
      recordedProcessCommand = 'sleep 30\n';
      const recycled = await runtime.getManagedServersSnapshot();
      expect(recycled.servers.map((server) => server.pid)).toEqual([]);

      // Genuine recorded server: command still identifies it, port included.
      recordedProcessCommand = '/bin/opencode serve --hostname 127.0.0.1 --port 5001\n';
      const genuine = await runtime.getManagedServersSnapshot();
      expect(genuine.servers).toEqual([
        { pid: process.pid, port: 5001, directory: null, version: null, status: 'unknown', startedAt: '2026-10-28T00:30:00.000Z', sessionCount: null },
      ]);

      // A different OpenCode server whose port merely contains the recorded
      // port as a substring (50010 vs 5001) is not the recorded server.
      recordedProcessCommand = '/bin/opencode serve --hostname 127.0.0.1 --port 50010\n';
      const wrongPort = await runtime.getManagedServersSnapshot();
      expect(wrongPort.servers).toEqual([]);

      // Identity cannot be verified: no command read -> not listed.
      recordedProcessCommand = '';
      const unverifiable = await runtime.getManagedServersSnapshot();
      expect(unverifiable.servers).toEqual([]);
    } finally {
      recordedProcessCommand = '';
    }
  });

  it('reports the host-only session count for its own server in the managed-servers read', async () => {
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      child.pid = process.pid;
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => Response.json({ version: '2.0.19' }));
    const runtime = createRuntime({
      getActiveSessionCount: () => 5,
      getActiveHostSessionCount: () => 2,
    });
    const server = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = server;
    try {
      await runtime.triggerHealthCheck();
      const snapshot = await runtime.getManagedServersSnapshot();
      const own = snapshot.servers.find((entry) => entry.pid === process.pid);
      expect(own?.sessionCount).toBe(2);
    } finally {
      await runtime.testState.openCodeProcess.close();
    }
  });

  it('journals managed launch, readiness, exit and restart as fixed actions only', async () => {
    const journal = createServerDiagnosticJournal();
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => {
        child.stderr.emit('data', 'plugin failed: token=secret-123 /private/file\n');
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    const runtime = createRuntime({ diagnosticJournal: journal });
    const firstServer = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = firstServer;
    try {
      await runtime.restartOpenCode();
      expect(journal.snapshot().events.map(({ action, detail }) => [action, detail])).toEqual([
        ['managed launch', 'attempt=1'],
        ['managed ready', 'attempt=1'],
        ['managed restart started', undefined],
        ['managed process exited', undefined],
        ['managed launch', 'attempt=1'],
        ['managed ready', 'attempt=1'],
        ['managed restart ready', undefined],
      ]);
      expect(spawnMock.mock.calls[0][2].env).not.toHaveProperty('OPENCODE_PRINT_LOGS');
      expect(JSON.stringify(journal.snapshot())).not.toMatch(/secret|private/);
    } finally {
      await runtime.testState.openCodeProcess.close();
    }
  });

  it('records an authoritative ready terminal event for external startup', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
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

  it('recovers an external OPENCODE_HOST connection using its configured endpoint', async () => {
    const fetchMock = vi.fn(async () => Response.json({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
    globalThis.fetch = fetchMock;
    const runtime = createRuntime({}, {
      openCodePort: null,
      openCodeBaseUrl: null,
      isExternalOpenCode: true,
    }, {
      ENV_CONFIGURED_OPENCODE_PORT: null,
      ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://seamus:4095', port: 4095 },
      ENV_EFFECTIVE_PORT: 4095,
    });

    await runtime.restartOpenCode();

    expect(runtime.getManagedOpenCodeProcessEnv()).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://seamus:4095/api/info',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(runtime.testState.openCodePort).toBe(4095);
    expect(runtime.testState.openCodeBaseUrl).toBe('http://seamus:4095');
    expect(runtime.testState.lastOpenCodeError).toBeNull();
  });

  it('retains the OPENCODE_HOST port after an external re-probe fails', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    const runtime = createRuntime({}, {
      openCodePort: 4095,
      openCodeBaseUrl: 'http://seamus:4095',
      isExternalOpenCode: true,
    }, {
      ENV_CONFIGURED_OPENCODE_PORT: null,
      ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://seamus:4095', port: 4095 },
      ENV_EFFECTIVE_PORT: 4095,
    });

    await expect(runtime.restartOpenCode()).rejects.toThrow(
      'External OpenCode server on port 4095 is not responding',
    );

    expect(runtime.testState.openCodePort).toBe(4095);
    expect(runtime.testState.openCodeBaseUrl).toBe('http://seamus:4095');
  });

  it('attaches to an OPENCODE_HOST running OpenCode v1 instead of starting a managed server', async () => {
    const requested = [];
    globalThis.fetch = vi.fn(async (url) => {
      const href = String(url);
      requested.push(href);
      if (href.endsWith('/global/health')) return Response.json({ healthy: true, version: '1.18.32' });
      return new Response('<html>OpenCode</html>', { headers: { 'content-type': 'text/html' } });
    });
    const runtime = createRuntime({
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
    }, {}, {
      ENV_CONFIGURED_OPENCODE_PORT: null,
      ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://seamus:4095', port: 4095 },
      ENV_EFFECTIVE_PORT: 4095,
    });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(requested).toContain('http://seamus:4095/global/health');
    expect(runtime.testState.isExternalOpenCode).toBe(true);
    expect(runtime.testState.isOpenCodeReady).toBe(false);
    expect(runtime.testState.openCodeBaseUrl).toBe('http://seamus:4095');
    expect(runtime.testState.openCodePort).toBe(4095);
    expect(runtime.testState.lastOpenCodeError).toContain('1.18.32');
  });

  it('warms only the last-used directory after a successful bootstrap', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-warm-'));
    const lastUsed = path.join(root, 'worktree-a');
    const otherProject = path.join(root, 'project-b');
    await fs.mkdir(lastUsed);
    await fs.mkdir(otherProject);
    const fetchMock = vi.fn(async () => Response.json({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
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
      getWarmupDirectories: vi.fn(async () => [lastUsed, otherProject]),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const warmups = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/api/location'))
      .map(([url, init]) => [String(url), init.headers['x-opencode-directory']]);
    // Each warmed directory boots its whole MCP fleet on OpenCode 2 (#4018).
    // v2 reads the directory from the header, and only location routes start
    // one: `/api/session` is a global list.
    expect(warmups).toEqual([
      ['http://127.0.0.1:45678/api/location', encodeURIComponent(lastUsed)],
    ]);
    // Server-side reads without a directory of their own go to the warmed one.
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(lastUsed);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('answers null once the warmed default directory is no longer usable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-stale-'));
    const stale = path.join(root, 'worktree-a');
    await fs.mkdir(stale);
    globalThis.fetch = vi.fn(async () => Response.json({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => [stale]),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // While the directory is usable, it scopes default reads.
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(stale);

    // The project directory is removed while the server keeps running. The
    // cached default must not keep being handed to OpenCode: a stale path
    // makes every directory-scoped read answer 500 (the bug behind the quota
    // endpoints' "UnexpectedStatus: 500").
    await fs.rm(stale, { recursive: true, force: true });
    expect(runtime.getDefaultOpenCodeDirectory()).toBeNull();

    // A path that now points at a regular file is not a directory either.
    await fs.writeFile(stale, 'x');
    expect(runtime.getDefaultOpenCodeDirectory()).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('scopes default reads to the chats root while no project directory is usable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-no-project-'));
    const chats = path.join(root, 'chats');
    const project = path.join(root, 'project');
    await fs.mkdir(chats);
    await fs.mkdir(project);
    let warmup = [];
    globalThis.fetch = vi.fn(async () => Response.json({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => warmup),
      noProjectDirectory: chats,
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No project: a read without a directory would start OpenCode over the
    // whole home, its working directory.
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(chats);
    expect(globalThis.fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/location'))).toEqual([]);

    // A project opened later takes over once the warmup source names it.
    warmup = [project];
    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(project);
    await fs.rm(root, { recursive: true, force: true });
  });

  // The UI stops a chat's location once the user leaves it. A read that went
  // to the chat used last at startup would start it again, every quota poll.
  it('scopes reads without a directory to the directory the user works in now', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-current-'));
    const leftChat = path.join(root, 'left-chat');
    const current = path.join(root, 'current');
    await fs.mkdir(leftChat);
    await fs.mkdir(current);
    globalThis.fetch = vi.fn(async () => Response.json({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => [leftChat]),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(leftChat);

    runtime.noteCurrentDirectory(current);
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(current);

    // A directory that is not there is never sent.
    runtime.noteCurrentDirectory(path.join(root, 'missing'));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(current);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('advances to a currently-valid warmup directory when the cached default goes stale', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-replace-'));
    const stale = path.join(root, 'gone');
    const surviving = path.join(root, 'still-here');
    await fs.mkdir(stale);
    await fs.mkdir(surviving);
    globalThis.fetch = vi.fn(async () => Response.json({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
    // The warm pass offered both; only the first was cached as the default.
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => [stale, surviving]),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(stale);

    // Removing the first still leaves a valid directory: default reads keep
    // their location scope rather than dropping it entirely.
    await fs.rm(stale, { recursive: true, force: true });
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(surviving);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('re-resolves the settings-backed default when the cached one is stale', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-refresh-'));
    const stale = path.join(root, 'old-project');
    const navigated = path.join(root, 'new-project');
    await fs.mkdir(stale);
    await fs.mkdir(navigated);
    let current = stale;
    globalThis.fetch = vi.fn(async () => Response.json({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      // Mirrors the real dep: the warmup source answers the settings'
      // lastDirectory, which moves as the user navigates.
      getWarmupDirectories: vi.fn(async () => [current]),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(stale);

    // The user navigated to another project while the old one vanished.
    await fs.rm(stale, { recursive: true, force: true });
    current = navigated;
    // First read drops the stale default and kicks the refresh; the next read
    // sees the re-resolved, currently-valid directory and scopes to it.
    expect(runtime.getDefaultOpenCodeDirectory()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(navigated);
    await fs.rm(root, { recursive: true, force: true });
  });

  // Windows chmod only toggles the read-only attribute, and root ignores the
  // permission bits, so neither can take read/execute away from a directory.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('treats a directory without read/execute permission as unusable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-perm-'));
    const locked = path.join(root, 'locked');
    await fs.mkdir(locked);
    globalThis.fetch = vi.fn(async () => Response.json({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => [locked]),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getDefaultOpenCodeDirectory()).toBe(locked);

    // OpenCode answers 500 FileSystem.realPath for a directory it cannot read
    // or traverse, same as for a missing one, so it must not be sent.
    await fs.chmod(locked, 0o000);
    try {
      expect(runtime.getDefaultOpenCodeDirectory()).toBeNull();
    } finally {
      await fs.chmod(locked, 0o755);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not scope the restart agent check to a directory that went stale', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-agent-'));
    const stale = path.join(root, 'worktree-a');
    await fs.mkdir(stale);
    const requested = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      requested.push([String(url), init?.headers?.['x-opencode-directory'] ?? null]);
      if (String(url).endsWith('/api/info')) {
        return Response.json({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } });
      }
      return Response.json({ data: [{ id: 'build' }] });
    });
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => [stale]),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await fs.rm(stale, { recursive: true, force: true });
    await expect(runtime.waitForAgentPresence('build', 500, 50)).resolves.toBeUndefined();

    const agentChecks = requested.filter(([url]) => url.endsWith('/api/agent'));
    expect(agentChecks.length).toBeGreaterThan(0);
    expect(agentChecks.every(([, directory]) => directory === null)).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('settles waitForAgentPresence within its deadline when /api/agent never answers', async () => {
    const signals = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith('/api/info')) {
        return Response.json({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } });
      }
      signals.push(init?.signal ?? null);
      // A wedged OpenCode: accepts the request and never answers, but like a
      // real fetch it rejects when the caller's signal aborts.
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    const startedAt = Date.now();
    await expect(runtime.waitForAgentPresence('build', 500, 50)).rejects.toThrow(
      'Agent "build" not available after OpenCode restart',
    );
    // Without a per-attempt deadline the first stalled fetch never settles,
    // so the wait would hang far past its own 500 ms deadline.
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
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
      fetchResult: () => new Response('{', { headers: { 'content-type': 'application/json' } }),
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

  it('tracks external OpenCode health failures and recovery without restarting it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
    globalThis.fetch = fetchMock;
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      isExternalOpenCode: true,
      isOpenCodeReady: true,
    });

    await runtime.triggerHealthCheck();

    expect(runtime.testState.isOpenCodeReady).toBe(false);
    expect(runtime.testState.lastOpenCodeHealthFailure).toEqual({
      class: 'error',
      detail: expect.any(String),
      at: expect.any(String),
      source: 'immediate',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:45678/api/info',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(runtime.testState.openCodeProcess).toBeNull();

    await runtime.triggerHealthCheck();

    expect(runtime.testState.isOpenCodeReady).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not wedge external health checks when the info body stalls', async () => {
    // Headers arrive at once; the body never does. The probe's abort
    // deadline must still fire while the body is being read — a real
    // fetch errors the body stream when its signal aborts — or the
    // health-check cycle promise stays pending and every later check
    // reuses it, leaving readiness frozen at its previous value.
    const stallingFetch = vi.fn(async (_url, init) => {
      const stream = new ReadableStream({
        start(controller) {
          init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    globalThis.fetch = stallingFetch;
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      isExternalOpenCode: true,
      isOpenCodeReady: true,
    });

    await runtime.triggerHealthCheck();

    expect(runtime.testState.isOpenCodeReady).toBe(false);
    expect(stallingFetch).toHaveBeenCalledTimes(1);

    // The cycle is not wedged: the next check issues a fresh probe and
    // readiness recovers when the server answers.
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    );
    await runtime.triggerHealthCheck();
    expect(runtime.testState.isOpenCodeReady).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  }, 20_000);

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
    const [command, commandArgs, options] = spawnMock.mock.calls[0];
    const { binary, args } = unwrapLaunch(command, commandArgs);

    expect(binary).toBe('opencode');
    expect(args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '45678']);
    expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.SHELL_ONLY).toBe('yes');
    expect(options.env.OPENCODE_PASSWORD).toBe('password');
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
    const [command, commandArgs] = spawnMock.mock.calls[0];
    const { binary, args } = unwrapLaunch(command, commandArgs);

    expect(binary).toBe('opencode');
    expect(args).toEqual(['serve', '--hostname', '0.0.0.0', '--port', '45678']);

    await server.close();
    expect(server.signalCode).toBe('SIGTERM');
  });

  it('removes AppImage launcher entries from the managed OpenCode launch env', async () => {
    delete process.env.OPENCODE_BINARY;
    const previous = { APPDIR: process.env.APPDIR, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH };
    process.env.APPDIR = '/tmp/.mount_OpenChAbC123';
    process.env.LD_LIBRARY_PATH = '/tmp/.mount_OpenChAbC123/usr/lib:/opt/x:';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    try {
      const runtime = createRuntime();
      const server = await runtime.startOpenCode();
      const [, , options] = spawnMock.mock.calls[0];

      expect(options.env.LD_LIBRARY_PATH).toBe('/opt/x');

      await server.close();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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

  it('passes the user variables to OpenCode under the variables OpenChamber owns', async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    const getUserEnvironment = vi.fn(() => ({
      DATABASE_URL: 'postgres://db',
      PATH: '/opt/tools/bin',
      OPENCODE_PASSWORD: 'user-password',
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'user-token',
    }));
    const getManagedOpenCodeEnv = vi.fn(async () => ({ OPENCHAMBER_AGENT_TOOL_TOKEN: 'ephemeral' }));

    const runtime = createRuntime({ getUserEnvironment, getManagedOpenCodeEnv });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.DATABASE_URL).toBe('postgres://db');
    expect(options.env.PATH).toBe('/opt/tools/bin:/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.OPENCODE_PASSWORD).toBe('password');
    expect(options.env.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('ephemeral');
    expect(runtime.getManagedOpenCodeProcessEnv().DATABASE_URL).toBe('postgres://db');
    // The replaced values are recorded as OpenChamber's; the user's are not.
    const injected = injectedEnvKeys(options.env);
    for (const key of ['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD', 'OPENCHAMBER_AGENT_TOOL_TOKEN']) {
      expect(injected.has(key)).toBe(true);
    }
    expect(injected.has('DATABASE_URL')).toBe(false);
    expect(injected.has('PATH')).toBe(false);

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
      OPENCODE_PASSWORD: 'untrusted-password',
      OPENCODE_SERVER_PASSWORD: 'untrusted-password',
    }));

    const runtime = createRuntime({ getManagedOpenCodeEnv });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(getManagedOpenCodeEnv).toHaveBeenCalledOnce();
    expect(options.env.OPENCODE_CONFIG_CONTENT).toBe('{"plugin":["file:///tool.js"]}');
    expect(options.env.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('ephemeral');
    expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.OPENCODE_PASSWORD).toBe('password');
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBe('password');

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

  it('tops up the v1 session migration before spawning managed OpenCode', async () => {
    const calls = [];
    const topUpV1SessionMigration = vi.fn(() => {
      calls.push('top-up');
      return { status: 'scheduled', missing: 3, revisited: 0 };
    });
    spawnMock.mockImplementation(() => {
      calls.push('spawn');
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));

    const runtime = createRuntime({ topUpV1SessionMigration });
    await runtime.startOpenCode();

    expect(topUpV1SessionMigration).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['top-up', 'spawn']);
  });

});

it('shares the managed CLI preflight with desktop while startup is pending', async () => {
  let finish;
  let entered;
  const checking = new Promise(resolve => { entered = resolve; });
  const check = new Promise(resolve => { finish = resolve; });
  let checks = 0;
  const runtime = createRuntime({
    checkOpenCodeBinary: () => { checks += 1; entered(); return check; },
    ensureOpencodeCliEnv: () => '/tmp/opencode',
  });
  spawnMock.mockImplementation(() => {
    const child = createMockChild();
    queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n'));
    return child;
  });
  expect(await runtime.getManagedOpenCodePreflight()).toBe(false);
  const starting = runtime.startOpenCode();
  await checking;
  const desktopVerdict = runtime.getManagedOpenCodePreflight();
  expect(runtime.testState.isOpenCodeReady).toBe(false);
  finish('2.0.20');
  expect(await desktopVerdict).toBe(true);
  expect(checks).toBe(1);
  const server = await starting;
  try {
    expect(await runtime.getManagedOpenCodePreflight()).toBe(true);
    runtime.testState.isExternalOpenCode = true;
    expect(await runtime.getManagedOpenCodePreflight()).toBe(false);
    runtime.testState.isExternalOpenCode = false;
    runtime.testState.isShuttingDown = true;
    expect(await runtime.getManagedOpenCodePreflight()).toBe(false);
  } finally {
    await server.close();
  }
});

it('a rejected CLI preflight never permits desktop bootstrap', async () => {
  const runtime = createRuntime({
    checkOpenCodeBinary: async () => {
      throw Object.assign(new Error('Unsupported CLI'), { code: 'OPENCODE_BINARY_INVALID' });
    },
  });
  await expect(runtime.startOpenCode()).rejects.toThrow('Unsupported CLI');
  expect(await runtime.getManagedOpenCodePreflight()).toBe(false);
  expect(spawnMock).not.toHaveBeenCalled();
});

describe('readiness on a log shared by several servers', () => {
  it('takes only the listening line for the port its child was given', async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = createMockChild();
      queueMicrotask(() => {
        // Another server's child, starting at the same time, writes first.
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:50000\n');
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    globalThis.fetch = vi.fn(async () => Response.json({}));
    const server = await createRuntime({ ensureOpencodeCliEnv: vi.fn(() => 'opencode') }).startOpenCode();
    expect(server.url).toBe('http://127.0.0.1:45678');
  });
});

describe('managed OpenCode adoption across OpenChamber restarts', () => {
  const READY_LINE = 'opencode server listening on http://127.0.0.1:45678\n';
  const OWNED_PS_OUTPUT = 'opencode serve --hostname 127.0.0.1 --port 45678\n';
  const readyLineFor = (command, args) => {
    const launched = unwrapLaunch(command, args).args;
    const port = launched[launched.indexOf('--port') + 1];
    return `opencode server listening on http://127.0.0.1:${port}\n`;
  };
  // Never a live pid, so a replace path cannot signal an unrelated process.
  const DEAD_PID = 2147483646;

  const startFirstRuntime = async () => {
    const dataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'opencode-adopt-test-'));
    tempDataDirs.push(dataDir);
    spawnMock.mockImplementationOnce(() => {
      const child = createMockChild();
      child.pid = DEAD_PID;
      queueMicrotask(() => child.stdout.emit('data', READY_LINE));
      return child;
    });
    globalThis.fetch = vi.fn(async () => Response.json({}));
    const server = await createRuntime({ dataDir, ensureOpencodeCliEnv: vi.fn(() => 'opencode') }).startOpenCode();
    spawnMock.mockClear();
    return { dataDir, server };
  };

  it('adopts a healthy OpenCode whose recorded pid, port and launch config match', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir, server: firstServer } = await startFirstRuntime();
    spawnSyncMock.mockImplementation((cmd) => ({ stdout: cmd === 'ps' ? OWNED_PS_OUTPUT : '' }));

    const second = createRuntime({ dataDir, ensureOpencodeCliEnv: vi.fn(() => 'opencode') });
    const adopted = await second.startOpenCode();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(adopted.pid).toBe(firstServer.pid);
    expect(adopted.url).toBe('http://127.0.0.1:45678');
  });

  it('hands off from the recorded OpenCode when its binary changed and keeps it draining', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir } = await startFirstRuntime();
    const recorded = JSON.parse(fsSync.readFileSync(path.join(dataDir, 'managed-opencode', 'state.json'), 'utf8'));
    spawnSyncMock.mockImplementation((cmd) => ({ stdout: cmd === 'ps' ? OWNED_PS_OUTPUT : '' }));
    globalThis.fetch = vi.fn(async () => Response.json({}));
    spawnMock.mockImplementationOnce((command, args) => {
      const child = createMockChild();
      // Like OpenCode, the line names the port the child was started on.
      queueMicrotask(() => child.stdout.emit('data', readyLineFor(command, args)));
      return child;
    });

    const second = createRuntime({ dataDir, ensureOpencodeCliEnv: vi.fn(() => '/opt/other/opencode') });
    await second.startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const { binary } = unwrapLaunch(spawnMock.mock.calls[0][0], spawnMock.mock.calls[0][1]);
    expect(binary).toBe('/opt/other/opencode');
    const draining = JSON.parse(fsSync.readFileSync(path.join(dataDir, 'managed-opencode', 'draining.json'), 'utf8'));
    expect(draining.draining).toEqual([expect.objectContaining({ pid: recorded.pid, port: recorded.port, binary: recorded.binary })]);
    const current = JSON.parse(fsSync.readFileSync(path.join(dataDir, 'managed-opencode', 'state.json'), 'utf8'));
    expect(current.port).not.toBe(recorded.port);
    expect(current.binary).toBe('/opt/other/opencode');
  });

  // Two OpenChamber servers on one data dir (the desktop app and `openchamber
  // serve`) share state.json and draining.json. The recorded OpenCode may be
  // the other server's; it must never be adopted, handed off from or drained.
  // The test runner's parent stands in for that other server: alive, not us.
  it('leaves an OpenCode that another live server owns alone and starts its own', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir } = await startFirstRuntime();
    const recorded = JSON.parse(fsSync.readFileSync(path.join(dataDir, 'managed-opencode', 'state.json'), 'utf8'));
    spawnSyncMock.mockImplementation((cmd) => ({ stdout: cmd === 'ps' ? OWNED_PS_OUTPUT : '' }));
    spawnMock.mockImplementationOnce((command, args) => {
      const child = createMockChild();
      // Like OpenCode, the line names the port the child was started on.
      queueMicrotask(() => child.stdout.emit('data', readyLineFor(command, args)));
      return child;
    });

    const second = createRuntime({
      dataDir,
      ensureOpencodeCliEnv: vi.fn(() => '/opt/other/opencode'),
      readProcessOwner: () => process.ppid,
    });
    await second.startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const drainingPath = path.join(dataDir, 'managed-opencode', 'draining.json');
    const draining = fsSync.existsSync(drainingPath) ? JSON.parse(fsSync.readFileSync(drainingPath, 'utf8')).draining : [];
    expect(draining.map((record) => record.pid)).not.toContain(recorded.pid);
  });

  it('adopts the OpenCode of the server handing off to it, and records itself as the owner', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir, server: firstServer } = await startFirstRuntime();
    spawnSyncMock.mockImplementation((cmd) => ({ stdout: cmd === 'ps' ? OWNED_PS_OUTPUT : '' }));
    // The registry names the predecessor as the owner, as it would after it spawned this OpenCode.
    const entryPath = path.join(process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY, `${firstServer.pid}.json`);
    const entry = JSON.parse(fsSync.readFileSync(entryPath, 'utf8'));
    fsSync.writeFileSync(entryPath, JSON.stringify({ ...entry, ownerPid: process.ppid }));

    const second = createRuntime({
      dataDir,
      ensureOpencodeCliEnv: vi.fn(() => 'opencode'),
      getHandoffPredecessorPid: () => process.ppid,
    });
    const adopted = await second.startOpenCode();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(adopted.pid).toBe(firstServer.pid);
    expect(JSON.parse(fsSync.readFileSync(entryPath, 'utf8')).ownerPid).toBe(process.pid);
  });

  it('leaves an OpenCode whose owner the registry does not record alone', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir } = await startFirstRuntime();
    const recorded = JSON.parse(fsSync.readFileSync(path.join(dataDir, 'managed-opencode', 'state.json'), 'utf8'));
    fsSync.rmSync(path.join(process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY, `${recorded.pid}.json`), { force: true });
    spawnSyncMock.mockImplementation((cmd) => ({ stdout: cmd === 'ps' ? OWNED_PS_OUTPUT : '' }));
    spawnMock.mockImplementationOnce((command, args) => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', readyLineFor(command, args)));
      return child;
    });

    await createRuntime({ dataDir, ensureOpencodeCliEnv: vi.fn(() => '/opt/other/opencode') }).startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const drainingPath = path.join(dataDir, 'managed-opencode', 'draining.json');
    const draining = fsSync.existsSync(drainingPath) ? JSON.parse(fsSync.readFileSync(drainingPath, 'utf8')).draining : [];
    expect(draining.map((record) => record.pid)).not.toContain(recorded.pid);
  });

  it('says another server holds a pinned port instead of failing to bind', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir } = await startFirstRuntime();
    // A live recorded process on the pinned port, owned by another live server.
    const statePath = path.join(dataDir, 'managed-opencode', 'state.json');
    fsSync.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(fsSync.readFileSync(statePath, 'utf8')), pid: process.ppid }));

    const second = createRuntime({ dataDir, ensureOpencodeCliEnv: vi.fn(() => 'opencode'), readProcessOwner: () => process.ppid });
    await expect(second.startOpenCode()).rejects.toThrow(/port 45678 is held by another OpenChamber server/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reloads its own OpenCode when another server has overwritten state.json', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir } = await startFirstRuntime();
    spawnSyncMock.mockImplementation((cmd) => ({ stdout: cmd === 'ps' ? OWNED_PS_OUTPUT : '' }));
    const ensureOpencodeCliEnv = vi.fn(() => 'opencode');
    const runtime = createRuntime({ dataDir, ensureOpencodeCliEnv });
    // The server keeps the started process in state, as restartOpenCode does.
    runtime.testState.openCodeProcess = await runtime.startOpenCode();
    const statePath = path.join(dataDir, 'managed-opencode', 'state.json');
    const mine = JSON.parse(fsSync.readFileSync(statePath, 'utf8'));
    fsSync.writeFileSync(statePath, JSON.stringify({ ...mine, pid: process.ppid, port: 51000 }));
    ensureOpencodeCliEnv.mockImplementation(() => '/opt/other/opencode');
    spawnMock.mockImplementationOnce((command, args) => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', readyLineFor(command, args)));
      return child;
    });

    await expect(runtime.reloadOpenCode()).resolves.toBe(true);
  });

  it('leaves an orphan another server claimed first', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir } = await startFirstRuntime();
    spawnSyncMock.mockImplementation((cmd) => ({ stdout: cmd === 'ps' ? OWNED_PS_OUTPUT : '' }));
    spawnMock.mockImplementationOnce((command, args) => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', readyLineFor(command, args)));
      return child;
    });
    // The recorded owner is gone, and another live server holds the claim on its OpenCode.
    const second = createRuntime({
      dataDir,
      ensureOpencodeCliEnv: vi.fn(() => 'opencode'),
      readProcessOwner: () => DEAD_PID,
      claimProcess: () => process.ppid,
    });
    await second.startOpenCode();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('keeps another live server\'s draining records when it rewrites draining.json', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir } = await startFirstRuntime();
    const drainingPath = path.join(dataDir, 'managed-opencode', 'draining.json');
    const foreign = { pid: 424242, port: 50075, binary: '/opt/other/opencode', drainStartedAt: Date.now() };
    fsSync.writeFileSync(drainingPath, JSON.stringify({ version: 1, draining: [foreign] }));
    spawnSyncMock.mockImplementation((cmd) => ({ stdout: cmd === 'ps' ? OWNED_PS_OUTPUT : '' }));
    globalThis.fetch = vi.fn(async () => Response.json({}));
    spawnMock.mockImplementationOnce((command, args) => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', readyLineFor(command, args)));
      return child;
    });
    // This server hands off from its own OpenCode, which adds a draining record of its own.
    const second = createRuntime({
      dataDir,
      ensureOpencodeCliEnv: vi.fn(() => '/opt/new/opencode'),
      readProcessOwner: (pid) => (pid === foreign.pid ? process.ppid : process.pid),
    });
    await second.startOpenCode();

    const pids = JSON.parse(fsSync.readFileSync(drainingPath, 'utf8')).draining.map((record) => record.pid);
    expect(pids).toContain(foreign.pid);
    expect(pids.length).toBeGreaterThan(1);
  });

  it('registers the draining OpenCode it inherits under itself', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir } = await startFirstRuntime();
    const registry = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    // A draining child its predecessor left, registered to a server that is gone.
    const inherited = { pid: 424243, port: 50076, binary: 'opencode', drainStartedAt: Date.now() };
    fsSync.writeFileSync(path.join(dataDir, 'managed-opencode', 'draining.json'), JSON.stringify({ version: 1, draining: [inherited] }));
    fsSync.writeFileSync(path.join(registry, `${inherited.pid}.json`), JSON.stringify({ pid: inherited.pid, ownerPid: DEAD_PID - 1, port: inherited.port, binary: 'opencode' }));
    spawnSyncMock.mockImplementation((cmd) => ({ stdout: cmd === 'ps' ? OWNED_PS_OUTPUT : '' }));

    await createRuntime({ dataDir, ensureOpencodeCliEnv: vi.fn(() => 'opencode') }).startOpenCode();
    await vi.waitFor(() => {
      expect(JSON.parse(fsSync.readFileSync(path.join(registry, `${inherited.pid}.json`), 'utf8')).ownerPid).toBe(process.pid);
    });
  });

  it('replaces the recorded OpenCode when the launch fingerprint changed', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir } = await startFirstRuntime();
    spawnSyncMock.mockImplementation((cmd) => ({ stdout: cmd === 'ps' ? OWNED_PS_OUTPUT : '' }));
    spawnMock.mockImplementationOnce((command, args) => {
      const child = createMockChild();
      // Like OpenCode, the line names the port the child was started on.
      queueMicrotask(() => child.stdout.emit('data', readyLineFor(command, args)));
      return child;
    });

    const second = createRuntime({ dataDir, ensureOpencodeCliEnv: vi.fn(() => 'opencode') }, { openCodeWorkingDirectory: '/tmp/other-project' });
    await second.startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('starts fresh without signalling when the recorded pid no longer runs OpenCode', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir } = await startFirstRuntime();
    spawnSyncMock.mockImplementation(() => ({ stdout: '' }));
    spawnMock.mockImplementationOnce((command, args) => {
      const child = createMockChild();
      // Like OpenCode, the line names the port the child was started on.
      queueMicrotask(() => child.stdout.emit('data', readyLineFor(command, args)));
      return child;
    });

    const second = createRuntime({ dataDir, ensureOpencodeCliEnv: vi.fn(() => 'opencode') });
    await second.startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('replaces a recorded OpenCode whose health check fails', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir, server: firstServer } = await startFirstRuntime();
    expect(firstServer.pid).toBe(DEAD_PID);
    spawnSyncMock.mockImplementation((cmd) => ({ stdout: cmd === 'ps' ? OWNED_PS_OUTPUT : '' }));
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    spawnMock.mockImplementationOnce((command, args) => {
      const child = createMockChild();
      // Like OpenCode, the line names the port the child was started on.
      queueMicrotask(() => child.stdout.emit('data', readyLineFor(command, args)));
      return child;
    });

    const second = createRuntime({ dataDir, ensureOpencodeCliEnv: vi.fn(() => 'opencode') });
    await second.startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});


describe('parsePositiveInt health env parsing (#689)', () => {
  it('honours plain decimal spellings', () => {
    expect(parsePositiveInt('5000', 5000)).toBe(5000);
    expect(parsePositiveInt('250', 5000)).toBe(250);
    expect(parsePositiveInt(' 12 ', 5000)).toBe(12);
  });

  it('falls back for non-plain-decimal spellings instead of truncating them', () => {
    for (const invalid of [undefined, '', 'abc', '5000junk', '5000ms', '5.9', '1e3', '0x10', '-5', '0']) {
      expect(parsePositiveInt(invalid, 5000)).toBe(5000);
      expect(parsePositiveInt(invalid, 20)).toBe(20);
    }
  });
});


describe('managed credential rotation', () => {
  const READY_LINE = 'opencode server listening on http://127.0.0.1:45678\n';
  const OWNED_PS_OUTPUT = 'opencode serve --hostname 127.0.0.1 --port 45678\n';
  // Never a live pid, so a replace path cannot signal an unrelated process.
  const DEAD_PID = 2147483646;
  // Fixture values only. Assertions compare SHA-256 hashes, never the
  // values themselves, matching how a real rotation is verified.
  const OLD_PASSWORD = 'old-fixture-password';
  const NEW_PASSWORD = 'new-fixture-password';
  const OLD_TOKEN = 'old-fixture-token';
  const NEW_TOKEN = 'new-fixture-token';
  const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
  const readState = (dataDir) => JSON.parse(fsSync.readFileSync(path.join(dataDir, 'managed-opencode', 'state.json'), 'utf8'));
  const readyLineFor = (command, args) => {
    const launched = unwrapLaunch(command, args).args;
    const port = launched[launched.indexOf('--port') + 1];
    return `opencode server listening on http://127.0.0.1:${port}\n`;
  };
  const spawnOnceWithReadyLine = () => {
    spawnMock.mockImplementationOnce((command, args) => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', readyLineFor(command, args)));
      return child;
    });
  };
  // Credential doubles with the real contract: a reuse value wins when one
  // is passed; with none, a fresh value is generated.
  const credentialDoubles = () => ({
    ensureLocalOpenCodeServerPassword: vi.fn(async ({ reusePassword }) => reusePassword ?? NEW_PASSWORD),
    getManagedOpenCodeEnv: vi.fn(async ({ agentToolToken }) => ({
      OPENCHAMBER_AGENT_TOOL_TOKEN: agentToolToken ?? NEW_TOKEN,
    })),
  });

  const startFirstRuntime = async () => {
    const dataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'opencode-rotate-test-'));
    tempDataDirs.push(dataDir);
    spawnMock.mockImplementationOnce(() => {
      const child = createMockChild();
      child.pid = DEAD_PID;
      queueMicrotask(() => child.stdout.emit('data', READY_LINE));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true }));
    await createRuntime({
      dataDir,
      ensureOpencodeCliEnv: vi.fn(() => 'opencode'),
      ensureLocalOpenCodeServerPassword: vi.fn(async () => OLD_PASSWORD),
      getManagedOpenCodeEnv: vi.fn(async () => ({ OPENCHAMBER_AGENT_TOOL_TOKEN: OLD_TOKEN })),
    }).startOpenCode();
    spawnMock.mockClear();
    spawnSyncMock.mockImplementation((cmd) => ({ stdout: cmd === 'ps' ? OWNED_PS_OUTPUT : '' }));
    globalThis.fetch = vi.fn(async () => ({ ok: true }));
    return { dataDir };
  };

  it('rotation start discards the saved pair and writes a fresh one', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir } = await startFirstRuntime();
    const before = readState(dataDir);
    expect(sha256(before.password)).toBe(sha256(OLD_PASSWORD));
    expect(sha256(before.agentToolToken)).toBe(sha256(OLD_TOKEN));
    spawnOnceWithReadyLine();

    const doubles = credentialDoubles();
    const second = createRuntime({
      dataDir,
      ensureOpencodeCliEnv: vi.fn(() => 'opencode'),
      rotateManagedCredentials: true,
      ...doubles,
    });
    await second.startOpenCode();

    expect(doubles.ensureLocalOpenCodeServerPassword).toHaveBeenCalledWith({ rotateManaged: true, reusePassword: null });
    expect(doubles.getManagedOpenCodeEnv).toHaveBeenCalledWith({ agentToolToken: null });
    // The changed launch fingerprint hands off from the recorded process;
    // it is never adopted with the old credentials.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const after = readState(dataDir);
    expect(sha256(after.password)).not.toBe(sha256(before.password));
    expect(sha256(after.agentToolToken)).not.toBe(sha256(before.agentToolToken));
    expect(sha256(after.password)).toBe(sha256(NEW_PASSWORD));
    expect(sha256(after.agentToolToken)).toBe(sha256(NEW_TOKEN));
  });

  it('rotation is one start only: the next start in the same process reuses the rotated pair', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir } = await startFirstRuntime();
    spawnOnceWithReadyLine();

    const doubles = credentialDoubles();
    const second = createRuntime({
      dataDir,
      ensureOpencodeCliEnv: vi.fn(() => 'opencode'),
      rotateManagedCredentials: true,
      ...doubles,
    });
    await second.startOpenCode();
    expect(doubles.ensureLocalOpenCodeServerPassword).toHaveBeenLastCalledWith({ rotateManaged: true, reusePassword: null });

    spawnOnceWithReadyLine();
    await second.startOpenCode();
    expect(doubles.ensureLocalOpenCodeServerPassword).toHaveBeenLastCalledWith({ rotateManaged: true, reusePassword: NEW_PASSWORD });
    expect(doubles.getManagedOpenCodeEnv).toHaveBeenLastCalledWith({ agentToolToken: NEW_TOKEN });
  });

  it('a normal start reuses the saved pair and adopts the running OpenCode', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir } = await startFirstRuntime();
    const before = readState(dataDir);

    const doubles = credentialDoubles();
    const second = createRuntime({
      dataDir,
      ensureOpencodeCliEnv: vi.fn(() => 'opencode'),
      ...doubles,
    });
    const adopted = await second.startOpenCode();

    expect(doubles.ensureLocalOpenCodeServerPassword).toHaveBeenCalledWith({ rotateManaged: true, reusePassword: OLD_PASSWORD });
    expect(doubles.getManagedOpenCodeEnv).toHaveBeenCalledWith({ agentToolToken: OLD_TOKEN });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(adopted.pid).toBe(before.pid);
  });

  it('a handoff start still reuses the saved pair', async () => {
    delete process.env.OPENCODE_BINARY;
    const { dataDir } = await startFirstRuntime();
    spawnOnceWithReadyLine();

    const doubles = credentialDoubles();
    const second = createRuntime({
      dataDir,
      ensureOpencodeCliEnv: vi.fn(() => '/opt/other/opencode'),
      ...doubles,
    });
    await second.startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(doubles.ensureLocalOpenCodeServerPassword).toHaveBeenCalledWith({ rotateManaged: true, reusePassword: OLD_PASSWORD });
    expect(doubles.getManagedOpenCodeEnv).toHaveBeenCalledWith({ agentToolToken: OLD_TOKEN });
    const after = readState(dataDir);
    expect(sha256(after.password)).toBe(sha256(OLD_PASSWORD));
    expect(sha256(after.agentToolToken)).toBe(sha256(OLD_TOKEN));
  });
});
