import { spawn as defaultSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Managed OpenCode Guardian.
 *
 * Trust boundary (Phase 2B):
 *   The guardian is the sole authoritative owner of an `Active` v2 record for
 *   a given incarnation on this host. Bootstrap adoption from the lifecycle
 *   startup path uses `client.list()` plus exact owner-scoped health and
 *   credential RPCs after the lifecycle supplies its stable owner/runtime
 *   identity. Ownerless or ambiguous active records are surfaced as attention
 *   and are never silently attached.
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
 *       boundary (weaker than the Linux `0600` socket model because
 *       any process running as that user can read the discovery file).
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

const isSafeNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const normalizeObservedProcessStartTicks = (value) => {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return value;
  return null;
};
const isCanonicalProcessStartTicks = (value) => typeof value === 'string'
  && /^(?:0|[1-9]\d*)$/.test(value);
const isExpiredRecoveryState = (state) => state === ManagedOpenCodeHandoffV2State.Stopping
  || state === ManagedOpenCodeHandoffV2State.HandoffPrepared;

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
  // eslint-disable-next-line no-console
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
      await this.#rehydrateChildren();
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

  #rememberAttention(record, reason, kind = 'identity-uncertain') {
    const incarnation = typeof record?.incarnation === 'string' && record.incarnation.length <= 256
      ? record.incarnation
      : `invalid-${this.#attention.size + 1}`;
    const launchPort = record?.launchSpec?.port;
    const port = Number.isSafeInteger(record?.port) && record.port > 0 && record.port <= 65535
      ? record.port
      : (Number.isSafeInteger(launchPort) && launchPort > 0 && launchPort <= 65535 ? launchPort : null);
    this.#attention.set(incarnation, {
      state: 'attention',
      attention: true,
      incarnation,
      ...(typeof record?.ownerInstanceId === 'string' ? { ownerInstanceId: record.ownerInstanceId } : {}),
      ...(typeof record?.runtimeIdentity === 'string' ? { runtimeIdentity: record.runtimeIdentity } : {}),
      ...(Number.isSafeInteger(record?.pid) && record.pid > 0 ? { pid: record.pid } : {}),
      ...(port !== null ? { port } : {}),
      kind,
      reason,
    });
  }

  async #reconcileAttentionRecords() {
    if (this.#attention.size === 0 || typeof this.#protocol.readRecord !== 'function') return;

    for (const incarnation of this.#attention.keys()) {
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
        this.#attention.delete(incarnation);
        continue;
      }
      if (
        loaded?.ok
        && (
          loaded.record?.state === ManagedOpenCodeHandoffV2State.Interrupted
          || loaded.record?.state === ManagedOpenCodeHandoffV2State.Retired
        )
      ) {
        if (!this.#allowUnauthenticatedCredentials) {
          try {
            await this.#removeCredential(loaded.record);
          } catch (error) {
            this.#rememberAttention(
              loaded.record,
              `managed OpenCode credential removal failed; attention record retained for retry: ${error?.message || String(error)}`,
              'confirmed-death-cleanup-failed',
            );
            continue;
          }
        }
        this.#attention.delete(incarnation);
      }
    }
  }

  #assertLaunchAvailable(port, owner) {
    for (const [incarnation, entry] of this.#children) {
      const entryPort = entry.port ?? entry.record?.launchSpec?.port ?? null;
      const sameStoppingOwner = entry.record?.state === ManagedOpenCodeHandoffV2State.Stopping
        && owner
        && entry.owner?.ownerInstanceId === owner.ownerInstanceId
        && entry.owner?.runtimeIdentity === owner.runtimeIdentity;
      if (entryPort === port || !Number.isSafeInteger(entryPort) || sameStoppingOwner) {
        throw new Error(`Guardian launch blocked by unresolved child ${incarnation}`);
      }
    }

    for (const attention of this.#attention.values()) {
      const sameOwner = owner
        && attention.ownerInstanceId === owner.ownerInstanceId
        && attention.runtimeIdentity === owner.runtimeIdentity;
      if (attention.port === port || !Number.isSafeInteger(attention.port) || sameOwner) {
        throw new Error(`Guardian launch blocked by attention record ${attention.incarnation}`);
      }
    }
  }

  async #interruptLatestLaunchRecord(incarnation, fallbackRecord, { cleanupCredential = false } = {}) {
    const cleanupBeforeTerminal = async (record) => {
      if (!cleanupCredential) return true;
      try {
        await this.#removeCredential(record);
        return true;
      } catch (error) {
        this.#rememberAttention(
          record,
          `launch cleanup could not remove the managed OpenCode credential: ${error?.message || String(error)}`,
          'confirmed-death-cleanup-failed',
        );
        return false;
      }
    };

    if (typeof this.#protocol.readRecord !== 'function') {
      if (!(await cleanupBeforeTerminal(fallbackRecord))) {
        return { ok: false, reason: 'credential-cleanup-failed' };
      }
      return this.#protocol.markInterrupted({
        incarnation,
        expectedRevision: fallbackRecord.revision,
      });
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
        if (!(await cleanupBeforeTerminal(record))) {
          return { ok: false, reason: 'credential-cleanup-failed' };
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

      if (!(await cleanupBeforeTerminal(record))) {
        return { ok: false, reason: 'credential-cleanup-failed' };
      }

      const interrupted = await this.#protocol.markInterrupted({
        incarnation,
        expectedRevision: record.revision,
      });
      if (interrupted?.ok || interrupted?.reason !== 'stale-revision' || attempt === 1) {
        if (!interrupted?.ok) {
          this.#rememberAttention(record, `launch cleanup failed: ${interrupted?.reason || 'unknown failure'}`);
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

  async #cleanupCredentialBeforeTerminal(record, reason) {
    if (this.#allowUnauthenticatedCredentials) return true;
    try {
      await this.#removeCredential(record);
      return true;
    } catch (error) {
      this.#rememberAttention(
        record,
        `${reason}: ${error?.message || 'credential cleanup was not confirmed'}`,
        'confirmed-death-cleanup-failed',
      );
      return false;
    }
  }

  async #interruptConfirmedDeadRecord(record) {
    if (!(await this.#cleanupCredentialBeforeTerminal(
      record,
      'confirmed child death could not complete managed OpenCode credential cleanup',
    ))) {
      return { ok: false, reason: 'credential-cleanup-failed' };
    }
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
      );
      return { ok: false, reason: 'terminal-transition-failed' };
    }
    if (!interrupted?.ok) {
      this.#rememberAttention(
        record,
        `confirmed child death could not be terminalized: ${interrupted?.reason || 'unknown failure'}`,
        'confirmed-death',
      );
    }
    return interrupted;
  }

  async #retireConfirmedDeadRecord(record, { allowExpired = false } = {}) {
    if (!(await this.#cleanupCredentialBeforeTerminal(
      record,
      'confirmed child death could not complete managed OpenCode credential cleanup',
    ))) {
      return { ok: false, reason: 'credential-cleanup-failed' };
    }

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
        record.state === ManagedOpenCodeHandoffV2State.Reserved
        || record.state === ManagedOpenCodeHandoffV2State.LaunchDelivering
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
        await this.#interruptConfirmedDeadRecord(record);
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
      this.#attention.delete(record.incarnation);
      this.#setRehydratedChild(record, {
        credentialRequired,
      });
      this.#log(`[guardian] recovered OpenCode pid=${record.pid} port=${record.port} incarnation=${record.incarnation}`);
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
    try {
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
      this.#children.set(incarnation, {
        child,
        pid: child.pid,
        port: normalizedSpec.port,
        url,
        incarnation,
        owner: normalizedOwner,
        launchSpec: normalizedLaunchSpec,
        record: active.record,
        credentialRequired: Boolean(managedCredential),
      });

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
            { cleanupCredential: credentialPersistenceAttempted },
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

  async #removeCredential(record) {
    const removed = await this.#credentialStore.remove(this.#credentialDescriptor(record));
    if (!removed || (removed.removed !== true && removed.removed !== false)) {
      throw new Error('Managed OpenCode credential removal was not confirmed');
    }
    return removed;
  }

  async stopChild(options = {}) {
    return this.#enqueueMutation(() => this.#stopChild(options));
  }

  async #stopChild({ incarnation, owner, administrative = false }) {
    return this.#runCredentialOperation(
      incarnation,
      () => this.#stopChildInternal({ incarnation, owner, administrative }),
    );
  }

  async #stopChildInternal({ incarnation, owner, administrative = false }) {
    const entry = this.#children.get(incarnation);
    if (!entry) {
      throw new Error(`Child not found: ${incarnation}`);
    }
    this.#assertOwnerMatch(entry, owner, administrative);

    this.#log(`[guardian] stopping child ${incarnation}`);

    const record = entry.record;
    const stopping = record.state === ManagedOpenCodeHandoffV2State.Stopping
      ? { ok: true, record }
      : await this.#protocol.beginStopping({
        incarnation,
        expectedRevision: record.revision,
        allowExpired: true,
      });
    if (!stopping.ok) throw new Error(`Failed to begin stopping: ${stopping.reason}`);
    entry.record = stopping.record;

    const terminationConfirmed = await this.#terminateChild(entry.child, stopping.record);
    if (terminationConfirmed === false) {
      const error = new Error(`Child ${incarnation} is still running; durable stopping record retained for retry`);
      error.code = 'GUARDIAN_CHILD_STILL_RUNNING';
      throw error;
    }

    if (this.#entryRequiresCredential(entry) && entry.credentialRemoved !== true) {
      try {
        await this.#removeCredential(stopping.record);
        entry.credentialRemoved = true;
      } catch (error) {
        this.#rememberAttention(stopping.record, 'managed OpenCode credential removal failed; stopping record retained');
        throw error;
      }
    }

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
      // Keep the child entry and its durable `stopping` record so an
      // administrative retry can revalidate and finish termination.
      throw error;
    }
    this.#children.delete(incarnation);
    this.#attention.delete(incarnation);

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
      this.#attention.delete(entry.incarnation);
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

  async prepareHandoff(options = {}) {
    return this.#enqueueMutation(() => this.#prepareHandoff(options));
  }

  async #prepareHandoff({ incarnation, owner, administrative = false }) {
    return this.#runCredentialOperation(
      incarnation,
      () => this.#prepareHandoffInternal({ incarnation, owner, administrative }),
    );
  }

  async #prepareHandoffInternal({ incarnation, owner, administrative = false }) {
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
    const prepared = await this.#protocol.prepareHandoff({
      incarnation,
      expectedRevision: record.revision,
    });
    if (!prepared?.ok) throw new Error(`Failed to prepare handoff: ${prepared?.reason || 'unknown failure'}`);

    // Update local tracking.
    entry.record = prepared.record;
    this.#log(`[guardian] prepared handoff for ${incarnation}`);
    return prepared.record;
  }

  async abortHandoff(options = {}) {
    return this.#enqueueMutation(() => this.#abortHandoff(options));
  }

  async #abortHandoff({ incarnation, owner, administrative = false }) {
    return this.#runCredentialOperation(
      incarnation,
      () => this.#abortHandoffInternal({ incarnation, owner, administrative }),
    );
  }

  async #abortHandoffInternal({ incarnation, owner, administrative = false }) {
    const entry = this.#children.get(incarnation);
    if (!entry) throw new Error(`Child not found: ${incarnation}`);
    this.#assertOwnerMatch(entry, owner, administrative);
    this.#assertRehydratedIdentity(entry);
    const record = entry.record;
    const active = await this.#protocol.abortHandoff({
      incarnation,
      expectedRevision: record.revision,
    });
    if (!active.ok) throw new Error(`Failed to abort handoff: ${active.reason}`);
    entry.record = active.record;
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
      const result = await this.#store.cleanup();
      this.#log(`[guardian] cleanup removed ${result.removed} expired record(s)`);
      return result;
    } catch (error) {
      this.#log(`[guardian] cleanup error: ${error.message}`);
      throw error;
    }
  }

  startTimers() {
    this.stopTimers();

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
