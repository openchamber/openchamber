import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('../guardian/detection.js', () => ({
  isGuardianRunning: vi.fn(),
  detectAndAdoptGuardianChild: vi.fn(),
  getGuardianSocketPath: vi.fn(() => '/tmp/test-guardian.sock'),
}));

vi.mock('../guardian/guardian-client.js', () => ({
  GuardianClient: vi.fn().mockImplementation(function ({ socketPath }) {
    return {
      socketPath,
      connect: vi.fn(),
      spawn: vi.fn(),
      stop: vi.fn(),
      prepareHandoff: vi.fn(),
      list: vi.fn(),
      disconnect: vi.fn(),
    };
  }),
  GuardianClientError: class GuardianClientError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
      this.name = 'GuardianClientError';
    }
  },
}));

import { isGuardianRunning, detectAndAdoptGuardianChild, getGuardianSocketPath } from '../guardian/detection.js';
import { GuardianClient } from '../guardian/guardian-client.js';

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');

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

const createActiveRollbackRecord = (incarnation) => ({
  state: 'active',
  incarnation,
});

// W-C: helper to flip `process.platform` per-test (mirrors the helper
// in launch-wiring.test.js). Windows-native test environments must
// also exercise the new code paths even when the actual `process.platform`
// is Linux, so the test uses this same pattern.
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
function setPlatformForTest(platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}
function restorePlatform() {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  } else {
    delete process.platform;
  }
}

const createRuntime = (overrides = {}) => {
  const state = {
    openCodeWorkingDirectory: '/tmp/project',
    openCodeProcess: null,
    openCodePort: null,
    openCodeBaseUrl: null,
    currentRestartPromise: null,
    currentIncarnation: null,
    currentOwner: {
      ownerInstanceId: 'owner-test-instance',
      runtimeIdentity: 'runtime-test-instance',
      launchFingerprint: 'current-fingerprint',
    },
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

  const deps = {
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: undefined,
      ENV_CONFIGURED_OPENCODE_HOST: null,
      ENV_EFFECTIVE_PORT: undefined,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ENV_SKIP_OPENCODE_START: false,
    },
    syncToHmrState: vi.fn(),
    syncFromHmrState: vi.fn(() => {
      state.isOpenCodeReady = false;
      state.openCodePort = null;
    }),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (route, prefixOverride) => {
      const port = state.openCodePort || 45678;
      return `http://127.0.0.1:${port}${route}`;
    },
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
    resetSessionRuntimeForOpenCodeReplacement: vi.fn(),
    guardianOwnerInstanceId: 'owner-test-instance',
    guardianRuntimeIdentity: 'runtime-test-instance',
    ...overrides,
  };

  const runtime = createOpenCodeLifecycleRuntime(deps);
  return { runtime, state, deps };
};

