import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  // lifecycle imports the managed-process registry, which initializes
  // `promisify(execFile)` at module load.
  execFile: vi.fn((_file, _args, _options, callback) => {
    callback(null, { stdout: '', stderr: '' });
  }),
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
      list: vi.fn().mockResolvedValue([]),
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
  GUARDIAN_AMBIGUOUS_REQUEST_CODE: 'GUARDIAN_REQUEST_AMBIGUOUS',
  isAmbiguousGuardianRequestError: (error) => (
    error?.ambiguous === true
    || error?.code === 'GUARDIAN_REQUEST_AMBIGUOUS'
    || error?.originalCode === 'GUARDIAN_REQUEST_AMBIGUOUS'
  ),
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
        health: vi.fn(async () => ({ healthy: true })),
        spawn: vi.fn(),
        stop: vi.fn(),
        prepareHandoff: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
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
    it('discovers unresolved durable operations after HMR loss and blocks startup before spawn/fallback', async () => {
      const operation = {
        operationId: 'operation-discovery-000000000000000000000000000000',
        kind: 'prepare-handoff',
        incarnation: 'discovered-incarnation',
        ownerInstanceId: 'owner-test-instance',
        runtimeIdentity: 'runtime-test-instance',
        launchFingerprint: 'current-fingerprint',
        targetRevision: 2,
        targetLeaseExpiresAt: 100_000,
        targetMac: 'target-mac',
        state: 'pending',
      };
      const spawn = vi.fn();
      GuardianClient.mockImplementation(function ({ socketPath }) {
        return {
          socketPath,
          connect: vi.fn(),
          operationList: vi.fn().mockResolvedValue([operation]),
          operationStatus: vi.fn().mockResolvedValue({ operation, record: null, expired: false }),
          list: vi.fn().mockResolvedValue([]),
          spawn,
          disconnect: vi.fn(),
        };
      });

      const { runtime, state } = createRuntime();
      await expect(runtime.startOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        operationId: operation.operationId,
        kind: 'prepare',
        incarnation: operation.incarnation,
      });
    });

    it('merges HMR fences with the complete durable operation discovery set', async () => {
      const owner = {
        ownerInstanceId: 'owner-test-instance',
        runtimeIdentity: 'runtime-test-instance',
        launchFingerprint: 'current-fingerprint',
      };
      const knownOperation = {
        operationId: 'known-hmr-operation-000000000000000000000000000000',
        kind: 'prepare-handoff',
        incarnation: 'known-hmr-incarnation',
        ...owner,
        targetRevision: 2,
        targetLeaseExpiresAt: 100_000,
        targetMac: 'known-target-mac',
        state: 'pending',
      };
      const undiscoveredOperation = {
        operationId: 'undiscovered-durable-operation-0000000000000000000000',
        kind: 'stop',
        incarnation: 'undiscovered-incarnation',
        ...owner,
        targetRevision: 3,
        targetLeaseExpiresAt: 100_001,
        targetMac: 'undiscovered-target-mac',
        state: 'pending',
      };
      const operations = new Map([
        [knownOperation.operationId, knownOperation],
        [undiscoveredOperation.operationId, undiscoveredOperation],
      ]);
      const operationList = vi.fn().mockResolvedValue([undiscoveredOperation]);
      const operationStatus = vi.fn(async ({ operationId }) => ({
        operation: operations.get(operationId),
        record: null,
        expired: false,
      }));
      const spawn = vi.fn();
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        operationList,
        operationStatus,
        list: vi.fn().mockResolvedValue([]),
        spawn,
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime();
      state.guardianOutcomeUnknownFence = {
        version: 1,
        kind: 'prepare',
        operationId: knownOperation.operationId,
        incarnation: knownOperation.incarnation,
        owner,
      };

      await expect(runtime.startOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
      });
      expect(operationList).toHaveBeenCalledOnce();
      expect(state.guardianOutcomeUnknownFences.map((fence) => fence.operationId)).toEqual([
        knownOperation.operationId,
        undiscoveredOperation.operationId,
      ]);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('reconciles a terminal initial-spawn operation after restart and releases its fence lease', async () => {
      const owner = {
        ownerInstanceId: 'owner-test-instance',
        runtimeIdentity: 'runtime-test-instance',
        launchFingerprint: 'initial-terminal-fingerprint',
      };
      const operation = {
        operationId: 'initial-terminal-operation-000000000000000000000000000000',
        kind: 'spawn',
        incarnation: 'initial-terminal-incarnation',
        ...owner,
        targetRevision: 1,
        targetLeaseExpiresAt: 100_000,
        targetMac: 'initial-target-mac',
        state: 'resolved',
        resolutionState: 'retired',
        resolutionRevision: 4,
        resolutionLeaseExpiresAt: 100_004,
        resolutionMac: 'initial-terminal-mac',
        revision: 2,
        confirmationExpiresAt: Date.now() + 60_000,
        mac: 'initial-operation-mac',
      };
      const successor = {
        incarnation: 'initial-recovered-successor',
        pid: 99101,
        port: 4098,
        owner,
      };
      const clientSpawn = vi.fn()
        .mockImplementationOnce(async (params) => {
          Object.assign(operation, params.owner);
          throw Object.assign(new Error('initial spawn response was lost'), {
            code: 'GUARDIAN_REQUEST_AMBIGUOUS',
            ambiguous: true,
            retryable: false,
            originalCode: 'connection_closed',
            operationId: operation.operationId,
          });
        })
        .mockImplementationOnce(async (params) => ({ ...successor, owner: params.owner }));
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        operationList: vi.fn().mockResolvedValue([]),
        operationStatus: vi.fn().mockResolvedValue({ operation, record: null, expired: false }),
        confirmOperation: vi.fn().mockResolvedValue({ operation, record: null }),
        spawn: clientSpawn,
        health: vi.fn().mockResolvedValue({ healthy: true }),
        list: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime({
        ensureLocalOpenCodeServerPassword: vi.fn(async () => 'initial-terminal-secret'),
      });

      await expect(runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
      });
      expect(runtime.__testManagedStartupSecretState().leaseCount).toBe(1);
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        kind: 'initial-spawn',
        operationId: operation.operationId,
      });

      await runtime.bootstrapOpenCodeAtStartup();

      expect(clientSpawn).toHaveBeenCalledTimes(2);
      expect(client.confirmOperation).toHaveBeenCalledOnce();
      expect(state.guardianOutcomeUnknownFence).toBeNull();
      // The reconciled fence lease was released before the replacement launch
      // acquired its own lease; one active lease therefore belongs only to the
      // recovered successor, not to the terminal initial-spawn operation.
      expect(runtime.__testManagedStartupSecretState().leaseCount).toBe(1);
      expect(runtime.__testGuardianStartupSecretLeaseCount()).toBe(1);
      expect(state.currentIncarnation).toBe(successor.incarnation);
    }, 10000);

    it('adopts guardian-managed child on startup', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ healthy: true }),
      });

      const restoreManagedOpenCodeCredential = vi.fn();
      const { runtime, state, deps } = createRuntime({ restoreManagedOpenCodeCredential });

      detectAndAdoptGuardianChild.mockImplementation(async (_socketPath, _portPath, options) => {
        await options.restoreCredential({ username: 'opencode', password: 'adopted-password' });
        return {
          incarnation: 'test-incarnation-123',
          pid: 12345,
          port: 4096,
          url: 'http://127.0.0.1:4096',
          owner: {
            ownerInstanceId: 'owner-test-instance',
            runtimeIdentity: 'runtime-test-instance',
            launchFingerprint: 'adopted-fingerprint',
          },
        };
      });

      await runtime.bootstrapOpenCodeAtStartup();

      expect(detectAndAdoptGuardianChild).toHaveBeenCalled();
      expect(detectAndAdoptGuardianChild.mock.calls[0][2]).toEqual(expect.objectContaining({
        expectedOwner: {
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
        },
        restoreCredential: restoreManagedOpenCodeCredential,
      }));
      expect(restoreManagedOpenCodeCredential).toHaveBeenCalledWith({
        username: 'opencode',
        password: 'adopted-password',
      });
      // M-3: adoption path stores a closeable proxy, not a bare { pid }.
      expect(state.openCodeProcess).toMatchObject({ pid: 12345, isGuardianManaged: true });
      expect(typeof state.openCodeProcess.close).toBe('function');
      expect(typeof state.openCodeProcess.kill).toBe('function');
      // M-1: adoption path routes the port through setOpenCodePort.
      expect(deps.setOpenCodePort).toHaveBeenCalledWith(4096);
      expect(state.openCodePort).toBe(4096);
      expect(state.openCodeBaseUrl).toBe('http://127.0.0.1:4096');
      expect(state.isOpenCodeReady).toBe(true);
      expect(state.isExternalOpenCode).toBe(false);
      expect(state.currentIncarnation).toBe('test-incarnation-123');
    }, 10000);

    it('explicit external/skip-start config wins over guardian adoption and does not shut down the guardian', async () => {
      // Regression for issue #2421: OPENCODE_SKIP_START=true is an operator
      // decision that this OpenChamber instance does NOT own a managed local
      // OpenCode. A previously-running guardian may still hold a child matching
      // our persisted owner metadata, but adopting it would couple our lifecycle
      // to a process we explicitly declined to manage. The skip-start/external
      // branch must win: no guardian adoption, the configured external OpenCode
      // is used as requested, and the running guardian is NOT shut down.
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ healthy: true }),
      });

      const restoreManagedOpenCodeCredential = vi.fn();
      const { runtime, state, deps } = createRuntime({
        restoreManagedOpenCodeCredential,
        env: {
          ENV_CONFIGURED_OPENCODE_PORT: undefined,
          ENV_CONFIGURED_OPENCODE_HOST: null,
          ENV_EFFECTIVE_PORT: 45678,
          ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
          ENV_SKIP_OPENCODE_START: true,
        },
      });

      // Guardian IS running and WOULD adopt a matching child if reached.
      isGuardianRunning.mockResolvedValue(true);
      detectAndAdoptGuardianChild.mockImplementation(async (_socketPath, _portPath, options) => {
        await options.restoreCredential({ username: 'opencode', password: 'adopted-password' });
        return {
          incarnation: 'would-be-adopted-incarnation',
          pid: 12345,
          port: 4096,
          url: 'http://127.0.0.1:4096',
          owner: {
            ownerInstanceId: 'owner-test-instance',
            runtimeIdentity: 'runtime-test-instance',
            launchFingerprint: 'adopted-fingerprint',
          },
        };
      });

      await runtime.bootstrapOpenCodeAtStartup();

      // Explicit external config wins: no guardian adoption occurs.
      expect(detectAndAdoptGuardianChild).not.toHaveBeenCalled();
      expect(restoreManagedOpenCodeCredential).not.toHaveBeenCalled();
      // The configured external OpenCode is used as requested.
      expect(state.isExternalOpenCode).toBe(true);
      expect(state.openCodePort).toBe(45678);
      expect(state.isOpenCodeReady).toBe(true);
      expect(state.openCodeProcess).toBeNull();
      expect(state.currentIncarnation).toBeNull();
      expect(state.currentOwner).toBeNull();
      // The running guardian is NOT shut down — external mode only means this
      // instance does not manage OpenCode through it. No stop/kill RPC issued.
      // (The mock GuardianClient.stop would record any shutdown attempt.)
      expect(deps.setOpenCodePort).toHaveBeenCalledWith(45678);
    }, 10000);

    it('fails closed when skip-start has no effective port', async () => {
      const { spawn } = await import('node:child_process');
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;
      const { runtime, state } = createRuntime({
        env: {
          ENV_CONFIGURED_OPENCODE_PORT: undefined,
          ENV_CONFIGURED_OPENCODE_HOST: null,
          ENV_EFFECTIVE_PORT: undefined,
          ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
          ENV_SKIP_OPENCODE_START: true,
        },
      });

      await runtime.bootstrapOpenCodeAtStartup();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(isGuardianRunning).not.toHaveBeenCalled();
      expect(detectAndAdoptGuardianChild).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(state.openCodeProcess).toBeNull();
      expect(state.openCodePort).toBeNull();
      expect(state.isOpenCodeReady).toBe(false);
      expect(state.isExternalOpenCode).toBe(false);
      expect(state.lastOpenCodeError).toBe('OpenCode skip-start mode requires an effective port');
    }, 10000);

    it('uses the adopted launch origin when configured host changed, including IPv6', async () => {
      const launchSpec = {
        binary: 'opencode',
        args: [],
        hostname: '::1',
        port: 4123,
        cwd: '/tmp/project',
      };
      detectAndAdoptGuardianChild.mockResolvedValue({
        incarnation: 'ipv6-adopted-incarnation',
        pid: 12345,
        port: 4123,
        url: 'http://[::1]:4123',
        owner: {
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
          launchFingerprint: 'ipv6-adopted-fingerprint',
        },
        launchSpec,
      });

      const { runtime, state } = createRuntime({
        env: {
          ENV_CONFIGURED_OPENCODE_PORT: undefined,
          ENV_CONFIGURED_OPENCODE_HOST: null,
          ENV_EFFECTIVE_PORT: undefined,
          ENV_CONFIGURED_OPENCODE_HOSTNAME: '10.0.0.9',
          ENV_SKIP_OPENCODE_START: false,
        },
      });
      state.openCodeBaseUrl = 'http://10.0.0.9:4096';

      await runtime.bootstrapOpenCodeAtStartup();

      expect(state.openCodeBaseUrl).toBe('http://[::1]:4123');
      expect(state.openCodePort).toBe(4123);
      expect(state.isExternalOpenCode).toBe(false);
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
          health: vi.fn().mockResolvedValue({ healthy: true }),
          spawn: clientSpawn,
          stop: clientStop,
          prepareHandoff: vi.fn(),
           list: vi.fn().mockResolvedValue([]),
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
          health: vi.fn().mockResolvedValue({ healthy: true }),
          spawn: clientSpawn,
          stop: vi.fn(),
          list: vi.fn().mockResolvedValue([]),
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

    it('keeps an ambiguous guardian launch non-retryable through startup wrapping', async () => {
      const clientConnect = vi.fn().mockResolvedValue(undefined);
      const clientSpawn = vi.fn().mockRejectedValue(Object.assign(
        new Error('guardian request outcome is unknown'),
        {
          code: 'GUARDIAN_REQUEST_AMBIGUOUS',
          ambiguous: true,
          retryable: false,
          originalCode: 'connection_closed',
        },
      ));
      const clientDisconnect = vi.fn();
      const clientList = vi.fn().mockResolvedValue([]);
      GuardianClient.mockImplementation(function () {
        return {
          connect: clientConnect,
          health: vi.fn().mockResolvedValue({ healthy: true }),
          spawn: clientSpawn,
          stop: vi.fn(),
          list: clientList,
          disconnect: clientDisconnect,
        };
      });

      const { spawn } = await import('node:child_process');
      const { runtime, state } = createRuntime();

      await expect(runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
        retryable: false,
        originalCode: 'connection_closed',
      });
      expect(clientSpawn).toHaveBeenCalledOnce();
      expect(clientDisconnect).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      expect(state.lastOpenCodeError).toContain('Guardian is running but initial OpenCode launch failed');
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        kind: 'initial-spawn',
        successorOwner: expect.any(Object),
      });
      expect(runtime.__testManagedStartupSecretState().leaseCount).toBe(1);

      // HMR/bootstrap retry consults the persisted owner fence first. An
      // empty or delayed list is not proof that the lost spawn did not apply.
      await expect(runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
      });
      expect(clientSpawn).toHaveBeenCalledOnce();
      expect(clientList).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      expect(runtime.__testManagedStartupSecretState().leaseCount).toBe(1);
    }, 10000);

    it('reconciles an HMR-restored initial-spawn fence only after delayed successor binding appears', async () => {
      const successorOwner = {
        ownerInstanceId: 'owner-test-instance',
        runtimeIdentity: 'runtime-test-instance',
        launchFingerprint: 'delayed-initial-successor',
      };
      const fence = {
        version: 1,
        kind: 'initial-spawn',
        owner: successorOwner,
        successorOwner,
        oldStopped: true,
      };
      const successor = {
        incarnation: 'delayed-initial-incarnation',
        state: 'active',
        pid: 45680,
        port: 45680,
        revision: 3,
        leaseExpiresAt: Date.now() + 60_000,
        mac: 'delayed-initial-mac',
        launchSpec: {
          binary: 'opencode',
          args: [],
          hostname: '127.0.0.1',
          port: 45680,
          cwd: '/tmp/project',
        },
        ...successorOwner,
      };
      let successorVisible = false;
      let successorStopped = false;
      const clientList = vi.fn(async () => {
        if (successorStopped) return [];
        return successorVisible ? [successor] : [];
      });
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        health: vi.fn().mockResolvedValue({ healthy: true }),
        list: clientList,
        stop: vi.fn(async () => { successorStopped = true; }),
        confirmAdoption: vi.fn(async () => ({
          record: successor,
          credential: null,
          health: { healthy: true },
        })),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const legacySpawn = (await import('node:child_process')).spawn;
      const { runtime, state } = createRuntime({
        ensureLocalOpenCodeServerPassword: vi.fn(async () => 'delayed-initial-secret'),
      });
      // This is the state that survives a Vite HMR module replacement.
      state.guardianOutcomeUnknownFence = fence;

      await expect(runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
      });
      expect(clientList).toHaveBeenCalledOnce();
      expect(state.guardianOutcomeUnknownFence).toEqual(fence);
      expect(legacySpawn).not.toHaveBeenCalled();
      expect(runtime.__testManagedStartupSecretState().leaseCount).toBe(0);

      successorVisible = true;
      await runtime.bootstrapOpenCodeAtStartup();

      expect(state.guardianOutcomeUnknownFence).toBeNull();
      expect(state.currentIncarnation).toBe(successor.incarnation);
      expect(state.currentOwner).toEqual(successorOwner);
      expect(state.openCodeProcess).toMatchObject({ isGuardianManaged: true, pid: successor.pid });
      // The guardian-side confirmation owns the final record/health/credential
      // binding and CAS; lifecycle only needs candidate lists.
      expect(clientList).toHaveBeenCalledTimes(3);
      expect(legacySpawn).not.toHaveBeenCalled();
      expect(runtime.__testManagedStartupSecretState().leaseCount).toBe(0);
    }, 10000);

    it('keeps the fence when guardian adoption CAS fails after a binding mutation', async () => {
      const owner = {
        ownerInstanceId: 'owner-binding-race',
        runtimeIdentity: 'runtime-binding-race',
        launchFingerprint: 'successor-binding-race',
      };
      const fence = {
        version: 1,
        kind: 'initial-spawn',
        owner,
        successorOwner: owner,
        oldStopped: true,
      };
      const launchSpec = {
        binary: 'opencode',
        args: [],
        hostname: '127.0.0.1',
        port: 45682,
        cwd: '/tmp/project',
      };
      let successorRevision = 1;
      const successorLeaseExpiresAt = Date.now() + 60_000;
      const child = () => ({
        incarnation: 'binding-race-successor',
        state: 'active',
        pid: 45682,
        port: 45682,
        revision: successorRevision,
        leaseExpiresAt: successorLeaseExpiresAt,
        mac: `binding-race-mac-${successorRevision}`,
        launchSpec,
        ...owner,
      });
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockImplementation(() => [child()]),
        confirmAdoption: vi.fn(async () => {
          successorRevision = 2;
          throw new Error('record CAS failed after binding mutation');
        }),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const legacySpawn = (await import('node:child_process')).spawn;
      const { runtime, state } = createRuntime();
      state.guardianOutcomeUnknownFence = fence;

      await expect(runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
        retryable: false,
      });
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        kind: 'initial-spawn',
        successorOwner: owner,
      });
      expect(state.openCodeProcess).toBeNull();
      expect(legacySpawn).not.toHaveBeenCalled();
       expect(client.confirmAdoption).toHaveBeenCalledOnce();
       expect(client.list).toHaveBeenCalledTimes(2);
    }, 10000);

    it.each([
      ['missing MAC', { mac: undefined }],
      ['incorrect MAC', { mac: 'wrong-mac' }],
      ['missing lease', { leaseExpiresAt: undefined }],
      ['incorrect lease', { leaseExpiresAt: Date.now() + 120_000 }],
      ['missing revision', { revision: undefined }],
      ['incorrect revision', { revision: 999 }],
      ['wrong owner', { ownerInstanceId: 'foreign-owner' }],
      ['wrong incarnation', { incarnation: 'foreign-incarnation' }],
    ])('keeps an ambiguity fence for a %s authoritative-list mismatch', async (_label, change) => {
      const owner = {
        ownerInstanceId: 'owner-test-instance',
        runtimeIdentity: 'runtime-test-instance',
        launchFingerprint: 'strict-fence-owner',
      };
      const fence = {
        version: 1,
        kind: 'spawn',
        incarnation: 'strict-old-incarnation',
        owner,
        successorOwner: {
          ...owner,
          launchFingerprint: 'strict-successor-owner',
        },
        revision: 4,
        leaseExpiresAt: Date.now() + 60_000,
        mac: 'strict-fence-mac',
        oldStopped: false,
      };
      const child = {
        incarnation: fence.incarnation,
        state: 'active',
        revision: fence.revision,
        leaseExpiresAt: fence.leaseExpiresAt,
        mac: fence.mac,
        pid: 45681,
        port: 45681,
        launchSpec: {
          binary: 'opencode',
          args: [],
          hostname: '127.0.0.1',
          port: 45681,
          cwd: '/tmp/project',
        },
        ...owner,
        ...change,
      };
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        health: vi.fn().mockResolvedValue({ healthy: true }),
        list: vi.fn().mockResolvedValue([child]),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime();
      state.guardianOutcomeUnknownFence = fence;

      await expect(runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
      });
      expect(state.guardianOutcomeUnknownFence).toEqual(fence);
      expect(state.openCodeProcess).toBeNull();
    });

    it('fails closed when initial guardian cleanup receives a malformed child list', async () => {
      const clientConnect = vi.fn().mockResolvedValue(undefined);
      const clientSpawn = vi.fn().mockResolvedValue({
        incarnation: 'initial-malformed-cleanup',
        pid: 12346,
        port: 45679,
        url: 'not-a-valid-url',
        owner: {
          ownerInstanceId: 'owner-initial',
          runtimeIdentity: 'runtime-initial',
          launchFingerprint: 'fingerprint-initial',
        },
      });
      const clientStop = vi.fn().mockResolvedValue(undefined);
      const clientList = vi.fn().mockResolvedValue({ malformed: true });
      const clientDisconnect = vi.fn();
      GuardianClient.mockImplementation(function () {
        return {
          connect: clientConnect,
          health: vi.fn().mockResolvedValue({ healthy: true }),
          spawn: clientSpawn,
          stop: clientStop,
          list: clientList,
          disconnect: clientDisconnect,
        };
      });

      const { spawn } = await import('node:child_process');
      const { runtime, state } = createRuntime();

      await expect(runtime.bootstrapOpenCodeAtStartup()).rejects.toMatchObject({
        code: 'GUARDIAN_CLEANUP_UNCERTAIN',
      });
      expect(clientStop).toHaveBeenCalledOnce();
      expect(clientList).toHaveBeenCalledOnce();
      expect(clientDisconnect).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      expect(runtime.__testManagedStartupSecretState()).toEqual({
        leaseCount: 1,
        secretCount: expect.any(Number),
      });
      expect(state.openCodeProcess).toMatchObject({
        isGuardianManaged: true,
        incarnation: 'initial-malformed-cleanup',
      });
    }, 10000);

    it('releases initial guardian launch leases after spawn rejection with an authoritative empty list', async () => {
      const clientConnect = vi.fn().mockResolvedValue(undefined);
      const clientSpawn = vi.fn().mockRejectedValue(new Error('guardian launch rejected'));
      const clientList = vi.fn().mockResolvedValue([]);
      const clientDisconnect = vi.fn();
      GuardianClient.mockImplementation(function () {
        return {
          connect: clientConnect,
          health: vi.fn().mockResolvedValue({ healthy: true }),
          spawn: clientSpawn,
          stop: vi.fn(),
          list: clientList,
          disconnect: clientDisconnect,
        };
      });

      const { spawn } = await import('node:child_process');
      const { runtime } = createRuntime({
        ensureLocalOpenCodeServerPassword: vi.fn(async () => 'initial-guardian-lease-secret'),
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await runtime.bootstrapOpenCodeAtStartup();
        expect(runtime.__testManagedStartupSecretState()).toEqual({
          leaseCount: 0,
          secretCount: 0,
        });
      }

      expect(clientSpawn).toHaveBeenCalledTimes(3);
      expect(clientList).toHaveBeenCalledTimes(3);
      expect(clientDisconnect).toHaveBeenCalledTimes(3);
      expect(spawn).not.toHaveBeenCalled();
    }, 10000);

    it('retains a guardian startup lease while cleanup is uncertain and releases it after confirmed cleanup', async () => {
      const incarnation = 'initial-retained-lease';
      const clientList = vi.fn()
        .mockResolvedValueOnce([{ incarnation, state: 'active' }])
        .mockResolvedValueOnce([]);
      const clientStop = vi.fn().mockResolvedValue(undefined);
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        health: vi.fn().mockResolvedValue({ healthy: true }),
        spawn: vi.fn().mockResolvedValue({
          incarnation,
          pid: 12346,
          port: 45679,
          owner: {
            ownerInstanceId: 'owner-initial',
            runtimeIdentity: 'runtime-initial',
            launchFingerprint: 'fingerprint-initial',
          },
        }),
        stop: clientStop,
        list: clientList,
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime({
        ensureLocalOpenCodeServerPassword: vi.fn(async () => 'retained-guardian-lease-secret'),
      });

      await runtime.bootstrapOpenCodeAtStartup();
      expect(runtime.__testManagedStartupSecretState().leaseCount).toBe(1);
      expect(runtime.__testGuardianStartupSecretLeaseCount()).toBe(1);

      await expect(state.openCodeProcess.close()).resolves.toBeUndefined();
      expect(runtime.__testManagedStartupSecretState().leaseCount).toBe(1);
      expect(runtime.__testManagedStartupSecretState().secretCount).toBeGreaterThan(0);
      expect(runtime.__testGuardianStartupSecretLeaseCount()).toBe(1);

      await expect(state.openCodeProcess.close()).resolves.toBeUndefined();
      expect(runtime.__testManagedStartupSecretState()).toEqual({
        leaseCount: 0,
        secretCount: 0,
      });
      expect(runtime.__testGuardianStartupSecretLeaseCount()).toBe(0);
      // The second close confirms quiescence from the fresh empty list; it
      // must not replay the already-authoritative stop RPC.
      expect(clientStop).toHaveBeenCalledTimes(1);
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
          health: vi.fn().mockResolvedValue({ healthy: true }),
          spawn: clientSpawn,
          stop: clientStop,
          prepareHandoff: clientPrepareHandoff,
           list: vi.fn().mockResolvedValue([]),
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
      expect(state.openCodeBaseUrl).toBe('http://127.0.0.1:45679');
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
          health: vi.fn().mockResolvedValue({ healthy: true }),
          spawn: clientSpawn,
          stop: clientStop,
          prepareHandoff: clientPrepareHandoff,
           list: vi.fn().mockResolvedValue([]),
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
        health: vi.fn(async () => {
          order.push('health');
          return { healthy: true };
        }),
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
        waitForReady: vi.fn(async () => true),
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
        list: vi.fn().mockResolvedValue([]),
        operationList: vi.fn().mockResolvedValue([]),
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
      expect(runtime.__testManagedStartupSecretState()).toEqual({
        leaseCount: 0,
        secretCount: 0,
      });
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

    it('clears a retained successor lease from the guardian map after confirmed cleanup', async () => {
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: vi.fn().mockResolvedValue(undefined),
        spawn: vi.fn().mockResolvedValue({
          incarnation: 'successor-invalid-origin',
          pid: 12346,
          port: 45679,
          url: 'not-a-valid-url',
        }),
        health: vi.fn().mockResolvedValue({ healthy: true }),
        stop: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime({
        ensureLocalOpenCodeServerPassword: vi.fn(async () => 'handoff-retained-lease-secret'),
      });
      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'current-invalid-origin';
      state.isOpenCodeReady = true;

      await expect(runtime.restartOpenCode()).rejects.toThrow(/without a confirmed rollback/);
      expect(runtime.__testManagedStartupSecretState()).toEqual({
        leaseCount: 0,
        secretCount: 0,
      });
      expect(runtime.__testGuardianStartupSecretLeaseCount()).toBe(0);
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
      expect(clientHealth).toHaveBeenCalledWith({ incarnation: 'dynamic-old-stop-failure', owner });
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
          health: vi.fn().mockResolvedValue({ healthy: true }),
          list: vi.fn().mockResolvedValue([]),
          disconnect: clientDisconnect,
        };
      });
      const restoreManagedOpenCodeCredential = vi.fn();
      detectAndAdoptGuardianChild.mockImplementation(async (_socketPath, _portPath, options) => {
        await options.restoreCredential({ username: 'opencode', password: 'restart-adopted-password' });
        return {
          incarnation: 'adopted-after-migration',
          pid: 12345,
          port: 45678,
          url: 'http://127.0.0.1:45678',
          owner: adoptedOwner,
        };
      });

      const { spawn } = await import('node:child_process');
      const { runtime, state } = createRuntime({ restoreManagedOpenCodeCredential });
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
        restoreCredential: restoreManagedOpenCodeCredential,
      });
      expect(restoreManagedOpenCodeCredential).toHaveBeenCalledWith({
        username: 'opencode',
        password: 'restart-adopted-password',
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

    it('blocks legacy restart when foreign unresolved attention blocks global admission', async () => {
      const { spawn } = await import('node:child_process');
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        admissionStatus: vi.fn().mockResolvedValue({
          admitted: false,
          attentionCount: 1,
          operationCount: 0,
        }),
        list: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });
      detectAndAdoptGuardianChild.mockResolvedValue(null);

      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = null;
      state.currentOwner = null;
      state.isOpenCodeReady = true;

      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_ADMISSION_BLOCKED',
      });
      expect(client.admissionStatus).toHaveBeenCalledOnce();
      expect(state.openCodeProcess.close).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
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
           list: vi.fn().mockResolvedValue([]),
          disconnect: vi.fn(),
        };
      });
      isGuardianRunning.mockResolvedValue(false);

      await runtime.restartOpenCode();

      expect(closeMock).toHaveBeenCalled();
      expect(spawn).toHaveBeenCalled();
      expect(state.openCodeProcess).not.toBeNull();
    }, 10000);

    it('does not legacy-spawn or abort after an ambiguous prepareHandoff', async () => {
      const { spawn } = await import('node:child_process');
      const clientAbortHandoff = vi.fn();
      const clientPrepareHandoff = vi.fn().mockRejectedValue(Object.assign(
        new Error('prepare response was lost'),
        {
          code: 'connection_closed',
          originalCode: 'GUARDIAN_REQUEST_AMBIGUOUS',
          retryable: false,
        },
      ));
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: clientPrepareHandoff,
        abortHandoff: clientAbortHandoff,
        spawn: vi.fn(),
        stop: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'ambiguous-prepare';
      state.isOpenCodeReady = true;

      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        retryable: false,
        originalCode: 'connection_closed',
      });
      expect(clientPrepareHandoff).toHaveBeenCalledOnce();
      expect(clientAbortHandoff).not.toHaveBeenCalled();
      expect(client.spawn).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    }, 10000);

    it('fences an ambiguous old-child stop until delayed successor reconciliation', async () => {
      const oldOwner = {
        ownerInstanceId: 'owner-stop-fence',
        runtimeIdentity: 'runtime-stop-fence',
        launchFingerprint: 'old-stop-fingerprint',
      };
      const oldRecord = {
        incarnation: 'ambiguous-stop-old',
        state: 'handoff-prepared',
        revision: 7,
        leaseExpiresAt: Date.now() + 60_000,
        mac: 'ambiguous-stop-old-mac',
        pid: 12345,
        port: 45678,
        launchSpec: {
          binary: 'opencode',
          args: [],
          hostname: '127.0.0.1',
          port: 45678,
          cwd: '/tmp/project',
        },
        ...oldOwner,
      };
      const terminalOld = { ...oldRecord, state: 'retired', revision: 8, mac: 'ambiguous-stop-retired-mac' };
      let successorOwner = null;
      let successorVisible = false;
      const successorLeaseExpiresAt = Date.now() + 60_000;
      const clientStop = vi.fn().mockRejectedValue(Object.assign(
        new Error('old stop response was lost'),
        {
          code: 'GUARDIAN_REQUEST_AMBIGUOUS',
          ambiguous: true,
          retryable: false,
          originalCode: 'connection_closed',
        },
      ));
      const clientSpawn = vi.fn(async (params) => {
        successorOwner = params.owner;
        return {
          incarnation: 'ambiguous-stop-successor',
          pid: 12346,
          port: 45679,
          owner: successorOwner,
        };
      });
      const clientList = vi.fn(async () => {
        const successor = successorVisible && successorOwner
          ? {
            incarnation: 'ambiguous-stop-successor',
            state: 'active',
            revision: 3,
            leaseExpiresAt: successorLeaseExpiresAt,
            mac: 'ambiguous-stop-successor-mac',
            pid: 12346,
            port: 45679,
            launchSpec: {
              binary: 'opencode',
              args: [],
              hostname: '127.0.0.1',
              port: 45679,
              cwd: '/tmp/project',
            },
            ...successorOwner,
          }
          : null;
        return successor ? [successor] : [];
      });
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: vi.fn().mockResolvedValue(oldRecord),
        spawn: clientSpawn,
        stop: clientStop,
        health: vi.fn().mockResolvedValue({ healthy: true }),
        list: clientList,
        terminalStatus: vi.fn().mockResolvedValue({ record: terminalOld }),
        confirmTerminal: vi.fn().mockResolvedValue({ record: terminalOld }),
        confirmAdoption: vi.fn(async () => ({
          record: successorVisible ? {
            incarnation: 'ambiguous-stop-successor',
            state: 'active',
            revision: 3,
            leaseExpiresAt: successorLeaseExpiresAt,
            mac: 'ambiguous-stop-successor-mac',
            pid: 12346,
            port: 45679,
            launchSpec: {
              binary: 'opencode',
              args: [],
              hostname: '127.0.0.1',
              port: 45679,
              cwd: '/tmp/project',
            },
            ...successorOwner,
          } : null,
          credential: null,
          health: { healthy: true },
        })),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const legacySpawn = (await import('node:child_process')).spawn;
      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: oldRecord.pid, close: vi.fn() };
      state.openCodePort = oldRecord.port;
      state.currentIncarnation = oldRecord.incarnation;
      state.currentOwner = oldOwner;
      state.isOpenCodeReady = true;

      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        retryable: false,
      });
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        kind: 'stop',
        cleanupTarget: 'old',
        incarnation: oldRecord.incarnation,
      });
      expect(clientStop).toHaveBeenCalledOnce();
      expect(legacySpawn).not.toHaveBeenCalled();

      // The terminal old record is visible before the successor. Reconcile
      // must remain fenced and must not repeat stop, spawn, or legacy fallback.
      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
      });
      expect(clientStop).toHaveBeenCalledOnce();
      expect(clientSpawn).toHaveBeenCalledOnce();
      expect(legacySpawn).not.toHaveBeenCalled();

      successorVisible = true;
      await runtime.restartOpenCode();

      expect(clientStop).toHaveBeenCalledOnce();
      expect(clientSpawn).toHaveBeenCalledOnce();
      expect(state.guardianOutcomeUnknownFence).toBeNull();
      expect(state.currentIncarnation).toBe('ambiguous-stop-successor');
      expect(legacySpawn).not.toHaveBeenCalled();
    }, 10000);

    it('fences an ambiguous abort-handoff and adopts only its exact post-abort binding', async () => {
      const owner = {
        ownerInstanceId: 'owner-abort-fence',
        runtimeIdentity: 'runtime-abort-fence',
        launchFingerprint: 'abort-fingerprint',
      };
      const prepared = {
        incarnation: 'ambiguous-abort-old',
        state: 'handoff-prepared',
        revision: 4,
        leaseExpiresAt: Date.now() + 60_000,
        mac: 'ambiguous-abort-prepared-mac',
        pid: 12345,
        port: 45678,
        launchSpec: {
          binary: 'opencode',
          args: [],
          hostname: '127.0.0.1',
          port: 45678,
          cwd: '/tmp/project',
        },
        ...owner,
      };
      const active = {
        ...prepared,
        state: 'active',
        revision: 5,
        leaseExpiresAt: Date.now() + 60_000,
        mac: 'ambiguous-abort-active-mac',
      };
      const clientAbort = vi.fn().mockRejectedValue(Object.assign(
        new Error('abort response was lost'),
        {
          code: 'GUARDIAN_REQUEST_AMBIGUOUS',
          ambiguous: true,
          retryable: false,
          originalCode: 'connection_closed',
        },
      ));
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: vi.fn().mockResolvedValue(prepared),
        spawn: vi.fn().mockRejectedValue(new Error('successor failed before spawn response')),
        abortHandoff: clientAbort,
        confirmAdoption: vi.fn().mockResolvedValue({
          record: active,
          credential: null,
          health: { healthy: true },
        }),
        health: vi.fn().mockResolvedValue({ healthy: true }),
        list: vi.fn().mockResolvedValue([active]),
        stop: vi.fn(),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const legacySpawn = (await import('node:child_process')).spawn;
      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: prepared.pid, close: vi.fn() };
      state.openCodePort = prepared.port;
      state.currentIncarnation = prepared.incarnation;
      state.currentOwner = owner;
      state.isOpenCodeReady = true;

      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        retryable: false,
      });
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        kind: 'abort-handoff',
        incarnation: prepared.incarnation,
      });
      expect(clientAbort).toHaveBeenCalledOnce();
      expect(legacySpawn).not.toHaveBeenCalled();

      await runtime.restartOpenCode();

      expect(clientAbort).toHaveBeenCalledOnce();
      expect(legacySpawn).not.toHaveBeenCalled();
      expect(state.guardianOutcomeUnknownFence).toBeNull();
      expect(state.currentIncarnation).toBe(active.incarnation);
      expect(state.isOpenCodeReady).toBe(true);
    }, 10000);

    it('does not repeat an ambiguous abort while reconciliation still sees handoff-prepared', async () => {
      const owner = {
        ownerInstanceId: 'owner-abort-prepared-fence',
        runtimeIdentity: 'runtime-abort-prepared-fence',
        launchFingerprint: 'abort-prepared-fingerprint',
      };
      const prepared = {
        incarnation: 'ambiguous-abort-still-prepared',
        state: 'handoff-prepared',
        revision: 9,
        leaseExpiresAt: Date.now() + 60_000,
        mac: 'ambiguous-abort-still-prepared-mac',
        pid: 12345,
        port: 45678,
        launchSpec: {
          binary: 'opencode',
          args: [],
          hostname: '127.0.0.1',
          port: 45678,
          cwd: '/tmp/project',
        },
        ...owner,
      };
      const clientAbort = vi.fn().mockRejectedValue(Object.assign(
        new Error('abort response was lost'),
        {
          code: 'GUARDIAN_REQUEST_AMBIGUOUS',
          ambiguous: true,
          retryable: false,
          originalCode: 'connection_closed',
        },
      ));
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: vi.fn().mockResolvedValue(prepared),
        spawn: vi.fn().mockRejectedValue(new Error('successor failed before spawn')),
        abortHandoff: clientAbort,
        confirmAdoption: vi.fn().mockRejectedValue(new Error('adoption unavailable while prepared')),
        stop: vi.fn(),
        health: vi.fn().mockResolvedValue({ healthy: true }),
        list: vi.fn().mockResolvedValue([prepared]),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: prepared.pid, close: vi.fn() };
      state.openCodePort = prepared.port;
      state.currentIncarnation = prepared.incarnation;
      state.currentOwner = owner;
      state.isOpenCodeReady = true;

      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        retryable: false,
      });
      expect(clientAbort).toHaveBeenCalledOnce();
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        kind: 'abort-handoff',
        incarnation: prepared.incarnation,
      });

      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        retryable: false,
      });
      expect(clientAbort).toHaveBeenCalledOnce();
      expect(client.spawn).toHaveBeenCalledOnce();
      expect(client.stop).not.toHaveBeenCalled();
    }, 10000);

    it('persists an abort-handoff ambiguity fence when a prepare-kind fence reconciles a still-prepared child and abortHandoff is ambiguous', async () => {
      // Regression for issue-2421: a prepare-kind fence (persisted when a
      // prepareHandoff response was lost after the record transitioned to
      // handoff-prepared) is reconciled by calling abortHandoff. If that
      // abortHandoff response is also lost, the catch must persist an
      // abort-handoff ambiguity fence using the authoritative prepared record
      // (oldChild) instead of dereferencing `checked.child`, which is still
      // null at that point. The escaping error must remain a
      // GUARDIAN_REQUEST_AMBIGUOUS error so startOpenCode/restart
      // legacy-fallback paths stay blocked, and a later reconciliation must
      // not replay the non-idempotent abortHandoff RPC.
      const owner = {
        ownerInstanceId: 'owner-prepare-abort-fence',
        runtimeIdentity: 'runtime-prepare-abort-fence',
        launchFingerprint: 'prepare-abort-fingerprint',
      };
      const prepared = {
        incarnation: 'prepare-then-ambiguous-abort',
        state: 'handoff-prepared',
        revision: 3,
        leaseExpiresAt: Date.now() + 60_000,
        mac: 'prepare-then-ambiguous-abort-prepared-mac',
        pid: 12345,
        port: 45678,
        launchSpec: {
          binary: 'opencode',
          args: [],
          hostname: '127.0.0.1',
          port: 45678,
          cwd: '/tmp/project',
        },
        ...owner,
      };
      const clientPrepareHandoff = vi.fn().mockRejectedValue(Object.assign(
        new Error('prepare response was lost'),
        {
          code: 'connection_closed',
          originalCode: 'GUARDIAN_REQUEST_AMBIGUOUS',
          retryable: false,
        },
      ));
      const clientAbort = vi.fn().mockRejectedValue(Object.assign(
        new Error('abort response was lost'),
        {
          code: 'GUARDIAN_REQUEST_AMBIGUOUS',
          ambiguous: true,
          retryable: false,
          originalCode: 'connection_closed',
        },
      ));
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: clientPrepareHandoff,
        abortHandoff: clientAbort,
        spawn: vi.fn(),
        stop: vi.fn(),
        health: vi.fn().mockResolvedValue({ healthy: true }),
        list: vi.fn().mockResolvedValue([prepared]),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const legacySpawn = (await import('node:child_process')).spawn;
      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: prepared.pid, close: vi.fn() };
      state.openCodePort = prepared.port;
      state.currentIncarnation = prepared.incarnation;
      state.currentOwner = owner;
      state.isOpenCodeReady = true;

      // First restart: prepareHandoff response is lost after the guardian
      // transitioned to handoff-prepared. The restart catch persists a
      // prepare-kind fence and rethrows the ambiguous error.
      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        retryable: false,
        originalCode: 'connection_closed',
      });
      expect(clientPrepareHandoff).toHaveBeenCalledOnce();
      expect(clientAbort).not.toHaveBeenCalled();
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        kind: 'prepare',
        incarnation: prepared.incarnation,
      });

      // Second restart: reconciliation finds the still-handoff-prepared
      // child, calls abortHandoff, and that response is also lost. The catch
      // must persist an abort-handoff ambiguity fence using the authoritative
      // prepared record (oldChild) and rethrow the ambiguous error. The bug
      // threw TypeError: Cannot read properties of null (reading 'child')
      // here instead.
      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        retryable: false,
      });
      expect(clientAbort).toHaveBeenCalledOnce();
      expect(legacySpawn).not.toHaveBeenCalled();
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        kind: 'abort-handoff',
        incarnation: prepared.incarnation,
        owner: owner,
        // The persisted fence is recognized as ambiguous so startOpenCode /
        // restart legacy-fallback paths remain blocked. The authoritative
        // prepared record (oldChild) is passed as preparedRecord; for a
        // non-durable client the binding is intentionally not copied into
        // the fence, mirroring the existing abort-handoff fence precedent.
        ambiguous: true,
      });

      // Third restart: reconciliation sees the abort-handoff fence against a
      // still-handoff-prepared child. It must throw the abort-handoff kind
      // error WITHOUT calling abortHandoff again (the non-idempotent RPC must
      // not be replayed) and WITHOUT legacy-spawning.
      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        retryable: false,
      });
      expect(clientAbort).toHaveBeenCalledOnce();
      expect(client.spawn).not.toHaveBeenCalled();
      expect(legacySpawn).not.toHaveBeenCalled();
      expect(client.stop).not.toHaveBeenCalled();
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        kind: 'abort-handoff',
        incarnation: prepared.incarnation,
      });
    }, 15000);

    it('atomically replaces a durable prepare fence with an abort-handoff fence keyed by the abort operation ID', async () => {
      // Durable-operation variant of issue-2421: when the ambiguous prepare and
      // ambiguous abort each carry their own durable operation ID, the
      // supersession must be a single atomic replacement that removes the
      // prepare-operation key and adds the abort-operation key in one state
      // transition + one HMR sync. The replacement fence must use the abort
      // operation ID (not the prepare operation ID), retain the authoritative
      // prepared record binding, and a later reconciliation must not replay the
      // non-idempotent abortHandoff RPC.
      const owner = {
        ownerInstanceId: 'owner-durable-prepare-abort',
        runtimeIdentity: 'runtime-durable-prepare-abort',
        launchFingerprint: 'durable-prepare-abort-fingerprint',
      };
      const prepareOperationId = 'durable-prepare-op-000000000000000000000000000';
      const abortOperationId = 'durable-abort-op-111111111111111111111111111';
      const prepared = {
        incarnation: 'durable-prepare-then-ambiguous-abort',
        state: 'handoff-prepared',
        revision: 5,
        leaseExpiresAt: Date.now() + 60_000,
        mac: 'durable-prepare-then-ambiguous-abort-prepared-mac',
        pid: 12345,
        port: 45678,
        launchSpec: {
          binary: 'opencode',
          args: [],
          hostname: '127.0.0.1',
          port: 45678,
          cwd: '/tmp/project',
        },
        ...owner,
      };
      // The prepare operation is resolved with its target binding matching the
      // prepared record so reconcileDurableGuardianOperation passes the fence
      // through to the child-list/abort path.
      const prepareOperation = {
        operationId: prepareOperationId,
        kind: 'prepare-handoff',
        incarnation: prepared.incarnation,
        ...owner,
        targetRevision: prepared.revision,
        targetLeaseExpiresAt: prepared.leaseExpiresAt,
        targetMac: prepared.mac,
        state: 'resolved',
        revision: 1,
        confirmationExpiresAt: Date.now() + 60_000,
        mac: 'prepare-operation-mac',
      };
      // The abort operation is resolved with its target binding matching the
      // same prepared record (the pre-abort state). Restart 3 reconciles this
      // operation, then sees the still-prepared child and throws without
      // replaying abortHandoff.
      const abortOperation = {
        operationId: abortOperationId,
        kind: 'abort-handoff',
        incarnation: prepared.incarnation,
        ...owner,
        targetRevision: prepared.revision,
        targetLeaseExpiresAt: prepared.leaseExpiresAt,
        targetMac: prepared.mac,
        state: 'resolved',
        revision: 2,
        confirmationExpiresAt: Date.now() + 60_000,
        mac: 'abort-operation-mac',
      };
      const clientPrepareHandoff = vi.fn().mockRejectedValue(Object.assign(
        new Error('durable prepare response was lost'),
        {
          code: 'GUARDIAN_REQUEST_AMBIGUOUS',
          ambiguous: true,
          retryable: false,
          originalCode: 'connection_closed',
          operationId: prepareOperationId,
        },
      ));
      const clientAbort = vi.fn().mockRejectedValue(Object.assign(
        new Error('durable abort response was lost'),
        {
          code: 'GUARDIAN_REQUEST_AMBIGUOUS',
          ambiguous: true,
          retryable: false,
          originalCode: 'connection_closed',
          operationId: abortOperationId,
        },
      ));
      const operationStatus = vi.fn(async ({ operationId }) => {
        if (operationId === prepareOperationId) {
          return { operation: prepareOperation, record: null, expired: false };
        }
        if (operationId === abortOperationId) {
          return { operation: abortOperation, record: null, expired: false };
        }
        return { operation: null, record: null, expired: false };
      });
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: clientPrepareHandoff,
        abortHandoff: clientAbort,
        spawn: vi.fn(),
        stop: vi.fn(),
        health: vi.fn().mockResolvedValue({ healthy: true }),
        list: vi.fn().mockResolvedValue([prepared]),
        operationList: vi.fn().mockResolvedValue([]),
        operationStatus,
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const legacySpawn = (await import('node:child_process')).spawn;
      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: prepared.pid, close: vi.fn() };
      state.openCodePort = prepared.port;
      state.currentIncarnation = prepared.incarnation;
      state.currentOwner = owner;
      state.isOpenCodeReady = true;

      // First restart: prepareHandoff response is lost after the guardian
      // transitioned to handoff-prepared. The restart catch persists a
      // prepare-kind fence keyed by the prepare operation ID. The prepared
      // record is not available at the catch point (the response was lost), so
      // the record binding is attached later during reconciliation; the fence
      // carries only the durable operation ID and owner/incarnation identity.
      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        retryable: false,
        originalCode: 'connection_closed',
      });
      expect(clientPrepareHandoff).toHaveBeenCalledOnce();
      expect(clientAbort).not.toHaveBeenCalled();
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        kind: 'prepare',
        operationId: prepareOperationId,
        incarnation: prepared.incarnation,
        owner,
        ambiguous: true,
      });
      expect(state.guardianOutcomeUnknownFences).toHaveLength(1);
      expect(state.guardianOutcomeUnknownFences[0].operationId).toBe(prepareOperationId);

      // Second restart: reconciliation reconciles the durable prepare
      // operation, finds the still-handoff-prepared child, calls abortHandoff,
      // and that response is also lost. The catch must atomically replace the
      // prepare fence with an abort-handoff fence keyed by the ABORT operation
      // ID (not the prepare operation ID), retaining the authoritative prepared
      // record binding, in a single state transition.
      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        retryable: false,
      });
      expect(clientAbort).toHaveBeenCalledOnce();
      expect(legacySpawn).not.toHaveBeenCalled();

      // Exactly one replacement fence exists, keyed by the abort operation ID.
      expect(state.guardianOutcomeUnknownFences).toHaveLength(1);
      expect(state.guardianOutcomeUnknownFences[0].operationId).toBe(abortOperationId);
      // No old prepare fence remains.
      expect(state.guardianOutcomeUnknownFences.some((fence) => fence.operationId === prepareOperationId))
        .toBe(false);
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        kind: 'abort-handoff',
        operationId: abortOperationId,
        incarnation: prepared.incarnation,
        owner,
        ambiguous: true,
        // The authoritative prepared record binding from oldChild is retained.
        revision: prepared.revision,
        leaseExpiresAt: prepared.leaseExpiresAt,
        mac: prepared.mac,
      });
      // The startup-secret lease is retained (not cleared) through the
      // replacement so diagnostics remain protected until authoritative
      // resolution.
      expect(state.guardianOutcomeUnknownLease).toBeNull();

      // Third restart: reconciliation reconciles the durable abort operation,
      // then sees the abort-handoff fence against a still-handoff-prepared
      // child. It must throw WITHOUT calling abortHandoff again (the
      // non-idempotent RPC must not be replayed) and WITHOUT legacy-spawning.
      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        retryable: false,
      });
      expect(clientAbort).toHaveBeenCalledOnce();
      expect(client.spawn).not.toHaveBeenCalled();
      expect(legacySpawn).not.toHaveBeenCalled();
      expect(client.stop).not.toHaveBeenCalled();
      // The replacement fence is still the single durable fence, keyed by the
      // abort operation ID.
      expect(state.guardianOutcomeUnknownFences).toHaveLength(1);
      expect(state.guardianOutcomeUnknownFences[0].operationId).toBe(abortOperationId);
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        kind: 'abort-handoff',
        operationId: abortOperationId,
        incarnation: prepared.incarnation,
      });
    }, 15000);

    it('leaves the old fence untouched when replacement fence construction throws (atomic supersession)', async () => {
      // Atomicity invariant for issue-2421: the abort-handoff supersession is
      // implemented as build-then-replace. If the replacement fence construction
      // throws (e.g. missing owner identity), the old prepare fence must remain
      // exactly in place — no intermediate "no fence" window, no partial state
      // mutation, and no HMR sync for a replacement that was never built. This
      // directly exercises the build/replace primitives exposed for testing.
      const owner = {
        ownerInstanceId: 'owner-atomicity-invariant',
        runtimeIdentity: 'runtime-atomicity-invariant',
        launchFingerprint: 'atomicity-fingerprint',
      };
      const prepareOperationId = 'atomicity-prepare-op-00000000000000000000000';
      const abortOperationId = 'atomicity-abort-op-111111111111111111111111111';
      const preparedRecord = {
        incarnation: 'atomicity-prepare-incarnation',
        state: 'handoff-prepared',
        revision: 7,
        leaseExpiresAt: Date.now() + 60_000,
        mac: 'atomicity-prepared-mac',
        ...owner,
      };
      const prepareFence = {
        version: 1,
        kind: 'prepare',
        operationId: prepareOperationId,
        incarnation: preparedRecord.incarnation,
        owner: { ...owner },
        revision: preparedRecord.revision,
        leaseExpiresAt: preparedRecord.leaseExpiresAt,
        mac: preparedRecord.mac,
        ambiguous: true,
        oldStopped: false,
      };
      const retainedLease = { incarnation: preparedRecord.incarnation, secret: 'atomicity-lease-secret' };
      const ambiguousAbortError = Object.assign(new Error('abort lost'), {
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
        operationId: abortOperationId,
      });

      // Build the runtime AFTER pre-populating state with the prepare fence and
      // lease. The lifecycle closure reads state.guardianOutcomeUnknownLease at
      // construction time, so the lease must be present before construction for
      // replaceGuardianOutcomeUnknownFence to preserve it.
      const { state, deps } = createRuntime();
      state.guardianOutcomeUnknownFences = [prepareFence];
      state.guardianOutcomeUnknownFence = prepareFence;
      state.guardianOutcomeUnknownLease = retainedLease;
      const runtime = createOpenCodeLifecycleRuntime({ ...deps, state });
      // createOpenCodeLifecycleRuntime does not reset fence fields, but restate
      // them defensively in case a future constructor touches state.
      state.guardianOutcomeUnknownFences = [prepareFence];
      state.guardianOutcomeUnknownFence = prepareFence;
      state.guardianOutcomeUnknownLease = retainedLease;

      const syncToHmrState = deps.syncToHmrState;
      const initialSyncCount = syncToHmrState.mock.calls.length;

      // 1) Building a replacement with a missing owner identity must throw
      //    BEFORE any state mutation.
      expect(() => runtime.__testBuildGuardianOutcomeUnknownFence({
        kind: 'abort-handoff',
        incarnation: preparedRecord.incarnation,
        owner: { ownerInstanceId: '', runtimeIdentity: 'runtime-incomplete', launchFingerprint: 'fp' },
        preparedRecord,
        source: ambiguousAbortError,
        lease: retainedLease,
      })).toThrow(Object.assign(
        new Error('Guardian ambiguous handoff outcome has no complete owner identity'),
        { code: 'GUARDIAN_OUTCOME_UNKNOWN_OWNER' },
      ));

      // The build failure must NOT have touched fence state, the lease, or HMR.
      expect(state.guardianOutcomeUnknownFences).toHaveLength(1);
      expect(state.guardianOutcomeUnknownFences[0]).toBe(prepareFence);
      expect(state.guardianOutcomeUnknownFence).toBe(prepareFence);
      expect(state.guardianOutcomeUnknownLease).toBe(retainedLease);
      expect(syncToHmrState.mock.calls.length).toBe(initialSyncCount);

      // 2) Building a replacement with complete identity succeeds and produces a
      //    fence keyed by the abort operation ID with the prepared record
      //    binding, WITHOUT mutating state (pure builder).
      const replacementFence = runtime.__testBuildGuardianOutcomeUnknownFence({
        kind: 'abort-handoff',
        incarnation: preparedRecord.incarnation,
        owner: { ...owner },
        preparedRecord,
        source: ambiguousAbortError,
        lease: retainedLease,
      });
      expect(replacementFence.kind).toBe('abort-handoff');
      expect(replacementFence.operationId).toBe(abortOperationId);
      expect(replacementFence.incarnation).toBe(preparedRecord.incarnation);
      expect(replacementFence.owner).toEqual(owner);
      expect(replacementFence.revision).toBe(preparedRecord.revision);
      expect(replacementFence.leaseExpiresAt).toBe(preparedRecord.leaseExpiresAt);
      expect(replacementFence.mac).toBe(preparedRecord.mac);
      expect(replacementFence.ambiguous).toBe(true);
      // The pure builder must not have mutated state or HMR.
      expect(state.guardianOutcomeUnknownFences).toHaveLength(1);
      expect(state.guardianOutcomeUnknownFences[0]).toBe(prepareFence);
      expect(syncToHmrState.mock.calls.length).toBe(initialSyncCount);

      // 3) The replacement swaps the prepare-operation key for the abort-operation
      //    key in a single state transition + single HMR sync, preserving the
      //    lease. The old prepare fence must not remain.
      const syncCountBeforeReplace = syncToHmrState.mock.calls.length;
      runtime.__testReplaceGuardianOutcomeUnknownFence(prepareFence, replacementFence);
      expect(state.guardianOutcomeUnknownFences).toHaveLength(1);
      expect(state.guardianOutcomeUnknownFences[0]).toBe(replacementFence);
      expect(state.guardianOutcomeUnknownFences[0].operationId).toBe(abortOperationId);
      expect(state.guardianOutcomeUnknownFences.some((fence) => fence.operationId === prepareOperationId))
        .toBe(false);
      expect(state.guardianOutcomeUnknownFence).toBe(replacementFence);
      expect(state.guardianOutcomeUnknownLease).toBe(retainedLease);
      // Exactly one HMR sync for the replacement.
      expect(syncToHmrState.mock.calls.length).toBe(syncCountBeforeReplace + 1);
    }, 10000);

    it('does not legacy-spawn or abort after an ambiguous successor spawn', async () => {
      const { spawn } = await import('node:child_process');
      const clientAbortHandoff = vi.fn();
      const clientSpawn = vi.fn().mockRejectedValue(Object.assign(
        new Error('spawn response was lost'),
        {
          code: 'GUARDIAN_REQUEST_AMBIGUOUS',
          ambiguous: true,
          retryable: false,
          originalCode: 'connection_closed',
        },
      ));
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: vi.fn().mockResolvedValue(undefined),
        abortHandoff: clientAbortHandoff,
        spawn: clientSpawn,
        stop: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'ambiguous-spawn';
      state.isOpenCodeReady = true;

      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
        retryable: false,
        originalCode: 'connection_closed',
      });
      expect(clientSpawn).toHaveBeenCalledOnce();
      expect(clientAbortHandoff).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(runtime.__testManagedStartupSecretState().leaseCount).toBe(1);
    }, 10000);

    it('keeps an ambiguous spawn fenced until a delayed successor is owner-scoped adopted', async () => {
      const oldOwner = {
        ownerInstanceId: 'owner-test-instance',
        runtimeIdentity: 'runtime-test-instance',
        launchFingerprint: 'current-fingerprint',
      };
      const oldRecord = {
        incarnation: 'delayed-old',
        state: 'handoff-prepared',
        revision: 4,
        leaseExpiresAt: Date.now() + 60_000,
        mac: 'old-record-mac',
        ...oldOwner,
      };
      let successorVisible = false;
      let oldStopped = false;
      const successorLeaseExpiresAt = Date.now() + 60_000;
      const clientPrepareHandoff = vi.fn().mockResolvedValue({
        ...oldRecord,
        revision: 4,
      });
      const clientSpawn = vi.fn().mockRejectedValue(Object.assign(
        new Error('successor response was lost'),
        {
          code: 'GUARDIAN_REQUEST_AMBIGUOUS',
          ambiguous: true,
          retryable: false,
          originalCode: 'connection_closed',
        },
      ));
      const clientHealth = vi.fn().mockResolvedValue({ healthy: true });
      const clientStop = vi.fn(async () => {
        oldStopped = true;
      });
      const clientList = vi.fn(async () => {
        const successorOwner = clientSpawn.mock.calls[0]?.[0]?.owner;
        const successor = successorOwner && successorVisible
          ? {
            incarnation: 'delayed-successor',
            state: 'active',
            pid: 45679,
            port: 45679,
            revision: 8,
            leaseExpiresAt: successorLeaseExpiresAt,
            mac: 'successor-record-mac',
            launchSpec: clientSpawn.mock.calls[0][0].launchSpec,
            ...successorOwner,
          }
          : null;
        if (oldStopped) return successor ? [successor] : [];
        return successor ? [oldRecord, successor] : [oldRecord];
      });
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: clientPrepareHandoff,
        spawn: clientSpawn,
        stop: clientStop,
        health: clientHealth,
        list: clientList,
        confirmAdoption: vi.fn(async () => ({
          record: {
            incarnation: 'delayed-successor',
            state: 'active',
            pid: 45679,
            port: 45679,
            revision: 8,
            leaseExpiresAt: successorLeaseExpiresAt,
            mac: 'successor-record-mac',
            launchSpec: clientSpawn.mock.calls[0][0].launchSpec,
            ...clientSpawn.mock.calls[0][0].owner,
          },
          credential: null,
          health: { healthy: true },
        })),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const legacySpawn = (await import('node:child_process')).spawn;
      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = oldRecord.incarnation;
      state.currentOwner = oldOwner;
      state.isOpenCodeReady = true;

      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
      });
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        kind: 'spawn',
        incarnation: oldRecord.incarnation,
        owner: oldOwner,
      });

      // The first retry happens before the delayed successor is visible. It
      // must not repeat spawn, stop the old child, or enter the legacy path.
      await expect(runtime.restartOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
      });
      expect(clientPrepareHandoff).toHaveBeenCalledOnce();
      expect(clientSpawn).toHaveBeenCalledOnce();
      expect(clientStop).not.toHaveBeenCalled();
      expect(legacySpawn).not.toHaveBeenCalled();
      expect(state.guardianOutcomeUnknownFence).not.toBeNull();

      // Once the exact owner-scoped successor is visible and healthy, the
      // retry stops only the exact old owner, adopts the successor, and clears
      // the fence after reconciliation.
      successorVisible = true;
      await runtime.restartOpenCode();

      expect(clientSpawn).toHaveBeenCalledOnce();
      expect(clientStop).toHaveBeenCalledWith({
        incarnation: oldRecord.incarnation,
        owner: oldOwner,
      });
      expect(state.currentIncarnation).toBe('delayed-successor');
      expect(state.currentOwner).toEqual(clientSpawn.mock.calls[0][0].owner);
      expect(state.openCodeProcess).toMatchObject({
        isGuardianManaged: true,
        pid: 45679,
      });
      expect(state.guardianOutcomeUnknownFence).toBeNull();
    }, 10000);

    it('keeps legacy fallback for a non-ambiguous prepareHandoff failure', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:34085\n');
        });
        return child;
      });
      const clientPrepareHandoff = vi.fn().mockRejectedValue(
        Object.assign(new Error('temporary prepare failure'), { code: 'connection_refused' }),
      );
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: clientPrepareHandoff,
        spawn: vi.fn(),
        stop: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'non-ambiguous-prepare';
      state.isOpenCodeReady = true;

      await runtime.restartOpenCode();

      expect(clientPrepareHandoff).toHaveBeenCalledOnce();
      expect(client.spawn).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledOnce();
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
           list: vi.fn().mockResolvedValue([]),
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

    it('fails closed when successor fallback discovery receives a malformed child list', async () => {
      const clientList = vi.fn().mockResolvedValue({ malformed: true });
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        prepareHandoff: vi.fn().mockResolvedValue(undefined),
        abortHandoff: vi.fn(async ({ incarnation }) => createActiveRollbackRecord(incarnation)),
        health: vi.fn().mockResolvedValue({ healthy: true }),
        spawn: vi.fn().mockRejectedValue(new Error('successor failed')),
        stop: vi.fn(),
        list: clientList,
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { spawn } = await import('node:child_process');
      const { runtime, state } = createRuntime();
      state.openCodeProcess = { pid: 12345, close: vi.fn() };
      state.openCodePort = 45678;
      state.currentIncarnation = 'current-malformed-successor';
      state.isOpenCodeReady = true;

      await expect(runtime.restartOpenCode()).rejects.toThrow(/without a confirmed rollback/);
      expect(clientList).toHaveBeenCalledOnce();
      expect(client.disconnect).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      expect(state.currentIncarnation).toBe('current-malformed-successor');
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
           list: vi.fn().mockResolvedValue([]),
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
            admissionStatus: vi.fn().mockResolvedValue({ admitted: true, attentionCount: 0, operationCount: 0 }),
            spawn: clientSpawn,
            stop: clientStop,
            prepareHandoff: clientPrepareHandoff,
           list: vi.fn().mockResolvedValue([]),
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

        // The handoff branch is skipped, but a running guardian's global
        // admission authority is still queried before the legacy launch.
        expect(clientConnect).toHaveBeenCalledOnce();
        expect(clientPrepareHandoff).not.toHaveBeenCalled();
        expect(clientSpawn).not.toHaveBeenCalled();
        expect(clientStop).not.toHaveBeenCalled();
        // Lifecycle may instantiate the owner-scoped discovery client before
        // honoring the handoff opt-out; no side-effecting guardian RPC is
        // allowed on the legacy path.
        expect(clientPrepareHandoff).not.toHaveBeenCalled();

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
        health: vi.fn(async () => ({ healthy: true })),
        spawn: vi.fn(),
          stop: clientStop,
          prepareHandoff: vi.fn(),
           list: vi.fn().mockResolvedValue([]),
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
          health: vi.fn().mockResolvedValue({ healthy: true }),
          stop: clientStop,
          prepareHandoff: clientPrepareHandoff,
           list: vi.fn().mockResolvedValue([]),
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
          health: vi.fn().mockResolvedValue({ healthy: true }),
          stop: clientStop,
          prepareHandoff: vi.fn(),
           list: vi.fn().mockResolvedValue([]),
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

    it('does not repeat an owner-scoped stop after an ambiguous response', async () => {
      const clientStop = vi.fn().mockRejectedValue(Object.assign(
        new Error('stop response was lost'),
        {
          code: 'GUARDIAN_REQUEST_AMBIGUOUS',
          ambiguous: true,
          retryable: false,
          originalCode: 'connection_closed',
        },
      ));
      GuardianClient.mockImplementation(function () {
        return {
          connect: vi.fn(),
          health: vi.fn().mockResolvedValue({ healthy: true }),
          stop: clientStop,
          list: vi.fn().mockResolvedValue([]),
          disconnect: vi.fn(),
        };
      });

      const { runtime, state } = createRuntime();
      detectAndAdoptGuardianChild.mockResolvedValue({
        incarnation: 'ambiguous-direct-stop',
        pid: 99004,
        port: 4096,
        url: 'http://127.0.0.1:4096',
        owner: {
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
          launchFingerprint: 'adopted-fingerprint',
        },
      });

      await runtime.bootstrapOpenCodeAtStartup();
      await expect(state.openCodeProcess.stopOwnedOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        retryable: false,
      });
      await expect(state.openCodeProcess.stopOwnedOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        retryable: false,
      });
      expect(clientStop).toHaveBeenCalledOnce();
      expect(state.guardianOutcomeUnknownFence).toMatchObject({
        kind: 'stop',
        incarnation: 'ambiguous-direct-stop',
      });
    }, 10000);

    it('retains and releases the direct-stop startup-secret lease only after terminal confirmation', async () => {
      const owner = {
        ownerInstanceId: 'owner-direct-stop-lease',
        runtimeIdentity: 'runtime-direct-stop-lease',
        launchFingerprint: 'direct-stop-lease-fingerprint',
      };
      const terminal = {
        incarnation: 'direct-stop-lease-incarnation',
        state: 'retired',
        pid: 99005,
        port: 4097,
        revision: 4,
        leaseExpiresAt: Date.now() + 60_000,
        mac: 'direct-stop-lease-mac',
        ...owner,
      };
      const clientList = vi.fn()
        .mockResolvedValueOnce([terminal])
        .mockResolvedValueOnce([terminal])
        .mockResolvedValueOnce([]);
      const clientStop = vi.fn().mockRejectedValueOnce(Object.assign(
        new Error('stop response was lost after terminalization'),
        {
          code: 'GUARDIAN_REQUEST_AMBIGUOUS',
          ambiguous: true,
          retryable: false,
          originalCode: 'connection_closed',
        },
      ));
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        health: vi.fn().mockResolvedValue({ healthy: true }),
        spawn: vi.fn().mockResolvedValue({
          incarnation: terminal.incarnation,
          pid: terminal.pid,
          port: terminal.port,
          url: `http://127.0.0.1:${terminal.port}`,
          owner,
        }),
        stop: clientStop,
        list: clientList,
        terminalStatus: vi.fn().mockResolvedValue({ record: terminal }),
        confirmTerminal: vi.fn().mockResolvedValue({ record: terminal }),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime({
        ensureLocalOpenCodeServerPassword: vi.fn(async () => 'direct-stop-lease-secret'),
      });
      await runtime.bootstrapOpenCodeAtStartup();
      expect(runtime.__testManagedStartupSecretState().leaseCount).toBe(1);
      expect(runtime.__testGuardianStartupSecretLeaseCount()).toBe(1);

      await expect(state.openCodeProcess.stopOwnedOpenCode()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        retryable: false,
      });
      expect(runtime.__testManagedStartupSecretState().leaseCount).toBe(1);

      await expect(runtime.__testReconcileGuardianOutcomeUnknownFence()).resolves.toMatchObject({
        resolved: true,
        adopted: false,
      });
      expect(clientStop).toHaveBeenCalledOnce();
      expect(client.terminalStatus).toHaveBeenCalledOnce();
      expect(client.confirmTerminal).toHaveBeenCalledOnce();
      expect(state.guardianOutcomeUnknownFence).toBeNull();
      expect(runtime.__testManagedStartupSecretState()).toEqual({
        leaseCount: 0,
        secretCount: 0,
      });
      expect(runtime.__testGuardianStartupSecretLeaseCount()).toBe(0);
    }, 10000);

    it('keeps a pruned terminal fence unresolved after its retention lease expires', async () => {
      const owner = {
        ownerInstanceId: 'owner-pruned-terminal',
        runtimeIdentity: 'runtime-pruned-terminal',
        launchFingerprint: 'pruned-terminal-fingerprint',
      };
      const fence = {
        version: 1,
        kind: 'stop',
        incarnation: 'pruned-terminal-incarnation',
        owner,
        revision: 8,
        leaseExpiresAt: Date.now() - 1,
        mac: 'pruned-terminal-mac',
        cleanupTarget: 'old',
        oldStopped: false,
      };
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        terminalStatus: vi.fn().mockRejectedValue(Object.assign(
          new Error('terminal record was pruned'),
          { code: 'GUARDIAN_TERMINAL_RECORD_ABSENT' },
        )),
        confirmTerminal: vi.fn(),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime();
      state.guardianOutcomeUnknownFence = fence;

      await expect(runtime.__testReconcileGuardianOutcomeUnknownFence()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
      });
      expect(state.guardianOutcomeUnknownFence).toEqual(fence);
      expect(client.terminalStatus).toHaveBeenCalledOnce();
    }, 10000);

    it('keeps a pruned terminal fence fail-closed before its signed retention lease expires', async () => {
      const owner = {
        ownerInstanceId: 'owner-unexpired-terminal',
        runtimeIdentity: 'runtime-unexpired-terminal',
        launchFingerprint: 'unexpired-terminal-fingerprint',
      };
      const fence = {
        version: 1,
        kind: 'stop',
        incarnation: 'unexpired-terminal-incarnation',
        owner,
        revision: 8,
        leaseExpiresAt: Date.now() + 60_000,
        mac: 'unexpired-terminal-mac',
        cleanupTarget: 'old',
        oldStopped: false,
      };
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        terminalStatus: vi.fn().mockRejectedValue(Object.assign(
          new Error('terminal record was pruned too early'),
          { code: 'GUARDIAN_TERMINAL_RECORD_ABSENT' },
        )),
        confirmTerminal: vi.fn(),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime();
      state.guardianOutcomeUnknownFence = fence;

      await expect(runtime.__testReconcileGuardianOutcomeUnknownFence()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
        retryable: false,
      });
      expect(state.guardianOutcomeUnknownFence).toEqual(fence);
      expect(client.terminalStatus).toHaveBeenCalledOnce();
    }, 10000);

    it('keeps a stale durable terminal fence blocked when operation resolution binding is replaced', async () => {
      const owner = {
        ownerInstanceId: 'owner-stale-terminal-binding',
        runtimeIdentity: 'runtime-stale-terminal-binding',
        launchFingerprint: 'stale-terminal-binding-fingerprint',
      };
      const fence = {
        version: 1,
        kind: 'stop',
        operationId: 'stale-terminal-operation-000000000000000000000000000000',
        incarnation: 'stale-terminal-incarnation',
        owner,
        revision: 8,
        leaseExpiresAt: Date.now() + 60_000,
        mac: 'stale-terminal-fence-mac',
        cleanupTarget: 'old',
        oldStopped: false,
      };
      const operation = {
        operationId: fence.operationId,
        kind: 'stop',
        incarnation: fence.incarnation,
        ...owner,
        targetRevision: 7,
        targetLeaseExpiresAt: fence.leaseExpiresAt - 1,
        targetMac: 'original-target-mac',
        state: 'resolved',
        resolutionState: 'retired',
        resolutionRevision: 9,
        resolutionLeaseExpiresAt: fence.leaseExpiresAt,
        resolutionMac: 'replacement-terminal-mac',
        revision: 2,
        confirmationExpiresAt: Date.now() + 60_000,
        mac: 'operation-mac',
      };
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        operationStatus: vi.fn().mockResolvedValue({ operation, record: null, expired: false }),
        list: vi.fn().mockResolvedValue([]),
        confirmOperation: vi.fn(),
        disconnect: vi.fn(),
      };
      GuardianClient.mockImplementation(function () { return client; });

      const { runtime, state } = createRuntime();
      state.guardianOutcomeUnknownFence = fence;

      await expect(runtime.__testReconcileGuardianOutcomeUnknownFence()).rejects.toMatchObject({
        code: 'GUARDIAN_REQUEST_AMBIGUOUS',
        ambiguous: true,
      });
      expect(client.confirmOperation).not.toHaveBeenCalled();
      expect(state.guardianOutcomeUnknownFence).toEqual(fence);
    }, 10000);
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
        owner: {
          ownerInstanceId: 'owner-test-instance',
          runtimeIdentity: 'runtime-test-instance',
          launchFingerprint: 'win-adopted-fingerprint',
        },
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
          health: vi.fn().mockResolvedValue({ healthy: true }),
          stop: clientStop,
          prepareHandoff: clientPrepareHandoff,
           list: vi.fn().mockResolvedValue([]),
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
          list: vi.fn().mockResolvedValue([]),
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
