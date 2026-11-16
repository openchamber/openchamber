import { readOpenCodeInfo, readExternalOpenCodeVersion, isSupportedOpenCodeVersion, requireOpenCodeV2, UnsupportedOpenCodeVersionError } from './compatibility.js';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { stripAppImageArgv0Leak, stripAppImageLauncherEnv, stripHostInjectedEnv } from '../inherited-env.js';
import { assignInjectedEnv } from '../injected-env.js';
import { registerManagedProcess, unregisterManagedProcess, reapOrphanedProcesses, readManagedProcessOwner, claimManagedProcess, readManagedProcessEntries, commandIdentifiesOurServer } from './managed-process-registry.js';
import { parseBoundedIntWithDefault, parsePositiveIntWithDefault } from '../shared/parse-int.js';
import {
  appendGeneration,
  clearManagedOpenCodeState,
  createEmptyManagedOpenCodeStore,
  createLaunchFingerprint,
  decideManagedOpenCodeLaunch,
  hashLaunchSecret,
  migrateV1StoreToV2,
  readDrainingOpenCodeRecords,
  readLogSince,
  readLogTail,
  readManagedOpenCodeState,
  readManagedOpenCodeStore,
  recordHandoffStep,
  reapManagedOpenCodeStore,
  resolveManagedOpenCodeStorePaths,
  rotateManagedLogIfOversized,
  sameOpenCodeArgs,
  transitionGenerationState,
  writeDrainingOpenCodeRecords,
  writeManagedOpenCodeState,
  writeManagedOpenCodeStore,
} from './managed-opencode-state.js';
import { createDrainingOpenCodeRegistry, resolveOpenCodeDrainGraceMs } from './draining-opencode.js';
import { buildManagedServersResponse } from './managed-servers.js';
import { countUpstreamRequests } from './upstream-requests.js';
import { hasChildProcessExited, stopOpenCodeByClosingStdin, waitForChildProcessClose } from './managed-process-stop.js';
import { applyProviderEnvAliases } from './provider-env-aliases.js';
import { overlayEnvironment } from '../environment/variables.js';
import { recordStartupPerformance } from './startup-performance.js';
import { topUpV1Migration } from './v1-migration-topup.js';
import { serverDiagnosticJournal } from '../diagnostics/server-journal.js';
import { readBoundedResponseJson, readBoundedResponseText } from '../shared/response-body.js';

// Socket activation hands OpenCode's listen socket to OpenChamber as fd 3. Node closes only the fds it
// opened itself, so an inherited fd 3 would reach OpenCode and keep the port open after OpenChamber exits.
const withoutInheritedListenFds = (command, args) => (process.platform === 'win32'
  ? { command, args }
  : { command: '/bin/sh', args: ['-c', 'exec 3>&-; exec "$0" "$@"', command, ...args] });

// Callback-to-promise execFile, shaped like the registry's injected
// `execFileAsync` ({ stdout, stderr }); an explicit wrapper instead of
// `promisify(execFile)`, whose custom resolution shape only exists on the
// real builtin and silently differs under test doubles.
const execFileAsync = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })));
  });

// A positive whole number from the environment, else the fallback. The
// strict plain-decimal judgement lives in shared/parse-int.js (design #802
// phase 2, #804): a bare parseInt would silently honour '5000junk' as 5000,
// truncate '5.9' to 5, and read '1e3' as a 1 ms health timeout. The exported
// name is kept for its importers.
export const parsePositiveInt = parsePositiveIntWithDefault;

// The two timer-feeding health readers are bounded at the 2^31-1 ms timer
// maximum (PR #836's pattern): an oversized value handed to setTimeout /
// setInterval / AbortSignal.timeout overflows and collapses to ~1 ms, so
// above-max falls back to the default instead. The timeout reader keeps
// positive-only semantics (min 1: '0' still means 'use the default', never
// an instantly-aborting 0 ms); the interval override keeps min 0, where an
// explicit '0' already lands today.
export const resolveHealthCheckTimeoutMs = (env = process.env) =>
  parseBoundedIntWithDefault(env.OPENCHAMBER_OPENCODE_HEALTH_TIMEOUT_MS, 5000, 1, 2_147_483_647);
export const resolveHealthCheckIntervalOverrideMs = (env = process.env) =>
  parseBoundedIntWithDefault(env.OPENCHAMBER_OPENCODE_HEALTH_INTERVAL_MS, 0, 0, 2_147_483_647);

const HEALTH_CHECK_TIMEOUT_MS = resolveHealthCheckTimeoutMs();
// `/api/info` is a fixed-shape version document; 64 KiB leaves generous headroom.
const OPENCODE_INFO_MAX_BYTES = 64 * 1024;
// Agent catalogs can carry plugin descriptions; match the 16 MiB session-list cap.
const OPENCODE_AGENT_MAX_BYTES = 16 * 1024 * 1024;
const HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES = parsePositiveInt(
  process.env.OPENCHAMBER_OPENCODE_HEALTH_CONSECUTIVE_FAILURES,
  20
);
const HEALTH_CHECK_INTERVAL_OVERRIDE_MS = resolveHealthCheckIntervalOverrideMs();
const HEALTH_CHECK_RESULT_CACHE_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_CACHE_MS, 750);
const OPENCODE_HEALTH_PATH = '/api/info';
const OPENCODE_REQUIRED_MAJOR_VERSION = 2;

/**
 * OpenChamber talks to OpenCode 2.x only. v1 serves its routes without the
 * `/api` prefix, publishes a different event vocabulary and has no `plugins`
 * config key, so an older binary fails in a hundred small ways instead of one
 * clear one.
 *
 * The version comes from the health payload rather than from `opencode
 * --version`: it costs no extra process, and it also covers an external
 * OpenCode the user started themselves. `/api/info` only exists in 2.x (2.0.8
 * removed the older `/api/health`), so a 404 there is the same answer by
 * another route. A 200 is the readiness signal; the payload has no `healthy`
 * field, only `{ version, pid, urls, paths }`.
 */
const OPENCODE_VERSION_REQUIREMENT_DETAIL =
  `OpenChamber requires OpenCode ${OPENCODE_REQUIRED_MAJOR_VERSION}.x`;

const classifyOpenCodeVersion = (version) => {
  if (typeof version !== 'string') return { ok: true };
  const match = version.match(/v?(\d+)\./);
  if (!match) return { ok: true };
  if (Number(match[1]) >= OPENCODE_REQUIRED_MAJOR_VERSION) return { ok: true };
  return {
    ok: false,
    detail: `${OPENCODE_VERSION_REQUIREMENT_DETAIL}, found ${version.trim()}. Update OpenCode and start OpenChamber again.`,
  };
};
// Only the directory the user will open anyway. On OpenCode 2 the first
// directory-scoped read boots that location's whole MCP fleet, so warming
// other projects "just in case" started processes nobody asked for (#4018).
const WARMUP_DIRECTORY_LIMIT = 1;
const WARMUP_REQUEST_TIMEOUT_MS = 30000;
const MANAGED_STDERR_TAIL_MAX_BYTES = 32 * 1024;
const MANAGED_LOG_POLL_MS = 100;
const HEALTH_FAILURE_DETAIL_MAX_LENGTH = 256;

export const getBoundedTextTail = (value, maxBytes) => {
  const buffer = Buffer.from(String(value ?? ''));
  if (buffer.byteLength <= maxBytes) return buffer.toString();
  const tail = buffer.subarray(buffer.byteLength - maxBytes);
  // Align the cut to a UTF-8 boundary (#2033): the raw byte cut can
  // land inside a multi-byte character, whose continuation bytes would
  // decode to U+FFFD at the head of the tail. Drop leading
  // continuation bytes (the guests/clone.js pattern), losing at most
  // the one straddling character.
  let start = 0;
  while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
  return tail.subarray(start).toString();
};

