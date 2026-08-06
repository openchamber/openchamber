import { spawn as defaultSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Managed OpenCode Guardian.
 *
 * Trust boundary (Phase 2B):
 *   The guardian is the sole authoritative owner of an `Active` v2 record for
 *   a given incarnation on this host. Bootstrap adoption from the lifecycle
 *   startup path uses `client.list()` only to identify a candidate, then the
 *   guardian-side confirmation revalidates the exact owner-scoped credential
 *   and health state before its same-record CAS. Ownerless or ambiguous active
 *   records are surfaced as attention and are never silently attached.
 *
 *   The IPC permissioning model already enforces the trust boundary:
 *     Linux/POSIX (sub-phase W-A):
 *     - v2 root dir is mode `0700` (UID-scoped)
 *     - the secret master file is mode `0600`
 *     - the atomic PID-file singleton guarantees one guardian per host per UID
 *     - the IPC Unix-domain socket is mode `0600` (umask `0o077` + explicit
 *       `chmodSync` in `GuardianIpcServer.start()`)
 *     - same-UID local processes are the documented trust boundary.
 *     Windows (sub-phase W-B / W-C / T2):
 *     - v2 root dir lives under `%LOCALAPPDATA%` and is ACL'd to the
 *       current user via `icacls` (`applyDirectoryAcl`).
  *     - the discovery file (`<rootDir>/port`) is ACL'd to the current
  *       user via `applyDiscoveryFileAcl` before identity-fenced
  *       hard-link publication.
 *     - the IPC server binds `127.0.0.1` only on an ephemeral port.
 *     - same-Windows-user local processes are the documented trust
 *       boundary. Both platforms share the same OS-user/UID boundary:
 *       POSIX `0600` restricts socket access to the owning UID, not to
 *       the creating process, so any same-UID process can connect; the
 *       Windows ACL + loopback binding provides the equivalent user-scoped
 *       boundary through a different mechanism.
 *
 *   Cross-process adoption with a `claimCapability` is tracked separately
 *   and intentionally NOT exposed by this module. Earlier revisions shipped
 *   a `claimCapability`-gated `adopt()` RPC that required the record to be in
 *   `HandoffPrepared` state; that RPC was removed because no production path
 *   used it and it conflated the spawn-time credential with the bootstrap
 *   adoption scenario.
 */

import {
  ManagedOpenCodeHandoffV2State,
  ManagedOpenCodeHandoffV2OperationKind,
  isManagedOpenCodeHandoffV2OperationId,
  normalizeManagedOpenCodeHandoffV2OwnerIdentity,
  normalizeManagedOpenCodeHandoffV2LaunchSpec,
} from '../opencode/managed-opencode-handoff-v2/record.js';
import { createManagedOpenCodeHandoffV2Store } from '../opencode/managed-opencode-handoff-v2/store.js';
import { createManagedOpenCodeHandoffV2Protocol } from '../opencode/managed-opencode-handoff-v2/protocol.js';
import { createManagedOpenCodeHandoffV2SecretProvider } from '../opencode/managed-opencode-handoff-v2/secret-provider.js';
import {
  createManagedOpenCodeCredentialStore,
  MANAGED_OPENCODE_CREDENTIAL_MISSING_CODE,
} from '../opencode/managed-opencode-handoff-v2/credential-store.js';
import { resolveManagedOpenCodeHandoffV2Root } from '../opencode/managed-opencode-handoff-v2/filesystem.js';
import { GuardianIpcServer } from './ipc-server.js';
import { buildManagedOpenCodeOrigin } from './host.js';
import {
  terminateChildWindows,
  terminateRehydratedChildWindows,
} from './windows-process.js';
import {
  matchesWindowsProcessLaunchIdentity,
  readProcessLaunchIdentity,
  readProcessStartTicks,
} from './process-identity.js';
import { createLaunchFingerprint } from './owner-identity.js';
import { resolveGuardianPaths } from './paths.js';
import { performConnectionBoundManagedOpenCodeHealth } from './health-client.js';

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 5000;
const DEFAULT_LEASE_RENEWAL_INTERVAL_MS = 30000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60000;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const STOP_SIGNAL_TIMEOUT_MS = 2500;
const STOP_KILL_TIMEOUT_MS = 1000;
const MANAGED_STARTUP_URL_OUTPUT_LIMIT = 16 * 1024;
const RESERVED_ATTENTION_RETRY_DELAYS_MS = Object.freeze([1000, 5000, 15000]);
const createOperationId = () => randomBytes(32).toString('base64url');

const isSafeNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const normalizeObservedProcessStartTicks = (value) => {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return value;
  return null;
};
const isCanonicalProcessStartTicks = (value) => typeof value === 'string'
  && /^(?:0|[1-9]\d*)$/.test(value);
const isExpiredRecoveryState = (state) => state === ManagedOpenCodeHandoffV2State.Reserved
  || state === ManagedOpenCodeHandoffV2State.Stopping
  || state === ManagedOpenCodeHandoffV2State.HandoffPrepared
  || state === ManagedOpenCodeHandoffV2State.Interrupted
  || state === ManagedOpenCodeHandoffV2State.Retired;

const markStartupCleanupSettled = (error) => {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      Object.defineProperty(error, 'cleanupSettled', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: true,
      });
      return error;
    } catch {
      // Fall through to a wrapper when a caller supplied a frozen error.
    }
  }

  const settled = new Error(String(error));
  settled.cause = error;
  settled.cleanupSettled = true;
  return settled;
};

const unresolvedAttentionCleanupError = (cause) => {
  const error = new Error('Guardian cleanup is uncertain: unresolved attention records remain');
  error.code = 'GUARDIAN_CLEANUP_UNCERTAIN';
  if (cause) error.cause = cause;
  return error;
};

const defaultLog = (message) => {
  console.log(message);
};

const defaultSocketPath = (rootDir) => path.join(
  resolveManagedOpenCodeHandoffV2Root(rootDir),
  'guardian.sock',
);

const isSafeHostname = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= 255
  && /^[A-Za-z0-9_.:[\]-]+$/.test(value);

const WINDOWS_BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);
const launchPathBasename = (value) => {
  const text = typeof value === 'string' ? value : '';
  return (text.includes('\\') ? path.win32.basename(text) : path.basename(text)).toLowerCase();
};
const launchPathExtension = (value) => {
  const text = typeof value === 'string' ? value : '';
  return (text.includes('\\') ? path.win32.extname(text) : path.extname(text)).toLowerCase();
};
const isAbsoluteLaunchPath = (value) => typeof value === 'string'
  && (path.isAbsolute(value) || path.win32.isAbsolute(value));
const isResolvedComSpecBinary = (binary) => {
  const binaryName = launchPathBasename(binary);
  const comSpecName = launchPathBasename(process.env.ComSpec || 'cmd.exe');
  return binaryName === 'cmd.exe' || binaryName === comSpecName;
};
const isManagedOpenCodeCmdWrapper = ({ binary, args }) => {
  if (!isResolvedComSpecBinary(binary) || !Array.isArray(args) || args.length !== 5) {
    return false;
  }

  const [disableExtensions, stripQuotes, command, call, target] = args;
  if (disableExtensions !== '/d' || stripQuotes !== '/s' || command !== '/c' || call !== 'call') {
    return false;
  }

  return isAbsoluteLaunchPath(target)
    && WINDOWS_BATCH_EXTENSIONS.has(launchPathExtension(target))
    && launchPathBasename(target).startsWith('opencode');
};

const isSafeEnvironmentKey = (key) => typeof key === 'string'
  && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
  && !/^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|COMSPEC|ComSpec)$/i.test(key);

const isSafeCredentialString = (value, maxLength = 64 * 1024) => typeof value === 'string'
  && value.length > 0
  && value.length <= maxLength
  && !/[\x00-\x1F\x7F]/.test(value);

const extractManagedOpenCodeCredential = (env, owner) => {
  const password = typeof env?.OPENCODE_SERVER_PASSWORD === 'string'
    ? env.OPENCODE_SERVER_PASSWORD.trim()
    : '';
  if (!password) return null;
  if (!owner) {
    throw new Error('Guardian launch rejected: managed OpenCode credentials require stable owner identity');
  }
  const username = typeof env.OPENCODE_SERVER_USERNAME === 'string'
    && env.OPENCODE_SERVER_USERNAME.trim().length > 0
    ? env.OPENCODE_SERVER_USERNAME.trim()
    : 'opencode';
  if (!isSafeCredentialString(username, 256) || !isSafeCredentialString(password)) {
    throw new Error('Guardian launch rejected: managed OpenCode credentials are invalid');
  }
  return { username, password };
};

const credentialUnavailable = () => {
  const error = new Error('Managed OpenCode credential is unavailable');
  error.code = 'GUARDIAN_CREDENTIAL_UNAVAILABLE';
  return error;
};

const healthBaseUrl = ({ hostname, port }) => buildManagedOpenCodeOrigin({ hostname, port });

const healthUrl = ({ hostname, port }) => `${healthBaseUrl({ hostname, port })}/global/health`;

const normalizeSpawnRequest = ({ binary, args = [], hostname, port, cwd, env, launchSpec } = {}) => {
  const spec = launchSpec && typeof launchSpec === 'object'
    ? launchSpec
    : { binary, args, hostname, port, cwd };
  if (typeof spec.binary !== 'string' || spec.binary.length === 0) {
    throw new TypeError('Invalid binary');
  }
  if (!Number.isSafeInteger(spec.port) || spec.port <= 0 || spec.port > 65535) {
    throw new TypeError('Invalid port');
  }
  const normalized = normalizeManagedOpenCodeHandoffV2LaunchSpec({
    binary: spec.binary,
    args: Array.isArray(spec.args) ? spec.args : [],
    hostname: spec.hostname,
    port: spec.port,
    cwd: spec.cwd,
  });
  if (!normalized || !isSafeHostname(normalized.hostname)) {
    throw new TypeError('Invalid managed OpenCode launch specification');
  }
  const binaryName = launchPathBasename(normalized.binary);
  const wrapperName = normalized.args[0] ? launchPathBasename(normalized.args[0]) : '';
  const isCmdBinary = isResolvedComSpecBinary(normalized.binary);
  const isOpenCodeBinary = isManagedOpenCodeCmdWrapper(normalized)
    || (!isCmdBinary && (
      (binaryName.startsWith('opencode') && !WINDOWS_BATCH_EXTENSIONS.has(launchPathExtension(normalized.binary)))
      || wrapperName.includes('opencode')
      || (normalized.binary === process.execPath && wrapperName.includes('guardian-test-opencode'))
    ));
  if (!isOpenCodeBinary) {
    throw new Error('Guardian launch rejected: executable is not an allowed OpenCode launch target');
  }
  const normalizedEnv = {};
  if (env !== undefined) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
      throw new TypeError('Invalid managed OpenCode environment');
    }
    const entries = Object.entries(env);
    if (entries.length > 512) throw new Error('Guardian launch rejected: environment is too large');
    for (const [key, value] of entries) {
      if (!isSafeEnvironmentKey(key) || typeof value !== 'string' || value.length > 64 * 1024) {
        throw new Error(`Guardian launch rejected: invalid environment key ${key}`);
      }
      normalizedEnv[key] = value;
    }
  }
  if (!path.isAbsolute(normalized.cwd)) {
    throw new Error('Guardian launch rejected: cwd must be absolute');
  }
  return { ...normalized, env: normalizedEnv };
};

export class ManagedOpenCodeGuardian {
  #store;
  #credentialStore;
  #protocol;
  #secretProvider;
  #healthCheckIntervalMs;
  #leaseRenewalIntervalMs;
  #cleanupIntervalMs;
  #socketPath;
  #portPath;
  #username;
  #log;
  #ipcServer;
  #timers = [];
  #children = new Map();
  #attention = new Map();
  #started = false;
  #rootDir;
  #spawnFn;
  #authSecretPath;
  #processInspector;
  #processLiveness;
  #aclInspector;
  #reparseChecker;
  #stopSignalTimeoutMs;
  #stopKillTimeoutMs;
  #windowsHandleTerminator;
  #allowUnauthenticatedCredentials;
  #onStopped;
  #onTransportReady;
  #stoppedCallbackInvoked = false;
  #mutationQueue = Promise.resolve();
  #credentialOperationQueues = new Map();
  #reservedAttentionRetryTimers = new Map();
  #reservedAttentionRetryAttempts = new Map();
  #shutdownRequested = false;
  #managedHealthProbe;

