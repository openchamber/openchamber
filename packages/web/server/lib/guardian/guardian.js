import { spawn as defaultSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';

/**
 * Managed OpenCode Guardian.
 *
 * Trust boundary (Phase 2B):
 *   The guardian is the sole authoritative owner of an `Active` v2 record for
 *   a given incarnation on this host. Bootstrap adoption from the lifecycle
 *   startup path uses `client.list()` and trusts the returned
 *   `(pid, port, incarnation)` tuple. This is intentional — the bootstrap
 *   scenario finds a child that already reached `Active` (no spawn-time
 *   `claimCapability` exists), so there is no protocol-level credential to
 *   hand to a would-be `adopt()` RPC.
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
 *       user via `applyDiscoveryFileAcl` before it is atomically
 *       renamed to its final name.
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
  canonicalizeManagedOpenCodeHandoffV2Record,
  normalizeManagedOpenCodeHandoffV2Record,
} from '../opencode/managed-opencode-handoff-v2/record.js';
import { createManagedOpenCodeHandoffV2Store } from '../opencode/managed-opencode-handoff-v2/store.js';
import { createManagedOpenCodeHandoffV2Protocol } from '../opencode/managed-opencode-handoff-v2/protocol.js';
import { createManagedOpenCodeHandoffV2SecretProvider } from '../opencode/managed-opencode-handoff-v2/secret-provider.js';
import { resolveManagedOpenCodeHandoffV2Root } from '../opencode/managed-opencode-handoff-v2/filesystem.js';
import { GuardianIpcServer } from './ipc-server.js';
import { terminateChildWindows } from './windows-process.js';

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 5000;
const DEFAULT_LEASE_RENEWAL_INTERVAL_MS = 30000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60000;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const STOP_SIGNAL_TIMEOUT_MS = 2500;
const STOP_KILL_TIMEOUT_MS = 1000;
const BOOT_TIME_PATH = '/proc/1';
const ZERO_MAC = Buffer.alloc(32).toString('base64url');

const isSafeNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

const getBootTime = () => {
  if (process.platform === 'win32') {
    return 0;
  }
  try {
    const stat = fs.statSync(BOOT_TIME_PATH);
    return Math.floor(stat.ctimeMs);
  } catch {
    return 0;
  }
};

const defaultLog = (message) => {
  // eslint-disable-next-line no-console
  console.log(message);
};

const expectedRecord = (record) => ({
  revision: record.revision,
  mac: record.mac,
  leaseExpiresAt: record.leaseExpiresAt,
});

const nextRevision = (record) =>
  record.revision < Number.MAX_SAFE_INTEGER ? record.revision + 1 : null;

const defaultSocketPath = (rootDir) => path.join(
  resolveManagedOpenCodeHandoffV2Root(rootDir),
  'guardian.sock',
);

export class ManagedOpenCodeGuardian {
  #store;
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
  #started = false;
  #rootDir;
  #spawnFn;

  constructor({
    store,
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

    this.#store = store;
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
    this.#socketPath = socketPath ?? defaultSocketPath(rootDir);
    this.#portPath = typeof portPath === 'string' && portPath.length > 0 ? portPath : undefined;
    this.#username = typeof username === 'string' && username.length > 0 ? username : undefined;
    this.#log = log;
    this.#spawnFn = spawnFn;
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

  async start() {
    if (this.#started) {
      throw new Error('ManagedOpenCodeGuardian is already started');
    }
    // W-C: the `process.platform === 'win32'` rejection is removed.
    // The transport factory inside `GuardianIpcServer.start()` dispatches
    // per-platform: Linux uses the Unix-domain socket bound to
    // `this.#socketPath`; Windows uses loopback TCP + discovery file
    // bound to `this.#portPath`.

    this.#log('[guardian] starting');
    this.#started = true;

    this.#ipcServer = new GuardianIpcServer({
      socketPath: this.#socketPath,
      portPath: this.#portPath,
      username: this.#username,
      guardian: this,
      log: this.#log,
    });
    await this.#ipcServer.start();
    this.startTimers();
    this.#log('[guardian] started');
  }

  async stop() {
    if (!this.#started) {
      return;
    }
    this.#log('[guardian] stopping');
    this.stopTimers();

    // Stop all tracked children.
    const children = Array.from(this.#children.entries());
    for (const [incarnation] of children) {
      try {
        await this.stopChild({ incarnation });
      } catch (error) {
        this.#log(`[guardian] error stopping child ${incarnation}: ${error.message}`);
      }
    }
    this.#children.clear();

    if (this.#ipcServer) {
      await this.#ipcServer.stop();
      this.#ipcServer = null;
    }

    try {
      await this.#store.close();
    } catch (error) {
      this.#log(`[guardian] error closing store: ${error.message}`);
    }

    this.#started = false;
    this.#log('[guardian] stopped');
  }

  async spawnManagedOpenCode({ port, hostname, binary, cwd, env, leaseMs = DEFAULT_LEASE_MS }) {
    if (!isSafeNonNegativeInteger(port) || port <= 0 || port > 65535) {
      throw new TypeError('Invalid port');
    }
    if (typeof binary !== 'string' || binary.length === 0) {
      throw new TypeError('Invalid binary');
    }
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new TypeError('Invalid cwd');
    }

    this.#log(`[guardian] spawning managed OpenCode on port ${port}`);

    // 1. Reserve launch.
    const reservation = await this.#protocol.reserveLaunch({ leaseMs });
    if (!reservation.ok) {
      throw new Error(`Failed to reserve launch: ${reservation.reason}`);
    }
    const incarnation = reservation.record.incarnation;

    let child;
    try {
      // 2. Begin launch with credential.
      const launching = await this.#protocol.beginLaunch({
        incarnation,
        expectedRevision: reservation.record.revision,
        withCredential: async (credential) => {
          try {
            const credentialFingerprint = createHmac('sha256', credential)
              .update(Buffer.from(incarnation, 'base64url'))
              .digest('base64url');
            this.#log(`[guardian] armed credential for ${incarnation} (fingerprint: ${credentialFingerprint.slice(0, 8)}...)`);
          } finally {
            credential?.fill(0);
          }
        },
      });

      if (!launching.ok) {
        throw new Error(`Failed to begin launch: ${launching.reason}`);
      }

      // 3. Spawn child process.
      const spawnArgs = ['serve', '--hostname', hostname ?? '127.0.0.1', '--port', String(port)];
      const spawnFn = this.#spawnFn ?? defaultSpawn;
      child = spawnFn(binary, spawnArgs, {
        cwd,
        env,
        detached: true,
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
          stdout += chunk.toString();
          const lines = stdout.split('\n');
          for (const line of lines) {
            if (!line.startsWith('opencode server listening')) continue;
            const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
            if (!match) {
              finish(reject, new Error(`Failed to parse server url from output: ${line}`));
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
          port,
          processStartTicks: getBootTime(),
        },
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
        port,
        url,
        incarnation,
        record: active.record,
      });

      this.#log(`[guardian] spawned OpenCode pid=${child.pid} port=${port} incarnation=${incarnation}`);
      return { incarnation, pid: child.pid, port };
    } catch (error) {
      // Terminate orphaned child and clean up v2 record on failure.
      if (child) {
        try {
          await this.#terminateChild(child);
        } catch {
          // Best-effort termination.
        }
      }
      try {
        await this.#protocol.markInterrupted({
          incarnation,
          expectedRevision: reservation.record.revision,
        });
      } catch {
        // Best-effort cleanup.
      }
      throw error;
    }
  }

  async stopChild({ incarnation }) {
    const entry = this.#children.get(incarnation);
    if (!entry) {
      throw new Error(`Child not found: ${incarnation}`);
    }

    this.#log(`[guardian] stopping child ${incarnation}`);

    const record = entry.record;
    const stopping = await this.#protocol.beginStopping({
      incarnation,
      expectedRevision: record.revision,
    });
    if (!stopping.ok) {
      throw new Error(`Failed to begin stopping: ${stopping.reason}`);
    }

    await this.#terminateChild(entry.child);

    let retired;
    try {
      retired = await this.#protocol.retire({
        incarnation,
        expectedRevision: stopping.record.revision,
      });
      if (!retired.ok) {
        throw new Error(`Failed to retire: ${retired.reason}`);
      }
    } finally {
      this.#children.delete(incarnation);
    }

    this.#log(`[guardian] stopped child ${incarnation}`);
    return retired.record;
  }

  async #terminateChild(child) {
    // W-D: on Windows, route termination through `taskkill.exe`
    // (no SIGTERM/SIGKILL escalation — those POSIX concepts do
    // not exist on Windows). The Unix branch below is preserved
    // byte-for-byte for Linux behavior parity.
    if (process.platform === 'win32') {
      return terminateChildWindows(child, { timeoutMs: STOP_SIGNAL_TIMEOUT_MS });
    }
    const pid = child?.pid;
    if (!pid) return;

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

    // SIGTERM to process group.
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Ignore.
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore.
    }

    if (await waitForClose(STOP_SIGNAL_TIMEOUT_MS)) {
      return;
    }

    // SIGKILL.
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Ignore.
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore.
    }

    await waitForClose(STOP_KILL_TIMEOUT_MS);
  }

  async healthCheck({ incarnation }) {
    const entry = this.#children.get(incarnation);
    if (!entry) {
      throw new Error(`Child not found: ${incarnation}`);
    }

    const url = `http://127.0.0.1:${entry.port}/global/health`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return { healthy: false, status: response.status };
      }
      const body = await response.json().catch(() => null);
      return { healthy: body?.healthy === true };
    } catch {
      return { healthy: false };
    }
  }

  async #signRecord(record) {
    const key = await this.#secretProvider.deriveRecordMacKey({ incarnation: record.incarnation });
    try {
      const unsigned = normalizeManagedOpenCodeHandoffV2Record({ ...record, mac: ZERO_MAC });
      if (!unsigned) throw new TypeError('Invalid record');
      const mac = createHmac('sha256', key)
        .update(canonicalizeManagedOpenCodeHandoffV2Record(unsigned))
        .digest('base64url');
      return { ...unsigned, mac };
    } finally {
      key?.fill(0);
    }
  }

  async #transitionRecord({ incarnation, expectedRevision, nextState }) {
    // Read raw record from store to get the full record including mac.
    const raw = await this.#store.read({ incarnation });
    if (!raw) throw new Error('record-absent');
    const record = raw;
    if (record.revision !== expectedRevision) {
      throw new Error('stale-revision');
    }

    const revision = nextRevision(record);
    if (revision === null) throw new Error('revision-exhausted');

    const next = await this.#signRecord({ ...record, state: nextState, revision });
    const cas = await this.#store.compareAndSwap({
      incarnation,
      expected: expectedRecord(record),
      next,
    });
    if (!cas || cas.status !== 'applied') {
      throw new Error(cas?.status || 'compare-and-swap-failed');
    }
    return next;
  }

  async prepareHandoff({ incarnation }) {
    const entry = this.#children.get(incarnation);
    if (!entry) {
      throw new Error(`Child not found: ${incarnation}`);
    }

    const record = entry.record;
    const prepared = await this.#transitionRecord({
      incarnation,
      expectedRevision: record.revision,
      nextState: ManagedOpenCodeHandoffV2State.HandoffPrepared,
    });

    // Update local tracking.
    entry.record = prepared;
    this.#log(`[guardian] prepared handoff for ${incarnation}`);
    return prepared;
  }

  async listChildren() {
    const results = [];
    for (const [incarnation, entry] of this.#children) {
      const loaded = await this.#protocol.readRecord({ incarnation });
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
            await this.#protocol.renewLease({
              incarnation,
              expectedRevision: record.revision,
              leaseMs: DEFAULT_LEASE_MS,
            });
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
    protocol: customProtocol,
    secretProvider: customSecretProvider,
    ...rest
  } = options;

  const secretProvider = customSecretProvider ?? createManagedOpenCodeHandoffV2SecretProvider({ rootDir });
  const store = customStore ?? createManagedOpenCodeHandoffV2Store({ rootDir });
  const protocol = customProtocol ?? createManagedOpenCodeHandoffV2Protocol({
    secretProvider,
    store,
  });

  return new ManagedOpenCodeGuardian({
    store,
    protocol,
    secretProvider,
    rootDir,
    ...rest,
  });
}