const sanitizeDiagnosticText = (value) => String(value ?? '')
  .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@')
  .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [redacted]')
  // Unquoted `Authorization: <scheme> <credential>` values must be handled
  // before the generic key/value rule below: that rule stops at whitespace, so
  // it would redact only the scheme word and leave the credential intact.
  // Scoped to authorization-style keys so ordinary prose using "basic" or
  // "token" is not mangled.
  .replace(
    /(^|[\s,{\[])((?:"|')?[a-z0-9_.-]{0,80}authorization[a-z0-9_.-]{0,80}(?:"|')?\s*[:=]\s*(?:"|')?(?:basic|bearer|token)\s+)[^\s,;"']+/gim,
    '$1$2[redacted]',
  )
  .replace(/([?&][^=&#\s]*(?:token|api[_-]?key|password|secret|authorization|credential|private[_-]?key)[^=&#\s]*=)[^&#\s]+/gi, '$1[redacted]')
  .replace(
    /(^|[\s,{\[])((?:"|')?[a-z0-9_.-]{0,80}(?:token|api[_-]?key|password|secret|authorization|credential|private[_-]?key)[a-z0-9_.-]{0,80}(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gim,
    '$1$2[redacted]',
  );

const getHealthFailureDetail = (error) => {
  const name = String(error?.name || 'Error');
  const message = String(error?.message || error || 'Unknown error');
  return sanitizeDiagnosticText(`${name}: ${message}`).slice(0, HEALTH_FAILURE_DETAIL_MAX_LENGTH);
};

const classifyHealthProbeError = (error) => {
  const name = String(error?.name || '');
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '');
  const normalizedMessage = message.toLowerCase();

  if (
    name === 'AbortError'
    || name === 'TimeoutError'
    || normalizedMessage.includes('the operation was aborted')
    || normalizedMessage.includes('abortsignal.timeout')
  ) {
    return { class: 'timeout', detail: getHealthFailureDetail(error) };
  }
  if (code === 'ECONNREFUSED' || normalizedMessage.includes('econnrefused')) {
    return { class: 'connection_refused', detail: getHealthFailureDetail(error) };
  }
  if (
    code === 'ECONNRESET'
    || normalizedMessage.includes('econnreset')
    || normalizedMessage.includes('socket hang up')
  ) {
    return { class: 'connection_reset', detail: getHealthFailureDetail(error) };
  }
  return { class: 'error', detail: getHealthFailureDetail(error) };
};

const SECRET_ENV_KEYS = new Set(['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD', 'OPENCHAMBER_AGENT_TOOL_TOKEN']);

const withoutSecretEnv = (env) => Object.fromEntries(
  Object.entries(env ?? {}).filter(([key]) => !SECRET_ENV_KEYS.has(key)),
);

export const createOpenCodeLifecycleRuntime = (deps) => {
  const {
    state,
    env,
    dataDir,
    syncToHmrState,
    syncFromHmrState,
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    waitForReady,
    normalizeApiPrefix,
    applyOpencodeBinaryFromSettings,
    ensureOpencodeCliEnv,
    ensureLocalOpenCodeServerPassword,
    resolveManagedOpenCodeLaunchSpec,
    setOpenCodePort,
    setDetectedOpenCodeApiPrefix,
    setupProxy,
    ensureOpenCodeApiPrefix,
    clearResolvedOpenCodeBinary,
    buildAugmentedPath,
    buildManagedOpenCodePath,
    getManagedOpenCodeShellEnvSnapshot,
    getManagedOpenCodeEnv = async () => ({}),
    // One start only: this server was launched to rotate the managed
    // credentials, so its first start must not reuse the saved pair. Later
    // starts in the same process adopt what that start wrote, as usual.
    rotateManagedCredentials = false,
    // The folder holding the managed config OpenCode reads (instance-dir.js), saved with the
    // managed state so a server that adopts this OpenCode takes the same folder over.
    getInstanceDir = () => null,
    // Whose OpenCode a recorded pid is (managed-process-registry.js), and the
    // server handing off to this one, if any. Two OpenChamber servers on one
    // data dir share state.json and draining.json; without this each took the
    // other's OpenCode for its own and retired it.
    readProcessOwner = readManagedProcessOwner,
    claimProcess = claimManagedProcess,
    getHandoffPredecessorPid = () => null,
    // Variables from Settings and `opencode service set env` (lib/environment).
    getUserEnvironment = () => ({}),
    // The same variables with vault references read; only the launch sees them.
    resolveUserEnvironment = async () => getUserEnvironment(),
    getActiveSessionCount = () => 0,
    // Defaults to the global count for runtimes that do not split out
    // space sessions; index.js wires the session runtime's host-only
    // count so the managed-servers read can use it.
    getActiveHostSessionCount = getActiveSessionCount,
    listBusySessionIds = () => [],
    spawnProcess = spawn,
    spawnSyncProcess = spawnSync,
    execFileProcess = execFileAsync,
    reapManagedOrphanedProcesses = reapOrphanedProcesses,
    readRegistryEntries = readManagedProcessEntries,
    getWarmupDirectories = async () => [],
    // Scopes server-side reads while no project directory is usable (the
    // managed chats root). Without it they name no directory, and OpenCode
    // starts a location over its own working directory, the whole home.
    noProjectDirectory = null,
    onOpenCodeRestarted = null,
    onOpenCodeHandoff = null,
    managedStartupTimeoutMs = 30_000,
    now = Date.now,
    topUpV1SessionMigration = topUpV1Migration,
    checkOpenCodeBinary = requireOpenCodeV2,
    diagnosticJournal = serverDiagnosticJournal,
  } = deps;

  let credentialRotationPending = rotateManagedCredentials === true;

  let managedPreflight = null;
  // The version the managed OpenCode last reported in its health payload,
  // kept for the managed-servers read; null until a probe has seen one.
  let lastKnownOpenCodeVersion = null;
  // The last managed process that actually became ready, with the port it
  // became ready on. The managed-servers read reports this process as the
  // own server, so a replacement that is still starting never inherits its
  // predecessor's port or readiness in the snapshot.
  let lastReadyOwnServer = null;
  // The environment the managed OpenCode was launched with. Keys OpenCode
  // takes from environment variables are never stored in it, so this is the
  // only place their values can be read back (see auth.js).
  let managedProcessEnv = null;
  const managedPaths = resolveManagedOpenCodeStorePaths(dataDir);

  const isManagedOpenCodeProcessAlive = () => {
    const child = state.openCodeProcess;
    if (!child || hasChildProcessExited(child)) return false;
    if (!child.pid) return true;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const snapshotManagedOpenCodeProcess = (child = state.openCodeProcess) => {
    if (!child) return null;
    const snapshot = {
      pid: child.pid || null,
      exitCode: child.exitCode ?? null,
      signalCode: child.signalCode ?? null,
      stderrTail: getBoundedTextTail(
        sanitizeDiagnosticText(child.stderrTail ?? ''),
        MANAGED_STDERR_TAIL_MAX_BYTES,
      ),
    };
    state.lastManagedOpenCodeProcess = snapshot;
    return snapshot;
  };

  const captureRestartDiagnostics = (reason) => {
    const processSnapshot = snapshotManagedOpenCodeProcess();
    const diagnostics = {
      reason: sanitizeDiagnosticText(String(reason || 'managed-restart')).slice(0, HEALTH_FAILURE_DETAIL_MAX_LENGTH),
      healthFailure: state.lastOpenCodeHealthFailure ? { ...state.lastOpenCodeHealthFailure } : null,
      process: processSnapshot
        ? { ...processSnapshot, alive: isManagedOpenCodeProcessAlive() }
        : null,
      busySessionCount: getActiveSessionCount(),
      at: new Date(now()).toISOString(),
    };
    state.lastOpenCodeRestartDiagnostics = diagnostics;
    console.warn('[lifecycle] managed OpenCode restart diagnostics', diagnostics);
  };

  const waitForPortRelease = (port, timeoutMs, hostname = env.ENV_CONFIGURED_OPENCODE_HOSTNAME) => {
    if (!port) {
      return Promise.resolve(true);
    }

    const probeHost = !hostname || hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]'
      ? '127.0.0.1'
      : hostname;
    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve) => {
      const attempt = () => {
        const socket = net.connect({ port, host: probeHost });
        let settled = false;

        const finish = (released) => {
          if (settled) return;
          settled = true;
          socket.removeAllListeners();
          socket.destroy();
          if (released || Date.now() >= deadline) {
            resolve(released);
            return;
          }
          setTimeout(attempt, 150);
        };

        socket.once('connect', () => finish(false));
        socket.once('timeout', () => finish(true));
        socket.once('error', (error) => {
          if (error && typeof error === 'object' && (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH')) {
            finish(true);
            return;
          }
          finish(false);
        });
        socket.setTimeout(500);
      };

      attempt();
    });
  };

  const terminateChildProcess = async (child) => {
    if (!child) {
      return;
    }

    const pid = child.pid;
    if (!pid || (process.platform === 'win32' && hasChildProcessExited(child))) {
      await waitForChildProcessClose(child, 250);
      return;
    }

    const signalProcessTree = (signal) => {
      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, signal);
        } catch {
        }
      }

      try {
        if (!hasChildProcessExited(child)) child.kill(signal);
      } catch {
      }
    };

    if (process.platform === 'win32') {
      // Windows child.kill() terminates only the parent, and nothing on
      // Windows lets OpenCode close its running turns first. Closing the stdin
      // lease does; the tree kill is the fallback (see managed-process-stop.js).
      await stopOpenCodeByClosingStdin(child, {
        forceKillTree: (treePid) => {
          try {
            spawnSyncProcess('taskkill', ['/pid', String(treePid), '/f', '/t'], {
              stdio: 'ignore',
              timeout: 5000,
              windowsHide: true,
            });
          } catch {
          }
        },
      });
      return;
    }

    signalProcessTree('SIGTERM');
    await waitForChildProcessClose(child, 2500);
    // Parent exit does not prove group exit. Tools can ignore SIGTERM and keep
    // running after their server has exited and closed its own stdio.
    signalProcessTree('SIGKILL');

    await waitForChildProcessClose(child, 1000);
  };

  const closeManagedOpenCodeChild = async (child) => {
    const pid = child?.pid;
    try {
      await terminateChildProcess(child);
    } finally {
      // Drop it from the registry only once it has actually exited, so a child
      // that survived teardown stays eligible for the next run's reaper.
      if (Number.isInteger(pid) && hasChildProcessExited(child)) {
        await unregisterManagedProcess(pid);
      }
    }
  };

  // The record this server last wrote. state.json is shared by every server on
  // the data dir and another one can overwrite it, so this server's own reload
  // and restart decisions start from this copy when the file names someone else's.
  let ownRecord = null;
  const writeOwnState = (record) => {
    ownRecord = record;
    writeManagedOpenCodeState(managedPaths.statePath, record);
    recordGenerationStart(record);
  };
  const clearOwnState = () => {
    if (ownRecord?.pid) closeGenerationForPid(ownRecord.pid);
    ownRecord = null;
    clearManagedOpenCodeState(managedPaths.statePath);
  };

  const clearManagedStateIfOwned = (pid) => {
    if (ownRecord?.pid === pid) ownRecord = null;
    const saved = readManagedOpenCodeState(managedPaths.statePath);
    if (saved?.pid === pid) clearManagedOpenCodeState(managedPaths.statePath);
    closeGenerationForPid(pid);
  };

  const isPidAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  };

  // ---- v2 store wiring (#82) ----
  // The v2 store (managed-opencode-state.js) is the ownership record for
  // action paths. It is dual-written with the v1 pair for one release:
  // state.json + draining.json keep their exact v1 behaviour for the
  // other servers sharing this data dir, while the store accumulates
  // the generation history, the write-ahead handoff record and the
  // reaper's view. First read bootstraps the store by migrating the
  // v1 pair (no lost generations); every load reaps generations whose
  // recorded pid is gone (store-only reaper: signal-0 liveness, never
  // `ps` inference). Store sync failures never break the v1 flow.
  const syncStore = (fn) => {
    try {
      fn();
    } catch (error) {
      console.error(`[OpenCode] v2 store sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const loadManagedStore = () => {
    let store = readManagedOpenCodeStore(managedPaths.storePath);
    if (!store) {
      const hasV1 = readManagedOpenCodeState(managedPaths.statePath) !== null
        || readDrainingOpenCodeRecords(managedPaths.drainingPath).length > 0;
      store = hasV1
        ? migrateV1StoreToV2({ statePath: managedPaths.statePath, drainingPath: managedPaths.drainingPath })
        : createEmptyManagedOpenCodeStore();
      if (hasV1) writeManagedOpenCodeStore(managedPaths.storePath, store);
    }
    const { store: reapedStore, reaped } = reapManagedOpenCodeStore(store, { isPidAlive });
    if (reaped.length > 0) writeManagedOpenCodeStore(managedPaths.storePath, reapedStore);
    return reapedStore;
  };
  const generationForPid = (store, pid) => [...store.generations].reverse()
    .find((generation) => generation.pid === pid && generation.state !== 'closed') ?? null;
  const ensureGeneration = (store, record, state) => {
    const existing = generationForPid(store, record.pid);
    if (existing) return { store, generation: existing };
    const next = appendGeneration(store, {
      pid: record.pid,
      port: record.port,
      binary: record.binary,
      args: record.args ?? [],
      fingerprint: record.fingerprint ?? '',
      state,
      started_at: record.startedAt ?? new Date().toISOString(),
    });
    return { store: next, generation: generationForPid(next, record.pid) };
  };
  const recordGenerationStart = (record) => syncStore(() => {
    const { store } = ensureGeneration(loadManagedStore(), record, 'active');
    writeManagedOpenCodeStore(managedPaths.storePath, store);
  });
  const closeGenerationForPid = (pid) => syncStore(() => {
    let store = loadManagedStore();
    const generation = generationForPid(store, pid);
    if (!generation) return;
    store = transitionGenerationState(store, generation.generation_id, 'closed');
    writeManagedOpenCodeStore(managedPaths.storePath, store);
  });
  const handoffIdFor = (predecessorPid, successorPid) => `handoff-${predecessorPid}-${successorPid}`;
  // Write-ahead: 'prepared' is persisted after the successor exists but
  // before the switch; 'switched' once the port points at the successor;
  // 'confirmed' once the predecessor is draining; 'aborted' on failure.
  // A crash between any two steps replays from the last persisted step
  // (replayHandoffStep in managed-opencode-state.js).
  const recordHandoffPrepared = (predecessor, successorPid, context) => syncStore(() => {
    let store = loadManagedStore();
    ({ store } = ensureGeneration(store, predecessor, 'active'));
    const predecessorGeneration = generationForPid(store, predecessor.pid);
    const successorGeneration = generationForPid(store, successorPid);
    if (!predecessorGeneration || !successorGeneration) return;
    const busy = Array.isArray(context?.busySessionIds)
      ? context.busySessionIds
      : (typeof listBusySessionIds === 'function' ? listBusySessionIds() : []);
    store = recordHandoffStep(store, {
      handoff_id: handoffIdFor(predecessor.pid, successorPid),
      predecessor: predecessorGeneration.generation_id,
      successor: successorGeneration.generation_id,
      busy_set: (Array.isArray(busy) ? busy : []).map((id) => String(id)),
      step: 'prepared',
      outcome: null,
      at: new Date().toISOString(),
    });
    writeManagedOpenCodeStore(managedPaths.storePath, store);
  });
  const recordHandoffAdvance = (predecessorPid, successorPid, step, outcome) => syncStore(() => {
    let store = loadManagedStore();
    const existing = store.handoffs.find((handoff) => handoff.handoff_id === handoffIdFor(predecessorPid, successorPid));
    if (!existing) return;
    store = recordHandoffStep(store, { ...existing, step, outcome, at: new Date().toISOString() });
    writeManagedOpenCodeStore(managedPaths.storePath, store);
    if (step === 'confirmed') {
      const generation = generationForPid(store, predecessorPid);
      if (generation && (generation.state === 'active' || generation.state === 'starting')) {
        store = transitionGenerationState(store, generation.generation_id, 'draining');
        writeManagedOpenCodeStore(managedPaths.storePath, store);
      }
    }
  });
  syncStore(() => loadManagedStore());

  // Ownership for action paths comes from the records (#82): a pid is
  // ours only when a non-closed store generation names it, or the v1
  // pair does (a record a v1-only peer wrote after this store was
  // bootstrapped). The record is then verified. A store generation is
  // its own identity — binary, fingerprint and started_at were
  // recorded at spawn — so signal-0 liveness verifies it and `ps` is
  // never consulted on the store path. A v1-only record carries no
  // such identity, so until the v1 pair retires it keeps the legacy
  // command-line verification: a recycled pid must never be adopted
  // or signalled on a bare number.
  const isOwnedOpenCodePid = (pid, binary) => {
    if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return false;
    const store = readManagedOpenCodeStore(managedPaths.storePath);
    const inStore = store?.generations.some((generation) => generation.pid === pid && generation.state !== 'closed') ?? false;
    if (inStore && isPidAlive(pid)) return true;
    const recorded = inStore
      || readManagedOpenCodeState(managedPaths.statePath)?.pid === pid
      || readDrainingOpenCodeRecords(managedPaths.drainingPath).some((record) => record.pid === pid);
    if (!recorded) return false;
    const result = spawnSyncProcess('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const command = String(result?.stdout ?? '').trim();
    return command.includes(path.basename(binary)) && /\bserve\b/.test(command);
  };

  // Identity check for the managed-servers read: a recorded pid can be
  // recycled onto an unrelated process, so signal-0 liveness is not
  // enough to list it. Read the live command and apply the orphan
  // reaper's identity check (opencode + serve + the recorded port).
  // Where the command cannot be read (win32, a failed ps, empty output)
  // identity is unverified and the entry is not listed. The read is
  // asynchronous: this runs on the managed-servers read path, and a
  // synchronous `ps` per recorded entry would block the event loop for
  // every other request (the regression managed-process-registry.js
  // documents for the reaper). Callers await this before building the
  // response; the builder itself stays synchronous.
  const readRecordedProcessCommand = async (pid) => {
    if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return '';
    try {
      const { stdout } = await execFileProcess('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      return String(stdout ?? '').trim();
    } catch {
      return '';
    }
  };

  const terminateRecordedOpenCodeProcess = async (pid) => {
    const signalGroup = (signal) => {
      try {
        process.kill(-pid, signal);
      } catch {
      }
      try {
        process.kill(pid, signal);
      } catch {
      }
    };
    signalGroup('SIGTERM');
    const deadline = Date.now() + 2500;
    while (isPidAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, MANAGED_LOG_POLL_MS));
    }
    if (isPidAlive(pid)) signalGroup('SIGKILL');
  };

  const probeManagedOpenCodeHealth = async (url) => {
    try {
      const response = await fetch(`${url}${OPENCODE_HEALTH_PATH}`, {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  };

  const formatHost = (hostname) => (hostname.includes(':') ? `[${hostname}]` : hostname);

  const managedOpenCodeArgs = (hostname) => ['serve', '--hostname', hostname];

  // The managed bin link is re-pointed on each nix switch, so identity is the target it resolves to.
  const resolveBinaryIdentity = (binary) => {
    try {
      return realpathSync(binary);
    } catch {
      return binary;
    }
  };

  const computeLaunchFingerprint = ({ binary, hostname, port, cwd, password, managedEnv }) => createLaunchFingerprint({
    binary,
    args: ['serve', '--hostname', hostname, '--port', String(port)],
    cwd,
    hostname,
    port,
    passwordHash: hashLaunchSecret(password),
    managedEnv: withoutSecretEnv(managedEnv),
    userEnv: withoutSecretEnv(getUserEnvironment()),
  });

  const closeRecordedOpenCodeProcess = async ({ pid, binary }) => {
    if (isOwnedOpenCodePid(pid, binary)) await terminateRecordedOpenCodeProcess(pid);
    if (!isPidAlive(pid)) await unregisterManagedProcess(pid);
    closeGenerationForPid(pid);
  };

  // draining.json is shared by every server on the data dir; a write keeps the
  // records another live server still owns, or their draining children would
  // lose that protection the next time this server's list changes.
  const persistDrainingOpenCode = (records) => {
    const mine = new Set(records.map((record) => record.pid));
    const theirs = readDrainingOpenCodeRecords(managedPaths.drainingPath)
      .filter((record) => !mine.has(record.pid) && Number.isInteger(otherServerOwning(record.pid)));
    writeDrainingOpenCodeRecords(managedPaths.drainingPath, [...records, ...theirs]);
    syncStore(() => {
      let store = loadManagedStore();
      for (const record of [...records, ...theirs]) {
        if (!Number.isInteger(record.port) || record.port <= 0 || typeof record.binary !== 'string') continue;
        const generation = generationForPid(store, record.pid);
        if (!generation) {
          ({ store } = ensureGeneration(store, record, 'draining'));
        } else if (generation.state === 'active' || generation.state === 'starting') {
          store = transitionGenerationState(store, generation.generation_id, 'draining');
        }
      }
      writeManagedOpenCodeStore(managedPaths.storePath, store);
    });
  };

  const drainingOpenCode = createDrainingOpenCodeRegistry({
    graceMs: resolveOpenCodeDrainGraceMs(process.env),
    countRequests: countUpstreamRequests,
    listBusySessionIds,
    onChange: persistDrainingOpenCode,
  });

  // Another live OpenChamber server's OpenCode: never adopted, handed off
  // from, drained or stopped here. Its owner is this process, a server that is
  // gone, or the predecessor handing off to this one in every other case.
  // Unknown ownership (no readable registry entry: the write is best effort)
  // is not taken as ours either: leaving an OpenCode running costs a process,
  // stopping another server's costs its sessions. Returns the other owner's
  // pid, 'unknown', or null when the OpenCode is this server's to manage.
  const otherServerOwning = (pid) => {
    const owner = readProcessOwner(pid);
    if (!Number.isInteger(owner)) return 'unknown';
    if (owner === process.pid || owner === getHandoffPredecessorPid()) return null;
    if (isPidAlive(owner)) return owner;
    // Its owner is gone: claim it, so a second server finding the same
    // orphan at the same time does not adopt it too.
    const holder = claimProcess(pid, owner);
    if (holder === process.pid) return null;
    if (!Number.isInteger(holder)) return 'unknown';
    return isPidAlive(holder) ? holder : 'unknown';
  };

  // This server takes over an OpenCode it manages from now on (adopted, or
  // draining after a handoff): the registry names it, so another server never
  // sees the old, gone owner and claims the process.
  const registerAsOwner = (record) => registerManagedProcess({
    pid: record.pid,
    ownerPid: process.pid,
    port: record.port,
    binary: record.binary,
    runtime: process.env.OPENCHAMBER_RUNTIME || 'web',
  });

  const seedDrainingOpenCode = () => {
    const recordsByPid = new Map();
    for (const record of readDrainingOpenCodeRecords(managedPaths.drainingPath)) recordsByPid.set(record.pid, record);
    const store = readManagedOpenCodeStore(managedPaths.storePath);
    for (const generation of store?.generations ?? []) {
      if (generation.state === 'draining' && !recordsByPid.has(generation.pid)) {
        recordsByPid.set(generation.pid, { pid: generation.pid, port: generation.port, binary: generation.binary });
      }
    }
    for (const record of recordsByPid.values()) {
      if (drainingOpenCode.has(record.pid) || !isOwnedOpenCodePid(record.pid, record.binary) || otherServerOwning(record.pid) !== null) continue;
      drainingOpenCode.add({
        ...record,
        close: () => closeRecordedOpenCodeProcess(record),
      });
      void registerAsOwner(record);
    }
  };

  const retireHandoffPredecessor = (predecessor, busySessionIds) => {
    const stopFollowing = onOpenCodeHandoff?.({
      url: `http://${formatHost(env.ENV_CONFIGURED_OPENCODE_HOSTNAME)}:${predecessor.port}`,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${predecessor.password}`).toString('base64')}` },
    }) ?? null;
    drainingOpenCode.add({
      pid: predecessor.pid,
      port: predecessor.port,
      binary: predecessor.binary,
      busySessionIds,
      close: async () => {
        stopFollowing?.();
        await closeRecordedOpenCodeProcess(predecessor);
      },
    });
  };

  const adoptManagedOpenCodeServer = (saved, hostname) => ({
    url: `http://${formatHost(hostname)}:${saved.port}`,
    pid: saved.pid,
    exitCode: null,
    signalCode: null,
    get stderrTail() {
      return getBoundedTextTail(
        sanitizeDiagnosticText(readLogTail(managedPaths.logPath, 0, MANAGED_STDERR_TAIL_MAX_BYTES)),
        MANAGED_STDERR_TAIL_MAX_BYTES,
      );
    },
    async close() {
      if (isOwnedOpenCodePid(saved.pid, saved.binary)) await terminateRecordedOpenCodeProcess(saved.pid);
      if (!isPidAlive(saved.pid)) {
        await unregisterManagedProcess(saved.pid);
        clearManagedStateIfOwned(saved.pid);
      }
    },
  });

  const formatCapturedOutput = ({ stdout, stderr }) => {
    const parts = [];
    if (stdout.trim()) {
      parts.push(`stdout:\n${stdout.trim()}`);
    }
    if (stderr.trim()) {
      parts.push(`stderr:\n${stderr.trim()}`);
    }
    return parts.length > 0 ? parts.join('\n\n') : 'No stdout/stderr captured';
  };

  const portOfUrl = (value) => {
    try {
      return Number(new URL(value).port);
    } catch {
      return null;
    }
  };

  const createManagedOpenCodeServerProcess = async ({ resolvedBinary, hostname, port, timeout, cwd, env: processEnv, shellEnvKeysCount = 0, attempt }) => {
    let binary = (resolvedBinary || process.env.OPENCODE_BINARY || 'opencode').trim() || 'opencode';
    const sourceBinary = binary;
    // Windows teardown stops OpenCode by closing its stdin lease, which only
    // `serve --stdio` holds (see managed-process-stop.js).
    const stdinLease = process.platform === 'win32';
    let args = ['serve', ...(stdinLease ? ['--stdio'] : []), '--hostname', hostname, '--port', String(port)];
    let launchWrapperType = null;

    if (process.platform === 'win32' && state.useWslForOpencode) {
      throw new Error('Launching OpenCode through WSL is no longer supported. Install OpenCode natively on Windows and configure opencode.cmd or opencode.exe.');
    }

    if (process.platform === 'win32' && !state.useWslForOpencode) {
      const launchSpec = resolveManagedOpenCodeLaunchSpec(binary);
      if (launchSpec?.binary) {
        if (launchSpec.wrapperType) {
          console.log(`Launching OpenCode via ${launchSpec.wrapperType}: ${launchSpec.binary}`);
        }
        launchWrapperType = launchSpec.wrapperType || null;
        binary = launchSpec.binary;
        args = [...(Array.isArray(launchSpec.args) ? launchSpec.args : []), ...args];
      }
    }

    const pathValue = typeof processEnv?.PATH === 'string' ? processEnv.PATH : '';
    const pathEntryCount = pathValue ? pathValue.split(process.platform === 'win32' ? ';' : ':').filter(Boolean).length : 0;
    state.lastOpenCodeLaunchDiagnostics = {
      launchedAt: new Date().toISOString(),
      sourceBinary,
      binary,
      args,
      cwd,
      hostname,
      port,
      wrapperType: launchWrapperType,
      pathEntryCount,
      hasShellEnv: shellEnvKeysCount > 0,
      shellEnvKeysCount,
    };
    console.log('[OpenCode] Launching managed server', state.lastOpenCodeLaunchDiagnostics);

    mkdirSync(managedPaths.dir, { recursive: true, mode: 0o700 });
    // Rotate before opening so logOffset below is the fresh file's size, never a
    // stale offset past the end of a rotated log.
    rotateManagedLogIfOversized(managedPaths.logPath);
    const logFd = openSync(managedPaths.logPath, 'a', 0o600);
    const logFdStats = fstatSync(logFd);
    const logOffset = logFdStats.size;
    // The readiness drain compares the live log against this identity to notice
    // a rotation by another server sharing the data dir (see drainOutput).
    const logFileIdentity = `${logFdStats.dev}:${logFdStats.ino}`;
    let child;
    try {
      // A file, not a pipe: an OpenCode left running after OpenChamber exits must not hit EPIPE.
      // Only the Windows stdin lease is a pipe, and closing it is how that OpenCode is told to stop.
      const launch = withoutInheritedListenFds(binary, args);
      child = spawnProcess(launch.command, launch.args, {
        cwd,
        env: processEnv,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: [stdinLease ? 'pipe' : 'ignore', logFd, logFd],
      });
    } finally {
      closeSync(logFd);
    }
    // Closing the lease after OpenCode already exited must not throw EPIPE.
    child.stdin?.on('error', () => {});
    let observedExitCode = null;
    let observedSignalCode = null;
    let recordedExit = false;
    diagnosticJournal.record('managed launch', { attempt });

    const getManagedProcessSnapshot = () => ({
      pid: child.pid || null,
      exitCode: observedExitCode ?? child.exitCode ?? null,
      signalCode: observedSignalCode ?? child.signalCode ?? null,
      stderrTail: getBoundedTextTail(
        sanitizeDiagnosticText(readLogTail(managedPaths.logPath, logOffset, MANAGED_STDERR_TAIL_MAX_BYTES)),
        MANAGED_STDERR_TAIL_MAX_BYTES,
      ),
    });
    const recordManagedProcessExit = (code, signal) => {
      if (code !== null && code !== undefined) observedExitCode = code;
      if (signal !== null && signal !== undefined) observedSignalCode = signal;
      state.lastManagedOpenCodeProcess = getManagedProcessSnapshot();
      if (!recordedExit) {
        recordedExit = true;
        diagnosticJournal.record('managed process exited');
      }
    };
    child.on('exit', recordManagedProcessExit);
    child.on('close', recordManagedProcessExit);

    // Ownership starts at spawn, including processes that never become ready.
    const registration = registerManagedProcess({
      pid: child.pid,
      ownerPid: process.pid,
      port,
      binary,
      runtime: process.env.OPENCHAMBER_RUNTIME || 'web',
    });

    let closePromise = null;
    const serverProcess = {
      url: null,
      pid: child.pid || null,
      get exitCode() { return observedExitCode ?? child.exitCode; },
      get signalCode() { return observedSignalCode ?? child.signalCode; },
      get stderrTail() { return getManagedProcessSnapshot().stderrTail; },
      close() {
        if (!closePromise) {
          closePromise = registration.then(async () => {
            await closeManagedOpenCodeChild(child);
            if (hasChildProcessExited(child)) clearManagedStateIfOwned(child.pid);
          });
        }
        return closePromise;
      },
    };

    const readiness = new Promise((resolve, reject) => {
      let output = '';
      let readOffset = logOffset;
      let done = false;
      let poll = null;
      const finish = (handler, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        child.off('exit', onExit);
        child.off('error', onError);
        handler(value);
      };

      // Rotation can also land mid-startup: another server sharing the data
      // dir may cross the cap while this child is starting and rename the log
      // this child is writing (its fd follows the renamed file). When the live
      // log no longer matches the identity captured at spawn, this child's
      // output continues in the `.1` generation, so drain both files — the
      // port filter below still accepts only this child's listening line.
      let replacementOffset = null;
      const drainOutput = () => {
        if (replacementOffset === null) {
          let rotated = false;
          try {
            const liveStats = statSync(managedPaths.logPath);
            rotated = `${liveStats.dev}:${liveStats.ino}` !== logFileIdentity;
          } catch {
            rotated = true;
          }
          if (rotated) replacementOffset = 0;
        }
        if (replacementOffset !== null) {
          const fromRotated = readLogSince(`${managedPaths.logPath}.1`, readOffset);
          readOffset = fromRotated.offset;
          output += fromRotated.text;
          const fromLive = readLogSince(managedPaths.logPath, replacementOffset);
          replacementOffset = fromLive.offset;
          output += fromLive.text;
        } else {
          const chunk = readLogSince(managedPaths.logPath, readOffset);
          readOffset = chunk.offset;
          output += chunk.text;
        }
        // OpenCode 2.x prints `server listening on http://host:port` with no
        // "opencode" prefix, and `{"url":"http://host:port"}` under --stdio.
        // The log is shared by every server on the data dir; another server's
        // child starting at the same time writes its own line here, so only a
        // URL on the port this child was given counts.
        const urls = [
          ...output.matchAll(/server listening on\s+(https?:\/\/\S+)/g),
          ...output.matchAll(/^\s*\{"url":"(https?:\/\/[^"\s]+)"\}\s*$/gm),
        ].map((match) => match[1]);
        const url = urls.find((candidate) => !(port > 0) || portOfUrl(candidate) === port);
        if (url) finish(resolve, url);
      };

      const onExit = (code, signal) => {
        drainOutput();
        if (done) return;
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        const appBundleHint = process.platform === 'darwin' && /\/OpenCode\.app\/Contents\/MacOS\/(?:OpenCode|opencode-cli)$/i.test(binary)
          ? ' The configured binary appears to point at the macOS desktop app bundle; OpenChamber needs the standalone opencode CLI.'
          : '';
        finish(reject, new Error(`OpenCode process exited before serving with ${reason}. Binary used: ${binary}.${appBundleHint} ${formatCapturedOutput({ stdout: output, stderr: '' })}`));
      };

      const onError = (error) => {
        finish(reject, error);
      };

      const timer = setTimeout(() => {
        drainOutput();
        finish(reject, new Error(`Timeout waiting for OpenCode to start after ${timeout}ms`));
      }, timeout);

      poll = setInterval(drainOutput, MANAGED_LOG_POLL_MS);
      child.on('exit', onExit);
      child.on('error', onError);
    }).catch(async (error) => {
      await serverProcess.close();
      if (state.openCodeProcess === serverProcess) {
        state.openCodeProcess = null;
        syncToHmrState();
      }
      throw error;
    });

    // Shutdown must be able to close an in-flight startup, not only a ready server.
    state.openCodeProcess = serverProcess;
    syncToHmrState();
    serverProcess.url = await readiness;
    await registration;
    return serverProcess;
  };

  const resolveManagedOpenCodePort = async (requestedPort, hostname = '127.0.0.1') => {
    if (typeof requestedPort === 'number' && Number.isFinite(requestedPort) && requestedPort > 0) {
      return requestedPort;
    }

    return await new Promise((resolve, reject) => {
      const server = net.createServer();
      const cleanup = () => {
        server.removeAllListeners('error');
        server.removeAllListeners('listening');
      };

      server.once('error', (error) => {
        cleanup();
        reject(error);
      });

      server.once('listening', () => {
        const address = server.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        server.close(() => {
          cleanup();
          if (port > 0) {
            resolve(port);
            return;
          }
          reject(new Error('Failed to allocate OpenCode port'));
        });
      });

      server.listen(0, hostname);
    });
  };

  const probeOpenCodeHealthDetailed = async () => {
    if (!state.openCodeProcess || !state.openCodePort) {
      return {
        healthy: false,
        failure: {
          class: 'error',
          detail: 'Managed OpenCode process or port is unavailable',
        },
      };
    }

    try {
      const response = await fetch(buildOpenCodeUrl(OPENCODE_HEALTH_PATH, ''), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          healthy: false,
          failure: {
            class: 'invalid_response',
            detail: response.status === 404
              ? `${OPENCODE_VERSION_REQUIREMENT_DETAIL}: this server has no /api/info, which every 2.x server serves.`
              : `Info endpoint returned HTTP ${response.status ?? 'unknown'}`,
          },
        };
      }
      const bounded = await readBoundedResponseText(response, OPENCODE_INFO_MAX_BYTES)
        .catch(() => ({ tooLarge: true }));
      if (bounded.tooLarge) {
        return {
          healthy: false,
          failure: {
            class: 'invalid_response',
            detail: 'Info endpoint returned an oversized or unreadable body',
          },
        };
      }
      let body;
      try {
        const text = bounded.text.charCodeAt(0) === 0xfeff ? bounded.text.slice(1) : bounded.text;
        body = JSON.parse(text);
      } catch {
        return {
          healthy: false,
          failure: {
            class: 'invalid_response',
            detail: 'Info endpoint returned invalid JSON',
          },
        };
      }
      const version = classifyOpenCodeVersion(body?.version);
      if (!version.ok) {
        return {
          healthy: false,
          failure: { class: 'invalid_response', detail: version.detail },
        };
      }
      if (body?.version) lastKnownOpenCodeVersion = body.version;
      return { healthy: true, failure: null };
    } catch (error) {
      return {
        healthy: false,
        failure: classifyHealthProbeError(error),
      };
    }
  };

  const isOpenCodeProcessHealthy = async () => (await probeOpenCodeHealthDetailed()).healthy;

  const probeExternalOpenCode = async (port, origin) => {
    if (!port || port <= 0) {
      return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const base = origin ?? `http://127.0.0.1:${port}`;
      const response = await fetch(`${base}${OPENCODE_HEALTH_PATH}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: controller.signal,
      });
      // The deadline stays active until the body is consumed: a server
      // that sends 200 headers and then stalls the body would otherwise
      // wedge this probe — and every health-check cycle sharing its
      // promise — forever.
      const info = await readOpenCodeInfo(response);
      return info !== null && isSupportedOpenCodeVersion(info.version);
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };

  // The version of an explicitly configured server that answered but is not a
  // supported OpenCode (v1, or 2.x below the minimum); null for anything else,
  // including a server that is down.
  const readUnsupportedExternalOpenCodeVersion = async (port, origin) => {
    if (!port || port <= 0) return null;
    const version = await readExternalOpenCodeVersion(origin ?? `http://127.0.0.1:${port}`, getOpenCodeAuthHeaders())
      .catch(() => null);
    return version && !isSupportedOpenCodeVersion(version) ? version : null;
  };

  const waitForOpenCodePort = async (timeoutMs = 15000) => {
    if (state.openCodePort !== null) {
      return state.openCodePort;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (state.openCodePort !== null) {
        return state.openCodePort;
      }
    }

    throw new Error('Timed out waiting for OpenCode port');
  };

  const START_OPEN_CODE_MAX_ATTEMPTS = 2;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const startOpenCodeOnce = async (attempt, handoffContext = null) => {
    const attemptStartedAt = performance.now();
    let phaseStartedAt = attemptStartedAt;
    recordStartupPerformance('opencode.attempt.start', { attempt });
    const desiredPort = env.ENV_CONFIGURED_OPENCODE_PORT ?? 0;
    const recordedState = readManagedOpenCodeState(managedPaths.statePath);
    const recordedOwner = recordedState ? otherServerOwning(recordedState.pid) : null;
    if (recordedOwner !== null) {
      console.log(recordedOwner === 'unknown'
        ? `[OpenCode] managed state names OpenCode ${recordedState.pid}, whose owner the registry does not record; leaving it alone`
        : `[OpenCode] managed state names OpenCode ${recordedState.pid} of another OpenChamber server (pid ${recordedOwner}); leaving it alone`);
      // Two servers cannot share a pinned port: say so instead of a bind failure.
      if (Number.isInteger(recordedOwner) && desiredPort > 0 && desiredPort === recordedState.port && isPidAlive(recordedState.pid)) {
        throw new Error(`OpenCode port ${desiredPort} is held by another OpenChamber server (pid ${recordedOwner}) using the same data folder. Give one of them a different OPENCODE_PORT, or its own OPENCHAMBER_DATA_DIR.`);
      }
    }
    // When the shared file names another server's OpenCode, this server's own
    // still-running one (from its own last write) is the one it manages.
    const ownAlive = ownRecord && isPidAlive(ownRecord.pid) ? ownRecord : null;
    const savedState = recordedOwner === null ? recordedState : ownAlive;
    seedDrainingOpenCode();
    let handoffPredecessor = null;
    const reusedPort = savedState && (desiredPort === 0 || desiredPort === savedState.port) ? savedState.port : null;
    let spawnPort = reusedPort ?? await resolveManagedOpenCodePort(desiredPort, env.ENV_CONFIGURED_OPENCODE_HOSTNAME);
    console.log(
      desiredPort > 0
        ? `Starting OpenCode on requested port ${desiredPort}...`
        : `Starting OpenCode on allocated port ${spawnPort}...`
    );

    await applyOpencodeBinaryFromSettings({ strict: true });
    const resolvedBinary = ensureOpencodeCliEnv();
    const binaryIdentity = resolveBinaryIdentity(resolvedBinary);
    const preflight = checkOpenCodeBinary(resolveManagedOpenCodeLaunchSpec(resolvedBinary));
    managedPreflight = preflight.then(() => true, () => false);
    await preflight;
    recordStartupPerformance('opencode.binary.ready', {
      attempt,
      durationMs: performance.now() - phaseStartedAt,
      totalDurationMs: performance.now() - attemptStartedAt,
    });
    phaseStartedAt = performance.now();
    // A rotation start discards the saved pair: with no reuse values the
    // password falls to the rotateManaged branch and the agent tool token
    // to the random path, and the changed launch fingerprint makes a
    // still-running predecessor hand off, so it is never adopted with the
    // old pair. A user-provided OPENCODE_SERVER_PASSWORD still wins inside
    // ensureLocalOpenCodeServerPassword; rotation never overrides it.
    const rotateCredentials = credentialRotationPending;
    if (rotateCredentials) {
      console.log('[OpenCode] Rotating managed credentials for this start; the saved password and agent tool token will not be reused');
    }
    const openCodePassword = await ensureLocalOpenCodeServerPassword({ rotateManaged: true, reusePassword: rotateCredentials ? null : (savedState?.password ?? null) });
    let envPath = process.env.PATH;
    if (typeof buildManagedOpenCodePath === 'function') {
      envPath = buildManagedOpenCodePath();
    } else if (typeof buildAugmentedPath === 'function') {
      envPath = buildAugmentedPath();
    }
    const shellEnv = typeof getManagedOpenCodeShellEnvSnapshot === 'function'
      ? getManagedOpenCodeShellEnvSnapshot() || {}
      : {};
    const managedOpenCodeEnv = await getManagedOpenCodeEnv({ agentToolToken: rotateCredentials ? null : (savedState?.agentToolToken ?? null) });
    recordStartupPerformance('opencode.environment.ready', {
      attempt,
      durationMs: performance.now() - phaseStartedAt,
      totalDurationMs: performance.now() - attemptStartedAt,
    });
    phaseStartedAt = performance.now();

    // Re-arm OpenCode's own V1 -> V2 session import for sessions a bundled
    // OpenCode 1.x created after the migration already completed. Only for the
    // managed process, only while it is not running, and never fatal.
    try {
      const topUp = topUpV1SessionMigration();
      if (topUp && topUp.status !== 'skipped') {
        console.log('[OpenCode] V1 session migration top-up:', topUp);
      }
    } catch (error) {
      console.warn('[OpenCode] V1 session migration top-up failed:', error instanceof Error ? error.message : error);
    }

    // The user's variables go over the inherited environment (a PATH entry
    // in front of the managed PATH) and under everything OpenChamber itself
    // sets for OpenCode.
    const inheritedEnv = overlayEnvironment({ ...shellEnv, ...process.env, PATH: envPath }, await resolveUserEnvironment());
    // The host process (Desktop's Electron main, or `serve --foreground`)
    // records its own private variables as injected; OpenCode does not need
    // Desktop's identity, dist dir or bind host, and nothing it spawns should
    // see them either. Strip them before OpenChamber's own deliberate
    // additions for OpenCode (its server password, OPENCODE_CONFIG) go on top.
    stripHostInjectedEnv(process.env, inheritedEnv);
    // What OpenChamber sets for OpenCode is recorded as injected, so a shell
    // the agent opens can tell it from the user's own variables.
    const processEnv = stripAppImageLauncherEnv(stripAppImageArgv0Leak(applyProviderEnvAliases(assignInjectedEnv(
      { ...inheritedEnv },
      {
        ...managedOpenCodeEnv,
        PATH: inheritedEnv.PATH,
        // OpenCode 2 reads OPENCODE_PASSWORD before the legacy name, so a
        // user's own OPENCODE_PASSWORD would otherwise win and every request
        // we send with openCodePassword would get 401.
        OPENCODE_PASSWORD: openCodePassword,
        OPENCODE_SERVER_PASSWORD: openCodePassword,
      },
    ))));
    managedProcessEnv = processEnv;

    let serverInstance;
    try {
      if (state.isShuttingDown) throw new Error('OpenCode startup cancelled during shutdown');
      const hostname = env.ENV_CONFIGURED_OPENCODE_HOSTNAME;
      const cwd = state.openCodeWorkingDirectory;
      let launchFingerprint = computeLaunchFingerprint({ binary: binaryIdentity, hostname, port: spawnPort, cwd, password: openCodePassword, managedEnv: managedOpenCodeEnv });
      const ownsSavedPid = savedState ? isOwnedOpenCodePid(savedState.pid, savedState.binary) : false;
      const healthy = ownsSavedPid ? await probeManagedOpenCodeHealth(`http://${formatHost(hostname)}:${savedState.port}`) : false;
      const args = managedOpenCodeArgs(hostname);
      let decision = savedState
        ? decideManagedOpenCodeLaunch({ state: savedState, ownsPid: ownsSavedPid, binary: binaryIdentity, args, fingerprint: launchFingerprint, port: spawnPort, healthy })
        : { action: 'start', reason: 'no-state' };
      if (handoffContext?.force && decision.action === 'adopt') {
        decision = { action: 'handoff', reason: 'config-refresh' };
      }
      console.log(`[OpenCode] managed launch: ${decision.action} (${decision.reason})`);

      if (decision.action === 'adopt') {
        serverInstance = adoptManagedOpenCodeServer(savedState, hostname);
        ownRecord = savedState;
        await registerAsOwner(savedState);
      } else if (decision.action === 'handoff') {
        if (spawnPort === savedState.port) {
          spawnPort = await resolveManagedOpenCodePort(0, hostname);
        }
        launchFingerprint = computeLaunchFingerprint({ binary: binaryIdentity, hostname, port: spawnPort, cwd, password: openCodePassword, managedEnv: managedOpenCodeEnv });
        serverInstance = await createManagedOpenCodeServerProcess({
          resolvedBinary,
          attempt,
          hostname,
          port: spawnPort,
          timeout: managedStartupTimeoutMs,
          cwd,
          shellEnvKeysCount: Object.keys(shellEnv).length,
          env: processEnv,
        });
        writeOwnState({
          pid: serverInstance.pid,
          port: spawnPort,
          binary: binaryIdentity,
          args,
          fingerprint: launchFingerprint,
          password: openCodePassword,
          agentToolToken: managedOpenCodeEnv.OPENCHAMBER_AGENT_TOOL_TOKEN ?? null,
          instanceDir: getInstanceDir(),
          startedAt: new Date().toISOString(),
        });
        handoffPredecessor = savedState;
        recordHandoffPrepared(savedState, serverInstance.pid, handoffContext);
      } else {
        if (savedState) {
          if (decision.action === 'replace') {
            await terminateRecordedOpenCodeProcess(savedState.pid);
            closeGenerationForPid(savedState.pid);
            await waitForPortRelease(savedState.port, 5000);
          }
          clearOwnState();
          if (reusedPort !== null && desiredPort === 0) {
            spawnPort = await resolveManagedOpenCodePort(desiredPort, hostname);
            launchFingerprint = computeLaunchFingerprint({ binary: binaryIdentity, hostname, port: spawnPort, cwd, password: openCodePassword, managedEnv: managedOpenCodeEnv });
          }
        }
        serverInstance = await createManagedOpenCodeServerProcess({
          resolvedBinary,
          attempt,
          hostname,
          port: spawnPort,
          timeout: managedStartupTimeoutMs,
          cwd,
          shellEnvKeysCount: Object.keys(shellEnv).length,
          env: processEnv,
        });
        writeOwnState({
          pid: serverInstance.pid,
          port: spawnPort,
          binary: binaryIdentity,
          args,
          fingerprint: launchFingerprint,
          password: openCodePassword,
          agentToolToken: managedOpenCodeEnv.OPENCHAMBER_AGENT_TOOL_TOKEN ?? null,
          instanceDir: getInstanceDir(),
          startedAt: new Date().toISOString(),
        });
      }

      if (!serverInstance || !serverInstance.url) {
        throw new Error('OpenCode server started but URL is missing');
      }
      recordStartupPerformance('opencode.process.ready', {
        attempt,
        durationMs: performance.now() - phaseStartedAt,
        totalDurationMs: performance.now() - attemptStartedAt,
      });
      phaseStartedAt = performance.now();

      const url = new URL(serverInstance.url);
      const port = parseInt(url.port, 10);
      const prefix = normalizeApiPrefix(url.pathname);

      const ready = await waitForReady(serverInstance.url, 10000);
      if (state.isShuttingDown) throw new Error('OpenCode startup cancelled during shutdown');
      if (ready) {
        credentialRotationPending = false;
        setOpenCodePort(port);
        if (lastReadyOwnServer?.pid !== serverInstance.pid) {
          // The cached version was reported by the predecessor process.
          // Pairing it with this process would present a fabricated
          // version for the new pid; report null until a health probe
          // against this process establishes its version.
          lastKnownOpenCodeVersion = null;
        }
        lastReadyOwnServer = { pid: serverInstance.pid, port };
        setDetectedOpenCodeApiPrefix(prefix);

        state.isOpenCodeReady = true;
        diagnosticJournal.record('managed ready', { attempt });
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;

        recordStartupPerformance('opencode.health.ready', {
          attempt,
          durationMs: performance.now() - phaseStartedAt,
          totalDurationMs: performance.now() - attemptStartedAt,
          outcome: 'ready',
        });

        if (handoffPredecessor) {
          recordHandoffAdvance(handoffPredecessor.pid, serverInstance.pid, 'switched', null);
          retireHandoffPredecessor(handoffPredecessor, handoffContext?.busySessionIds ?? null);
          recordHandoffAdvance(handoffPredecessor.pid, serverInstance.pid, 'confirmed', 'predecessor-draining');
        }
        return serverInstance;
      }

      throw new Error('Server started but health check failed (timeout)');
    } catch (error) {
      diagnosticJournal.record('managed startup failed', { attempt });
      await serverInstance?.close();
      if (serverInstance && state.openCodeProcess === serverInstance) state.openCodeProcess = null;
      if (handoffPredecessor) writeOwnState(handoffPredecessor);
      const message = error instanceof Error ? error.message : String(error);
      if (handoffPredecessor && serverInstance?.pid) {
        recordHandoffAdvance(handoffPredecessor.pid, serverInstance.pid, 'aborted', message);
        closeGenerationForPid(serverInstance.pid);
      }
      state.lastOpenCodeError = message;
      if (!handoffContext) state.openCodePort = null;
      syncToHmrState();
      recordStartupPerformance('opencode.attempt.error', {
        attempt,
        totalDurationMs: performance.now() - attemptStartedAt,
        outcome: 'error',
      });
      console.error(`Failed to start OpenCode: ${message}`);
      throw error;
    }
  };

  const startOpenCode = async (handoffContext = null) => {
    managedPreflight = null;
    let lastError = null;
    for (let attempt = 1; attempt <= START_OPEN_CODE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await startOpenCodeOnce(attempt, handoffContext);
      } catch (error) {
        lastError = error;
        if (state.isShuttingDown || error instanceof UnsupportedOpenCodeVersionError || error?.code === 'OPENCODE_BINARY_INVALID') {
          break;
        }
        if (attempt >= START_OPEN_CODE_MAX_ATTEMPTS) {
          break;
        }

        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[OpenCode] Managed server startup failed on attempt ${attempt}/${START_OPEN_CODE_MAX_ATTEMPTS}; retrying: ${message}`);
        if (!handoffContext) {
          state.openCodePort = null;
          state.isOpenCodeReady = false;
          state.openCodeNotReadySince = Date.now();
        }
        syncToHmrState();
        await delay(750 * attempt);
      }
    }

    throw lastError;
  };

  // Only a changed binary or argument list replaces the process. Other launch settings
  // (environment, password, working directory) apply at the next start, so a reload never
  // interrupts running sessions for them.
  const reloadOpenCode = async () => {
    if (state.isShuttingDown || state.isExternalOpenCode || !state.openCodeProcess) return false;
    const recorded = readManagedOpenCodeState(managedPaths.statePath);
    const saved = recorded?.pid === state.openCodeProcess.pid ? recorded : ownRecord?.pid === state.openCodeProcess.pid ? ownRecord : null;
    if (!saved) return false;
    await applyOpencodeBinaryFromSettings({ strict: false });
    const binary = ensureOpencodeCliEnv();
    const args = managedOpenCodeArgs(env.ENV_CONFIGURED_OPENCODE_HOSTNAME);
    // saved.binary is the resolved identity, so an unchanged bin link is not a change.
    if (resolveBinaryIdentity(binary) === saved.binary && sameOpenCodeArgs(saved.args, args)) return false;
    console.log('[OpenCode] binary or arguments changed; handing off to a new OpenCode process');
    await restartOpenCode('config-reload', { handoff: true, busySessionIds: listBusySessionIds() });
    return true;
  };

  const restartOpenCode = async (reason = 'managed-restart', { handoff = false, busySessionIds = null, force = false } = {}) => {
    if (state.isShuttingDown) return;
    if (state.currentRestartPromise) {
      await state.currentRestartPromise;
      return;
    }

    state.currentRestartPromise = (async () => {
      managedPreflight = null;
      if (!state.isExternalOpenCode) diagnosticJournal.record('managed restart started');
      if (!handoff) {
        state.isRestartingOpenCode = true;
        state.isOpenCodeReady = false;
        state.openCodeNotReadySince = Date.now();
      }
      console.log(handoff ? 'Handing off OpenCode process...' : 'Restarting OpenCode process...');

      if (state.isExternalOpenCode) {
        console.log('Re-probing external OpenCode server...');
        const probePort = state.openCodePort ?? env.ENV_EFFECTIVE_PORT ?? 4096;
        const probeOrigin = state.openCodeBaseUrl ?? env.ENV_CONFIGURED_OPENCODE_HOST?.origin;
        const healthy = await probeExternalOpenCode(probePort, probeOrigin);
        if (healthy) {
          console.log(`External OpenCode server on port ${probePort} is healthy`);
          state.openCodeBaseUrl = probeOrigin ?? null;
          setOpenCodePort(probePort);
          state.isOpenCodeReady = true;
          diagnosticJournal.record('external connected');
          state.lastOpenCodeError = null;
          state.openCodeNotReadySince = 0;
          syncToHmrState();
        } else {
          diagnosticJournal.record('external unavailable');
          state.lastOpenCodeError = `External OpenCode server on port ${probePort} is not responding`;
          console.error(state.lastOpenCodeError);
          throw new Error(state.lastOpenCodeError);
        }

        if (state.expressApp) {
          setupProxy(state.expressApp);
          ensureOpenCodeApiPrefix();
        }
        return;
      }

      captureRestartDiagnostics(reason);

      if (!handoff) {
        const portToKill = state.openCodePort;

        if (state.openCodeProcess) {
          console.log('Stopping existing OpenCode process...');
          try {
            await state.openCodeProcess.close();
          } catch (error) {
            console.warn('Error closing OpenCode process:', error);
          }
          state.openCodeProcess = null;
          syncToHmrState();
        }

        if (!(await waitForPortRelease(portToKill, 5000))) {
          console.warn(`Timed out waiting for OpenCode port ${portToKill} to be released`);
        }

        if (env.ENV_CONFIGURED_OPENCODE_PORT) {
          console.log(`Using OpenCode port from environment: ${env.ENV_CONFIGURED_OPENCODE_PORT}`);
          setOpenCodePort(env.ENV_CONFIGURED_OPENCODE_PORT);
        } else {
          state.openCodePort = null;
          syncToHmrState();
        }

        state.openCodeApiPrefixDetected = true;
        state.openCodeApiPrefix = '';
        if (state.openCodeApiDetectionTimer) {
          clearTimeout(state.openCodeApiDetectionTimer);
          state.openCodeApiDetectionTimer = null;
        }
      }

      state.lastOpenCodeError = null;
      state.openCodeProcess = await startOpenCode(handoff ? { busySessionIds, force } : null);
      diagnosticJournal.record('managed restart ready');
      syncToHmrState();

      // A handoff keeps the proxy and the event stream on the old port until the new one is ready.
      if (handoff) return;

      if (state.expressApp) {
        setupProxy(state.expressApp);
        ensureOpenCodeApiPrefix();
      }

      // The restart may have landed on a NEW port (the old one can remain
      // occupied if waitForPortRelease didn't free it in
      // time, on any platform). Upstream event readers pinned to the old
      // process would keep the UI silent forever, so rebind them to the
      // current port. Best effort: a failure here must not fail the restart
      // itself.
      try {
        onOpenCodeRestarted?.();
      } catch (error) {
        console.warn('Failed to rebind event stream after OpenCode restart:', error?.message ?? error);
      }
    })();

    try {
      await state.currentRestartPromise;
    } catch (error) {
      if (!state.isExternalOpenCode) diagnosticJournal.record('managed restart failed');
      console.error(`Failed to ${handoff ? 'hand off' : 'restart'} OpenCode: ${error.message}`);
      state.lastOpenCodeError = error.message;
      if (!handoff) {
        if (!env.ENV_EFFECTIVE_PORT) {
          state.openCodePort = null;
          syncToHmrState();
        }
        state.openCodeApiPrefixDetected = true;
        state.openCodeApiPrefix = '';
      }
      throw error;
    } finally {
      state.currentRestartPromise = null;
      state.isRestartingOpenCode = false;
    }
  };

  const waitForOpenCodeReady = async (timeoutMs = 20000, intervalMs = 400) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const deadline = Date.now() + timeoutMs;
    let lastError = null;

    while (Date.now() < deadline) {
      let timeout = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
        const response = await fetch(buildOpenCodeUrl(OPENCODE_HEALTH_PATH, ''), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        timeout = null;

        if (!response.ok) {
          lastError = new Error(`OpenCode info endpoint responded with status ${response.status}`);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        const info = await readOpenCodeInfo(response);
        if (!info) throw new Error('The server did not identify itself as OpenCode 2.x. OpenChamber requires OpenCode 2.x; if the server runs an older OpenCode, upgrade it.');
        if (!isSupportedOpenCodeVersion(info.version)) throw new UnsupportedOpenCodeVersionError(info.version);
        lastKnownOpenCodeVersion = info.version;
        state.isOpenCodeReady = true;
        state.lastOpenCodeError = null;
        return;
      } catch (error) {
        lastError = error;
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    if (lastError) {
      state.lastOpenCodeError = lastError.message || String(lastError);
      throw lastError;
    }

    const timeoutError = new Error('Timed out waiting for OpenCode to become ready');
    state.lastOpenCodeError = timeoutError.message;
    throw timeoutError;
  };

  const waitForAgentPresence = async (agentName, timeoutMs = 15000, intervalMs = 300) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let timeout = null;
      try {
        const headers = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
        const scopedDirectory = getValidatedDefaultDirectory();
        if (scopedDirectory) headers['x-opencode-directory'] = encodeURIComponent(scopedDirectory);
        // Bound each attempt the way waitForOpenCodeReady bounds its health
        // checks, so one stalled /api/agent request cannot defeat the overall
        // deadline. The abort stays live until the bounded body read completes.
        const controller = new AbortController();
        timeout = setTimeout(
          () => controller.abort(),
          Math.min(HEALTH_CHECK_TIMEOUT_MS, Math.max(deadline - Date.now(), 1)),
        );
        const response = await fetch(buildOpenCodeUrl('/api/agent'), {
          method: 'GET',
          headers,
          signal: controller.signal,
        });

        if (response.ok) {
          // OpenCode 2.x answers `/api/*` with `{ location, data }`.
          const body = await readBoundedResponseJson(response, OPENCODE_AGENT_MAX_BYTES);
          const agents = Array.isArray(body) ? body : body?.data;
          if (Array.isArray(agents) && agents.some((agent) => agent?.id === agentName)) {
            return;
          }
        }
      } catch {
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Agent "${agentName}" not available after OpenCode restart`);
  };

  const refreshOpenCodeAfterConfigChange = async (reason, options = {}) => {
    const { agentName } = options;

    console.log(`Refreshing OpenCode after ${reason}`);
    clearResolvedOpenCodeBinary();
    await applyOpencodeBinaryFromSettings();

    await restartOpenCode(reason || 'config-change', { handoff: true, busySessionIds: listBusySessionIds(), force: true });

    // A managed OpenCode process is restarted (and thus re-reads config from
    // disk) by restartOpenCode(). An external OpenCode server is NOT owned by
    // OpenChamber: restartOpenCode() only re-probes its health, so the freshly
    // written config is on disk but the running server keeps serving its old,
    // startup-cached config until the user restarts it themselves. Report this
    // honestly so callers don't claim the change is live.
    const external = state.isExternalOpenCode === true;

    try {
      await waitForOpenCodeReady();
      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;

      // Waiting for the agent to appear only makes sense when we actually
      // reloaded config. An external server will never surface it here.
      if (agentName && !external) {
        await waitForAgentPresence(agentName);
      }

      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;
    } catch (error) {
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.error(`Failed to refresh OpenCode after ${reason}:`, error.message);
      throw error;
    }

    return { reloaded: !external, external };
  };

  const bootstrapOpenCodeAtStartup = async () => {
    const bootstrapStartedAt = performance.now();
    let bootstrapError = null;
    let unsupportedExternalVersion = null;
    recordStartupPerformance('opencode.bootstrap.start');
    try {
      // Before doing anything, reap any OpenCode process WE spawned in a prior
      // run that was orphaned by a crash/hard-exit. Verified + scoped to our own
      // pids, so it never touches a live instance's or the user's own server.
      try {
        const orphanReapStartedAt = performance.now();
        const keepPids = [
          readManagedOpenCodeState(managedPaths.statePath)?.pid,
          ...readDrainingOpenCodeRecords(managedPaths.drainingPath).map((record) => record.pid),
        ].filter(Number.isInteger);
        const { reaped } = await reapManagedOrphanedProcesses({ log: (msg) => console.log(msg), keepPids });
        recordStartupPerformance('opencode.orphan-reap.ready', {
          durationMs: performance.now() - orphanReapStartedAt,
          totalDurationMs: performance.now() - bootstrapStartedAt,
        });
        if (reaped > 0) console.log(`[lifecycle] startup reaped ${reaped} orphaned OpenCode process(es)`);
      } catch (error) {
        console.warn('[lifecycle] orphan reap failed:', error?.message ?? error);
      }

      syncFromHmrState();
      if (await isOpenCodeProcessHealthy()) {
        console.log(`[HMR] Reusing existing OpenCode process on port ${state.openCodePort}`);
      } else if (env.ENV_SKIP_OPENCODE_START && env.ENV_EFFECTIVE_PORT) {
        const label = env.ENV_CONFIGURED_OPENCODE_HOST ? env.ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
        console.log(`Using external OpenCode server at ${label} (skip-start mode)`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        state.isOpenCodeReady = true;
        state.isExternalOpenCode = true;
        diagnosticJournal.record('external connected');
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        syncToHmrState();
      } else if (env.ENV_EFFECTIVE_PORT && await probeExternalOpenCode(env.ENV_EFFECTIVE_PORT, env.ENV_CONFIGURED_OPENCODE_HOST?.origin)) {
        const label = env.ENV_CONFIGURED_OPENCODE_HOST ? env.ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
        console.log(`Auto-detected existing OpenCode server at ${label}`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        state.isOpenCodeReady = true;
        state.isExternalOpenCode = true;
        diagnosticJournal.record('external connected');
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        syncToHmrState();
      } else if (env.ENV_EFFECTIVE_PORT && (unsupportedExternalVersion = await readUnsupportedExternalOpenCodeVersion(
        env.ENV_EFFECTIVE_PORT,
        env.ENV_CONFIGURED_OPENCODE_HOST?.origin,
      ))) {
        // The configured server is an OpenCode this OpenChamber cannot use.
        // Attach to it anyway, not ready, so the compatibility check reports
        // its version instead of a managed instance silently replacing it.
        const label = env.ENV_CONFIGURED_OPENCODE_HOST ? env.ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
        console.warn(`OpenCode ${unsupportedExternalVersion} at ${label} is not supported by this OpenChamber`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        state.isExternalOpenCode = true;
        diagnosticJournal.record('external unavailable');
        syncToHmrState();
        throw new UnsupportedOpenCodeVersionError(unsupportedExternalVersion);
      } else {
        // We never auto-attach to an arbitrary pre-existing OpenCode instance.
        // Attaching to an external server requires explicit opt-in via env
        // (OPENCODE_HOST / OPENCODE_PORT / OPENCODE_SKIP_START), handled by the
        // branches above. Without that opt-in we always start our OWN managed
        // instance on a freshly-allocated port. A blind probe of the default
        // port 4096 used to hijack a user's separately-running OpenCode (e.g.
        // the OpenCode desktop app), coupling our lifecycle to theirs and
        // breaking init against an unexpected server version/config.
        if (env.ENV_EFFECTIVE_PORT) {
          console.log(`Using OpenCode port from environment: ${env.ENV_EFFECTIVE_PORT}`);
          setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        } else {
          state.openCodePort = null;
          syncToHmrState();
        }

        state.lastOpenCodeError = null;
        state.openCodeProcess = await startOpenCode();
        syncToHmrState();
      }
      await waitForOpenCodePort();
      try {
        await waitForOpenCodeReady();
      } catch (error) {
        bootstrapError = error;
        if (state.isExternalOpenCode) diagnosticJournal.record('external unavailable');
        // Skip-start mode assumed readiness up front; a server that never
        // proved itself must not keep reporting ready to startup diagnostics.
        state.isOpenCodeReady = false;
        console.error(`OpenCode readiness check failed: ${error.message}`);
      }
    } catch (error) {
      bootstrapError = error;
      console.error(`Failed to start OpenCode: ${error.message}`);
      console.log('Continuing without OpenCode integration...');
      state.lastOpenCodeError = error.message;
    }
    diagnosticJournal.record(bootstrapError ? 'bootstrap failed' : 'bootstrap ready');
    recordStartupPerformance(
      bootstrapError ? 'opencode.bootstrap.error' : 'opencode.bootstrap.ready',
      {
        totalDurationMs: performance.now() - bootstrapStartedAt,
        outcome: bootstrapError ? 'error' : 'ready',
      },
    );
    if (!bootstrapError) {
      void warmOpenCodeDirectories();
    }
  };

  // The directory server-side reads use when they have none of their own: the
  // one warmed at startup, which OpenCode is running anyway. v2 answers a
  // location read without a directory for its own working directory (the
  // user's home for a managed OpenCode) and starts it, MCP servers included.
  //
  // It is a cache of the directory warmed at startup, but that directory can
  // stop being usable while the server keeps running: the user deletes or
  // moves the project, the path is replaced by a regular file, or its
  // permissions change. Handing that stale path to OpenCode makes every
  // directory-scoped read answer `500 FileSystem.realPath ... ENOENT`, which
  // is an avoidable failure of reads that are not about the directory at all
  // (the integration list behind quota credentials, the small model's model
  // list). The getter therefore revalidates on each read and, when the cached
  // path is no longer usable, advances to another directory the warm pass
  // validated and re-reads the settings-backed warmup source so the
  // currently-valid `lastDirectory` replaces the stale one. Only a usable
  // directory is ever sent; a valid directory still scopes the read, which
  // keeps OpenCode from booting its working directory + MCP fleet.
  let defaultOpenCodeDirectory = null;
  // The directories the last warm pass (or a later refresh) found usable,
  // kept so a stale default can fall back synchronously without another
  // settings read.
  let warmedOpenCodeDirectories = [];
  let defaultDirectoryRefresh = null;
  let defaultDirectoryRefreshAt = 0;
  // A stale default is normal once and persistent when the user has no usable
  // directory at all; the cooldown keeps that state from turning every read
  // (small-model generations can be frequent) into a settings read.
  const DEFAULT_DIRECTORY_REFRESH_COOLDOWN_MS = 5000;

  const isUsableDirectory = (directory) => {
    if (!directory) return false;
    try {
      // `stat`/`access` reject a non-path value on their own, so the caller
      // only needs to rule out an empty hint; a throw lands in the catch.
      if (!statSync(directory).isDirectory()) return false;
      // A directory whose read/execute bit is gone is not a directory scoped
      // reads can use; OpenCode answers `500 FileSystem.realPath` for it just
      // like the missing-path case, so treat it the same.
      accessSync(directory, fsConstants.R_OK | fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  const usableDirectories = (directories) => (
    Array.isArray(directories) ? directories.filter((directory) => isUsableDirectory(directory)) : []
  );

  // The first directory that is usable *right now*, revalidating each
  // candidate because the warmed list was validated only at warm time.
  const selectUsableDirectory = (directories) => usableDirectories(directories)[0] || null;

  // Re-reads the settings-backed warmup source when the cached default is no
  // longer usable, so a directory valid now (`lastDirectory` after a move, a
  // surviving project) replaces the stale one. Coalesced: concurrent reads
  // trigger at most one refresh.
  const refreshDefaultDirectories = () => {
    if (defaultDirectoryRefresh) return defaultDirectoryRefresh;
    defaultDirectoryRefresh = (async () => {
      try {
        const directories = await getWarmupDirectories();
        warmedOpenCodeDirectories = usableDirectories(directories);
        const usable = selectUsableDirectory(warmedOpenCodeDirectories);
        if (usable) defaultOpenCodeDirectory = usable;
      } catch {
        // Best-effort: the caller falls back to the no-project directory or
        // OpenCode's working directory for this read, and the refresh can
        // succeed next time.
      } finally {
        defaultDirectoryRefresh = null;
      }
    })();
    return defaultDirectoryRefresh;
  };

  // The warmed directory only while it is still usable; otherwise another
  // usable directory (from this or a refreshed pass), else the no-project
  // directory, else null so the caller sends no directory and OpenCode uses
  // its own working directory.
  const getValidatedDefaultDirectory = () => {
    if (isUsableDirectory(defaultOpenCodeDirectory)) return defaultOpenCodeDirectory;
    const alternate = selectUsableDirectory(warmedOpenCodeDirectories);
    if (alternate) {
      defaultOpenCodeDirectory = alternate;
      return alternate;
    }
    const checkedAt = now();
    if (!defaultDirectoryRefresh && checkedAt - defaultDirectoryRefreshAt >= DEFAULT_DIRECTORY_REFRESH_COOLDOWN_MS) {
      defaultDirectoryRefreshAt = checkedAt;
      void refreshDefaultDirectories();
    }
    return isUsableDirectory(noProjectDirectory) ? noProjectDirectory : null;
  };

  // OpenCode initializes each project directory lazily on its first
  // directory-scoped request, and that initialization takes seconds on large
  // session stores. Without warming, the user's first session open pays it
  // interactively (the chat waits on the message fetch until the directory
  // finishes initializing). Warm the last-used directory right after
  // readiness so the work overlaps UI startup instead. Sequential and
  // best-effort: a failed or slow directory never blocks the others for long,
  // and a restart invalidates the pass via the port/readiness guard.
  const warmOpenCodeDirectories = async () => {
    let directories = [];
    try {
      directories = await getWarmupDirectories();
    } catch {
      return;
    }
    if (!Array.isArray(directories) || directories.length === 0) return;
    warmedOpenCodeDirectories = usableDirectories(directories);
    defaultOpenCodeDirectory = warmedOpenCodeDirectories[0] || null;

    const warmedPort = state.openCodePort;
    for (const directory of directories.slice(0, WARMUP_DIRECTORY_LIMIT)) {
      if (typeof directory !== 'string' || !directory) continue;
      if (!state.isOpenCodeReady || state.openCodePort !== warmedPort) return;
      let timeout = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), WARMUP_REQUEST_TIMEOUT_MS);
        // Warming a directory is the point, not the answer: any read that goes
        // through v2's location middleware makes OpenCode initialise it.
        // `/api/location` is the cheapest; `/api/session` is a global list and
        // warms nothing. v2 takes the directory from this header, not from a
        // `?directory=` query.
        const url = buildOpenCodeUrl('/api/location', '');
        await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'x-opencode-directory': encodeURIComponent(directory),
            ...getOpenCodeAuthHeaders(),
          },
          signal: controller.signal,
        });
      } catch {
        // Best-effort — the directory stays lazy and the UI's own request warms it.
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  };

  /**
   * Perform an immediate (one-shot) health check and restart OpenCode if it's
   * not healthy.  Callers on the SSE / WS proxy path use this to trigger
   * recovery without waiting for the next periodic interval (up to 15 s).
   *
   * Skips restart when sessions are actively busy — a busy server under
   * concurrent load can fail the health check timeout without actually
   * being dead (the health endpoint competes with LLM work).
   * Forces restart if sessions stay "busy" and the server stays unhealthy
   * for over 2 minutes (staleness guard against stuck session state).
   */
  const STALE_BUSY_GRACE_MS = 2 * 60 * 1000;
  let lastUnhealthyWithBusySessionsAt = 0;
  let consecutiveHealthFailures = 0;
  let lastCountedHealthFailureAt = 0;
  let healthProbePromise = null;
  let healthCheckCyclePromise = null;
  let lastHealthProbeResult = null;
  let healthFailureCountIntervalMs = 15_000;

  const resetHealthFailureState = () => {
    consecutiveHealthFailures = 0;
    lastUnhealthyWithBusySessionsAt = 0;
    lastCountedHealthFailureAt = 0;
  };

  const probeOpenCodeHealth = async () => {
    const checkedAt = now();
    if (lastHealthProbeResult && checkedAt - lastHealthProbeResult.at < HEALTH_CHECK_RESULT_CACHE_MS) {
      return lastHealthProbeResult;
    }

    if (healthProbePromise) {
      return healthProbePromise;
    }

    healthProbePromise = probeOpenCodeHealthDetailed()
      .then((result) => {
        lastHealthProbeResult = { at: now(), ...result };
        return lastHealthProbeResult;
      })
      .finally(() => {
        healthProbePromise = null;
      });

    return healthProbePromise;
  };

  const shouldSkipRestartForBusySessions = () => {
    const activeCount = getActiveSessionCount();
    if (activeCount === 0) {
      lastUnhealthyWithBusySessionsAt = 0;
      return { skip: false, staleBusy: false };
    }

    const checkedAt = now();
    if (!lastUnhealthyWithBusySessionsAt) {
      lastUnhealthyWithBusySessionsAt = checkedAt;
      return { skip: true, staleBusy: false };
    }

    if (checkedAt - lastUnhealthyWithBusySessionsAt >= STALE_BUSY_GRACE_MS) {
      console.warn(
        `[lifecycle] OpenCode unhealthy with ${activeCount} busy session(s) for > 2 min — forcing restart`
      );
      lastUnhealthyWithBusySessionsAt = 0;
      return { skip: false, staleBusy: true };
    }

    return { skip: true, staleBusy: false };
  };

  const runHealthCheckCycle = async (source) => {
    if ((!state.openCodeProcess && !state.isExternalOpenCode) || state.isShuttingDown || state.isRestartingOpenCode) return;
    if (healthCheckCyclePromise) return healthCheckCyclePromise;

    healthCheckCyclePromise = (async () => {
      if (state.isExternalOpenCode) {
        const probePort = state.openCodePort ?? env.ENV_EFFECTIVE_PORT ?? 4096;
        const probeOrigin = state.openCodeBaseUrl ?? env.ENV_CONFIGURED_OPENCODE_HOST?.origin;
        const healthy = await probeExternalOpenCode(probePort, probeOrigin);
        const checkedAt = now();

        if (healthy) {
          if (!state.isOpenCodeReady) {
            diagnosticJournal.record('health recovered');
            state.isOpenCodeReady = true;
            state.openCodeNotReadySince = 0;
            syncToHmrState();
          }
          resetHealthFailureState();
          return;
        }

        const wasReady = state.isOpenCodeReady;
        state.isOpenCodeReady = false;
        if (!state.openCodeNotReadySince) state.openCodeNotReadySince = checkedAt;
        state.lastOpenCodeHealthFailure = {
          class: 'error',
          detail: 'External OpenCode health probe failed or returned an unsupported version',
          at: new Date(checkedAt).toISOString(),
          source,
        };
        if (wasReady) {
          diagnosticJournal.record('health failed', { failureClass: 'error' });
        }
        syncToHmrState();
        return;
      }

      const healthResult = await probeOpenCodeHealth();
      if (!healthResult.healthy) {
        if (!isManagedOpenCodeProcessAlive()) {
          console.log(`[lifecycle] ${source} health check: OpenCode process exited, restarting...`);
          consecutiveHealthFailures = 0;
          lastHealthProbeResult = null;
          await restartOpenCode(`${source}-process-exited`);
          return;
        }
        const checkedAt = now();
        if (lastCountedHealthFailureAt && checkedAt - lastCountedHealthFailureAt < healthFailureCountIntervalMs) {
          return;
        }
        lastCountedHealthFailureAt = checkedAt;
        consecutiveHealthFailures += 1;
        const healthFailure = healthResult.failure || {
          class: 'error',
          detail: 'Health check failed without diagnostic detail',
        };
        state.lastOpenCodeHealthFailure = {
          class: healthFailure.class,
          detail: healthFailure.detail,
          at: new Date(checkedAt).toISOString(),
          source,
        };
        diagnosticJournal.record('health failed', { failureClass: healthFailure.class });
        console.warn(
          `[lifecycle] ${source} health check failed (${consecutiveHealthFailures}/${HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES}) class=${healthFailure.class}`
        );
        if (consecutiveHealthFailures < HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES) return;
        const busyDecision = shouldSkipRestartForBusySessions();
        if (busyDecision.skip) return;
        console.log(`[lifecycle] ${source} health check failure threshold reached, restarting OpenCode...`);
        consecutiveHealthFailures = 0;
        lastHealthProbeResult = null;
        await restartOpenCode(
          busyDecision.staleBusy
            ? `${source}-stale-busy-health-failure`
            : `${source}-health-failure`,
        );
      } else {
        if (consecutiveHealthFailures) diagnosticJournal.record('health recovered');
        resetHealthFailureState();
      }
    })().finally(() => {
      healthCheckCyclePromise = null;
    });

    return healthCheckCyclePromise;
  };

  const triggerHealthCheck = async () => {
    try {
      await runHealthCheckCycle('immediate');
    } catch (error) {
      console.error(`[lifecycle] immediate health check error: ${error.message}`);
    }
  };

  const startHealthMonitoring = (healthCheckIntervalMs) => {
    if (state.healthCheckInterval) {
      clearInterval(state.healthCheckInterval);
    }

    const effectiveIntervalMs = HEALTH_CHECK_INTERVAL_OVERRIDE_MS || healthCheckIntervalMs;
    healthFailureCountIntervalMs = effectiveIntervalMs;

    state.healthCheckInterval = setInterval(async () => {
      try {
        await runHealthCheckCycle('periodic');
      } catch (error) {
        console.error(`Health check error: ${error.message}`);
      }
    }, effectiveIntervalMs);
  };


  // The managed-servers read (design #612 phase 2, #525): registry entries
  // from the validated readers, this instance's own server completed from
  // lifecycle state, and the session runtime's live count. The projection
  // in managed-servers.js is the allowlist; state.json fields beyond the
  // own pid/port/startedAt never leave this runtime.
  const getManagedServersSnapshot = async () => {
    // A failed registry read propagates: the route answers 500 rather than
    // presenting an unavailable registry as an empty server list.
    const registryEntries = await readRegistryEntries();
    const drainingRecords = [
      ...readDrainingOpenCodeRecords(managedPaths.drainingPath),
      ...drainingOpenCode.snapshot(),
    ];
    // Adopt the live state as the ready own server when no ready transition
    // was observed in this runtime (e.g. an HMR-reused process).
    if (
      !lastReadyOwnServer &&
      state.isOpenCodeReady === true &&
      Number.isInteger(state.openCodeProcess?.pid) &&
      Number.isInteger(state.openCodePort)
    ) {
      lastReadyOwnServer = { pid: state.openCodeProcess.pid, port: state.openCodePort };
    }
    const readyOwn =
      lastReadyOwnServer && isPidAlive(lastReadyOwnServer.pid) ? lastReadyOwnServer : null;
    const startingPid = state.openCodeProcess?.pid ?? ownRecord?.pid ?? null;
    const own = state.isExternalOpenCode
      ? null
      : readyOwn
        ? {
            pid: readyOwn.pid,
            port: readyOwn.port,
            directory: getValidatedDefaultDirectory(),
            version: lastKnownOpenCodeVersion,
            ready: true,
            startedAt: ownRecord?.pid === readyOwn.pid ? (ownRecord?.startedAt ?? null) : null,
            sessionCount: getActiveHostSessionCount(),
          }
        : Number.isInteger(startingPid)
          ? {
              // Still starting, and no predecessor is ready: report only
              // what belongs to this pid. Port and session count stay null
              // (the projection falls back to this pid's own registry
              // entry for the port) instead of borrowing another
              // process's values.
              pid: startingPid,
              port: null,
              directory: getValidatedDefaultDirectory(),
              version: null,
              ready: false,
              startedAt: ownRecord?.pid === startingPid ? (ownRecord?.startedAt ?? null) : null,
              sessionCount: null,
            }
          : null;
    // Verify recorded pids before building the response, in parallel:
    // the projected port for a pid is its registry port, falling back to
    // its draining record's port when the registry has none (the same
    // precedence the builder applies). The hosting instance's own pid is
    // exempt — it is verified by this instance's live lifecycle state.
    const recordedPorts = new Map();
    for (const entry of Array.isArray(registryEntries) ? registryEntries : []) {
      if (Number.isInteger(entry?.pid) && !recordedPorts.has(entry.pid)) {
        recordedPorts.set(entry.pid, Number.isInteger(entry.port) && entry.port > 0 ? entry.port : null);
      }
    }
    for (const record of Array.isArray(drainingRecords) ? drainingRecords : []) {
      if (!Number.isInteger(record?.pid)) continue;
      if (!recordedPorts.has(record.pid)) {
        recordedPorts.set(record.pid, Number.isInteger(record.port) && record.port > 0 ? record.port : null);
      } else if (recordedPorts.get(record.pid) === null && Number.isInteger(record.port) && record.port > 0) {
        recordedPorts.set(record.pid, record.port);
      }
    }
    const verifiedRecordedPids = new Set();
    await Promise.all(
      [...recordedPorts.entries()]
        .filter(([pid]) => pid !== own?.pid && isPidAlive(pid))
        .map(async ([pid, port]) => {
          const command = await readRecordedProcessCommand(pid);
          if (commandIdentifiesOurServer(command, { port })) verifiedRecordedPids.add(pid);
        }),
    );
    return buildManagedServersResponse({
      registryEntries,
      drainingRecords,
      own,
      isPidAlive,
      isRecordedPidVerified: (server) => verifiedRecordedPids.has(server.pid),
      now: now(),
    });
  };

  return {
    /** The managed OpenCode's launch environment; null for an external OpenCode or before the first launch. */
    getManagedOpenCodeProcessEnv: () => (state.isExternalOpenCode ? null : managedProcessEnv),
    /** The directory to scope a server-side OpenCode read that has none, or null once none is usable. */
    getDefaultOpenCodeDirectory: () => getValidatedDefaultDirectory(),
    /**
     * The UI saved the directory it now works in. That directory is running
     * already, so reads without a directory of their own go there: the one
     * used last at startup may be a chat the user has left, and the UI stops
     * a left chat's OpenCode location, which such a read would start again.
     */
    noteCurrentDirectory: (directory) => {
      if (!isUsableDirectory(directory)) return;
      defaultOpenCodeDirectory = directory;
      warmedOpenCodeDirectories = [directory, ...warmedOpenCodeDirectories.filter((entry) => entry !== directory)];
    },
    getManagedServersSnapshot,
    getManagedOpenCodePreflight: async () => {
      const preflight = managedPreflight;
      if (!preflight || state.isExternalOpenCode || state.isShuttingDown) return false;
      const compatible = await preflight;
      return compatible && preflight === managedPreflight && !state.isExternalOpenCode && !state.isShuttingDown;
    },
    reloadOpenCode,
    startOpenCode,
    restartOpenCode,
    closeDrainingOpenCode: () => drainingOpenCode.closeAll('openchamber-stop'),
    waitForOpenCodeReady,
    waitForAgentPresence,
    refreshOpenCodeAfterConfigChange,
    bootstrapOpenCodeAtStartup,
    startHealthMonitoring,
    triggerHealthCheck,
    waitForPortRelease,
  };
};