  constructor({
    store,
    credentialStore,
    protocol,
    secretProvider,
    healthCheckIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS,
    leaseRenewalIntervalMs = DEFAULT_LEASE_RENEWAL_INTERVAL_MS,
    cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS,
    socketPath,
    // W-C: Windows IPC transport options forwarded from the
    // standalone entrypoint (`bin/openchamber-guardian.js`). On Linux
    // these are optional and ignored by the transport factory; on
    // Windows they are required to bind the loopback-TCP listener and
    // ACL the discovery file to the current user.
    portPath,
    username,
    log = defaultLog,
    rootDir,
    spawnFn,
    authSecretPath,
    processInspector,
    processLiveness,
    aclInspector,
    reparseChecker,
    stopSignalTimeoutMs = STOP_SIGNAL_TIMEOUT_MS,
    stopKillTimeoutMs = STOP_KILL_TIMEOUT_MS,
    windowsHandleTerminator = terminateRehydratedChildWindows,
    allowUnauthenticatedCredentials = false,
    managedHealthProbe = performConnectionBoundManagedOpenCodeHealth,
    onStopped,
    onTransportReady,
  } = {}) {
    if (!store || typeof store.read !== 'function') {
      throw new TypeError('ManagedOpenCodeGuardian requires a store');
    }
    if (!protocol || typeof protocol.reserveLaunch !== 'function') {
      throw new TypeError('ManagedOpenCodeGuardian requires a protocol');
    }
    if (!secretProvider || typeof secretProvider.issueLifecycleCredential !== 'function') {
      throw new TypeError('ManagedOpenCodeGuardian requires a secretProvider');
    }
    if (typeof log !== 'function') {
      throw new TypeError('ManagedOpenCodeGuardian requires a log function');
    }
    const resolvedCredentialStore = credentialStore ?? createManagedOpenCodeCredentialStore({
      rootDir,
      secretProvider,
      platform: process.platform,
      username,
      aclInspector,
      reparseChecker,
      log,
    });
    if (!resolvedCredentialStore || typeof resolvedCredentialStore.read !== 'function'
      || typeof resolvedCredentialStore.create !== 'function'
      || typeof resolvedCredentialStore.remove !== 'function') {
      throw new TypeError('ManagedOpenCodeGuardian requires a credential store');
    }

    this.#store = store;
    this.#credentialStore = resolvedCredentialStore;
    this.#protocol = protocol;
    this.#secretProvider = secretProvider;
    this.#healthCheckIntervalMs = isSafeNonNegativeInteger(healthCheckIntervalMs)
      ? healthCheckIntervalMs
      : DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.#leaseRenewalIntervalMs = isSafeNonNegativeInteger(leaseRenewalIntervalMs)
      ? leaseRenewalIntervalMs
      : DEFAULT_LEASE_RENEWAL_INTERVAL_MS;
    this.#cleanupIntervalMs = isSafeNonNegativeInteger(cleanupIntervalMs)
      ? cleanupIntervalMs
      : DEFAULT_CLEANUP_INTERVAL_MS;
    this.#rootDir = rootDir;
    const resolvedPaths = resolveGuardianPaths({ rootDir });
    this.#socketPath = socketPath ?? resolvedPaths.socketPath ?? defaultSocketPath(rootDir);
    this.#portPath = typeof portPath === 'string' && portPath.length > 0
      ? portPath
      : undefined;
    this.#username = typeof username === 'string' && username.length > 0 ? username : undefined;
    this.#log = log;
    this.#spawnFn = spawnFn;
    this.#authSecretPath = authSecretPath ?? resolveGuardianPaths({
      rootDir,
      socketPath: this.#socketPath,
      portPath: this.#portPath,
    }).authSecretPath;
    this.#processInspector = processInspector;
    this.#processLiveness = processLiveness;
    this.#aclInspector = aclInspector;
    this.#reparseChecker = reparseChecker;
    this.#stopSignalTimeoutMs = isSafeNonNegativeInteger(stopSignalTimeoutMs)
      ? stopSignalTimeoutMs
      : STOP_SIGNAL_TIMEOUT_MS;
    this.#stopKillTimeoutMs = isSafeNonNegativeInteger(stopKillTimeoutMs)
      ? stopKillTimeoutMs
      : STOP_KILL_TIMEOUT_MS;
    if (typeof windowsHandleTerminator !== 'function') {
      throw new TypeError('ManagedOpenCodeGuardian requires a Windows handle terminator');
    }
    this.#windowsHandleTerminator = windowsHandleTerminator;
    this.#allowUnauthenticatedCredentials = allowUnauthenticatedCredentials === true;
    if (typeof managedHealthProbe !== 'function') {
      throw new TypeError('ManagedOpenCodeGuardian requires a managed health probe');
    }
    this.#managedHealthProbe = managedHealthProbe;
    this.#onStopped = typeof onStopped === 'function' ? onStopped : null;
    this.#onTransportReady = typeof onTransportReady === 'function' ? onTransportReady : null;
  }

  get portPath() {
    return this.#portPath;
  }

  get username() {
    return this.#username;
  }

  get socketPath() {
    return this.#socketPath;
  }

  get protocol() {
    return this.#protocol;
  }

  setSpawnFn(fn) {
    this.#spawnFn = fn;
  }

  #enqueueMutation(operation, { markShutdown = false } = {}) {
    const blockedByShutdown = !markShutdown && this.#shutdownRequested;
    if (markShutdown) this.#shutdownRequested = true;

    const queued = this.#mutationQueue.then(() => {
      if (blockedByShutdown) {
        throw new Error('Guardian shutdown is in progress');
      }
      return operation();
    });
    // Keep the queue usable after a failed mutation while preserving the
    // failure for the caller that owns this operation.
    this.#mutationQueue = queued.catch(() => {});
    return queued;
  }

  #runCredentialOperation(incarnation, operation) {
    if (typeof incarnation !== 'string' || incarnation.length === 0) {
      return operation();
    }
    const previous = this.#credentialOperationQueues.get(incarnation) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.#credentialOperationQueues.set(incarnation, current);
    return current.finally(() => {
      if (this.#credentialOperationQueues.get(incarnation) === current) {
        this.#credentialOperationQueues.delete(incarnation);
      }
    });
  }

  async start() {
    if (this.#started) {
      throw new Error('ManagedOpenCodeGuardian is already started');
    }
    if (process.platform === 'win32' && !this.#portPath) {
      throw new TypeError('Windows portPath is required');
    }
    if (process.platform !== 'win32' && !this.#socketPath) {
      throw new TypeError('POSIX socketPath is required');
    }

    // W-C: the `process.platform === 'win32'` rejection is removed.
    // The transport factory inside `GuardianIpcServer.start()` dispatches
    // per-platform: Linux uses the Unix-domain socket bound to
    // `this.#socketPath`; Windows uses loopback TCP + discovery file
    // bound to `this.#portPath`.

    this.#log('[guardian] starting');
    this.#started = true;

    try {
      this.#ipcServer = new GuardianIpcServer({
        platform: process.platform,
        socketPath: this.#socketPath,
        portPath: this.#portPath,
        username: this.#username,
        guardian: this,
        log: this.#log,
        authSecretPath: this.#authSecretPath,
        aclInspector: this.#aclInspector,
        reparseChecker: this.#reparseChecker,
      });
      // Discover durable ambiguity handles before child rows are interpreted;
      // terminal cleanup must know whether an operation still fences them.
      await this.#rehydrateDurableOperations();
      await this.#rehydrateChildren();
      await this.#reconcileAttentionRecords({ operationOnly: true });
      await this.#ipcServer.start();
      if (this.#onTransportReady) {
        await this.#onTransportReady(this.#ipcServer.transportIdentity);
      }
      this.startTimers();
      this.#log('[guardian] started');
    } catch (error) {
      this.stopTimers();

      // Attention records are durable ownership blockers even when no child
      // could be rehydrated. Do not tear down the IPC/store authority beside
      // an unresolved live, identity, health, or credential record: the
      // standalone entrypoint must retain its marker and a later stop must be
      // able to retry after the record is resolved.
      if (this.#attention.size > 0) {
        throw unresolvedAttentionCleanupError(error);
      }

      let transportCleanupError = null;
      if (this.#ipcServer) {
        try {
          await this.#ipcServer.stop();
          this.#ipcServer = null;
        } catch (cleanupError) {
          // A listener may already be closed while its socket/discovery
          // artifact remains owned and retryable. Keep the guardian started,
          // the IPC server, and the store alive so a later stop can complete
          // cleanup; releasing the PID marker here would allow a second
          // guardian to race the unresolved transport.
          transportCleanupError = cleanupError;
        }
      }

      if (transportCleanupError) {
        const uncertain = new Error(
          `Guardian startup failed and transport cleanup is uncertain: ${transportCleanupError.message}`,
        );
        uncertain.code = 'GUARDIAN_CLEANUP_UNCERTAIN';
        uncertain.cause = error;
        uncertain.cleanupError = transportCleanupError;
        throw uncertain;
      }

      // Rehydration may have attached a live child before a later startup
      // step failed. Transport cleanup alone is not enough to release the
      // singleton marker in that case: doing so would leave the child owned
      // by no running guardian. Keep the store/guardian retryable so an
      // explicit stop can resolve the child ownership first.
      if (this.#children.size > 0) {
        const uncertain = new Error(
          'Guardian startup failed while recovered child ownership remained unresolved',
        );
        uncertain.code = 'GUARDIAN_CLEANUP_UNCERTAIN';
        uncertain.cause = error;
        throw uncertain;
      }

      try { await this.#store.close(); } catch (closeError) {
        this.#log(`[guardian] error closing recovery store after startup failure: ${closeError.message}`);
        this.#started = true;
        const uncertain = new Error(
          `Guardian startup failed and recovery-store cleanup is uncertain: ${closeError.message}`,
        );
        uncertain.code = 'GUARDIAN_CLEANUP_UNCERTAIN';
        uncertain.cause = error;
        uncertain.cleanupError = closeError;
        throw uncertain;
      }
      // Explicitly settle the startup rollback before returning the original
      // failure. The standalone entrypoint owns marker release for this
      // verified-clean state; an implicit half-started guardian must not keep
      // that marker alive after every artifact has been cleaned.
      this.#started = false;
      this.#shutdownRequested = false;
      throw markStartupCleanupSettled(error);
    }
  }

  async stop() {
    if (!this.#started && !this.#shutdownRequested) return;
    return this.#enqueueMutation(() => this.#stopInternal(), { markShutdown: true });
  }

  async #stopInternal() {
    if (!this.#started) {
      return;
    }
    this.#log('[guardian] stopping');
    this.stopTimers();

    // Stop all tracked children.
    const children = Array.from(this.#children.entries());
    const failures = [];
    for (const [incarnation] of children) {
      try {
        await this.#stopChild({ incarnation, administrative: true });
      } catch (error) {
        this.#log(`[guardian] error stopping child ${incarnation}: ${error.message}`);
        failures.push({ incarnation, error });
      }
    }

    if (failures.length > 0) {
      const details = failures
        .map(({ incarnation, error }) => `${incarnation}: ${error.message}`)
        .join('; ');
      const failure = new Error(`Guardian stop failed; live child records remain recoverable: ${details}`);
      failure.code = 'GUARDIAN_STOP_FAILED';
      throw failure;
    }

    await this.#reconcileAttentionRecords();
    if (this.#attention.size > 0) {
      throw unresolvedAttentionCleanupError();
    }

    this.#children.clear();

    if (this.#ipcServer) {
      // GuardianIpcServer retains its transport when artifact cleanup fails.
      // Do not mark this guardian stopped or release its ownership callback
      // until that close has completed successfully; a later stop can retry.
      await this.#ipcServer.stop();
      this.#ipcServer = null;
    }

    try {
      await this.#store.close();
    } catch (error) {
      this.#log(`[guardian] error closing store: ${error.message}`);
      const uncertain = new Error(`Guardian store cleanup is uncertain: ${error.message}`);
      uncertain.code = 'GUARDIAN_CLEANUP_UNCERTAIN';
      uncertain.cleanupError = error;
      throw uncertain;
    }

    this.#started = false;
    this.#log('[guardian] stopped');
    if (this.#onStopped && !this.#stoppedCallbackInvoked) {
      this.#stoppedCallbackInvoked = true;
      try {
        await this.#onStopped();
      } catch (error) {
        this.#log(`[guardian] stopped callback failed: ${error?.message || String(error)}`);
      }
    }
  }

  async reload() {
    return this.#enqueueMutation(() => {
      if (!this.#started) throw new Error('Guardian is not started');
      this.stopTimers();
      this.startTimers();
      return { reloaded: true };
    });
  }

  #inspectProcess(pid, record) {
    if (this.#processInspector) {
      return this.#processInspector({ pid, record }) || null;
    }
    return {
      processStartTicks: readProcessStartTicks(pid),
      launch: readProcessLaunchIdentity(pid),
    };
  }

  #readProcessStartTicks(pid) {
    const inspected = this.#inspectProcess(pid);
    return normalizeObservedProcessStartTicks(inspected?.processStartTicks);
  }

  #validateProcessIdentity(record, inspected, { requireLaunch = false } = {}) {
    const processStartTicks = normalizeObservedProcessStartTicks(inspected?.processStartTicks);
    if (requireLaunch && (!record?.launchSpec || typeof record.launchSpec !== 'object')) {
      return process.platform === 'win32'
        ? 'Windows process launch identity is unavailable'
        : 'POSIX process launch identity is unavailable';
    }
    if (requireLaunch && !isCanonicalProcessStartTicks(record?.processStartTicks)) {
      return process.platform === 'win32'
        ? 'Windows process start identity is unavailable'
        : 'POSIX process start identity is unavailable';
    }
    if (record.processStartTicks !== null && processStartTicks === null) {
      return process.platform === 'win32'
        ? 'Windows process start identity is unavailable'
        : 'POSIX process start identity is unavailable';
    }
    if (
      processStartTicks !== null
      && processStartTicks !== record.processStartTicks
    ) {
      return 'PID start identity changed';
    }

    const commandLine = inspected?.launch?.commandLine;
    if (requireLaunch && (typeof commandLine !== 'string' || commandLine.length === 0)) {
      return process.platform === 'win32'
        ? 'Windows process launch identity is unavailable'
        : 'POSIX process launch identity is unavailable';
    }
    if (commandLine && record.launchSpec) {
      if (process.platform === 'win32') {
        if (!matchesWindowsProcessLaunchIdentity(commandLine, record.launchSpec, { port: record.port })) {
          return 'live executable or launch arguments do not match';
        }
      } else {
        const tokens = [
          path.basename(record.launchSpec.binary),
          ...record.launchSpec.args.map((arg) => path.basename(arg)),
          'serve',
          '--hostname',
          record.launchSpec.hostname,
          '--port',
          String(record.port),
        ];
        if (!tokens.every((token) => commandLine.includes(token))) {
          return 'live executable or launch arguments do not match';
        }
      }
      if (inspected.launch.cwd && path.resolve(inspected.launch.cwd) !== path.resolve(record.launchSpec.cwd)) {
        return 'live working directory does not match';
      }
    }
    if (inspected?.launchFingerprint && inspected.launchFingerprint !== record.launchFingerprint) {
      return 'live launch identity changed';
    }
    return null;
  }

  #validateRehydratedRecordIdentity(record, pid) {
    let inspected;
    try {
      inspected = this.#inspectProcess(pid, record);
    } catch {
      inspected = null;
    }
    return this.#validateProcessIdentity(record, inspected, { requireLaunch: true });
  }

  #validateRehydratedIdentity(entry) {
    if (!entry?.rehydrated) return null;
    const failure = this.#validateRehydratedRecordIdentity(entry.record, entry.pid);
    if (failure) this.#rememberAttention(entry.record, failure, 'identity-uncertain');
    return failure;
  }

  #assertRehydratedIdentity(entry) {
    const failure = this.#validateRehydratedIdentity(entry);
    if (!failure) return;
    const error = new Error(`Guardian child identity validation failed: ${failure}`);
    error.code = 'GUARDIAN_CHILD_IDENTITY_INVALID';
    throw error;
  }

  #credentialDescriptor(record) {
    return {
      incarnation: record?.incarnation,
      ownerInstanceId: record?.ownerInstanceId,
      runtimeIdentity: record?.runtimeIdentity,
      launchFingerprint: record?.launchFingerprint,
      credentialFingerprint: record?.credentialFingerprint,
    };
  }

  #entryRequiresCredential(entry) {
    return entry?.credentialRequired === true
      || (entry?.credentialRequired === undefined && !this.#allowUnauthenticatedCredentials);
  }

  async #readCredential(record, { required = true } = {}) {
    if (!required) {
      return null;
    }
    try {
      const credential = await this.#credentialStore.read(this.#credentialDescriptor(record));
      if (!credential
        || !isSafeCredentialString(credential.username, 256)
        || !isSafeCredentialString(credential.password)) {
        throw credentialUnavailable();
      }
      return credential;
    } catch (error) {
      if (error?.code === MANAGED_OPENCODE_CREDENTIAL_MISSING_CODE
        || error?.code === 'GUARDIAN_CREDENTIAL_UNAVAILABLE') {
        throw credentialUnavailable();
      }
      throw credentialUnavailable();
    }
  }

  #credentialHeaders(credential) {
    if (!credential) return {};
    const encoded = Buffer.from(`${credential.username}:${credential.password}`, 'utf8');
    try {
      return {
        Authorization: `Basic ${encoded.toString('base64')}`,
      };
    } finally {
      encoded.fill(0);
    }
  }

  #setRehydratedChild(record, { credentialRequired, credentialError = null } = {}) {
    const entry = {
      child: this.#createRehydratedChild(record),
      pid: record.pid,
      port: record.port,
      url: healthBaseUrl({ hostname: record.launchSpec?.hostname, port: record.port }),
      incarnation: record.incarnation,
      owner: record.ownerInstanceId && record.runtimeIdentity && record.launchFingerprint
        ? {
          ownerInstanceId: record.ownerInstanceId,
          runtimeIdentity: record.runtimeIdentity,
          launchFingerprint: record.launchFingerprint,
        }
        : null,
      launchSpec: record.launchSpec,
      record,
      rehydrated: true,
      credentialRequired,
      ...(credentialError ? { credentialError } : {}),
    };
    this.#children.set(record.incarnation, entry);
    return entry;
  }

  #isProcessAlive(pid) {
    if (typeof this.#processLiveness === 'function') {
      try {
        const state = this.#processLiveness(pid);
        return state !== false && state !== 'dead';
      } catch {
        return true;
      }
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // ESRCH is authoritative death. Permission and other probe failures
      // are unknown and must not retire or clear a durable child record.
      return error?.code !== 'ESRCH';
    }
  }

  #isProcessDefinitelyGone(pid) {
    if (typeof this.#processLiveness === 'function') {
      try {
        const state = this.#processLiveness(pid);
        return state === false || state === 'dead';
      } catch {
        return false;
      }
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error?.code === 'ESRCH';
    }
  }

  #clearAttentionRetry(incarnation) {
    const timer = this.#reservedAttentionRetryTimers.get(incarnation);
    if (timer) clearTimeout(timer);
    this.#reservedAttentionRetryTimers.delete(incarnation);
    this.#reservedAttentionRetryAttempts.delete(incarnation);
  }

  #operationIds(value) {
    const ids = [];
    const add = (candidate) => {
      if (typeof candidate === 'string' && candidate.length > 0 && !ids.includes(candidate)) {
        ids.push(candidate);
      }
    };
    if (Array.isArray(value?.operationIds)) value.operationIds.forEach(add);
    add(value?.operationId);
    return ids;
  }

  #rememberEntryOperation(entry, operationId) {
    if (!entry || typeof operationId !== 'string' || operationId.length === 0) return;
    const operationIds = this.#operationIds(entry);
    if (!operationIds.includes(operationId)) operationIds.push(operationId);
    entry.operationIds = operationIds;
    // Keep the singular field as a compatibility alias for older callers.
    entry.operationId = operationIds[0];
  }

  #clearResolvedOperationIds(incarnation, resolvedIds) {
    if (!Array.isArray(resolvedIds) || resolvedIds.length === 0) return;
    const remove = (entry) => {
      if (!entry) return [];
      const remaining = this.#operationIds(entry).filter((id) => !resolvedIds.includes(id));
      if (remaining.length > 0) {
        entry.operationIds = remaining;
        entry.operationId = remaining[0];
      } else {
        delete entry.operationIds;
        delete entry.operationId;
      }
      return remaining;
    };
    remove(this.#children.get(incarnation));
    remove(this.#attention.get(incarnation));
  }

  #terminalRecordFromOperation(operation, attention) {
    if (!operation || !['interrupted', 'retired'].includes(operation.resolutionState)) return null;
    return {
      incarnation: operation.incarnation,
      ownerInstanceId: operation.ownerInstanceId,
      runtimeIdentity: operation.runtimeIdentity,
      launchFingerprint: operation.launchFingerprint,
      credentialFingerprint: attention?.credentialFingerprint,
      state: operation.resolutionState,
      revision: operation.resolutionRevision,
      leaseExpiresAt: operation.resolutionLeaseExpiresAt,
      mac: operation.resolutionMac,
      pid: attention?.pid,
      port: attention?.port,
    };
  }

  #scheduleAttentionRetry(incarnation) {
    if (!this.#started || this.#shutdownRequested || this.#reservedAttentionRetryTimers.has(incarnation)) return;
    const attempt = this.#reservedAttentionRetryAttempts.get(incarnation) ?? 0;
    if (attempt >= RESERVED_ATTENTION_RETRY_DELAYS_MS.length) {
      this.#log(`[guardian] attention ${incarnation} remains retained; bounded reconciliation retries exhausted`);
      return;
    }
    const delay = RESERVED_ATTENTION_RETRY_DELAYS_MS[attempt];
    const timer = setTimeout(async () => {
      this.#reservedAttentionRetryTimers.delete(incarnation);
      this.#reservedAttentionRetryAttempts.set(incarnation, attempt + 1);
      if (!this.#started || this.#shutdownRequested || !this.#attention.has(incarnation)) return;
      try {
        await this.#reconcileAttentionRecords();
      } catch (error) {
      this.#log(`[guardian] attention ${incarnation} retry failed: ${error?.message || String(error)}`);
      }

      if (!this.#attention.has(incarnation)) {
        this.#clearAttentionRetry(incarnation);
        return;
      }
      // Retain and reschedule for terminal credential-cleanup attention too.
      // A Reserved record may have transitioned to Interrupted/Retired before
      // credential removal failed; returning without a future timer would
      // strand the encrypted credential until a process restart.
      this.#scheduleAttentionRetry(incarnation);
    }, delay);
    timer.unref?.();
    this.#reservedAttentionRetryTimers.set(incarnation, timer);
    this.#log(`[guardian] scheduled attention reconciliation for ${incarnation} in ${delay}ms`);
  }

  #rememberAttention(record, reason, kind = 'identity-uncertain', operationId = null) {
    const incarnation = typeof record?.incarnation === 'string' && record.incarnation.length <= 256
      ? record.incarnation
      : `invalid-${this.#attention.size + 1}`;
    const previous = this.#attention.get(incarnation);
    const launchPort = record?.launchSpec?.port;
    const port = Number.isSafeInteger(record?.port) && record.port > 0 && record.port <= 65535
      ? record.port
      : (Number.isSafeInteger(launchPort) && launchPort > 0 && launchPort <= 65535 ? launchPort : null);
    const retainedOperationIds = this.#operationIds(previous);
    const incomingOperationIds = Array.isArray(operationId) ? operationId : [operationId];
    for (const candidate of incomingOperationIds) {
      if (typeof candidate === 'string' && candidate.length > 0 && !retainedOperationIds.includes(candidate)) {
        retainedOperationIds.push(candidate);
      }
    }
    this.#attention.set(incarnation, {
      state: 'attention',
      attention: true,
      incarnation,
      ...(typeof record?.ownerInstanceId === 'string'
        ? { ownerInstanceId: record.ownerInstanceId }
        : (previous?.ownerInstanceId ? { ownerInstanceId: previous.ownerInstanceId } : {})),
      ...(typeof record?.runtimeIdentity === 'string'
        ? { runtimeIdentity: record.runtimeIdentity }
        : (previous?.runtimeIdentity ? { runtimeIdentity: previous.runtimeIdentity } : {})),
      ...(typeof record?.launchFingerprint === 'string'
        ? { launchFingerprint: record.launchFingerprint }
        : (previous?.launchFingerprint ? { launchFingerprint: previous.launchFingerprint } : {})),
      ...(typeof record?.credentialFingerprint === 'string'
        ? { credentialFingerprint: record.credentialFingerprint }
        : (previous?.credentialFingerprint ? { credentialFingerprint: previous.credentialFingerprint } : {})),
      ...(Number.isSafeInteger(record?.pid) && record.pid > 0 ? { pid: record.pid } : {}),
      ...(port !== null ? { port } : {}),
      kind,
      reason,
      ...(retainedOperationIds.length > 0 ? {
        operationId: retainedOperationIds[0],
        operationIds: retainedOperationIds,
      } : {}),
    });
    if (record?.state === ManagedOpenCodeHandoffV2State.Reserved
      || kind === 'confirmed-death-cleanup'
      || kind === 'confirmed-death-cleanup-failed'
      || kind === 'reserved-reconciliation-failed') {
      this.#scheduleAttentionRetry(incarnation);
    }
  }

  async #reconcileAttentionRecords({ operationOnly = false } = {}) {
    if (this.#attention.size === 0 || typeof this.#protocol.readRecord !== 'function') return;

    for (const incarnation of this.#attention.keys()) {
      const attention = this.#attention.get(incarnation);
      const operationIds = this.#operationIds(attention);
      if (operationOnly && operationIds.length === 0) continue;
      const entry = this.#children.get(incarnation);

      // Operation resolution is part of retention, not a best-effort
      // notification. Keep the child/attention handle until the durable
      // operation CAS succeeds; a read failure or CAS conflict is never
      // interpreted as absence or success.
      if (operationIds.length > 0) {
        let loadedOperationRecord;
        try {
          loadedOperationRecord = await this.#protocol.readRecord({
            incarnation,
            allowExpired: true,
          });
        } catch {
          // A linked operation remains the durable recovery handle when the
          // child row cannot be read. Never fall through to missing-record
          // credential cleanup after an authoritative read failure.
          continue;
        }
        if (!loadedOperationRecord?.ok) {
          // A terminal operation carries its own signed resolution binding and
          // is intentionally retained as a tombstone after the child row is
          // pruned. It can therefore settle the operation set without
          // treating an unresolved/read-failed row as success.
          const resolvedTerminalIds = [];
          let terminalRecord = null;
          for (const operationId of operationIds) {
            const loadedOperation = typeof this.#protocol.readOperation === 'function'
              ? await this.#protocol.readOperation({ operationId, allowExpired: true }).catch(() => null)
              : null;
            if (!loadedOperation?.ok || loadedOperation.operation.state !== 'resolved') continue;
            resolvedTerminalIds.push(operationId);
            terminalRecord ||= this.#terminalRecordFromOperation(loadedOperation.operation, attention);
          }
          if (resolvedTerminalIds.length === operationIds.length && terminalRecord) {
            if (await this.#reconcileTerminalCredential(terminalRecord)) {
              this.#clearResolvedOperationIds(incarnation, resolvedTerminalIds);
              this.#attention.delete(incarnation);
              this.#clearAttentionRetry(incarnation);
            }
          }
          // `record-absent` is distinct from a read failure, but both retain
          // operation-linked attention. The operation may still be resolved
          // later from an authoritative terminal record.
          continue;
        }
        const operationRecord = loadedOperationRecord.record;
        const resolvedIds = [];
        for (const operationId of operationIds) {
          if (await this.#resolveDurableOperation(operationId, operationRecord)) {
            resolvedIds.push(operationId);
          }
        }
        if (resolvedIds.length > 0) this.#clearResolvedOperationIds(incarnation, resolvedIds);
        if (resolvedIds.length === operationIds.length) {
          const terminal = [
            ManagedOpenCodeHandoffV2State.Interrupted,
            ManagedOpenCodeHandoffV2State.Retired,
          ].includes(operationRecord.state);
          if (terminal) {
            const credentialReconciled = await this.#reconcileTerminalCredential(operationRecord);
            if (!credentialReconciled) continue;
            if (entry) this.#children.delete(incarnation);
          } else if (!entry) {
            // A resolved non-terminal operation without a rehydrated child
            // is still an ownership gap. Keep the attention fence until an
            // authoritative child can be attached.
            continue;
          }
          if (this.#operationIds(this.#attention.get(incarnation)).length === 0) {
            this.#attention.delete(incarnation);
            this.#clearAttentionRetry(incarnation);
          }
          continue;
        }
        // The operation row may be pending, expired, absent, or unreadable;
        // none of those outcomes authorizes ordinary missing-record cleanup.
        continue;
      }

      // A child entry still owns the process even if another authority has
      // already terminalized its durable row. Let the normal child-stop path
      // perform the process/credential cleanup before removing its attention.
      if (this.#children.has(incarnation)) continue;

      let loaded;
      try {
        loaded = await this.#protocol.readRecord({ incarnation, allowExpired: true });
      } catch {
        continue;
      }

      if (!loaded?.ok && loaded?.reason === 'record-absent') {
        // A missing child row is not proof that encrypted credential material
        // is gone. Retain attention until the credential store independently
        // confirms absence/cleanup.
        if (this.#allowUnauthenticatedCredentials) {
          this.#attention.delete(incarnation);
          this.#clearAttentionRetry(incarnation);
          continue;
        }
        const attention = this.#attention.get(incarnation);
        if (!attention?.credentialFingerprint
          || !attention.ownerInstanceId
          || !attention.runtimeIdentity
          || !attention.launchFingerprint) continue;
        try {
          await this.#removeCredential(attention);
          this.#attention.delete(incarnation);
          this.#clearAttentionRetry(incarnation);
        } catch {
          // Keep the record and retry timer on any uncertain cleanup result.
        }
        continue;
      }
      if (loaded?.ok && loaded.record?.state === ManagedOpenCodeHandoffV2State.Reserved) {
        await this.#reconcileReservedLaunchRecord(loaded.record, { allowExpired: true });
        continue;
      }
      if (
        loaded?.ok
        && (
          loaded.record?.state === ManagedOpenCodeHandoffV2State.Interrupted
          || loaded.record?.state === ManagedOpenCodeHandoffV2State.Retired
        )
      ) {
        if (await this.#reconcileTerminalCredential(loaded.record)) {
          this.#attention.delete(incarnation);
          this.#clearAttentionRetry(incarnation);
        }
      }
    }
  }

  async #reconcileTerminalCredential(record) {
    if (this.#allowUnauthenticatedCredentials) return true;
    try {
      await this.#removeCredential(record);
      return true;
    } catch (error) {
      this.#rememberAttention(
        record,
        `managed OpenCode credential removal failed; attention record retained for retry: ${error?.message || String(error)}`,
        'confirmed-death-cleanup-failed',
      );
      return false;
    }
  }

  async #reconcileReservedLaunchRecord(record, { allowExpired = false } = {}) {
    if (record?.state !== ManagedOpenCodeHandoffV2State.Reserved) return false;
    if (typeof this.#protocol.markInterrupted !== 'function') {
      this.#rememberAttention(record, 'reserved launch cannot be terminalized safely');
      return false;
    }

    // Reserved is the only unresolved launch state that proves no child could
    // have been spawned: beginLaunch has not yet crossed its CAS fence. Move
    // the record to a terminal state before removing the encrypted credential.
    // If the guardian crashes after the CAS, the next guardian can retry the
    // terminal-record cleanup without ever deleting a credential for a child
    // that may still be detached.
    let candidate = record;
    let interrupted = null;
    let permitExpired = allowExpired;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        interrupted = await this.#protocol.markInterrupted({
          incarnation: candidate.incarnation,
          expectedRevision: candidate.revision,
          ...(permitExpired ? { allowExpired: true } : {}),
        });
        if (interrupted?.ok || interrupted?.reason !== 'record-expired') break;

        // Verification and the fenced CAS use separate clock/store reads. If a
        // previously-live reservation expires in that gap, retry the same
        // owner/MAC/revision-fenced transition through the explicit expired
        // recovery path instead of leaving attention stuck on Reserved forever.
        const latest = typeof this.#protocol.readRecord === 'function'
          ? await this.#protocol.readRecord({
            incarnation: candidate.incarnation,
            allowExpired: true,
          }).catch(() => null)
          : null;
        if (!latest?.ok || latest.record?.state !== ManagedOpenCodeHandoffV2State.Reserved) break;
        candidate = latest.record;
        permitExpired = true;
      }
    } catch (error) {
      this.#rememberAttention(
        candidate,
        `reserved launch recovery store operation failed; attention record retained for retry: ${error?.message || String(error)}`,
        'reserved-reconciliation-failed',
      );
      return false;
    }
    if (!interrupted?.ok) {
      const latest = typeof this.#protocol.readRecord === 'function'
        ? await this.#protocol.readRecord({
          incarnation: candidate.incarnation,
          allowExpired: true,
        }).catch(() => null)
        : null;
      this.#rememberAttention(
        latest?.ok ? latest.record : candidate,
        `reserved launch recovery could not be fenced: ${interrupted?.reason || 'unknown failure'}`,
      );
      return false;
    }

    const operationIds = this.#operationIds(this.#attention.get(candidate.incarnation));
    const resolvedOperationIds = [];
    for (const operationId of operationIds) {
      if (await this.#resolveDurableOperation(operationId, interrupted.record)) {
        resolvedOperationIds.push(operationId);
      }
    }
    if (resolvedOperationIds.length !== operationIds.length) {
      this.#rememberAttention(
        interrupted.record,
        'reserved launch terminalized but durable operation resolution remains unresolved; retaining credential material',
        'operation-resolution-failed',
        operationIds,
      );
      return false;
    }
    const credentialReconciled = await this.#reconcileTerminalCredential(interrupted.record);
    if (credentialReconciled) {
      this.#clearResolvedOperationIds(candidate.incarnation, resolvedOperationIds);
      if (this.#operationIds(this.#attention.get(candidate.incarnation)).length === 0) {
        this.#attention.delete(candidate.incarnation);
      }
      this.#clearAttentionRetry(candidate.incarnation);
    }
    return credentialReconciled;
  }

  #assertLaunchAvailable(port, owner) {
    for (const [incarnation, entry] of this.#children) {
      const entryPort = entry.port ?? entry.record?.launchSpec?.port ?? null;
      const hasCompleteOwner = typeof entry.owner?.ownerInstanceId === 'string'
        && entry.owner.ownerInstanceId.length > 0
        && typeof entry.owner?.runtimeIdentity === 'string'
        && entry.owner.runtimeIdentity.length > 0
        && typeof entry.owner?.launchFingerprint === 'string'
        && entry.owner.launchFingerprint.length > 0;
      const sameStoppingOwner = entry.record?.state === ManagedOpenCodeHandoffV2State.Stopping
        && owner
        && entry.owner?.ownerInstanceId === owner.ownerInstanceId
        && entry.owner?.runtimeIdentity === owner.runtimeIdentity;
      if (
        entryPort === port
        || sameStoppingOwner
        || !Number.isSafeInteger(entryPort)
        || !hasCompleteOwner
      ) {
        throw new Error(`Guardian launch blocked by unresolved child ${incarnation}`);
      }
    }

    for (const attention of this.#attention.values()) {
      // Attention is an unresolved ownership decision. Port and owner fields
      // may be stale, missing, or contradictory, so no new launch can safely
      // proceed until the authoritative record is terminal and cleanup has
      // removed the attention entry.
      throw new Error(`Guardian launch blocked by attention record ${attention.incarnation}`);
    }
  }

  async #interruptLatestLaunchRecord(
    incarnation,
    fallbackRecord,
    { cleanupCredential = false, operationId = null } = {},
  ) {
    const finishTerminalCleanup = async (record) => {
      if (operationId && !(await this.#resolveDurableOperation(operationId, record))) {
        this.#rememberAttention(
          record,
          'launch terminalized but durable operation resolution remains unresolved; retaining credential material',
          'operation-resolution-failed',
          operationId,
        );
        return false;
      }
      if (cleanupCredential && !(await this.#reconcileTerminalCredential(record))) return false;
      return true;
    };

    if (typeof this.#protocol.readRecord !== 'function') {
      const interrupted = await this.#protocol.markInterrupted({
        incarnation,
        expectedRevision: fallbackRecord.revision,
      });
      if (interrupted?.ok && !(await finishTerminalCleanup(interrupted.record))) {
        return { ok: false, reason: 'terminal-cleanup-unresolved', record: interrupted.record };
      }
      return interrupted;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const loaded = await this.#protocol.readRecord({ incarnation });
      if (!loaded?.ok) {
        this.#rememberAttention(fallbackRecord, `launch cleanup could not read the authoritative record: ${loaded?.reason || 'read-failed'}`);
        return loaded || { ok: false, reason: 'record-read-failed' };
      }

      const record = loaded.record;
      if (
        record.state === ManagedOpenCodeHandoffV2State.Interrupted
        || record.state === ManagedOpenCodeHandoffV2State.Retired
      ) {
        if (!(await finishTerminalCleanup(record))) {
          return { ok: false, reason: 'terminal-cleanup-unresolved', record };
        }
        return loaded;
      }
      if (record.state === ManagedOpenCodeHandoffV2State.LaunchDelivering) {
        this.#rememberAttention(record, 'launch delivery is still fenced; refusing to guess child ownership');
        return { ok: false, reason: 'launch-delivery-fenced' };
      }
      if (
        record.state !== ManagedOpenCodeHandoffV2State.Reserved
        && record.state !== ManagedOpenCodeHandoffV2State.Launching
      ) {
        return loaded;
      }

      const interrupted = await this.#protocol.markInterrupted({
        incarnation,
        expectedRevision: record.revision,
      });
      if (interrupted?.ok || interrupted?.reason !== 'stale-revision' || attempt === 1) {
        if (!interrupted?.ok) {
          this.#rememberAttention(record, `launch cleanup failed: ${interrupted?.reason || 'unknown failure'}`);
        } else if (!(await finishTerminalCleanup(interrupted.record))) {
          return { ok: false, reason: 'terminal-cleanup-unresolved', record: interrupted.record };
        }
        return interrupted;
      }
    }

    return { ok: false, reason: 'launch-cleanup-failed' };
  }

  async #markStaleRecord(record, reason) {
    this.#log(`[guardian] retaining child record ${record.incarnation} for recovery: ${reason}`);
    this.#rememberAttention(record, reason, 'identity-uncertain');
  }

  async #interruptConfirmedDeadRecord(record, operationId = null) {
    let interrupted;
    try {
      interrupted = await this.#protocol.markInterrupted({
        incarnation: record.incarnation,
        expectedRevision: record.revision,
      });
    } catch (error) {
      this.#rememberAttention(
        record,
        `confirmed child death could not be terminalized: ${error?.message || String(error)}`,
        'confirmed-death',
        operationId,
      );
      return { ok: false, reason: 'terminal-transition-failed' };
    }
    if (!interrupted?.ok) {
      this.#rememberAttention(
        record,
        `confirmed child death could not be terminalized: ${interrupted?.reason || 'unknown failure'}`,
        'confirmed-death',
        operationId,
      );
    }
    return interrupted;
  }

  async #handleUnexpectedChildExit(incarnation, entry) {
    if (this.#children.get(incarnation) !== entry
      || ![ManagedOpenCodeHandoffV2State.Active, ManagedOpenCodeHandoffV2State.HandoffPrepared,
        ManagedOpenCodeHandoffV2State.Claimed].includes(entry.record?.state)) return;
    const interrupted = await this.#interruptConfirmedDeadRecord(entry.record, this.#operationIds(entry));
    if (!interrupted?.ok) return;
    entry.record = interrupted.record;
    const operationIds = this.#operationIds(entry);
    const resolvedOperationIds = [];
    for (const operationId of operationIds) {
      if (await this.#resolveDurableOperation(operationId, interrupted.record)) {
        resolvedOperationIds.push(operationId);
      }
    }
    if (resolvedOperationIds.length !== operationIds.length) {
      this.#rememberAttention(
        interrupted.record,
        'terminal child cleanup completed but durable operation resolution remains unresolved; retaining lifecycle handles',
        'operation-resolution-failed',
        operationIds,
      );
      return;
    }
    if (!(await this.#reconcileTerminalCredential(interrupted.record))) return;
    this.#clearResolvedOperationIds(incarnation, resolvedOperationIds);
    this.#children.delete(incarnation);
    if (this.#operationIds(this.#attention.get(incarnation)).length === 0) {
      this.#attention.delete(incarnation);
    }
  }

  async #retireConfirmedDeadRecord(record, { allowExpired = false } = {}) {
    const stopping = record.state === ManagedOpenCodeHandoffV2State.Stopping
      ? { ok: true, record }
      : await this.#protocol.beginStopping({
        incarnation: record.incarnation,
        expectedRevision: record.revision,
        allowExpired,
      });
    if (!stopping?.ok) {
      this.#rememberAttention(
        record,
        `confirmed child death could not enter stopping state: ${stopping?.reason || 'unknown failure'}`,
        'confirmed-death',
      );
      return stopping;
    }

    const retired = await this.#protocol.retire({
      incarnation: record.incarnation,
      expectedRevision: stopping.record.revision,
      allowExpired,
    });
    if (!retired?.ok) {
      this.#rememberAttention(
        stopping.record,
        `confirmed child death could not be retired: ${retired?.reason || 'unknown failure'}`,
        'confirmed-death',
      );
    }
    if (retired?.ok) {
      const operationIds = this.#operationIds(this.#attention.get(record.incarnation));
      const resolvedOperationIds = [];
      for (const operationId of operationIds) {
        if (await this.#resolveDurableOperation(operationId, retired.record)) {
          resolvedOperationIds.push(operationId);
        }
      }
      if (resolvedOperationIds.length !== operationIds.length) {
        this.#rememberAttention(
          retired.record,
          'confirmed child death requires durable operation/credential reconciliation',
          'operation-resolution-failed',
          operationIds,
        );
      } else if (await this.#reconcileTerminalCredential(retired.record)) {
        this.#clearResolvedOperationIds(record.incarnation, resolvedOperationIds);
        this.#attention.delete(record.incarnation);
        this.#clearAttentionRetry(record.incarnation);
      }
    }
    return retired;
  }

  #createRehydratedChild(record) {
    const child = new EventEmitter();
    const confirmExit = (signal = 'SIGTERM') => {
      if (!this.#isProcessDefinitelyGone(record.pid)) return false;
      if (child.exitCode === null && child.signalCode === null) {
        child.exitCode = 0;
        child.signalCode = signal;
        queueMicrotask(() => child.emit('close', 0, signal));
      }
      return true;
    };
    Object.assign(child, {
      pid: record.pid,
      exitCode: null,
      signalCode: null,
      isRehydrated: true,
      confirmExit,
      kill: (signal = 'SIGTERM') => {
        if (process.platform !== 'win32') {
          if (confirmExit(signal)) return false;
          if (this.#validateRehydratedRecordIdentity(record, record.pid)) return false;
        }
        try {
          if (process.platform === 'win32') {
            // The actual Windows termination is performed by the helper in
            // #terminateChild. This method only satisfies ChildProcess shape.
            return true;
          }
          process.kill(-record.pid, signal);
          process.kill(record.pid, signal);
        } catch {
          // The process may have exited between identity and termination.
        }
        // A synthetic child has no kernel-backed ChildProcess close event. Do
        // not set exitCode/signalCode or emit `close` until confirmExit() has
        // observed authoritative OS death.
        return true;
      },
    });
    return child;
  }

  async #rehydrateChildren() {
    if (typeof this.#store.list !== 'function') {
      throw new Error('Guardian recovery store cannot list child records');
    }
    let rows;
    try {
      rows = await this.#store.list();
    } catch (error) {
      this.#log(`[guardian] recovery store read failed: ${error.message}`);
      throw new Error(`Guardian recovery store read failed: ${error.message}`, { cause: error });
    }
    if (!Array.isArray(rows)) {
      throw new Error('Guardian recovery store returned an invalid child list');
    }

    for (const raw of rows) {
      const verified = await this.#protocol.verifyRecord(raw, {
        allowExpired: isExpiredRecoveryState(raw?.state),
      });
      if (!verified.ok) {
        this.#rememberAttention(raw, `record verification failed: ${verified.reason}`);
        continue;
      }
      let record = verified.record;
      if (
        record.state === ManagedOpenCodeHandoffV2State.Interrupted
        || record.state === ManagedOpenCodeHandoffV2State.Retired
      ) {
        const operationIds = this.#operationIds(this.#attention.get(record.incarnation));
        if (operationIds.length > 0) {
          // The operation handle was discovered before this child row. Keep
          // it until its terminal CAS succeeds before removing credentials.
          this.#rememberAttention(
            record,
            'terminal child record requires durable operation/credential reconciliation',
            'confirmed-death-cleanup',
            operationIds,
          );
        } else {
          await this.#reconcileTerminalCredential(record);
        }
        continue;
      }
      if (record.state === ManagedOpenCodeHandoffV2State.Reserved) {
        const reconciled = await this.#reconcileReservedLaunchRecord(record, {
          allowExpired: verified.expired === true,
        });
        // Rehydration may receive a non-throwing CAS conflict from the store.
        // Keep the Reserved attention on the bounded same-process retry path;
        // waiting for periodic cleanup or a restart would strand it.
        if (!reconciled && this.#attention.has(record.incarnation)) {
          this.#scheduleAttentionRetry(record.incarnation);
        }
        continue;
      }
      if (
        record.state === ManagedOpenCodeHandoffV2State.LaunchDelivering
        || record.state === ManagedOpenCodeHandoffV2State.Launching
      ) {
        this.#rememberAttention(
          record,
          'durable launch has no bound process identity; refusing to resume or guess a detached child',
        );
        continue;
      }
      if (record.state === ManagedOpenCodeHandoffV2State.Stopping) {
        if (
          !Number.isSafeInteger(record.pid)
          || record.pid <= 0
          || !Number.isSafeInteger(record.port)
          || record.port <= 0
          || !isCanonicalProcessStartTicks(record.processStartTicks)
        ) {
          this.#rememberAttention(record, 'stopping record has no complete process identity');
          continue;
        }
        if (!this.#isProcessAlive(record.pid)) {
          await this.#retireConfirmedDeadRecord(record, { allowExpired: verified.expired === true });
          continue;
        }
        const inspected = this.#inspectProcess(record.pid, record);
        const identityFailure = this.#validateProcessIdentity(record, inspected, { requireLaunch: true });
        if (identityFailure) {
          this.#rememberAttention(record, identityFailure);
          continue;
        }
        const stoppingEntry = this.#setRehydratedChild(record, {
          credentialRequired: !this.#allowUnauthenticatedCredentials,
        });
        if (stoppingEntry.credentialRequired) {
          try {
            await this.#readCredential(record);
          } catch {
            stoppingEntry.credentialError = true;
            this.#rememberAttention(record, 'managed OpenCode credential is unavailable for stopping recovery');
          }
        }
        this.#log(`[guardian] recovered stopping OpenCode pid=${record.pid} port=${record.port} incarnation=${record.incarnation}`);
        continue;
      }
      if (![
        ManagedOpenCodeHandoffV2State.Active,
        ManagedOpenCodeHandoffV2State.HandoffPrepared,
        ManagedOpenCodeHandoffV2State.Claimed,
      ].includes(record.state)) continue;
      if (!record.ownerInstanceId || !record.runtimeIdentity || !record.launchFingerprint || !record.launchSpec) {
        await this.#markStaleRecord(record, 'missing stable owner or launch identity');
        continue;
      }
      if (!this.#isProcessAlive(record.pid)) {
        if (record.state === ManagedOpenCodeHandoffV2State.HandoffPrepared && verified.expired === true) {
          await this.#retireConfirmedDeadRecord(record, { allowExpired: true });
          continue;
        }
        const interrupted = await this.#interruptConfirmedDeadRecord(record);
        if (interrupted?.ok) {
          const operationIds = this.#operationIds(this.#attention.get(record.incarnation));
          if (operationIds.length > 0) {
            this.#rememberAttention(
              interrupted.record,
              'confirmed child death requires durable operation/credential reconciliation',
              'confirmed-death-cleanup',
              operationIds,
            );
          } else {
            await this.#reconcileTerminalCredential(interrupted.record);
          }
        }
        continue;
      }
      const inspected = this.#inspectProcess(record.pid, record);
      const identityFailure = this.#validateProcessIdentity(record, inspected, { requireLaunch: true });
      if (identityFailure) {
        await this.#markStaleRecord(record, identityFailure);
        continue;
      }
      const expectedFingerprint = createLaunchFingerprint(record.launchSpec);
      if (expectedFingerprint !== record.launchFingerprint) {
        await this.#markStaleRecord(record, 'stored launch fingerprint is inconsistent');
        continue;
      }
      const credentialRequired = !this.#allowUnauthenticatedCredentials;
      let credential;
      try {
        credential = await this.#readCredential(record, { required: credentialRequired });
      } catch {
        this.#setRehydratedChild(record, {
          credentialRequired: true,
          credentialError: true,
        });
        this.#rememberAttention(
          record,
          'managed OpenCode credential is unavailable; refusing unauthenticated adoption',
          'credential-unavailable',
        );
        continue;
      }
      const health = await this.#probeHealth(record, { credential });
      if (!health.healthy) {
        if (health.credentialProofFailed) {
          this.#setRehydratedChild(record, { credentialRequired });
          this.#rememberAttention(
            record,
            health.reason || 'managed OpenCode health proof failed; refusing credential delivery',
            'credential-proof-failed',
          );
          continue;
        }
        if (health.credentialUnavailable) {
          this.#setRehydratedChild(record, {
            credentialRequired: true,
            credentialError: true,
          });
          this.#rememberAttention(
            record,
            'managed OpenCode credential was rejected; refusing unauthenticated adoption',
            'credential-rejected',
          );
          continue;
        }
        this.#setRehydratedChild(record, { credentialRequired });
        this.#rememberAttention(
          record,
          health.reason || 'managed OpenCode health check failed; adoption remains recoverable',
          'health-failure',
        );
        continue;
      }

      // Health probes are port-based. The process bound to that port can be
      // replaced while the request is in flight, so a successful response is
      // not by itself proof that the persisted child identity is still ours.
      const postHealthIdentityFailure = this.#validateRehydratedRecordIdentity(record, record.pid);
      if (postHealthIdentityFailure) {
        await this.#markStaleRecord(record, postHealthIdentityFailure);
        continue;
      }

      if (record.state === ManagedOpenCodeHandoffV2State.HandoffPrepared) {
        let active = await this.#protocol.abortHandoff({
          incarnation: record.incarnation,
          expectedRevision: record.revision,
        });
        if (!active.ok && active.reason === 'record-expired'
          && typeof this.#protocol.recoverExpiredHandoff === 'function') {
          active = await this.#protocol.recoverExpiredHandoff({
            incarnation: record.incarnation,
            expectedRevision: record.revision,
          });
        }
        if (!active.ok) {
          await this.#markStaleRecord(record, `handoff recovery failed: ${active.reason}`);
          continue;
        }
        record = active.record;
      }

      // Handoff recovery is asynchronous. Revalidate once more immediately
      // before publishing the child as adoptable/healthy so a PID/port reuse
      // during abortHandoff cannot be adopted through a stale record.
      const adoptionIdentityFailure = this.#validateRehydratedRecordIdentity(record, record.pid);
      if (adoptionIdentityFailure) {
        await this.#markStaleRecord(record, adoptionIdentityFailure);
        continue;
      }
      if (this.#operationIds(this.#attention.get(record.incarnation)).length === 0) {
        this.#attention.delete(record.incarnation);
      }
      this.#setRehydratedChild(record, {
        credentialRequired,
      });
      this.#log(`[guardian] recovered OpenCode pid=${record.pid} port=${record.port} incarnation=${record.incarnation}`);
    }

  }

  async #rehydrateDurableOperations() {
    if (typeof this.#store.listOperations !== 'function') return;
    let operations;
    try {
      operations = await this.#store.listOperations();
    } catch (error) {
      throw new Error(`Guardian durable operation recovery failed: ${error?.message || String(error)}`);
    }
    if (!Array.isArray(operations)) {
      throw new Error('Guardian durable operation recovery returned an invalid list');
    }
    for (const operation of operations) {
      if (![
        'pending',
        'expired',
      ].includes(operation?.state)) continue;

      const loaded = typeof this.#protocol.readRecord === 'function'
        ? await this.#protocol.readRecord({
          incarnation: operation.incarnation,
          allowExpired: true,
        }).catch(() => null)
        : null;
      const record = loaded?.ok
        ? loaded.record
        : {
          incarnation: operation.incarnation,
          ownerInstanceId: operation.ownerInstanceId,
          runtimeIdentity: operation.runtimeIdentity,
          launchFingerprint: operation.launchFingerprint,
          state: 'unknown',
        };
      const entry = this.#children.get(operation.incarnation);
      if (entry && entry.owner
        && entry.owner.ownerInstanceId === operation.ownerInstanceId
        && entry.owner.runtimeIdentity === operation.runtimeIdentity
        && entry.owner.launchFingerprint === operation.launchFingerprint) {
        this.#rememberEntryOperation(entry, operation.operationId);
      }
      this.#rememberAttention(
        record,
        `durable ${operation.state} operation remains unresolved; authoritative quiescence is required`,
        'operation-unresolved',
        operation.operationId,
      );
    }
  }

  async #probeHealth(record, { credential } = {}) {
    const url = healthUrl({
      hostname: record?.launchSpec?.hostname,
      port: record?.port,
    });

    // HTTP Basic Auth proves only that the peer accepted the password. It
    // does not prove that the peer is the process the guardian launched. The
    // managed probe therefore performs the challenge and Basic Auth requests
    // over one connection and never reconnects between them. Password-free
    // legacy launches retain the normal health path below.
    if (credential) {
      try {
        return await this.#managedHealthProbe({ url, record, credential });
      } catch {
        return {
          healthy: false,
          credentialProofFailed: true,
          reason: 'managed OpenCode health proof challenge failed; refusing to send the managed credential',
        };
      }
    }

    let headers = { Accept: 'application/json' };
    try {
      headers = { ...headers, ...this.#credentialHeaders(credential) };
    } catch {
      return { healthy: false, credentialUnavailable: true };
    }
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return {
        healthy: false,
        ...(credential && (response.status === 401 || response.status === 403)
          ? { credentialUnavailable: true }
          : {}),
        status: response.status,
        reason: credential && (response.status === 401 || response.status === 403)
          ? 'managed OpenCode credential was rejected by the child'
          : `managed OpenCode health endpoint returned HTTP ${response.status}`,
      };
      const body = await response.json().catch(() => null);
      if (body?.healthy === true) return { healthy: true };
      return {
        healthy: false,
        reason: body && typeof body === 'object'
          ? 'managed OpenCode health endpoint reported unhealthy'
          : 'managed OpenCode health endpoint returned malformed data',
      };
    } catch {
      return {
        healthy: false,
        reason: 'managed OpenCode health request failed transiently',
      };
    }
  }

  async spawnManagedOpenCode(options = {}) {
    return this.#enqueueMutation(() => this.#spawnManagedOpenCode(options));
  }

  async #spawnManagedOpenCode({
    port,
    hostname,
    binary,
    args,
    cwd,
    env,
    leaseMs = DEFAULT_LEASE_MS,
    owner,
    launchSpec,
    operationId = createOperationId(),
  } = {}) {
    if (!this.#started) throw new Error('Guardian is not started');
    const normalizedSpec = normalizeSpawnRequest({
      binary,
      args,
      hostname,
      port,
      cwd,
      env,
      launchSpec,
    });
    const { env: normalizedEnv, ...normalizedLaunchSpec } = normalizedSpec;
    const parsedOwner = normalizeManagedOpenCodeHandoffV2OwnerIdentity(owner ?? {});
    const legacyInjectedSpawn = !owner && this.#spawnFn;
    const normalizedOwner = parsedOwner && Object.values(parsedOwner).every((value) => value !== null)
      ? parsedOwner
      : null;
    if (!normalizedOwner && !legacyInjectedSpawn) {
      throw new Error('Guardian launch rejected: stable owner identity is required');
    }
    const managedCredential = extractManagedOpenCodeCredential(normalizedEnv, normalizedOwner);
    if (managedCredential) {
      normalizedEnv.OPENCODE_SERVER_USERNAME = managedCredential.username;
      normalizedEnv.OPENCODE_SERVER_PASSWORD = managedCredential.password;
    }
    const expectedLaunchFingerprint = createLaunchFingerprint(normalizedLaunchSpec);
    if (normalizedOwner && normalizedOwner.launchFingerprint !== expectedLaunchFingerprint) {
      throw new Error('Guardian launch rejected: launch fingerprint does not match launch specification');
    }
    this.#assertLaunchAvailable(normalizedSpec.port, normalizedOwner);
    if (!this.#spawnFn) {
      try {
        const stat = fs.statSync(normalizedSpec.cwd);
        if (!stat.isDirectory()) throw new Error('not a directory');
      } catch {
        throw new Error('Guardian launch rejected: cwd is not an accessible directory');
      }
    }

    this.#log(`[guardian] spawning managed OpenCode on port ${normalizedSpec.port}`);

    // 1. Reserve launch.
    const reservation = await this.#protocol.reserveLaunch({
      leaseMs,
      ...(normalizedOwner ? { owner: normalizedOwner, launchSpec: normalizedLaunchSpec } : {}),
    });
    if (!reservation.ok) {
      throw new Error(`Failed to reserve launch: ${reservation.reason}`);
    }
    const incarnation = reservation.record.incarnation;

    let child;
    let childTerminationConfirmed = true;
    let credentialPersistenceAttempted = false;
    let durableOperationPersisted = false;
    try {
      // Persist the operation before beginning credential delivery or issuing
      // any child-process side effect. A failed/invalid durable write is a
      // hard admission failure; the catch below fences and cleans the
      // reservation instead of spawning without a recovery handle.
      if (normalizedOwner) {
        await this.#createDurableOperation({
          operationId,
          kind: ManagedOpenCodeHandoffV2OperationKind.Spawn,
          record: reservation.record,
          owner: normalizedOwner,
        });
        durableOperationPersisted = true;
      }
      if (managedCredential) {
        credentialPersistenceAttempted = true;
        await this.#credentialStore.create({
          ...this.#credentialDescriptor(reservation.record),
          username: managedCredential.username,
          password: managedCredential.password,
        });
      }

      // 2. Begin launch with credential.
      const launching = await this.#protocol.beginLaunch({
        incarnation,
        expectedRevision: reservation.record.revision,
        withCredential: async (credential) => {
          try {
            // Credential bytes are deliberately never logged. The v2 record
            // already stores only a derived fingerprint.
          } finally {
            credential?.fill(0);
          }
        },
      });

      if (!launching.ok) {
        throw new Error(`Failed to begin launch: ${launching.reason}`);
      }

      // 3. Spawn child process.
      const spawnArgs = [
        ...normalizedSpec.args,
        'serve',
        '--hostname',
        normalizedSpec.hostname,
        '--port',
        String(normalizedSpec.port),
      ];
      const spawnFn = this.#spawnFn ?? defaultSpawn;
      child = spawnFn(normalizedSpec.binary, spawnArgs, {
        cwd: normalizedSpec.cwd,
        env: normalizedEnv,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (!child.pid) {
        throw new Error('Spawned child has no pid');
      }

      // 4. Wait for stdout "opencode server listening" line.
      const url = await new Promise((resolve, reject) => {
        let stdout = '';
        let done = false;
        const finish = (handler, value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          child.stdout?.off('data', onStdout);
          child.stderr?.off('data', onStderr);
          child.off('exit', onExit);
          child.off('error', onError);
          handler(value);
        };

        const onStdout = (chunk) => {
          const text = chunk?.toString?.() ?? String(chunk ?? '');
          const remaining = MANAGED_STARTUP_URL_OUTPUT_LIMIT - stdout.length;
          if (remaining > 0) stdout += text.slice(0, remaining);
          const lines = stdout.split('\n');
          for (const line of lines) {
            if (!line.startsWith('opencode server listening')) continue;
            const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
            if (!match) {
              finish(reject, new Error('Failed to parse server url from OpenCode startup output'));
              return;
            }
            finish(resolve, match[1]);
            return;
          }
        };

        const onStderr = () => {};

        const onExit = (code, signal) => {
          const reason = signal ? `signal ${signal}` : `code ${code}`;
          finish(reject, new Error(`OpenCode process exited before serving with ${reason}`));
        };

        const onError = (error) => {
          finish(reject, error);
        };

        const timer = setTimeout(() => {
          finish(reject, new Error('Timeout waiting for OpenCode to start'));
        }, 30000);

        child.stdout?.on('data', onStdout);
        child.stderr?.on('data', onStderr);
        child.on('exit', onExit);
        child.on('error', onError);
      });

      // 5. Bind spawned process.
      const active = await this.#protocol.bindSpawnedProcess({
        incarnation,
        expectedRevision: launching.record.revision,
        identity: {
          pid: child.pid,
          port: normalizedSpec.port,
          processStartTicks: this.#readProcessStartTicks(child.pid),
        },
        ...(normalizedOwner ? { owner: normalizedOwner, launchSpec: normalizedLaunchSpec } : {}),
      });

      if (!active.ok) {
        // Clean up child if bind failed.
        await this.#terminateChild(child);
        throw new Error(`Failed to bind spawned process: ${active.reason}`);
      }

      // Track child.
      const entry = {
        child,
        pid: child.pid,
        port: normalizedSpec.port,
        url,
        incarnation,
        owner: normalizedOwner,
        launchSpec: normalizedLaunchSpec,
        record: active.record,
        credentialRequired: Boolean(managedCredential),
        operationId: normalizedOwner ? operationId : null,
      };
      this.#children.set(incarnation, entry);
      child.once?.('close', () => {
        this.#enqueueMutation(
          () => this.#handleUnexpectedChildExit(incarnation, entry),
        ).catch((error) => this.#log(`[guardian] unexpected child exit recovery failed: ${error?.message || String(error)}`));
      });

      if (normalizedOwner && !(await this.#resolveDurableOperation(operationId, active.record))) {
        this.#rememberAttention(
          active.record,
          'managed OpenCode child is live but durable spawn operation resolution remains unresolved',
          'operation-resolution-failed',
          operationId,
        );
      }

      this.#log(`[guardian] spawned OpenCode pid=${child.pid} port=${normalizedSpec.port} incarnation=${incarnation}`);
      return {
        incarnation,
        pid: child.pid,
        port: normalizedSpec.port,
        owner: normalizedOwner,
      };
    } catch (error) {
      // Terminate orphaned child and clean up v2 record on failure.
      if (child) {
        try {
          await this.#terminateChild(child);
          childTerminationConfirmed = !this.#isProcessAlive(child.pid);
        } catch {
          childTerminationConfirmed = false;
        }
      }
      if (childTerminationConfirmed) {
        let authoritativeCleanup;
        try {
            authoritativeCleanup = await this.#interruptLatestLaunchRecord(
              incarnation,
              reservation.record,
              {
                cleanupCredential: credentialPersistenceAttempted,
                operationId: durableOperationPersisted ? operationId : null,
              },
            );
          } catch (cleanupError) {
          this.#rememberAttention(
            reservation.record,
            `launch cleanup failed: ${cleanupError?.message || String(cleanupError)}`,
          );
        }
      } else {
        const latest = typeof this.#protocol.readRecord === 'function'
          ? await this.#protocol.readRecord({ incarnation }).catch(() => null)
          : null;
        this.#rememberAttention(
          latest?.ok ? latest.record : reservation.record,
          'failed launch child could not be confirmed terminated; refusing to clear its durable binding',
        );
      }
      throw error;
    }
  }

  #assertOwnerMatch(entry, owner, administrative = false) {
    if (administrative) return;
    if (!entry.owner?.ownerInstanceId) {
      throw new Error('Guardian child ownership identity is required');
    }
    const normalized = normalizeManagedOpenCodeHandoffV2OwnerIdentity(owner ?? {});
    if (!normalized || Object.values(normalized).some((value) => value === null)) {
      throw new Error('Guardian child ownership identity is required');
    }
    if (
      normalized.ownerInstanceId !== entry.owner.ownerInstanceId
      || normalized.runtimeIdentity !== entry.owner.runtimeIdentity
      || normalized.launchFingerprint !== entry.owner.launchFingerprint
    ) {
      throw new Error('Guardian child ownership identity does not match');
    }
  }

  #assertRecordOwnerMatch(record, owner) {
    const normalized = normalizeManagedOpenCodeHandoffV2OwnerIdentity(owner ?? {});
    if (!normalized || Object.values(normalized).some((value) => value === null)
      || record?.ownerInstanceId !== normalized.ownerInstanceId
      || record?.runtimeIdentity !== normalized.runtimeIdentity
      || record?.launchFingerprint !== normalized.launchFingerprint) {
      throw new Error('Guardian terminal record ownership identity does not match');
    }
  }

  async #removeCredential(record) {
    const removed = await this.#credentialStore.remove(this.#credentialDescriptor(record));
    if (!removed || (removed.removed !== true && removed.removed !== false)) {
      throw new Error('Managed OpenCode credential removal was not confirmed');
    }
    return removed;
  }

  async #createDurableOperation({ operationId, kind, record, owner }) {
    if (typeof this.#protocol.createOperation !== 'function') {
      const error = new Error('Guardian durable operation persistence is unavailable');
      error.code = 'GUARDIAN_OPERATION_CREATE_UNAVAILABLE';
      throw error;
    }
    if (!isManagedOpenCodeHandoffV2OperationId(operationId)) {
      const error = new Error('Guardian durable operation ID is invalid');
      error.code = 'GUARDIAN_OPERATION_CREATE_INVALID';
      throw error;
    }
    const created = await this.#protocol.createOperation({
      operationId,
      kind,
      incarnation: record.incarnation,
      owner,
      target: {
        revision: record.revision,
        leaseExpiresAt: record.leaseExpiresAt,
        mac: record.mac,
      },
    });
    if (!created?.ok
      || created.operation?.operationId !== operationId
      || created.operation?.kind !== kind
      || created.operation?.incarnation !== record.incarnation
      || created.operation?.ownerInstanceId !== owner.ownerInstanceId
      || created.operation?.runtimeIdentity !== owner.runtimeIdentity
      || created.operation?.launchFingerprint !== owner.launchFingerprint
      || created.operation?.targetRevision !== record.revision
      || created.operation?.targetLeaseExpiresAt !== record.leaseExpiresAt
      || created.operation?.targetMac !== record.mac) {
      const error = new Error(`Guardian durable operation creation failed: ${created?.reason || 'invalid persisted operation'}`);
      error.code = 'GUARDIAN_OPERATION_CREATE_FAILED';
      throw error;
    }
    return created.operation;
  }

  #assertDurableOperationQuiescent(operation, record) {
    if (!operation || !record
      || operation.incarnation !== record.incarnation
      || operation.ownerInstanceId !== record.ownerInstanceId
      || operation.runtimeIdentity !== record.runtimeIdentity
      || operation.launchFingerprint !== record.launchFingerprint
      || !Number.isSafeInteger(operation.targetRevision)
      || typeof operation.targetMac !== 'string') {
      throw Object.assign(
        new Error('Guardian durable operation lacks an exact owner/incarnation binding'),
        { code: 'GUARDIAN_OPERATION_BINDING_INVALID' },
      );
    }

    const expectedStates = {
      [ManagedOpenCodeHandoffV2OperationKind.Spawn]: [
        ManagedOpenCodeHandoffV2State.Active,
        ManagedOpenCodeHandoffV2State.Interrupted,
        ManagedOpenCodeHandoffV2State.Retired,
      ],
      [ManagedOpenCodeHandoffV2OperationKind.Stop]: [
        ManagedOpenCodeHandoffV2State.Interrupted,
        ManagedOpenCodeHandoffV2State.Retired,
      ],
      [ManagedOpenCodeHandoffV2OperationKind.PrepareHandoff]: [
        ManagedOpenCodeHandoffV2State.HandoffPrepared,
      ],
      [ManagedOpenCodeHandoffV2OperationKind.AbortHandoff]: [
        ManagedOpenCodeHandoffV2State.Active,
      ],
    };
    if (!expectedStates[operation.kind]?.includes(record.state)) {
      throw Object.assign(
        new Error('Guardian durable operation resolution state is not quiescent'),
        { code: 'GUARDIAN_OPERATION_NOT_QUIESCENT' },
      );
    }

    const entry = this.#children.get(record.incarnation);
    const terminal = [ManagedOpenCodeHandoffV2State.Interrupted, ManagedOpenCodeHandoffV2State.Retired]
      .includes(record.state);
    if (!terminal) {
      const attention = this.#attention.get(record.incarnation);
      if (!entry || (attention && !this.#operationIds(attention).includes(operation.operationId))) {
        throw Object.assign(
          new Error('Guardian durable operation has no quiescent live child'),
          { code: 'GUARDIAN_OPERATION_NOT_QUIESCENT' },
        );
      }
      if (entry.record?.revision !== record.revision
        || entry.record?.leaseExpiresAt !== record.leaseExpiresAt
        || entry.record?.mac !== record.mac) {
        throw Object.assign(
          new Error('Guardian durable operation live-child binding changed'),
          { code: 'GUARDIAN_OPERATION_BINDING_INVALID' },
        );
      }
      if (entry.rehydrated && this.#validateRehydratedIdentity(entry)) {
        throw Object.assign(
          new Error('Guardian durable operation live-child identity is uncertain'),
          { code: 'GUARDIAN_OPERATION_NOT_QUIESCENT' },
        );
      }
      return;
    }

    // A terminal row is not enough by itself. The guardian must also have an
    // authoritative no-longer-running observation before the side-effect
    // fence can be resolved.
    if (entry) {
      const exited = entry.terminationConfirmed === true
        || (entry.rehydrated
          ? this.#isProcessDefinitelyGone(entry.pid)
          : entry.child?.exitCode !== null || entry.child?.signalCode !== null);
      if (!exited) {
        throw Object.assign(
          new Error('Guardian durable operation terminal child has not quiesced'),
          { code: 'GUARDIAN_OPERATION_NOT_QUIESCENT' },
        );
      }
    } else if (Number.isSafeInteger(record.pid) && record.pid > 0 && !this.#isProcessDefinitelyGone(record.pid)) {
      throw Object.assign(
        new Error('Guardian durable operation terminal process death is not authoritative'),
        { code: 'GUARDIAN_OPERATION_NOT_QUIESCENT' },
      );
    }
  }

  async #resolveDurableOperation(operationId, record) {
    if (!operationId || typeof this.#protocol.readOperation !== 'function'
      || typeof this.#protocol.resolveOperation !== 'function') return false;
    try {
      let loaded = await this.#protocol.readOperation({ operationId, allowExpired: true });
      if (!loaded?.ok) return false;
      if (loaded.operation.state === 'pending' && loaded.expired
        && typeof this.#protocol.expireOperation === 'function') {
        const expired = await this.#protocol.expireOperation({
          operationId,
          expectedRevision: loaded.operation.revision,
          expectedConfirmationExpiresAt: loaded.operation.confirmationExpiresAt,
          expectedMac: loaded.operation.mac,
        });
        if (!expired?.ok) return false;
        loaded = await this.#protocol.readOperation({ operationId, allowExpired: true });
        if (!loaded?.ok) return false;
      }
      if (loaded.operation.state === 'resolved') return true;
      if (!['pending', 'expired'].includes(loaded.operation.state)) return false;
      this.#assertDurableOperationQuiescent(loaded.operation, record);
      const resolved = await this.#protocol.resolveOperation({
        operationId,
        expectedRevision: loaded.operation.revision,
        expectedConfirmationExpiresAt: loaded.operation.confirmationExpiresAt,
        expectedMac: loaded.operation.mac,
        resolutionState: record.state,
        resolution: {
          record,
          target: {
            revision: loaded.operation.targetRevision,
            leaseExpiresAt: loaded.operation.targetLeaseExpiresAt,
            mac: loaded.operation.targetMac,
          },
          revision: record.revision,
          leaseExpiresAt: record.leaseExpiresAt,
          mac: record.mac,
        },
      });
      return resolved?.ok === true;
    } catch {
      // Read/CAS/quiescence failure retains the operation and all lifecycle
      // handles. Absence is never interpreted as a successful resolution.
      return false;
    }
  }

  async getOperationStatus({ operationId, owner } = {}) {
    if (!isManagedOpenCodeHandoffV2OperationId(operationId)
      || typeof this.#protocol.readOperation !== 'function') {
      throw new Error('Guardian operation status is unavailable');
    }
    const loaded = await this.#protocol.readOperation({ operationId, allowExpired: true });
    if (!loaded?.ok) {
      const error = new Error(`Guardian operation is unavailable: ${loaded?.reason || 'read-failed'}`);
      error.code = loaded?.reason === 'operation-absent'
        ? 'GUARDIAN_OPERATION_RECORD_ABSENT'
        : 'GUARDIAN_OPERATION_RECORD_UNAVAILABLE';
      throw error;
    }
    const normalizedOwner = normalizeManagedOpenCodeHandoffV2OwnerIdentity(owner ?? {});
    if (!normalizedOwner || Object.values(normalizedOwner).some((value) => value === null)
      || loaded.operation.ownerInstanceId !== normalizedOwner.ownerInstanceId
      || loaded.operation.runtimeIdentity !== normalizedOwner.runtimeIdentity
      || loaded.operation.launchFingerprint !== normalizedOwner.launchFingerprint) {
      throw new Error('Guardian operation ownership identity does not match');
    }
    let target = null;
    if (typeof this.#protocol.readRecord === 'function') {
      const current = await this.#protocol.readRecord({
        incarnation: loaded.operation.incarnation,
        allowExpired: true,
      });
      if (current?.ok) target = current.record;
      else if (current?.reason !== 'record-absent') {
        const error = new Error(`Guardian operation target is unavailable: ${current?.reason || 'read-failed'}`);
        error.code = 'GUARDIAN_OPERATION_TARGET_UNAVAILABLE';
        throw error;
      }
    }
    return { operation: loaded.operation, record: target, expired: loaded.expired === true };
  }

  async listOperations({ owner } = {}) {
    if (typeof this.#protocol.listOperations !== 'function') {
      throw new Error('Guardian operation discovery is unavailable');
    }
    const normalizedOwner = normalizeManagedOpenCodeHandoffV2OwnerIdentity({
      ownerInstanceId: owner?.ownerInstanceId ?? null,
      runtimeIdentity: owner?.runtimeIdentity ?? null,
      launchFingerprint: owner?.launchFingerprint ?? null,
    });
    if (!normalizedOwner
      || typeof owner?.ownerInstanceId !== 'string'
      || typeof owner?.runtimeIdentity !== 'string'
      || (owner?.launchFingerprint !== undefined && typeof owner.launchFingerprint !== 'string')) {
      throw new Error('Guardian operation discovery requires an owner scope');
    }
    let discovered;
    try {
      discovered = await this.#protocol.listOperations({ owner });
    } catch (error) {
      const failure = new Error(`Guardian operation discovery failed: ${error?.message || String(error)}`);
      failure.code = 'GUARDIAN_OPERATION_DISCOVERY_UNAVAILABLE';
      failure.cause = error;
      throw failure;
    }
    if (!discovered?.ok || !Array.isArray(discovered.operations)) {
      const failure = new Error(`Guardian operation discovery failed: ${discovered?.reason || 'invalid list'}`);
      failure.code = 'GUARDIAN_OPERATION_DISCOVERY_UNAVAILABLE';
      throw failure;
    }
    return discovered.operations;
  }

  async getAdmissionStatus() {
    if (!this.#started) throw new Error('Guardian is not started');

    // Reconcile terminal attention before reporting admission, but never turn
    // a read/CAS failure into an empty result. Any attention left after this
    // pass is a global ownership fence, regardless of its owner or port.
    await this.#reconcileAttentionRecords();
    if (typeof this.#protocol.listAllOperations !== 'function') {
      const error = new Error('Guardian global admission discovery is unavailable');
      error.code = 'GUARDIAN_ADMISSION_UNAVAILABLE';
      throw error;
    }
    let discovered;
    try {
      discovered = await this.#protocol.listAllOperations();
    } catch (error) {
      const failure = new Error(`Guardian global admission discovery failed: ${error?.message || String(error)}`);
      failure.code = 'GUARDIAN_ADMISSION_UNAVAILABLE';
      failure.cause = error;
      throw failure;
    }
    if (!discovered?.ok || !Array.isArray(discovered.operations)) {
      const failure = new Error(
        `Guardian global admission discovery failed: ${discovered?.reason || 'invalid list'}`,
      );
      failure.code = 'GUARDIAN_ADMISSION_UNAVAILABLE';
      throw failure;
    }
    const unresolvedOperations = discovered.operations.filter((operation) => (
      operation?.state === 'pending' || operation?.state === 'expired'
    ));
    const attentionCount = this.#attention.size;
    return {
      admitted: attentionCount === 0 && unresolvedOperations.length === 0,
      attentionCount,
      operationCount: unresolvedOperations.length,
    };
  }

  async resolveOperation({ operationId, owner, expected, resolution } = {}) {
    const status = await this.getOperationStatus({ operationId, owner });
    if (!expected || !resolution) throw new Error('Guardian operation resolution requires a complete binding');
    const resolutionRecord = status.record || resolution.record;
    if (!resolutionRecord) {
      throw new Error('Guardian operation resolution requires an authoritative signed record');
    }
    if (status.record && (
      status.record.incarnation !== status.operation.incarnation
      || status.record.revision !== resolutionRecord.revision
      || status.record.leaseExpiresAt !== resolutionRecord.leaseExpiresAt
      || status.record.mac !== resolutionRecord.mac
      || status.record.state !== resolutionRecord.state
    )) {
      throw new Error('Guardian operation resolution does not match the authoritative target record');
    }
    const resolved = await this.#enqueueMutation(() => {
      this.#assertDurableOperationQuiescent(status.operation, resolutionRecord);
      return this.#protocol.resolveOperation({
        operationId,
        expectedRevision: expected.revision,
        expectedConfirmationExpiresAt: expected.confirmationExpiresAt,
        expectedMac: expected.mac,
        resolutionState: resolutionRecord.state,
        resolution: {
          record: resolutionRecord,
          target: {
            revision: status.operation.targetRevision,
            leaseExpiresAt: status.operation.targetLeaseExpiresAt,
            mac: status.operation.targetMac,
          },
          revision: resolutionRecord.revision,
          leaseExpiresAt: resolutionRecord.leaseExpiresAt,
          mac: resolutionRecord.mac,
        },
      });
    });
    if (!resolved?.ok) throw new Error(`Guardian operation resolution failed: ${resolved?.reason || 'unknown failure'}`);
    return { operation: resolved.operation, record: status.record };
  }

  async expireOperation({ operationId, owner, expected } = {}) {
    const status = await this.getOperationStatus({ operationId, owner });
    if (!expected || typeof this.#protocol.expireOperation !== 'function') {
      throw new Error('Guardian operation expiry is unavailable');
    }
    const expired = await this.#enqueueMutation(() => this.#protocol.expireOperation({
      operationId,
      expectedRevision: expected.revision,
      expectedConfirmationExpiresAt: expected.confirmationExpiresAt,
      expectedMac: expected.mac,
    }));
    if (!expired?.ok) throw new Error(`Guardian operation expiry failed: ${expired?.reason || 'unknown failure'}`);
    return { operation: expired.operation, record: status.record, expired: true };
  }

  async confirmOperation({ operationId, owner, expected } = {}) {
    const status = await this.getOperationStatus({ operationId, owner });
    if (!expected || typeof this.#protocol.confirmOperation !== 'function') {
      throw new Error('Guardian operation confirmation is unavailable');
    }
    const confirmed = await this.#enqueueMutation(() => this.#protocol.confirmOperation({
      operationId,
      expectedRevision: expected.revision,
      expectedConfirmationExpiresAt: expected.confirmationExpiresAt,
      expectedMac: expected.mac,
      allowExpired: true,
    }));
    if (!confirmed?.ok) throw new Error(`Guardian operation confirmation failed: ${confirmed?.reason || 'unknown failure'}`);
    return { operation: confirmed.operation, record: status.record };
  }

  async stopChild(options = {}) {
    return this.#enqueueMutation(() => this.#stopChild(options));
  }

  async #stopChild({ incarnation, owner, administrative = false, operationId }) {
    return this.#runCredentialOperation(
      incarnation,
      () => this.#stopChildInternal({ incarnation, owner, administrative, operationId }),
    );
  }

  async #stopChildInternal({ incarnation, owner, administrative = false, operationId }) {
    const entry = this.#children.get(incarnation);
    if (!entry) {
      throw new Error(`Child not found: ${incarnation}`);
    }
    this.#assertOwnerMatch(entry, owner, administrative);

    this.#log(`[guardian] stopping child ${incarnation}`);

    const record = entry.record;
    const existingOperationIds = this.#operationIds(entry);
    let existingStopOperationId = null;
    if (!operationId && typeof this.#protocol.readOperation === 'function') {
      for (const existingOperationId of existingOperationIds) {
        const existing = await this.#protocol.readOperation({
          operationId: existingOperationId,
          allowExpired: true,
        }).catch(() => null);
        if (existing?.ok === true
          && existing.operation.kind === ManagedOpenCodeHandoffV2OperationKind.Stop
          && ['pending', 'expired'].includes(existing.operation.state)) {
          existingStopOperationId = existingOperationId;
          break;
        }
      }
    }
    if (existingStopOperationId && !administrative) {
      throw Object.assign(
        new Error(`Guardian stop for ${incarnation} is already fenced by an unresolved stop operation`),
        { code: 'GUARDIAN_OPERATION_UNRESOLVED' },
      );
    }
    const durableOperationId = operationId || existingStopOperationId || createOperationId();
    const normalizedOwner = normalizeManagedOpenCodeHandoffV2OwnerIdentity(owner ?? entry.owner ?? {});
    const durableOperationOwner = normalizedOwner && Object.values(normalizedOwner).every((value) => value !== null)
      ? normalizedOwner
      : null;
    const durableOperationCreated = Boolean(durableOperationOwner) && !existingStopOperationId;
    if (!administrative && !durableOperationOwner) {
      throw new Error('Guardian stop requires a complete owner identity for durable operation fencing');
    }
    if (durableOperationCreated) {
      await this.#createDurableOperation({
        operationId: durableOperationId,
        kind: ManagedOpenCodeHandoffV2OperationKind.Stop,
        record,
        owner: durableOperationOwner,
      });
      this.#rememberEntryOperation(entry, durableOperationId);
    }
    const stopping = record.state === ManagedOpenCodeHandoffV2State.Stopping
      ? { ok: true, record }
      : await this.#protocol.beginStopping({
          incarnation,
          expectedRevision: record.revision,
          allowExpired: true,
        }).catch((error) => {
          if (durableOperationOwner) {
            this.#rememberAttention(
              record,
              `begin stopping transition failed; durable operation remains unresolved: ${error?.message || String(error)}`,
              'operation-transition-failed',
              durableOperationId,
            );
          }
          throw error;
        });
    if (!stopping.ok) {
      if (durableOperationOwner) {
        this.#rememberAttention(
          record,
          `begin stopping transition failed; durable operation remains unresolved: ${stopping.reason || 'unknown failure'}`,
          'operation-transition-failed',
          durableOperationId,
        );
      }
      throw new Error(`Failed to begin stopping: ${stopping.reason}`);
    }
    entry.record = stopping.record;

    let terminationConfirmed;
    try {
      terminationConfirmed = await this.#terminateChild(entry.child, stopping.record);
    } catch (error) {
      if (durableOperationOwner) {
        this.#rememberAttention(
          stopping.record,
          `child termination failed; durable operation remains unresolved: ${error?.message || String(error)}`,
          'operation-transition-failed',
          durableOperationId,
        );
      }
      throw error;
    }
    if (terminationConfirmed === false) {
      const error = new Error(`Child ${incarnation} is still running; durable stopping record retained for retry`);
      error.code = 'GUARDIAN_CHILD_STILL_RUNNING';
      if (durableOperationOwner) {
        this.#rememberAttention(
          stopping.record,
          `child termination remains unresolved; durable operation remains fenced: ${error.message}`,
          'operation-transition-failed',
          durableOperationId,
        );
      }
      throw error;
    }
    entry.terminationConfirmed = true;

    let retired;
    try {
      retired = await this.#protocol.retire({
        incarnation,
        expectedRevision: stopping.record.revision,
        allowExpired: true,
      });
      if (!retired.ok) {
        throw new Error(`Failed to retire: ${retired.reason}`);
      }
    } catch (error) {
      if (durableOperationOwner) {
        this.#rememberAttention(
          stopping.record,
          `retire transition failed; durable operation remains unresolved: ${error?.message || String(error)}`,
          'operation-transition-failed',
          durableOperationId,
        );
      }
      // Keep the child entry and its durable `stopping` record so an
      // administrative retry can revalidate and finish termination.
      throw error;
    }
    entry.record = retired.record;
    const operationIds = this.#operationIds(entry);
    const resolvedOperationIds = [];
    for (const candidateOperationId of operationIds) {
      if (await this.#resolveDurableOperation(candidateOperationId, retired.record)) {
        resolvedOperationIds.push(candidateOperationId);
      }
    }
    if (resolvedOperationIds.length !== operationIds.length) {
      this.#rememberAttention(
        retired.record,
        'terminal child cleanup completed but durable operation resolution remains unresolved; retaining lifecycle handles',
        'operation-resolution-failed',
        operationIds,
      );
      const error = new Error(`Failed to resolve durable stop operation for ${incarnation}`);
      error.code = 'GUARDIAN_OPERATION_RESOLUTION_UNCERTAIN';
      throw error;
    }
    if (this.#entryRequiresCredential(entry) && entry.credentialRemoved !== true) {
      const credentialReconciled = await this.#reconcileTerminalCredential(retired.record);
      if (!credentialReconciled) {
        throw new Error('Managed OpenCode credential removal remains unresolved after terminal operation resolution');
      }
      entry.credentialRemoved = true;
    }
    this.#clearResolvedOperationIds(incarnation, resolvedOperationIds);
    if (this.#operationIds(this.#attention.get(incarnation)).length === 0) {
      this.#children.delete(incarnation);
      this.#attention.delete(incarnation);
    }

    this.#log(`[guardian] stopped child ${incarnation}`);
    return retired.record;
  }

  async #terminateChild(child, record = null) {
    // W-D: on Windows, route live children through their process handle and
    // rehydrated children through the retained-handle helper (no PID-only
    // taskkill fallback). The Unix branch below is preserved byte-for-byte
    // for Linux behavior parity.
    if (process.platform === 'win32') {
      if (record && !this.#isProcessDefinitelyGone(record.pid)) {
        const identityFailure = this.#validateProcessIdentity(record, this.#inspectProcess(record.pid, record), {
          requireLaunch: child?.isRehydrated === true,
        });
        if (identityFailure) {
          throw new Error(`Windows child identity validation failed: ${identityFailure}`);
        }
      }
      const rehydrated = child?.isRehydrated === true;
      const result = await terminateChildWindows(child, {
        timeoutMs: this.#stopSignalTimeoutMs,
        ...(typeof this.#processLiveness === 'function'
          ? { isProcessAlive: this.#processLiveness }
          : {}),
        ...(rehydrated
          ? {
            terminateByHandle: (target) => this.#windowsHandleTerminator(target, { record }),
          }
          : {}),
      });
      if (!result?.ok) {
        throw new Error(`Windows child termination failed: ${result?.reason || 'still-running'}`);
      }
      return true;
    }
    const pid = child?.pid;
    if (!pid) return true;

    const rehydrated = child?.isRehydrated === true;

    const validateRehydratedIdentityBeforeSignal = (signal) => {
      if (!record || !rehydrated) return { gone: false };
      // A definitely exited process is safe to retire without signaling. The
      // synthetic child may emit close only from this authoritative check.
      if (typeof child.confirmExit === 'function' && child.confirmExit(signal)) {
        return { gone: true };
      }
      const identityFailure = this.#validateRehydratedRecordIdentity(record, pid);
      if (identityFailure) {
        throw new Error(`POSIX child identity validation failed: ${identityFailure}`);
      }
      return { gone: false };
    };

    const hasChildProcessExited = () =>
      !child || child.exitCode !== null || child.signalCode !== null;

    if (hasChildProcessExited()) return;

    const waitForClose = (timeoutMs) => new Promise((resolve) => {
      if (hasChildProcessExited()) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(hasChildProcessExited()), timeoutMs);
      child.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    const waitForRehydratedExit = (timeoutMs, signal) => new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        if (typeof child.confirmExit === 'function' && child.confirmExit(signal)) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(check, Math.min(25, Math.max(1, deadline - Date.now())));
      };
      check();
    });

    const waitForTermination = (timeoutMs, signal) => rehydrated
      ? waitForRehydratedExit(timeoutMs, signal)
      : waitForClose(timeoutMs);

    // SIGTERM to process group.
    const beforeTerm = validateRehydratedIdentityBeforeSignal('SIGTERM');
    if (beforeTerm.gone) return true;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Ignore.
    }
    if (!rehydrated || !validateRehydratedIdentityBeforeSignal('SIGTERM').gone) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore.
      }
    }

    if (await waitForTermination(this.#stopSignalTimeoutMs, 'SIGTERM')) {
      return true;
    }

    // SIGKILL.
    const beforeKill = validateRehydratedIdentityBeforeSignal('SIGKILL');
    if (beforeKill.gone) return true;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Ignore.
    }
    if (!rehydrated || !validateRehydratedIdentityBeforeSignal('SIGKILL').gone) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore.
      }
    }

    const terminated = await waitForTermination(this.#stopKillTimeoutMs, 'SIGKILL');
    if (!terminated) {
      const error = new Error(`POSIX child ${pid} is still running after termination signals`);
      error.code = 'GUARDIAN_CHILD_STILL_RUNNING';
      return false;
    }
    return true;
  }

  async healthCheck({ incarnation } = {}) {
    return this.#runCredentialOperation(
      incarnation,
      () => this.#healthCheckInternal({ incarnation }),
    );
  }

  async healthCheckForOwner({ incarnation, owner } = {}) {
    return this.#runCredentialOperation(incarnation, async () => {
      const entry = this.#children.get(incarnation);
      if (!entry) {
        throw new Error(`Child not found: ${incarnation}`);
      }
      this.#assertOwnerMatch(entry, owner, false);
      return this.#healthCheckInternal({ incarnation, entry, owner });
    });
  }

  async #healthCheckInternal({ incarnation, entry: suppliedEntry, owner } = {}) {
    const entry = suppliedEntry ?? this.#children.get(incarnation);
    if (!entry) {
      throw new Error(`Child not found: ${incarnation}`);
    }

    const identityFailure = this.#validateRehydratedIdentity(entry);
    if (identityFailure) {
      return { healthy: false, reason: identityFailure };
    }

    let record = entry.record;
    if (typeof this.#protocol.readRecord === 'function') {
      let loaded;
      try {
        loaded = await this.#protocol.readRecord({
          incarnation,
          allowExpired: isExpiredRecoveryState(record?.state),
        });
      } catch {
        loaded = null;
      }
      if (!loaded?.ok) {
        this.#rememberAttention(
          record,
          'authoritative child record is unavailable for health',
          'identity-uncertain',
        );
        return { healthy: false, reason: 'authoritative child record is unavailable' };
      }
      record = loaded.record;
      if (record.incarnation !== incarnation || (owner && (
        record.ownerInstanceId !== owner.ownerInstanceId
        || record.runtimeIdentity !== owner.runtimeIdentity
        || record.launchFingerprint !== owner.launchFingerprint
      ))) {
        throw new Error('Guardian child ownership identity does not match');
      }
      entry.record = record;
    }

    let credential;
    try {
      credential = await this.#readCredential(record, {
        required: this.#entryRequiresCredential(entry),
      });
    } catch {
      entry.credentialError = true;
      this.#rememberAttention(
        record,
        'managed OpenCode credential is unavailable; refusing unauthenticated health',
        'credential-unavailable',
      );
      return { healthy: false, reason: 'managed OpenCode credential is unavailable' };
    }

    const health = await this.#probeHealth(record, { credential });
    if (health.credentialProofFailed) {
      this.#rememberAttention(
        record,
        health.reason || 'managed OpenCode health proof failed; refusing credential delivery',
        'credential-proof-failed',
      );
      return {
        healthy: false,
        ...(health.status === undefined ? {} : { status: health.status }),
        reason: health.reason || 'managed OpenCode health proof failed; refusing credential delivery',
      };
    }
    if (health.credentialUnavailable) {
      entry.credentialError = true;
      this.#rememberAttention(
        record,
        'managed OpenCode credential was rejected by the child',
        'credential-rejected',
      );
      return { healthy: false, reason: 'managed OpenCode credential was rejected', status: health.status };
    }
    if (health.healthy && entry.rehydrated) {
      // A health response proves only that something answered on the port.
      // Revalidate the persisted process identity after the response and
      // before returning healthy to an adopter or lifecycle caller.
      const postHealthIdentityFailure = this.#validateRehydratedRecordIdentity(record, record.pid);
      if (postHealthIdentityFailure) {
        this.#rememberAttention(record, postHealthIdentityFailure, 'identity-uncertain');
        return { healthy: false, reason: postHealthIdentityFailure };
      }
    }
    if (health.healthy) {
      if (this.#operationIds(this.#attention.get(entry.incarnation)).length === 0) {
        this.#attention.delete(entry.incarnation);
      }
      entry.credentialError = false;
    } else {
      this.#rememberAttention(
        record,
        health.reason || 'managed OpenCode health check failed transiently',
        'health-failure',
      );
    }
    return {
      healthy: health.healthy,
      ...(health.status === undefined ? {} : { status: health.status }),
      ...(!health.healthy && health.reason ? { reason: health.reason } : {}),
    };
  }

  async getCredential({ incarnation, owner } = {}) {
    return this.#runCredentialOperation(
      incarnation,
      () => this.#getCredentialInternal({ incarnation, owner }),
    );
  }

  async #getCredentialInternal({ incarnation, owner } = {}) {
    const entry = this.#children.get(incarnation);
    if (!entry) {
      throw new Error(`Child not found: ${incarnation}`);
    }
    this.#assertOwnerMatch(entry, owner, false);
    if (!this.#entryRequiresCredential(entry) || entry.credentialRemoved === true) {
      throw credentialUnavailable();
    }

    let record = entry.record;
    if (typeof this.#protocol.readRecord === 'function') {
      const loaded = await this.#protocol.readRecord({
        incarnation,
        allowExpired: isExpiredRecoveryState(record?.state),
      });
      if (!loaded?.ok) throw credentialUnavailable();
      record = loaded.record;
      if (
        record.incarnation !== incarnation
        || record.ownerInstanceId !== entry.owner?.ownerInstanceId
        || record.runtimeIdentity !== entry.owner?.runtimeIdentity
        || record.launchFingerprint !== entry.owner?.launchFingerprint
      ) {
        throw credentialUnavailable();
      }
      entry.record = record;
    }
    if (![
      ManagedOpenCodeHandoffV2State.Active,
      ManagedOpenCodeHandoffV2State.HandoffPrepared,
      ManagedOpenCodeHandoffV2State.Claimed,
    ].includes(record.state)) {
      throw credentialUnavailable();
    }

    try {
      return await this.#readCredential(record);
    } catch {
      throw credentialUnavailable();
    }
  }

  async confirmAdoption(options = {}) {
    return this.#enqueueMutation(() => this.#runCredentialOperation(
      options.incarnation,
      () => this.#confirmAdoptionInternal(options),
    ));
  }

  async #confirmAdoptionInternal({ incarnation, owner, expected } = {}) {
    const entry = this.#children.get(incarnation);
    if (!entry) throw new Error(`Child not found: ${incarnation}`);
    this.#assertOwnerMatch(entry, owner, false);
    this.#assertRehydratedIdentity(entry);
    if (!expected || !Number.isSafeInteger(expected.revision)
      || !Number.isSafeInteger(expected.leaseExpiresAt)
      || typeof expected.mac !== 'string' || expected.mac.length === 0) {
      throw new Error('Guardian adoption confirmation requires a complete record binding');
    }

    const readCurrent = async () => {
      const loaded = await this.#protocol.readRecord({ incarnation });
      if (!loaded?.ok) throw new Error(`Guardian adoption record is unavailable: ${loaded?.reason || 'read-failed'}`);
      const record = loaded.record;
      if (record.state !== ManagedOpenCodeHandoffV2State.Active
        || record.revision !== expected.revision
        || record.leaseExpiresAt !== expected.leaseExpiresAt
        || record.mac !== expected.mac
        || record.ownerInstanceId !== owner.ownerInstanceId
        || record.runtimeIdentity !== owner.runtimeIdentity
        || record.launchFingerprint !== owner.launchFingerprint) {
        throw new Error('Guardian adoption record binding changed');
      }
      entry.record = record;
      return record;
    };

    const first = await readCurrent();
    const firstCredential = await this.#readCredential(first, {
      required: this.#entryRequiresCredential(entry),
    });
    const firstHealth = await this.#healthCheckInternal({ incarnation, entry, owner });
    if (firstHealth?.healthy !== true) throw new Error('Guardian adoption health confirmation failed');

    // Health performs its own authoritative record/credential read. Read the
    // credential once more after that probe and require the same value before
    // the final CAS, so a credential mutation after the earlier read fails
    // closed instead of restoring stale web auth state.
    const final = await readCurrent();
    const finalCredential = await this.#readCredential(final, {
      required: this.#entryRequiresCredential(entry),
    });
    if (firstCredential && finalCredential
      && (firstCredential.username !== finalCredential.username
        || firstCredential.password !== finalCredential.password)) {
      throw new Error('Guardian adoption credential changed');
    }
    const finalHealth = await this.#healthCheckInternal({ incarnation, entry, owner });
    if (finalHealth?.healthy !== true) throw new Error('Guardian adoption final health confirmation failed');
    const committed = await this.#protocol.confirmRecord({
      incarnation,
      expectedRevision: expected.revision,
      expectedLeaseExpiresAt: expected.leaseExpiresAt,
      expectedMac: expected.mac,
    });
    if (!committed?.ok) throw new Error(`Guardian adoption record CAS failed: ${committed?.reason || 'unknown failure'}`);
    return {
      record: committed.record,
      credential: finalCredential,
      health: { healthy: true },
    };
  }

  async getTerminalStatus(options = {}) {
    return this.#runCredentialOperation(
      options.incarnation,
      () => this.#getTerminalStatusInternal(options),
    );
  }

  async #getTerminalStatusInternal({ incarnation, owner } = {}) {
    if (typeof incarnation !== 'string' || incarnation.length === 0) {
      throw new Error('Guardian terminal status requires an incarnation');
    }
    if (typeof this.#protocol.readRecord !== 'function') {
      throw new Error('Guardian terminal status is unavailable');
    }
    const loaded = await this.#protocol.readRecord({ incarnation, allowExpired: true });
    if (!loaded?.ok) {
      const error = new Error(`Guardian terminal record is unavailable: ${loaded?.reason || 'read-failed'}`);
      error.code = loaded?.reason === 'record-absent'
        ? 'GUARDIAN_TERMINAL_RECORD_ABSENT'
        : 'GUARDIAN_TERMINAL_RECORD_UNAVAILABLE';
      throw error;
    }
    const record = loaded.record;
    if (![ManagedOpenCodeHandoffV2State.Interrupted, ManagedOpenCodeHandoffV2State.Retired]
      .includes(record.state)) {
      throw new Error('Guardian terminal record is not terminal');
    }
    this.#assertRecordOwnerMatch(record, owner);
    return { record };
  }

  async confirmTerminal(options = {}) {
    return this.#enqueueMutation(() => this.#runCredentialOperation(
      options.incarnation,
      () => this.#confirmTerminalInternal(options),
    ));
  }

  async #confirmTerminalInternal({ incarnation, owner, expected } = {}) {
    const status = await this.#getTerminalStatusInternal({ incarnation, owner });
    if (!expected || !Number.isSafeInteger(expected.revision)
      || !Number.isSafeInteger(expected.leaseExpiresAt)
      || typeof expected.mac !== 'string' || expected.mac.length === 0
      || status.record.revision !== expected.revision
      || status.record.leaseExpiresAt !== expected.leaseExpiresAt
      || status.record.mac !== expected.mac) {
      throw new Error('Guardian terminal record binding changed');
    }
    const committed = await this.#protocol.confirmRecord({
      incarnation,
      expectedRevision: expected.revision,
      expectedLeaseExpiresAt: expected.leaseExpiresAt,
      expectedMac: expected.mac,
      allowExpired: true,
    });
    if (!committed?.ok) {
      throw new Error(`Guardian terminal record CAS failed: ${committed?.reason || 'unknown failure'}`);
    }
    return { record: committed.record };
  }

  async prepareHandoff(options = {}) {
    return this.#enqueueMutation(() => this.#prepareHandoff(options));
  }

  async #prepareHandoff({ incarnation, owner, administrative = false, operationId }) {
    return this.#runCredentialOperation(
      incarnation,
      () => this.#prepareHandoffInternal({ incarnation, owner, administrative, operationId }),
    );
  }

  async #prepareHandoffInternal({ incarnation, owner, administrative = false, operationId }) {
    const entry = this.#children.get(incarnation);
    if (!entry) {
      throw new Error(`Child not found: ${incarnation}`);
    }
    this.#assertOwnerMatch(entry, owner, administrative);
    this.#assertRehydratedIdentity(entry);

    const record = entry.record;
    if (typeof this.#protocol.prepareHandoff !== 'function') {
      throw new Error('Guardian handoff protocol cannot prepare a handoff');
    }
    const durableOperationId = operationId || createOperationId();
    const normalizedOwner = normalizeManagedOpenCodeHandoffV2OwnerIdentity(owner ?? entry.owner ?? {});
    const durableOperationOwner = normalizedOwner && Object.values(normalizedOwner).every((value) => value !== null)
      ? normalizedOwner
      : null;
    if (!administrative && !durableOperationOwner) {
      throw new Error('Guardian prepare requires a complete owner identity for durable operation fencing');
    }
    if (durableOperationOwner) {
      await this.#createDurableOperation({
        operationId: durableOperationId,
        kind: ManagedOpenCodeHandoffV2OperationKind.PrepareHandoff,
        record,
        owner: durableOperationOwner,
      });
      this.#rememberEntryOperation(entry, durableOperationId);
    }
    let prepared;
    try {
      prepared = await this.#protocol.prepareHandoff({
        incarnation,
        expectedRevision: record.revision,
      });
      if (!prepared?.ok) throw new Error(`Failed to prepare handoff: ${prepared?.reason || 'unknown failure'}`);
    } catch (error) {
      if (durableOperationOwner) {
        this.#rememberAttention(
          record,
          `prepare handoff transition failed; durable operation remains unresolved: ${error?.message || String(error)}`,
          'operation-transition-failed',
          durableOperationId,
        );
      }
      throw error;
    }

    // Update local tracking.
    entry.record = prepared.record;
    if (durableOperationOwner && !(await this.#resolveDurableOperation(durableOperationId, prepared.record))) {
      this.#rememberAttention(
        prepared.record,
        'prepared handoff is live but durable operation resolution remains unresolved',
        'operation-resolution-failed',
        durableOperationId,
      );
    }
    this.#log(`[guardian] prepared handoff for ${incarnation}`);
    return prepared.record;
  }

  async abortHandoff(options = {}) {
    return this.#enqueueMutation(() => this.#abortHandoff(options));
  }

  async #abortHandoff({ incarnation, owner, administrative = false, operationId }) {
    return this.#runCredentialOperation(
      incarnation,
      () => this.#abortHandoffInternal({ incarnation, owner, administrative, operationId }),
    );
  }

  async #abortHandoffInternal({ incarnation, owner, administrative = false, operationId }) {
    const entry = this.#children.get(incarnation);
    if (!entry) throw new Error(`Child not found: ${incarnation}`);
    this.#assertOwnerMatch(entry, owner, administrative);
    this.#assertRehydratedIdentity(entry);
    const record = entry.record;
    const normalizedOwner = normalizeManagedOpenCodeHandoffV2OwnerIdentity(owner ?? {});
    const durableOperationOwner = normalizedOwner && Object.values(normalizedOwner).every((value) => value !== null)
      ? normalizedOwner
      : null;
    const durableOperationId = operationId || createOperationId();
    if (!administrative && !durableOperationOwner) {
      throw new Error('Guardian abort requires a complete owner identity for durable operation fencing');
    }
    if (durableOperationOwner) {
      await this.#createDurableOperation({
        operationId: durableOperationId,
        kind: ManagedOpenCodeHandoffV2OperationKind.AbortHandoff,
        record,
        owner: durableOperationOwner,
      });
      this.#rememberEntryOperation(entry, durableOperationId);
    }
    let active;
    try {
      active = await this.#protocol.abortHandoff({
        incarnation,
        expectedRevision: record.revision,
      });
      if (!active.ok) throw new Error(`Failed to abort handoff: ${active.reason}`);
    } catch (error) {
      if (durableOperationOwner) {
        this.#rememberAttention(
          record,
          `abort handoff transition failed; durable operation remains unresolved: ${error?.message || String(error)}`,
          'operation-transition-failed',
          durableOperationId,
        );
      }
      throw error;
    }
    entry.record = active.record;
    if (durableOperationOwner && !(await this.#resolveDurableOperation(durableOperationId, active.record))) {
      this.#rememberAttention(
        active.record,
        'aborted handoff is live but durable operation resolution remains unresolved',
        'operation-resolution-failed',
        durableOperationId,
      );
    }
    return active.record;
  }

  async listChildren() {
    const results = [];
    for (const [incarnation, entry] of this.#children) {
      if (entry.credentialError || this.#attention.has(incarnation)) continue;
      const loaded = await this.#protocol.readRecord({
        incarnation,
        allowExpired: isExpiredRecoveryState(entry.record?.state),
      });
      if (loaded.ok) {
        results.push(loaded.record);
      } else {
        results.push({
          incarnation,
          pid: entry.pid,
          port: entry.port,
          state: 'unknown',
          error: loaded.reason,
        });
      }
    }
    results.push(...this.#attention.values());
    return results;
  }

  async cleanup() {
    try {
      // Terminal records remain the recovery handle until their credential
      // removal is confirmed. Reconcile first, then keep unresolved attention
      // incarnations out of time-based store cleanup so a transient removal
      // failure remains retryable after the periodic pass.
      await this.#reconcileAttentionRecords();
      // Pending operation horizons cannot be deleted by generic cleanup.
      // Once the authoritative confirmation horizon has elapsed, transition
      // them through the signed protocol first; failures retain the pending
      // row as the recovery handle instead of leaving an unclassified timeout.
      if (typeof this.#store.listOperations === 'function'
        && typeof this.#protocol.expireOperation === 'function') {
        const operations = await this.#store.listOperations();
        if (!Array.isArray(operations)) throw new Error('Guardian operation cleanup returned an invalid list');
        for (const operation of operations) {
          if (operation.state !== 'pending') continue;
          const expired = await this.#protocol.expireOperation({
            operationId: operation.operationId,
            expectedRevision: operation.revision,
            expectedConfirmationExpiresAt: operation.confirmationExpiresAt,
            expectedMac: operation.mac,
          });
          if (!expired?.ok && !['operation-not-expired', 'operation-expired'].includes(expired?.reason)) {
            this.#log(`[guardian] retaining unresolved durable operation ${operation.operationId}: ${expired?.reason || 'expiry failed'}`);
          }
        }
      }
      const protectedIncarnations = [...this.#attention.keys()];
      const result = await this.#store.cleanup({ protectedIncarnations });
      this.#log(`[guardian] cleanup removed ${result.removed} expired record(s)`);
      return result;
    } catch (error) {
      this.#log(`[guardian] cleanup error: ${error.message}`);
      throw error;
    }
  }

  startTimers() {
    this.stopTimers();

    // Rehydration can discover terminal credential-cleanup attention before
    // the timer pair is installed. Re-arm those durable retries at the timer
    // boundary so a same-process restart is not required for H3 recovery.
    for (const attention of this.#attention.values()) {
      if (attention.kind === 'confirmed-death-cleanup'
        || attention.kind === 'confirmed-death-cleanup-failed'
        || attention.kind === 'reserved-reconciliation-failed'
        || attention.state === ManagedOpenCodeHandoffV2State.Reserved) {
        this.#scheduleAttentionRetry(attention.incarnation);
      }
    }

    if (this.#healthCheckIntervalMs > 0) {
      this.#timers.push(setInterval(async () => {
        for (const [incarnation] of this.#children) {
          try {
            await this.healthCheck({ incarnation });
          } catch {
            // Health check failures don't auto-restart per spec.
          }
        }
      }, this.#healthCheckIntervalMs));
    }

    if (this.#leaseRenewalIntervalMs > 0) {
      this.#timers.push(setInterval(async () => {
        for (const [incarnation, entry] of this.#children) {
          try {
            const loaded = await this.#protocol.readRecord({ incarnation });
            if (!loaded.ok) continue;
            const record = loaded.record;
            if (record.state !== ManagedOpenCodeHandoffV2State.Active) continue;
            const renewed = await this.#protocol.renewLease({
              incarnation,
              expectedRevision: record.revision,
              leaseMs: DEFAULT_LEASE_MS,
            });
            if (
              renewed?.ok
              && this.#children.get(incarnation) === entry
              && entry.record?.revision === record.revision
            ) {
              entry.record = renewed.record;
            }
          } catch {
            // Ignore renewal failures.
          }
        }
      }, this.#leaseRenewalIntervalMs));
    }

    if (this.#cleanupIntervalMs > 0) {
      this.#timers.push(setInterval(async () => {
        try {
          await this.cleanup();
        } catch {
          // Ignore cleanup failures.
        }
      }, this.#cleanupIntervalMs));
    }
  }

  stopTimers() {
    for (const timer of this.#timers) {
      clearInterval(timer);
    }
    this.#timers = [];
    for (const timer of this.#reservedAttentionRetryTimers.values()) clearTimeout(timer);
    this.#reservedAttentionRetryTimers.clear();
    this.#reservedAttentionRetryAttempts.clear();
  }
}

export function createManagedOpenCodeGuardian(options = {}) {
  const {
    rootDir,
    store: customStore,
    credentialStore: customCredentialStore,
    protocol: customProtocol,
    secretProvider: customSecretProvider,
    ...rest
  } = options;

  const secretProvider = customSecretProvider ?? createManagedOpenCodeHandoffV2SecretProvider({ rootDir });
  const store = customStore ?? createManagedOpenCodeHandoffV2Store({ rootDir });
  const credentialStore = customCredentialStore ?? createManagedOpenCodeCredentialStore({
    rootDir,
    secretProvider,
    username: rest.username,
    aclInspector: rest.aclInspector,
    reparseChecker: rest.reparseChecker,
    log: rest.log,
  });
  const protocol = customProtocol ?? createManagedOpenCodeHandoffV2Protocol({
    secretProvider,
    store,
  });

  return new ManagedOpenCodeGuardian({
    store,
    credentialStore,
    protocol,
    secretProvider,
    rootDir,
    ...rest,
  });
}