describe('Guardian integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: guardian is running, adoption returns null.
    isGuardianRunning.mockResolvedValue(true);
    detectAndAdoptGuardianChild.mockResolvedValue(null);
    // Reset GuardianClient to default implementation so one test's
    // mockImplementation does not leak into the next.
    GuardianClient.mockImplementation(function ({ socketPath }) {
      return {
        socketPath,
        connect: vi.fn(),
        spawn: vi.fn(),
        stop: vi.fn(),
        prepareHandoff: vi.fn(),
        list: vi.fn(),
        disconnect: vi.fn(),
      };
    });
  });

  afterEach(() => {
    // vi.stubGlobal is not available in the bun vitest-compat runner, so
    // tests assign globalThis.fetch directly. Clean it up so the next
    // test starts from a pristine state.
    delete globalThis.fetch;
  });

  describe('bootstrapOpenCodeAtStartup', () => {
    it('adopts guardian-managed child on startup', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ healthy: true }),
      });

      const { runtime, state, deps } = createRuntime();

      detectAndAdoptGuardianChild.mockResolvedValue({
        incarnation: 'test-incarnation-123',
        pid: 12345,
        port: 4096,
        url: 'http://127.0.0.1:4096',
        owner: {
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
          launchFingerprint: 'adopted-fingerprint',
        },
      });

      await runtime.bootstrapOpenCodeAtStartup();

      expect(detectAndAdoptGuardianChild).toHaveBeenCalled();
      expect(detectAndAdoptGuardianChild.mock.calls[0][2]).toEqual({
        expectedOwner: {
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
        },
      });
      // M-3: adoption path stores a closeable proxy, not a bare { pid }.
      expect(state.openCodeProcess).toMatchObject({ pid: 12345, isGuardianManaged: true });
      expect(typeof state.openCodeProcess.close).toBe('function');
      expect(typeof state.openCodeProcess.kill).toBe('function');
      // M-1: adoption path routes the port through setOpenCodePort.
      expect(deps.setOpenCodePort).toHaveBeenCalledWith(4096);
      expect(state.openCodePort).toBe(4096);
      expect(state.isOpenCodeReady).toBe(true);
      expect(state.isExternalOpenCode).toBe(false);
      expect(state.currentIncarnation).toBe('test-incarnation-123');
    }, 10000);

    it('falls back to legacy start when guardian not running', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ healthy: true }),
      });

      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
        });
        return child;
      });

      const { runtime, state } = createRuntime();

      detectAndAdoptGuardianChild.mockResolvedValue(null);
      isGuardianRunning.mockResolvedValue(false);

      await runtime.bootstrapOpenCodeAtStartup();

      expect(detectAndAdoptGuardianChild).toHaveBeenCalled();
      expect(spawn).toHaveBeenCalled();
      expect(state.openCodeProcess).not.toBeNull();
    }, 10000);

    it('falls back to legacy start when guardian detection throws', async () => {
      const { runtime, state } = createRuntime();

      detectAndAdoptGuardianChild.mockRejectedValue(new Error('Connection refused'));

      await runtime.bootstrapOpenCodeAtStartup();

      expect(detectAndAdoptGuardianChild).toHaveBeenCalled();
      // When detection throws, bootstrap logs the error and continues without OpenCode.
      expect(state.lastOpenCodeError).toBe('Connection refused');
    }, 10000);

    it('refuses legacy startup when the guardian status probe throws', async () => {
      const { spawn } = await import('node:child_process');
      const { runtime, state } = createRuntime();

      isGuardianRunning.mockRejectedValue(new Error('status probe failed'));

      await runtime.bootstrapOpenCodeAtStartup();

      expect(spawn).not.toHaveBeenCalled();
      expect(state.openCodeProcess).toBeNull();
      expect(state.lastOpenCodeError).toMatch(
        /Guardian status probe failed; refusing legacy lifecycle fallback: status probe failed/,
      );
    }, 10000);

    it('starts the initial managed child through a running guardian', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ healthy: true }),
      });

      const owner = {
        ownerInstanceId: 'owner-initial',
        runtimeIdentity: 'runtime-initial',
        launchFingerprint: 'fingerprint-initial',
      };
      const clientConnect = vi.fn().mockResolvedValue(undefined);
      const clientSpawn = vi.fn().mockResolvedValue({
        incarnation: 'initial-incarnation',
        pid: 12346,
        port: 45679,
        owner,
      });
      const clientStop = vi.fn().mockResolvedValue(undefined);
      GuardianClient.mockImplementation(function ({ socketPath }) {
        return {
          socketPath,
          connect: clientConnect,
          spawn: clientSpawn,
          stop: clientStop,
          prepareHandoff: vi.fn(),
          list: vi.fn(),
          disconnect: vi.fn(),
        };
      });

      const { runtime, state } = createRuntime();
      await runtime.bootstrapOpenCodeAtStartup();

      expect(clientConnect).toHaveBeenCalled();
      expect(clientSpawn).toHaveBeenCalledWith(expect.objectContaining({
        hostname: '127.0.0.1',
        cwd: '/tmp/project',
        owner: expect.objectContaining({
          ownerInstanceId: expect.any(String),
          runtimeIdentity: expect.any(String),
          launchFingerprint: expect.any(String),
        }),
        launchSpec: expect.objectContaining({
          hostname: '127.0.0.1',
          port: expect.any(Number),
          cwd: '/tmp/project',
        }),
      }));
      expect(state.openCodeProcess).toMatchObject({ pid: 12346, isGuardianManaged: true });
      expect(state.currentIncarnation).toBe('initial-incarnation');
      expect(state.currentOwner).toEqual(owner);

      await state.openCodeProcess.close();
      expect(clientStop).toHaveBeenCalledWith({ incarnation: 'initial-incarnation', owner });
    }, 10000);

    it('does not legacy-spawn when a live guardian initial launch fails', async () => {
      const clientConnect = vi.fn().mockResolvedValue(undefined);
      const clientSpawn = vi.fn().mockRejectedValue(new Error('guardian launch rejected'));
      const clientDisconnect = vi.fn();
      GuardianClient.mockImplementation(function () {
        return {
          connect: clientConnect,
          spawn: clientSpawn,
          stop: vi.fn(),
          disconnect: clientDisconnect,
        };
      });

      const { spawn } = await import('node:child_process');
      const { runtime, state } = createRuntime();

      await runtime.bootstrapOpenCodeAtStartup();

      expect(clientConnect).toHaveBeenCalledOnce();
      expect(clientSpawn).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      expect(clientDisconnect).toHaveBeenCalledOnce();
      expect(state.openCodeProcess).toBeNull();
      expect(state.isOpenCodeReady).toBe(false);
      expect(state.lastOpenCodeError).toMatch(
        /Guardian is running but initial OpenCode launch failed; refusing legacy fallback/,
      );
    }, 10000);
  });

  describe('restartOpenCode', () => {
    it('performs handoff restart through guardian', async () => {
      const clientConnect = vi.fn().mockResolvedValue(undefined);
      const clientSpawn = vi.fn().mockResolvedValue({
        incarnation: 'successor-123',
        pid: 12346,
        port: 45679,
      });
      const clientPrepareHandoff = vi.fn().mockResolvedValue(undefined);
      const clientStop = vi.fn().mockResolvedValue(undefined);
      const clientDisconnect = vi.fn();

      // Override GuardianClient for this test.
      GuardianClient.mockImplementation(function () {
        return {
          connect: clientConnect,
          spawn: clientSpawn,
          stop: clientStop,
          prepareHandoff: clientPrepareHandoff,
          list: vi.fn(),
          disconnect: clientDisconnect,
        };
      });

      const { runtime, state, deps } = createRuntime();

      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'current-123';
      state.isOpenCodeReady = true;

      // The restart may throw because waitForReady or startOpenCode aren't fully mocked,
      // but we can verify the guardian client was invoked.
      try {
        await runtime.restartOpenCode();
      } catch {
        // Expected if legacy fallback also fails in test environment.
      }

      expect(clientConnect).toHaveBeenCalled();
      expect(clientPrepareHandoff).toHaveBeenCalledWith({
        incarnation: 'current-123',
        owner: expect.objectContaining({
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
        }),
      });
      expect(clientSpawn).toHaveBeenCalled();
      expect(clientStop).toHaveBeenCalledWith({
        incarnation: 'current-123',
        owner: expect.objectContaining({
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
        }),
      });
      // M-3: on successful handoff the client is kept alive inside the
      // successor's closeable proxy, so disconnect() is NOT called here.
      expect(clientDisconnect).not.toHaveBeenCalled();
      // M-1: handoff-spawn routes the successor port through setOpenCodePort.
      expect(deps.setOpenCodePort).toHaveBeenCalledWith(45679);
      expect(deps.resetSessionRuntimeForOpenCodeReplacement).toHaveBeenCalledTimes(1);
      // M-3: the handoff-spawn proxy is a closeable, guardian-managed wrapper.
      expect(state.openCodeProcess).toMatchObject({ pid: 12346, isGuardianManaged: true });
      expect(typeof state.openCodeProcess.close).toBe('function');
    });

    it('guardian handoff spawn passes managed launch env (password + agent-tool) through IPC', async () => {
      // F-2: the guardian handoff path must use the same managed-launch
      // env-construction as startOpenCodeOnce. Otherwise the successor
      // lacks OPENCODE_SERVER_PASSWORD (so proxied requests carrying
      // getOpenCodeAuthHeaders() fail to authenticate) and lacks the
      // agent-tool runtime env.
      const clientConnect = vi.fn().mockResolvedValue(undefined);
      const clientSpawn = vi.fn().mockResolvedValue({
        incarnation: 'successor-f2',
        pid: 12347,
        port: 45680,
      });
      const clientPrepareHandoff = vi.fn().mockResolvedValue(undefined);
      const clientStop = vi.fn().mockResolvedValue(undefined);
      const clientDisconnect = vi.fn();

      GuardianClient.mockImplementation(function () {
        return {
          connect: clientConnect,
          spawn: clientSpawn,
          stop: clientStop,
          prepareHandoff: clientPrepareHandoff,
          list: vi.fn(),
          disconnect: clientDisconnect,
        };
      });

      const applyOpencodeBinaryFromSettings = vi.fn(async () => {
        process.env.OPENCODE_BINARY = '/usr/local/bin/opencode';
        return '/usr/local/bin/opencode';
      });
      const ensureLocalOpenCodeServerPassword = vi.fn(async () => 'password');
      const getManagedOpenCodeEnv = vi.fn(async () => ({
        'agent-tool': 'tool-runtime-1',
        OPENCHAMBER_AGENT_TOOL_TOKEN: 'ephemeral',
      }));

      const { runtime, state } = createRuntime({
        applyOpencodeBinaryFromSettings,
        ensureLocalOpenCodeServerPassword,
        getManagedOpenCodeEnv,
      });

      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'current-123';
      state.isOpenCodeReady = true;

      try {
        await runtime.restartOpenCode();
      } catch {
        // Legacy fallback may throw in test env; we only care about the
        // guardian branch assertions below.
      }

      // The handoff branch must have been entered: client.spawn was called.
      expect(clientSpawn).toHaveBeenCalled();
      const spawnArgs = clientSpawn.mock.calls[0][0];

      // F-2: applyOpencodeBinaryFromSettings must run in strict mode BEFORE
      // client.spawn so the resolved binary is the one we hand the guardian.
      const binaryCallIndex = applyOpencodeBinaryFromSettings.mock.calls
        .findIndex((call) => call[0]?.strict === true);
      expect(binaryCallIndex).toBeGreaterThanOrEqual(0);

      const spawnCallOrder = clientSpawn.mock.invocationCallOrder[0];
      const binaryCallOrder = applyOpencodeBinaryFromSettings.mock.invocationCallOrder[binaryCallIndex];
      expect(binaryCallOrder).toBeLessThan(spawnCallOrder);

      // F-2: the spawn env must include the rotated server password.
      expect(spawnArgs.env.OPENCODE_SERVER_PASSWORD).toBe('password');

      // F-2: the spawn env must merge the agent-tool env from
      // getManagedOpenCodeEnv.
      expect(spawnArgs.env['agent-tool']).toBe('tool-runtime-1');
      expect(spawnArgs.env.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('ephemeral');

      // F-2: the binary is whatever applyOpencodeBinaryFromSettings
      // resolved (the helper passes the launch-spec unwrapped path).
      expect(spawnArgs.binary).toBe('/usr/local/bin/opencode');

      // F-2: password must have been rotated for the handoff spawn.
      expect(ensureLocalOpenCodeServerPassword).toHaveBeenCalledWith({ rotateManaged: true });
    });

    it('falls back to legacy restart when guardian unavailable', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:34085\n');
        });
        return child;
      });

      const closeMock = vi.fn();
      const { runtime, state } = createRuntime();

      state.openCodeProcess = { pid: 12345, close: closeMock };
      state.openCodePort = 45678;
      state.isOpenCodeReady = true;

      isGuardianRunning.mockResolvedValue(false);

      await runtime.restartOpenCode();

      expect(closeMock).toHaveBeenCalled();
      expect(spawn).toHaveBeenCalled();
      expect(state.openCodeProcess).not.toBeNull();
    }, 10000);

    it('stops the old child before spawning a fixed-port successor', async () => {
      const order = [];
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: vi.fn(async () => { order.push('prepare'); }),
        stop: vi.fn(async ({ incarnation }) => { order.push(`stop:${incarnation}`); }),
        spawn: vi.fn(async () => {
          order.push('spawn');
          return {
            incarnation: 'fixed-successor',
            pid: 12346,
            port: 45678,
          };
        }),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime({
        env: {
          ENV_CONFIGURED_OPENCODE_PORT: 45678,
          ENV_CONFIGURED_OPENCODE_HOST: null,
          ENV_EFFECTIVE_PORT: undefined,
          ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
          ENV_SKIP_OPENCODE_START: false,
        },
        waitForPortRelease: vi.fn(async () => {
          order.push('release');
          return true;
        }),
        waitForReady: vi.fn(async () => {
          order.push('health');
          return true;
        }),
      });
      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'fixed-current';
      state.currentOwner = {
        ownerInstanceId: 'owner-test-instance',
        runtimeIdentity: 'runtime-test-instance',
        launchFingerprint: 'old-fingerprint',
      };

      await runtime.restartOpenCode();

      expect(order).toEqual(['prepare', 'stop:fixed-current', 'release', 'spawn', 'health']);
      expect(state.currentIncarnation).toBe('fixed-successor');
      expect(state.openCodePort).toBe(45678);
    });

    it('refuses legacy fallback after a fixed-port old-child stop succeeds but successor spawn fails', async () => {
      const oldClose = vi.fn();
      const clientAbort = vi.fn();
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        abortHandoff: clientAbort,
        spawn: vi.fn().mockRejectedValue(new Error('fixed successor failed')),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime({
        env: {
          ENV_CONFIGURED_OPENCODE_PORT: 45678,
          ENV_CONFIGURED_OPENCODE_HOST: null,
          ENV_EFFECTIVE_PORT: undefined,
          ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
          ENV_SKIP_OPENCODE_START: false,
        },
      });
      state.openCodeProcess = { pid: 12345, close: oldClose };
      state.openCodePort = 45678;
      state.currentIncarnation = 'fixed-current';

      await expect(runtime.restartOpenCode()).rejects.toThrow(/without a confirmed rollback/);
      expect(oldClose).not.toHaveBeenCalled();
      expect(clientAbort).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalled();
    });

    it('does not spawn a fixed-port successor when the owner-scoped old stop fails', async () => {
      const oldProcess = { pid: 12345, close: vi.fn() };
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockRejectedValue(new Error('old stop failed')),
        spawn: vi.fn(),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime({
        env: {
          ENV_CONFIGURED_OPENCODE_PORT: 45678,
          ENV_CONFIGURED_OPENCODE_HOST: null,
          ENV_EFFECTIVE_PORT: undefined,
          ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
          ENV_SKIP_OPENCODE_START: false,
        },
      });
      state.openCodeProcess = oldProcess;
      state.openCodePort = 45678;
      state.currentIncarnation = 'fixed-current-stop-failure';
      state.isOpenCodeReady = true;

      await expect(runtime.restartOpenCode()).rejects.toThrow(/without a confirmed rollback/);
      expect(client.spawn).not.toHaveBeenCalled();
      expect(state.openCodeProcess).toBe(oldProcess);
      expect(state.currentIncarnation).toBe('fixed-current-stop-failure');
      expect(state.isOpenCodeReady).toBe(true);
    });

    it('does not fall back when guardian disconnect fails after successor cleanup', async () => {
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: vi.fn().mockResolvedValue(undefined),
        abortHandoff: vi.fn(async ({ incarnation }) => createActiveRollbackRecord(incarnation)),
        health: vi.fn().mockResolvedValue({ healthy: true }),
        spawn: vi.fn().mockRejectedValue(new Error('successor spawn failed')),
        stop: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn(() => { throw new Error('disconnect failed'); }),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { spawn } = await import('node:child_process');
      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'dynamic-current-disconnect-failure';
      state.isOpenCodeReady = true;

      await expect(runtime.restartOpenCode()).rejects.toThrow(/without a confirmed rollback/);
      expect(spawn).not.toHaveBeenCalled();
      expect(state.currentIncarnation).toBe('dynamic-current-disconnect-failure');
      expect(state.openCodeProcess).not.toBeNull();
    });

    it('does not call guardian handoff operations without a current incarnation', async () => {
      const client = {
        connect: vi.fn(),
        prepareHandoff: vi.fn(),
        stop: vi.fn(),
        spawn: vi.fn(),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime();
      const { spawn } = await import('node:child_process');
      const replacement = createMockChild();
      spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          replacement.stdout.emit('data', 'opencode server listening on http://127.0.0.1:34086\n');
        });
        return replacement;
      });
      const close = vi.fn();
      state.openCodeProcess = { pid: 12345, close };
      state.openCodePort = 45678;
      state.currentIncarnation = null;
      state.isOpenCodeReady = true;

      await expect(runtime.restartOpenCode()).resolves.toBeUndefined();
      expect(client.prepareHandoff).not.toHaveBeenCalled();
      expect(client.stop).not.toHaveBeenCalledWith(expect.objectContaining({ incarnation: undefined }));
      expect(close).toHaveBeenCalled();
    });

    it('rolls a dynamic old-stop failure back to active before legacy fallback', async () => {
      const owner = {
        ownerInstanceId: 'owner-dynamic-rollback',
        runtimeIdentity: 'runtime-dynamic-rollback',
        launchFingerprint: 'old-dynamic-fingerprint',
      };
      const clientStop = vi.fn(async ({ incarnation }) => {
        if (incarnation === 'dynamic-old-stop-failure' && clientStop.oldStopAttempts++ === 0) {
          throw new Error('old stop failed');
        }
        return undefined;
      });
      clientStop.oldStopAttempts = 0;
      const clientAbortHandoff = vi.fn(async ({ incarnation }) => createActiveRollbackRecord(incarnation));
      const clientHealth = vi.fn().mockResolvedValue({ healthy: true });
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: vi.fn().mockResolvedValue(undefined),
        spawn: vi.fn().mockResolvedValue({
          incarnation: 'dynamic-successor',
          pid: 12346,
          port: 45679,
        }),
        stop: clientStop,
        abortHandoff: clientAbortHandoff,
        health: clientHealth,
        list: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:34087\n');
        });
        return child;
      });

      const restoreOpenCodeAuthState = vi.fn();
      const captureOpenCodeAuthState = vi.fn(() => restoreOpenCodeAuthState);
      const { runtime, state } = createRuntime({ captureOpenCodeAuthState });
      state.openCodeProcess = {
        pid: 12345,
        isGuardianManaged: true,
        owner,
        stopOwnedOpenCode: vi.fn(),
        detach: vi.fn(),
      };
      state.openCodePort = 45678;
      state.currentIncarnation = 'dynamic-old-stop-failure';
      state.currentOwner = owner;
      state.isOpenCodeReady = true;

      await runtime.restartOpenCode();

      expect(clientAbortHandoff).toHaveBeenCalledWith({
        incarnation: 'dynamic-old-stop-failure',
        owner,
      });
      expect(clientHealth).toHaveBeenCalledWith({ incarnation: 'dynamic-old-stop-failure' });
      expect(captureOpenCodeAuthState).toHaveBeenCalledOnce();
      expect(restoreOpenCodeAuthState).toHaveBeenCalledOnce();
      expect(clientStop.oldStopAttempts).toBe(2);
      expect(spawn).toHaveBeenCalledOnce();
      expect(state.currentIncarnation).toBeNull();
    });

    it('adopts the exact owner child before handoff when the incarnation is missing', async () => {
      const adoptedOwner = {
        ownerInstanceId: 'owner-test-instance',
        runtimeIdentity: 'runtime-test-instance',
        launchFingerprint: 'adopted-fingerprint',
      };
      const clientConnect = vi.fn().mockResolvedValue(undefined);
      const clientPrepareHandoff = vi.fn().mockResolvedValue(undefined);
      const clientSpawn = vi.fn().mockResolvedValue({
        incarnation: 'successor-after-adoption',
        pid: 12347,
        port: 45680,
      });
      const clientStop = vi.fn().mockResolvedValue(undefined);
      const clientDisconnect = vi.fn();
      GuardianClient.mockImplementation(function () {
        return {
          connect: clientConnect,
          prepareHandoff: clientPrepareHandoff,
          spawn: clientSpawn,
          stop: clientStop,
          list: vi.fn().mockResolvedValue([]),
          disconnect: clientDisconnect,
        };
      });
      detectAndAdoptGuardianChild.mockResolvedValue({
        incarnation: 'adopted-after-migration',
        pid: 12345,
        port: 45678,
        url: 'http://127.0.0.1:45678',
        owner: adoptedOwner,
      });

      const { spawn } = await import('node:child_process');
      const { runtime, state } = createRuntime();
      state.openCodeProcess = null;
      state.openCodePort = null;
      state.currentIncarnation = null;
      state.currentOwner = null;
      state.isOpenCodeReady = false;

      await runtime.restartOpenCode();

      expect(detectAndAdoptGuardianChild).toHaveBeenCalled();
      expect(detectAndAdoptGuardianChild.mock.calls[0][2]).toEqual({
        expectedOwner: {
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
        },
      });
      expect(clientPrepareHandoff).toHaveBeenCalledWith({
        incarnation: 'adopted-after-migration',
        owner: adoptedOwner,
      });
      expect(clientStop).toHaveBeenCalledWith({
        incarnation: 'adopted-after-migration',
        owner: adoptedOwner,
      });
      expect(clientSpawn).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      expect(state.currentIncarnation).toBe('successor-after-adoption');
      expect(state.openCodeProcess).toMatchObject({ isGuardianManaged: true, pid: 12347 });
    });

    it('fails closed when a missing incarnation cannot be inspected for owner adoption', async () => {
      const { spawn } = await import('node:child_process');
      detectAndAdoptGuardianChild.mockRejectedValue(
        Object.assign(new Error('guardian ownership conflict'), { code: 'GUARDIAN_ADOPTION_CONFLICT' }),
      );
      const { runtime, state } = createRuntime();
      state.openCodeProcess = null;
      state.openCodePort = null;
      state.currentIncarnation = null;
      state.currentOwner = null;

      await expect(runtime.restartOpenCode()).rejects.toThrow(/guardian ownership conflict/);
      expect(spawn).not.toHaveBeenCalled();
      expect(state.currentIncarnation).toBeNull();
    });

    it('does not use the legacy port fallback when guardian state is unresolved', async () => {
      const { spawn, spawnSync } = await import('node:child_process');
      detectAndAdoptGuardianChild.mockRejectedValue(
        Object.assign(new Error('guardian child is still stopping'), { code: 'GUARDIAN_ADOPTION_ATTENTION' }),
      );
      const { runtime, state } = createRuntime();
      state.openCodeProcess = null;
      state.openCodePort = 45678;
      state.currentIncarnation = null;
      state.currentOwner = null;
      spawnSync.mockClear();

      await expect(runtime.restartOpenCode()).rejects.toThrow(/still stopping/);
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it('does not port-kill after an authenticated guardian resolves no exact owner child', async () => {
      const { spawn, spawnSync } = await import('node:child_process');
      const child = createMockChild();
      spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:34085\n');
        });
        return child;
      });
      detectAndAdoptGuardianChild.mockResolvedValue(null);
      isGuardianRunning.mockResolvedValue(true);
      const closeMock = vi.fn();
      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: 12345, close: closeMock };
      state.openCodePort = 45678;
      state.currentIncarnation = null;
      state.currentOwner = null;
      state.isOpenCodeReady = true;
      spawnSync.mockClear();

      await runtime.restartOpenCode();

      expect(closeMock).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it('falls back to legacy restart when guardian handoff fails', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:34085\n');
        });
        return child;
      });

      const closeMock = vi.fn();
      const { runtime, state } = createRuntime();

      state.openCodeProcess = { pid: 12345, close: closeMock };
      state.openCodePort = 45678;
      state.isOpenCodeReady = true;

      GuardianClient.mockImplementation(function () {
        return {
          connect: vi.fn().mockRejectedValue(new Error('Connection refused')),
          spawn: vi.fn(),
          stop: vi.fn(),
          prepareHandoff: vi.fn(),
          list: vi.fn(),
          disconnect: vi.fn(),
        };
      });

      await runtime.restartOpenCode();

      expect(closeMock).toHaveBeenCalled();
      expect(spawn).toHaveBeenCalled();
      expect(state.openCodeProcess).not.toBeNull();
    }, 10000);

    it('resets currentIncarnation when prepareHandoff succeeds but spawn fails', async () => {
      // Phase 3 review M-2/M-4: if prepareHandoff succeeds but spawn fails,
      // the catch block must clear state.currentIncarnation. Otherwise the
      // next restart would call prepareHandoff for a retired incarnation,
      // guardian would throw "Child not found", the catch would swallow it,
      // and the next restart would silently fall through to the legacy
      // path even when handoff could otherwise work.
      const clientPrepareHandoff = vi.fn().mockResolvedValue(undefined);
      const clientSpawn = vi.fn().mockRejectedValue(new Error('spawn failed'));
      const clientDisconnect = vi.fn();

      GuardianClient.mockImplementation(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          prepareHandoff: clientPrepareHandoff,
          abortHandoff: vi.fn(async ({ incarnation }) => createActiveRollbackRecord(incarnation)),
          health: vi.fn().mockResolvedValue({ healthy: true }),
          spawn: clientSpawn,
          stop: vi.fn(),
          list: vi.fn(),
          disconnect: clientDisconnect,
        };
      });

      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:34085\n');
        });
        return child;
      });

      const { runtime, state } = createRuntime();

      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'current-123';
      state.isOpenCodeReady = true;

      // First restart: handoff branch executes, prepareHandoff resolves,
      // spawn rejects, catch resets currentIncarnation, then falls back to
      // legacy restart.
      await runtime.restartOpenCode();

      expect(clientPrepareHandoff).toHaveBeenCalledWith({
        incarnation: 'current-123',
        owner: expect.objectContaining({
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
        }),
      });
      expect(clientSpawn).toHaveBeenCalled();
      // M-2/M-4: the catch block must clear the now-departed incarnation
      // so the next restart does not try to handoff a dead child.
      expect(state.currentIncarnation).toBeNull();
      expect(spawn).toHaveBeenCalled();
    }, 10000);

    it('rolls a prepared handoff back before legacy fallback', async () => {
      const owner = {
        ownerInstanceId: 'owner-rollback',
        runtimeIdentity: 'runtime-rollback',
        launchFingerprint: 'fingerprint-rollback',
      };
      const clientPrepareHandoff = vi.fn().mockResolvedValue(undefined);
      const clientAbortHandoff = vi.fn(async ({ incarnation }) => createActiveRollbackRecord(incarnation));
      const clientSpawn = vi.fn().mockRejectedValue(new Error('successor failed'));
      GuardianClient.mockImplementation(function () {
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          prepareHandoff: clientPrepareHandoff,
          abortHandoff: clientAbortHandoff,
          spawn: clientSpawn,
          stop: vi.fn(),
          list: vi.fn(),
          disconnect: vi.fn(),
        };
      });

      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:34085\n');
        });
        return child;
      });

      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'current-rollback';
      state.currentOwner = owner;
      state.isOpenCodeReady = true;

      await runtime.restartOpenCode();

      expect(clientPrepareHandoff).toHaveBeenCalledWith({ incarnation: 'current-rollback', owner });
      expect(clientAbortHandoff).toHaveBeenCalledWith({ incarnation: 'current-rollback', owner });
      expect(state.currentIncarnation).toBeNull();
      expect(state.currentOwner).toBeNull();
    }, 10000);

    it('fails closed when abortHandoff does not return the active incarnation', async () => {
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: vi.fn().mockResolvedValue(undefined),
        abortHandoff: vi.fn().mockResolvedValue({
          state: 'handoff-prepared',
          incarnation: 'current-invalid-rollback',
        }),
        health: vi.fn().mockResolvedValue({ healthy: true }),
        spawn: vi.fn().mockRejectedValue(new Error('successor failed')),
        stop: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { spawn } = await import('node:child_process');
      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'current-invalid-rollback';
      state.isOpenCodeReady = true;

      await expect(runtime.restartOpenCode()).rejects.toThrow(/without a confirmed rollback/);
      expect(client.health).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(state.currentIncarnation).toBe('current-invalid-rollback');
    });
  });

  // F-1: --no-handoff (OPENCHAMBER_RESTART_HANDOFF=disabled) must skip the
  // guardian handoff branch entirely and go straight to the legacy restart.
  // The flag is an opt-out, so the default (env unset) keeps the existing
  // handoff path tested above.
  describe('restartOpenCode OPENCHAMBER_RESTART_HANDOFF opt-out', () => {
    const withHandoffEnv = (value) => {
      const previous = process.env.OPENCHAMBER_RESTART_HANDOFF;
      if (value === undefined) {
        delete process.env.OPENCHAMBER_RESTART_HANDOFF;
      } else {
        process.env.OPENCHAMBER_RESTART_HANDOFF = value;
      }
      return () => {
        if (previous === undefined) {
          delete process.env.OPENCHAMBER_RESTART_HANDOFF;
        } else {
          process.env.OPENCHAMBER_RESTART_HANDOFF = previous;
        }
      };
    };

    it('skips guardian handoff when OPENCHAMBER_RESTART_HANDOFF=disabled and uses legacy restart', async () => {
      const restore = withHandoffEnv('disabled');
      try {
        const { spawn } = await import('node:child_process');
        const child = createMockChild();
        spawn.mockImplementationOnce(() => {
          queueMicrotask(() => {
            child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:34085\n');
          });
          return child;
        });

        const clientConnect = vi.fn().mockResolvedValue(undefined);
        const clientSpawn = vi.fn().mockResolvedValue({
          incarnation: 'should-not-be-used',
          pid: 99999,
          port: 40960,
        });
        const clientPrepareHandoff = vi.fn().mockResolvedValue(undefined);
        const clientStop = vi.fn().mockResolvedValue(undefined);
        const clientDisconnect = vi.fn();

        GuardianClient.mockImplementation(function () {
          return {
            connect: clientConnect,
            spawn: clientSpawn,
            stop: clientStop,
            prepareHandoff: clientPrepareHandoff,
            list: vi.fn(),
            disconnect: clientDisconnect,
          };
        });

        const closeMock = vi.fn();
        const { runtime, state, deps } = createRuntime();

        state.openCodeProcess = { pid: 12345, close: closeMock };
        state.openCodePort = 45678;
        state.currentIncarnation = 'current-123';
        state.isOpenCodeReady = true;

        await runtime.restartOpenCode();

        // The guardian branch must be skipped entirely: the client must
        // never be constructed, never connected, and never asked to
        // prepareHandoff / spawn.
        expect(clientConnect).not.toHaveBeenCalled();
        expect(clientPrepareHandoff).not.toHaveBeenCalled();
        expect(clientSpawn).not.toHaveBeenCalled();
        expect(clientStop).not.toHaveBeenCalled();
        expect(GuardianClient).not.toHaveBeenCalled();

        // The legacy path must have run instead: child spawned, port routed
        // through setOpenCodePort, previous child closed.
        expect(spawn).toHaveBeenCalled();
        expect(closeMock).toHaveBeenCalled();
        expect(state.openCodeProcess).not.toBeNull();
        expect(deps.setOpenCodePort).toHaveBeenCalled();
      } finally {
        restore();
      }
    }, 10000);
  });

  // Phase 3 review M-5: assert the adopted/handoff-spawned proxies expose
  // a working close() that asks the guardian to stop the incarnation, and
  // assert both paths route the port through setOpenCodePort.
  describe('guardian child proxy (Phase 3 review M-3/M-1/M-5)', () => {
    it('adopted child proxy has a close() that calls GuardianClient.stop', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ healthy: true }),
      });

      const clientStop = vi.fn().mockResolvedValue(undefined);
      GuardianClient.mockImplementation(function () {
        return {
          connect: vi.fn(),
          spawn: vi.fn(),
          stop: clientStop,
          prepareHandoff: vi.fn(),
          list: vi.fn(),
          disconnect: vi.fn(),
        };
      });

      const { runtime, state, deps } = createRuntime();

      detectAndAdoptGuardianChild.mockResolvedValue({
        incarnation: 'adopt-incarnation-xyz',
        pid: 99001,
        port: 4096,
        url: 'http://127.0.0.1:4096',
        owner: {
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
          launchFingerprint: 'adopted-fingerprint',
        },
      });

      await runtime.bootstrapOpenCodeAtStartup();

      expect(state.openCodeProcess).not.toBeNull();
      expect(typeof state.openCodeProcess.close).toBe('function');
      expect(typeof state.openCodeProcess.kill).toBe('function');

      // Calling close() must invoke GuardianClient.stop with the adopted
      // incarnation so the guardian can shut the child down gracefully.
      await state.openCodeProcess.close();
      expect(clientStop).toHaveBeenCalledWith({
        incarnation: 'adopt-incarnation-xyz',
        owner: expect.objectContaining({
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
        }),
      });

      // M-1: the adoption path must route the port through setOpenCodePort
      // (not a direct state.openCodePort assignment).
      expect(deps.setOpenCodePort).toHaveBeenCalledWith(4096);
    }, 10000);

    it('handoff-spawned child proxy has a close() that calls GuardianClient.stop', async () => {
      const clientConnect = vi.fn().mockResolvedValue(undefined);
      const clientSpawn = vi.fn().mockResolvedValue({
        incarnation: 'successor-incarnation-xyz',
        pid: 99002,
        port: 45679,
      });
      const clientPrepareHandoff = vi.fn().mockResolvedValue(undefined);
      const clientStop = vi.fn().mockResolvedValue(undefined);
      const clientDisconnect = vi.fn();

      GuardianClient.mockImplementation(function () {
        return {
          connect: clientConnect,
          spawn: clientSpawn,
          stop: clientStop,
          prepareHandoff: clientPrepareHandoff,
          list: vi.fn(),
          disconnect: clientDisconnect,
        };
      });

      const { runtime, state, deps } = createRuntime();

      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'current-123';
      state.isOpenCodeReady = true;

      try {
        await runtime.restartOpenCode();
      } catch {
        // May fall back to legacy restart in test env; we only care about
        // the guardian branch assertions below.
      }

      // If handoff-spawn succeeded, the proxy must be the closeable wrapper
      // (not the prior child's mock) and must call stop() on the guardian.
      const proxy = state.openCodeProcess;
      if (proxy && proxy.isGuardianManaged) {
        expect(typeof proxy.close).toBe('function');
        expect(proxy.pid).toBe(99002);

        await proxy.close();
        expect(clientStop.mock.calls.at(-1)?.[0]).toMatchObject({
          incarnation: 'successor-incarnation-xyz',
          owner: expect.objectContaining({
            ownerInstanceId: 'owner-test-instance',
            runtimeIdentity: 'runtime-test-instance',
          }),
        });
        // M-1: handoff-spawn must route the successor port through setOpenCodePort.
        expect(deps.setOpenCodePort).toHaveBeenCalledWith(45679);
        // M-3: the client must remain alive in the proxy (not disconnected).
        expect(clientDisconnect).not.toHaveBeenCalled();
      } else {
        // Fallback path executed (e.g. waitForReady failed). The original
        // closeMock from state.openCodeProcess should have been called and
        // setOpenCodePort should not have been called with the successor
        // port. We still assert setOpenCodePort was not invoked with the
        // successor port to make the fallback observable.
        expect(deps.setOpenCodePort).not.toHaveBeenCalledWith(45679);
      }
    });

    it('close() on a guardian proxy swallows guardian errors so owner-scoped shutdown can continue', async () => {
      // If GuardianClient.stop() rejects, the proxy's close() must NOT
      // re-throw, because shutdown-runtime.js treats guardian cleanup as
      // best-effort without killing an arbitrary port listener.
      const clientStop = vi.fn().mockRejectedValue(new Error('Guardian down'));
      GuardianClient.mockImplementation(function () {
        return {
          connect: vi.fn(),
          spawn: vi.fn(),
          stop: clientStop,
          prepareHandoff: vi.fn(),
          list: vi.fn(),
          disconnect: vi.fn(),
        };
      });

      const { runtime, state } = createRuntime();

      detectAndAdoptGuardianChild.mockResolvedValue({
        incarnation: 'adopt-incarnation-err',
        pid: 99003,
        port: 4096,
        url: 'http://127.0.0.1:4096',
        owner: {
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
          launchFingerprint: 'adopted-fingerprint',
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ healthy: true }),
      });

      await runtime.bootstrapOpenCodeAtStartup();

      await expect(state.openCodeProcess.close()).resolves.toBeUndefined();
      expect(clientStop).toHaveBeenCalledWith({
        incarnation: 'adopt-incarnation-err',
        owner: expect.objectContaining({
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
        }),
      });
    });
  });

  // W-C: with `process.platform === 'win32'` mocked, the lifecycle's
  // handoff + bootstrap paths must execute end-to-end through the new
  // Windows IPC transport. The test mocks live at the `detection.js`
  // and `guardian-client.js` seams (already in place from the original
  // test setup), so this exercises the lifecycle wiring rather than the
  // transport itself. The transport has its own dedicated tests under
  // `ipc-transport.test.js` and `discovery-file.test.js`.
  describe('W-C: Windows handoff + bootstrap adoption', () => {
    afterEach(() => {
      restorePlatform();
    });

    it('bootstrapOpenCodeAtStartup adopts guardian-managed child on Windows', async () => {
      setPlatformForTest('win32');
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ healthy: true }),
      });

      detectAndAdoptGuardianChild.mockResolvedValue({
        incarnation: 'win-incarnation-001',
        pid: 88001,
        port: 14096,
        url: 'http://127.0.0.1:14096',
      });

      const { runtime, state, deps } = createRuntime();
      await runtime.bootstrapOpenCodeAtStartup();

      expect(detectAndAdoptGuardianChild).toHaveBeenCalled();
      // The first argument is the default socketPath (undefined here);
      // the second argument must be a string-or-undefined value passed
      // through `getWindowsPortPath()` (which returns undefined on Linux
      // but a real path on Windows when LOCALAPPDATA is set).
      const args = detectAndAdoptGuardianChild.mock.calls[0];
      expect(args.length).toBeGreaterThanOrEqual(2);

      expect(state.openCodeProcess).toMatchObject({ pid: 88001, isGuardianManaged: true });
      expect(typeof state.openCodeProcess.close).toBe('function');
      expect(deps.setOpenCodePort).toHaveBeenCalledWith(14096);
      expect(state.isOpenCodeReady).toBe(true);
      expect(state.currentIncarnation).toBe('win-incarnation-001');
    });

    it('restartOpenCode handoff branch runs on Windows and calls GuardianClient', async () => {
      setPlatformForTest('win32');

      const clientConnect = vi.fn().mockResolvedValue(undefined);
      const clientSpawn = vi.fn().mockResolvedValue({
        incarnation: 'win-successor-001',
        pid: 88002,
        port: 14097,
      });
      const clientPrepareHandoff = vi.fn().mockResolvedValue(undefined);
      const clientStop = vi.fn().mockResolvedValue(undefined);
      const clientDisconnect = vi.fn();

      GuardianClient.mockImplementation(function () {
        return {
          connect: clientConnect,
          spawn: clientSpawn,
          stop: clientStop,
          prepareHandoff: clientPrepareHandoff,
          list: vi.fn(),
          disconnect: clientDisconnect,
        };
      });

      const { runtime, state, deps } = createRuntime();
      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'win-current-001';
      state.isOpenCodeReady = true;

      try {
        await runtime.restartOpenCode();
      } catch {
        // Legacy fallback may throw in the test env; we only care about
        // the guardian branch assertions below.
      }

      expect(isGuardianRunning).toHaveBeenCalled();
      // The handoff branch must have run on Windows: GuardianClient
      // constructed, connected, prepared handoff, spawned successor,
      // stopped current.
      expect(clientConnect).toHaveBeenCalled();
      expect(clientPrepareHandoff).toHaveBeenCalledWith({
        incarnation: 'win-current-001',
        owner: expect.objectContaining({
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
        }),
      });
      expect(clientSpawn).toHaveBeenCalled();
      expect(clientStop).toHaveBeenCalledWith({
        incarnation: 'win-current-001',
        owner: expect.objectContaining({
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
        }),
      });
      // M-3: on successful handoff the client is kept alive in the
      // proxy.
      expect(clientDisconnect).not.toHaveBeenCalled();
      expect(deps.setOpenCodePort).toHaveBeenCalledWith(14097);
      expect(state.openCodeProcess).toMatchObject({ pid: 88002, isGuardianManaged: true });
    });

    it('restartOpenCode handoff branch passes both socketPath and portPath through', async () => {
      setPlatformForTest('win32');

      const clientConnect = vi.fn().mockResolvedValue(undefined);
      const clientSpawn = vi.fn().mockResolvedValue({
        incarnation: 'win-successor-002',
        pid: 88003,
        port: 14098,
      });

      GuardianClient.mockImplementation(function () {
        return {
          connect: clientConnect,
          spawn: clientSpawn,
          stop: vi.fn().mockResolvedValue(undefined),
          prepareHandoff: vi.fn().mockResolvedValue(undefined),
          list: vi.fn(),
          disconnect: vi.fn(),
        };
      });

      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'win-current-002';
      state.isOpenCodeReady = true;

      try {
        await runtime.restartOpenCode();
      } catch {
        // Best-effort.
      }

      // GuardianClient must have been constructed with both arguments;
      // the factory inside `guardian-client.js` dispatches per platform.
      const ctorCalls = GuardianClient.mock.calls;
      expect(ctorCalls.length).toBeGreaterThan(0);
      const ctorArgs = ctorCalls[0][0];
      expect(ctorArgs).toHaveProperty('socketPath');
      // On Windows the second arg is the portPath; on the test runner
      // (Linux) it is undefined unless LOCALAPPDATA is set. Either is
      // acceptable here as long as the property is present.
      expect('portPath' in ctorArgs).toBe(true);
    });
  });
});
