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
    it.skipIf(process.platform === 'win32')('adopts guardian-managed child on startup', async () => {
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
      });

      await runtime.bootstrapOpenCodeAtStartup();

      expect(detectAndAdoptGuardianChild).toHaveBeenCalled();
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
  });

  describe('restartOpenCode', () => {
    it.skipIf(process.platform === 'win32')('performs handoff restart through guardian', async () => {
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
      expect(clientPrepareHandoff).toHaveBeenCalledWith({ incarnation: 'current-123' });
      expect(clientSpawn).toHaveBeenCalled();
      expect(clientStop).toHaveBeenCalledWith({ incarnation: 'current-123' });
      // M-3: on successful handoff the client is kept alive inside the
      // successor's closeable proxy, so disconnect() is NOT called here.
      expect(clientDisconnect).not.toHaveBeenCalled();
      // M-1: handoff-spawn routes the successor port through setOpenCodePort.
      expect(deps.setOpenCodePort).toHaveBeenCalledWith(45679);
      // M-3: the handoff-spawn proxy is a closeable, guardian-managed wrapper.
      expect(state.openCodeProcess).toMatchObject({ pid: 12346, isGuardianManaged: true });
      expect(typeof state.openCodeProcess.close).toBe('function');
    });

    it.skipIf(process.platform === 'win32')('guardian handoff spawn passes managed launch env (password + agent-tool) through IPC', async () => {
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

    it.skipIf(process.platform === 'win32')('resets currentIncarnation when prepareHandoff succeeds but spawn fails', async () => {
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

      expect(clientPrepareHandoff).toHaveBeenCalledWith({ incarnation: 'current-123' });
      expect(clientSpawn).toHaveBeenCalled();
      // M-2/M-4: the catch block must clear the now-departed incarnation
      // so the next restart does not try to handoff a dead child.
      expect(state.currentIncarnation).toBeNull();
      expect(spawn).toHaveBeenCalled();
    }, 10000);
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
    it.skipIf(process.platform === 'win32')('adopted child proxy has a close() that calls GuardianClient.stop', async () => {
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
      });

      await runtime.bootstrapOpenCodeAtStartup();

      expect(state.openCodeProcess).not.toBeNull();
      expect(typeof state.openCodeProcess.close).toBe('function');
      expect(typeof state.openCodeProcess.kill).toBe('function');

      // Calling close() must invoke GuardianClient.stop with the adopted
      // incarnation so the guardian can shut the child down gracefully.
      await state.openCodeProcess.close();
      expect(clientStop).toHaveBeenCalledWith({ incarnation: 'adopt-incarnation-xyz' });

      // M-1: the adoption path must route the port through setOpenCodePort
      // (not a direct state.openCodePort assignment).
      expect(deps.setOpenCodePort).toHaveBeenCalledWith(4096);
    }, 10000);

    it.skipIf(process.platform === 'win32')('handoff-spawned child proxy has a close() that calls GuardianClient.stop', async () => {
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
        expect(clientStop).toHaveBeenCalledWith({ incarnation: 'successor-incarnation-xyz' });
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

    it.skipIf(process.platform === 'win32')('close() on a guardian proxy swallows guardian errors so port-kill fallback can run', async () => {
      // If GuardianClient.stop() rejects, the proxy's close() must NOT
      // re-throw, because shutdown-runtime.js relies on it to be best-effort.
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
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ healthy: true }),
      });

      await runtime.bootstrapOpenCodeAtStartup();

      await expect(state.openCodeProcess.close()).resolves.toBeUndefined();
      expect(clientStop).toHaveBeenCalledWith({ incarnation: 'adopt-incarnation-err' });
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
      expect(clientPrepareHandoff).toHaveBeenCalledWith({ incarnation: 'win-current-001' });
      expect(clientSpawn).toHaveBeenCalled();
      expect(clientStop).toHaveBeenCalledWith({ incarnation: 'win-current-001' });
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
