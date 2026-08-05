import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from '../cli-output.js';
import { getGuardianSocketPath, isGuardianRunning } from '../../server/lib/guardian/detection.js';
import { GuardianClient } from '../../server/lib/guardian/guardian-client.js';
import { resolveGuardianPaths } from '../../server/lib/guardian/paths.js';
import { readProcessIdentity, probeProcessLiveness } from '../../server/lib/guardian/process-identity.js';
import {
  inspectGuardianPidMarker,
  readGuardianPidMarker,
} from '../../server/lib/guardian/pid-marker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GUARDIAN_ENTRY = path.resolve(__dirname, '..', 'openchamber-guardian.js');

let cachedGuardianPaths = null;
function getDefaultGuardianPaths() {
  if (cachedGuardianPaths === null) {
    const paths = resolveGuardianPaths();
    cachedGuardianPaths = {
      ...paths,
      socketPath: getGuardianSocketPath(paths.rootDir),
    };
  }
  return cachedGuardianPaths;
}

const GUARDIAN_AUTOSTART_ENV = 'OPENCHAMBER_GUARDIAN_AUTOSTART';
const GUARDIAN_LOG_FILE = 'guardian.log';
const PROBE_READY_TIMEOUT_MS = 5000;
const PROBE_POLL_INTERVAL_MS = 100;
const STOP_TIMEOUT_MS = 3000;
const WINDOWS_GUARDIAN_IPC_REQUIRED_MESSAGE =
  'authenticated guardian IPC is required on Windows; PID fallback signaling is disabled to prevent PID reuse. Retry after the guardian IPC endpoint is reachable.';

function getDefaultGuardianSocketPath() {
  return getDefaultGuardianPaths().socketPath;
}

function getDefaultGuardianPidFile() {
  return getDefaultGuardianPaths().pidFile;
}

/**
 * W-C: Windows discovery-file path (`<rootDir>/port`) or `undefined` on
 * Linux/POSIX. Always returns a stable value within a single process
 * because `defaultIpcPaths` is platform-dispatched; consumers can pass
 * this unconditionally to `GuardianClient` / `isGuardianRunning` /
 * `startGuardianDetached` and the transport factory decides which to
 * dial.
 */
function getDefaultGuardianPortPath() {
  return getDefaultGuardianPaths().portPath;
}

function _resetCachedGuardianPathsForTest() {
  cachedGuardianPaths = null;
}

// W-C: `assertPlatformSupported` is removed. The CLI subcommands now
// work on every platform; the per-platform IPC paths come from
// `defaultIpcPaths`. The `--no-handoff` and `--no-guardian` opt-outs
// remain the operator-facing escape hatches for users who want legacy
// behavior.

function readPidFile() {
  const marker = readGuardianPidMarker(getDefaultGuardianPidFile());
  return Number.isFinite(marker?.pid) && marker.pid > 0 ? marker.pid : null;
}

let processAliveOverride = null;
async function isProcessAlive(pid) {
  if (typeof processAliveOverride === 'function') {
    const state = processAliveOverride(pid);
    return state === true || state === 'alive';
  }
  if (!Number.isFinite(pid) || pid <= 0) return false;
  return probeProcessLiveness(pid) === 'alive';
}
function _setProcessAliveOverrideForTest(fn) {
  processAliveOverride = fn;
}

async function waitForGuardianReady({
  socketPath = getDefaultGuardianSocketPath(),
  portPath = getDefaultGuardianPortPath(),
  timeoutMs = PROBE_READY_TIMEOUT_MS,
  intervalMs = PROBE_POLL_INTERVAL_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await isGuardianRunning(socketPath, portPath)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
}

async function waitForPidFileRemoved({
  timeoutMs = STOP_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const marker = readGuardianPidMarker(getDefaultGuardianPidFile());
    if (!marker) return true;
    await new Promise((r) => setTimeout(r, PROBE_POLL_INTERVAL_MS));
  }
  return false;
}

async function startGuardianDetached({
  logFd,
  env,
  dataDir,
  socketPath,
  portPath,
  spawnFn = spawn,
} = {}) {
  // W-C: the Windows early-rejection is removed. The standalone
  // guardian process now starts on every platform; the IPC transport
  // factory inside it dispatches per-platform. `windowsHide: true`
  // remains defense-in-depth against a console flash on Windows.

  const childEnv = { ...process.env, ...(env || {}) };
  const effectiveDataDir = dataDir ?? childEnv.OPENCHAMBER_DATA_DIR;
  const resolvedPaths = resolveGuardianPaths({
    dataDir: effectiveDataDir,
    socketPath,
    portPath,
  });
  const effectiveSocketPath = resolvedPaths.socketPath;
  const effectivePortPath = resolvedPaths.portPath;

  const args = [GUARDIAN_ENTRY];
  if (typeof effectiveSocketPath === 'string'
      && effectiveSocketPath
      && effectiveSocketPath !== getDefaultGuardianSocketPath()) {
    args.push('--socket-path', effectiveSocketPath);
  }
  if (typeof effectivePortPath === 'string'
      && effectivePortPath
      && effectivePortPath !== getDefaultGuardianPortPath()) {
    args.push('--port-path', effectivePortPath);
  }
  if (effectiveDataDir) {
    args.push('--data-dir', effectiveDataDir);
  }

  const child = spawnFn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: childEnv,
    windowsHide: true,
  });

  if (child && typeof child.unref === 'function') {
    child.unref();
  }

  const pid = child && Number.isFinite(child.pid) ? child.pid : 0;
  return { pid, socketPath: effectiveSocketPath, portPath: effectivePortPath, child };
}

async function stopGuardianViaIpc({
  timeoutMs = STOP_TIMEOUT_MS,
  socketPath = getDefaultGuardianSocketPath(),
  portPath = getDefaultGuardianPortPath(),
  killFn = process.kill,
  processIdentityFn = readProcessIdentity,
  processLivenessFn = probeProcessLiveness,
  logWarning,
} = {}) {
  // There is no platform short-circuit before the IPC shutdown RPC; the
  // transport factory dials the right backend. After an IPC failure, Windows
  // deliberately refuses the POSIX-style PID fallback below.

  const emitWarning = (message) => {
    if (typeof logWarning === 'function') {
      logWarning(message);
    } else {
      // Best-effort fallback: never throw out of a cleanup helper.
      try { console.warn(`Warning: ${message}`); } catch { /* ignore */ }
    }
  };

  let ipcError = null;
  let shutdownAcknowledged = false;
  try {
    const client = new GuardianClient({
      socketPath,
      portPath,
      connectTimeoutMs: Math.min(timeoutMs, 1500),
      requestTimeoutMs: timeoutMs,
    });
    try {
      await client.connect();
      const shutdownResult = await client.shutdown();
      shutdownAcknowledged = shutdownResult?.acknowledged === true;
    } finally {
      try { client.disconnect(); } catch { /* ignore */ }
    }
    if (await waitForPidFileRemoved({ timeoutMs })) {
      return true;
    }
    if (shutdownAcknowledged) {
      let reachable = true;
      try {
        reachable = await isGuardianRunning(socketPath, portPath);
      } catch {
        // An ambiguous post-shutdown probe is not proof that the guardian is
        // gone; preserve the live-child recovery path below.
        reachable = true;
      }
      if (reachable) {
        emitWarning('Guardian acknowledged shutdown but remains reachable; refusing direct termination while child state is unresolved.');
        return false;
      }
      emitWarning('Guardian acknowledged shutdown but guardian.pid remains; refusing to report success or signal a PID fallback.');
      return false;
    }
    ipcError = new Error('IPC shutdown completed but PID file was not removed within timeout');
  } catch (error) {
    ipcError = error;
  }

  // IPC path failed (connect refused, hung, stale socket, ...). Windows has no
  // safe equivalent of a retained guardian process handle here, so never turn
  // a persisted PID into a signal target after an IPC failure. POSIX keeps its
  // existing identity-fenced fallback below.
  if (process.platform === 'win32') {
    emitWarning(`Guardian IPC shutdown failed; ${WINDOWS_GUARDIAN_IPC_REQUIRED_MESSAGE}`);
    return false;
  }

  // POSIX direct signaling is only a last resort after revalidating the
  // persisted marker identity.
  emitWarning(
    `Guardian IPC shutdown failed (${ipcError?.message || String(ipcError)}); checking persisted identity before fallback signaling.`
  );

  const marker = readGuardianPidMarker(getDefaultGuardianPidFile());
  if (!marker || !Number.isFinite(marker.pid) || marker.pid <= 0) {
    emitWarning('Guardian PID marker is missing or malformed; refusing direct termination.');
    return false;
  }
  const verifyIdentity = () => inspectGuardianPidMarker(marker, {
    readIdentity: processIdentityFn,
    liveness: processLivenessFn,
  });
  const beforeTerm = verifyIdentity();
  if (beforeTerm.state === 'stale' && beforeTerm.reason === 'recorded process is dead') {
    emitWarning('Guardian PID marker is stale but was not removed; refusing to report a confirmed stop.');
    return false;
  }
  if (beforeTerm.state !== 'alive') {
    emitWarning(`Guardian PID marker identity is unresolved (${beforeTerm.reason || 'unknown'}); refusing direct termination.`);
    return false;
  }

  try {
    killFn(marker.pid, 'SIGTERM');
  } catch (error) {
    emitWarning(
      `Guardian SIGTERM failed (${error?.message || String(error)}); checking identity before SIGKILL.`
    );
  }

  if (await waitForPidFileRemoved({ timeoutMs })) {
    return true;
  }

  const beforeKill = verifyIdentity();
  if (beforeKill.state === 'stale' && beforeKill.reason === 'recorded process is dead') {
    emitWarning('Guardian PID marker remains after the process exited; refusing to report a confirmed stop.');
    return false;
  }
  if (beforeKill.state !== 'alive') {
    emitWarning(`Guardian PID marker identity is unresolved (${beforeKill.reason || 'unknown'}); refusing SIGKILL.`);
    return false;
  }
  {
    try {
      killFn(marker.pid, 'SIGKILL');
    } catch (error) {
      emitWarning(
        `Guardian SIGKILL failed (${error?.message || String(error)}).`
      );
      return false;
    }
  }
  return await waitForPidFileRemoved({ timeoutMs });
}

async function getGuardianStatus({
  socketPath = getDefaultGuardianSocketPath(),
  portPath = getDefaultGuardianPortPath(),
} = {}) {
  // W-C: Windows is now supported; `isGuardianRunning` dispatches per
  // platform via the optional `portPath` argument.
  const running = await isGuardianRunning(socketPath, portPath);
  const pid = running ? readPidFile() : null;
  return {
    running,
    pid: Number.isFinite(pid) ? pid : null,
    socketPath,
    portPath,
    supported: true,
    platform: process.platform,
  };
}

// CLI-boundary derivation of the "this OpenChamber instance owns a managed
// local OpenCode" decision. The CLI runs before the server, so it cannot read
// the server's normalized `ownsManagedLocalOpenCode()`; instead it derives the
// same answer from the operator env flags here. This is the single CLI call
// site that needs the decision — it is not a scattered raw env check. The
// server side normalizes the same flag in `packages/web/server/index.js`.
const SKIP_OPENCODE_START_ENV_KEYS = ['OPENCODE_SKIP_START', 'OPENCHAMBER_SKIP_OPENCODE_START'];
const isSkipStartConfigured = () => SKIP_OPENCODE_START_ENV_KEYS.some(
  (key) => process.env[key] === 'true',
);

function shouldAutoStartGuardian({ options } = {}) {
  // W-C: Windows is supported; the opt-outs are the CLI flags
  // (`--no-guardian`, `--no-handoff`), the env-var kill switch, and explicit
  // external/skip-start mode. When an operator configures external OpenCode
  // (`OPENCODE_SKIP_START` / `OPENCHAMBER_SKIP_OPENCODE_START`), this instance
  // does not own a managed local OpenCode, so we must not autostart the
  // guardian merely for OpenCode ownership. A previously-running guardian
  // (possibly a separate service) is left untouched; autostart only spawns a
  // new one when this instance will actually manage OpenCode through it.
  if (!options || options.guardian === false) return false;
  if (options.handoff === false) return false;
  if (process.env[GUARDIAN_AUTOSTART_ENV] === 'disabled') return false;
  if (isSkipStartConfigured()) return false;
  return true;
}

async function maybeAutoStartGuardian({
  logFd,
  options,
  emitNotice,
  spawnFn,
  waitForReadyFn = waitForGuardianReady,
  readyTimeoutMs = PROBE_READY_TIMEOUT_MS,
  readyPollIntervalMs = PROBE_POLL_INTERVAL_MS,
} = {}) {
  if (!shouldAutoStartGuardian({ options })) {
    return { started: false, reason: 'opt-out' };
  }

  const socketPath = getDefaultGuardianSocketPath();
  const portPath = getDefaultGuardianPortPath();
  if (await isGuardianRunning(socketPath, portPath)) {
    const pid = readPidFile();
    if (typeof emitNotice === 'function') {
      emitNotice({
        level: 'info',
        code: 'GUARDIAN_ALREADY_RUNNING',
        message: `guardian already running${pid ? ` (pid ${pid})` : ''}`,
      });
    }
    return { started: false, reason: 'already-running', pid: Number.isFinite(pid) ? pid : null };
  }

  try {
    const { pid } = await startGuardianDetached({ logFd, socketPath, portPath, spawnFn });
    // TOCTOU: between our isGuardianRunning probe and the spawn, another
    // invocation may have won the race. The entrypoint's O_EXCL PID file
    // is the authoritative mutex; if the recorded PID differs from ours
    // and is alive, another process owns the singleton.
    const winnerPid = readPidFile();
    if (Number.isFinite(pid) && pid > 0
        && Number.isFinite(winnerPid) && winnerPid > 0
        && winnerPid !== pid
        && (await isProcessAlive(winnerPid))) {
      const ready = await waitForReadyFn({
        socketPath,
        portPath,
        timeoutMs: readyTimeoutMs,
        intervalMs: readyPollIntervalMs,
      });
      if (!ready) {
        throw new Error(`guardian IPC endpoint did not become ready within ${readyTimeoutMs}ms`);
      }
      if (typeof emitNotice === 'function') {
        emitNotice({
          level: 'info',
          code: 'GUARDIAN_RACE_LOST',
          message: `guardian autostart raced; another instance already owns pid ${winnerPid}`,
        });
      }
      return { started: false, reason: 'already-running', pid: winnerPid };
    }
    if (Number.isFinite(pid) && pid > 0 && !(await isProcessAlive(pid))) {
      throw new Error(`spawned pid ${pid} exited unexpectedly`);
    }

    const ready = await waitForReadyFn({
      socketPath,
      portPath,
      timeoutMs: readyTimeoutMs,
      intervalMs: readyPollIntervalMs,
    });
    if (!ready) {
      throw new Error(`guardian IPC endpoint did not become ready within ${readyTimeoutMs}ms`);
    }
    if (typeof emitNotice === 'function') {
      emitNotice({
        level: 'info',
        code: 'GUARDIAN_AUTOSTARTED',
        message: `guardian autostarted${pid ? ` (pid ${pid})` : ''}`,
      });
    }
    return { started: true, pid: Number.isFinite(pid) ? pid : null };
  } catch (error) {
    const message = `guardian autostart failed: ${error?.message || String(error)}`;
    if (typeof emitNotice === 'function') {
      emitNotice({
        level: 'warning',
        code: 'GUARDIAN_AUTOSTART_FAILED',
        message,
      });
    }
    throw new TunnelCliError(message, EXIT_CODE.GENERAL_ERROR);
  }
}

async function runStartAction({ options }) {
  // W-C: assertPlatformSupported removed.
  const status = await getGuardianStatus();
  if (status.running) {
    const result = { action: 'start', started: false, alreadyRunning: true, ...status };
    if (isJsonMode(options)) {
      printJson(result);
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`guardian already-running pid:${status.pid ?? 'unknown'}\n`);
      return;
    }
    clackIntro('OpenChamber Guardian');
    logStatus('info', `guardian already running${status.pid ? ` (pid ${status.pid})` : ''}`);
    clackOutro('no-op');
    return;
  }

  const logPath = path.join(path.dirname(getDefaultGuardianPidFile()), GUARDIAN_LOG_FILE);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  try {
    const { pid } = await startGuardianDetached({ logFd, spawnFn: spawn });
    if (Number.isFinite(pid) && pid > 0 && !(await isProcessAlive(pid))) {
      throw new TunnelCliError(
        'Guardian process exited unexpectedly. Check the log for details.',
        EXIT_CODE.GENERAL_ERROR
      );
    }
    const ready = await waitForGuardianReady();
    const result = {
      action: 'start',
      started: ready,
      pid: Number.isFinite(pid) ? pid : null,
      socketPath: getDefaultGuardianSocketPath(),
      logPath,
    };
    if (isJsonMode(options)) {
      printJson(result);
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`guardian started pid:${result.pid ?? 'unknown'} ready:${ready ? 'yes' : 'no'}\n`);
      return;
    }
    clackIntro('OpenChamber Guardian');
    if (ready) {
      logStatus('success', `guardian started${result.pid ? ` (pid ${result.pid})` : ''}`);
    } else {
      logStatus('warning', `guardian spawned${result.pid ? ` (pid ${result.pid})` : ''} but socket not ready yet`);
    }
    logStatus('info', `socket: ${result.socketPath}`);
    clackOutro(ready ? 'started' : 'started (pending)');
  } finally {
    try { fs.closeSync(logFd); } catch { /* ignore */ }
  }
}

async function runStopAction({ options }) {
  // W-C: assertPlatformSupported removed.
  const status = await getGuardianStatus();
  const marker = readGuardianPidMarker(getDefaultGuardianPidFile());
  if (!status.running && !marker) {
    const result = { action: 'stop', stopped: false, alreadyStopped: true, ...status };
    if (isJsonMode(options)) {
      printJson(result);
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write('guardian not-running\n');
      return;
    }
    clackIntro('OpenChamber Guardian');
    logStatus('info', 'guardian not running');
    clackOutro('no-op');
    return;
  }

  const stopped = await stopGuardianViaIpc({ timeoutMs: STOP_TIMEOUT_MS });
  const result = {
    status: stopped ? 'ok' : 'error',
    action: 'stop',
    stopped,
    pid: status.pid ?? (Number.isFinite(marker?.pid) ? marker.pid : null),
    socketPath: status.socketPath,
    ...(stopped ? {} : {
      reason: process.platform === 'win32'
        ? 'windows-guardian-ipc-required'
        : 'guardian-stop-unconfirmed',
    }),
  };
  if (isJsonMode(options)) {
    printJson(result);
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`guardian stopped:${stopped ? 'yes' : 'no'} pid:${status.pid ?? 'unknown'}\n`);
    return;
  }
  clackIntro('OpenChamber Guardian');
  if (stopped) {
    logStatus('success', `guardian stopped${status.pid ? ` (pid ${status.pid})` : ''}`);
  } else {
    logStatus(
      'warning',
      process.platform === 'win32'
        ? `guardian did not stop: ${WINDOWS_GUARDIAN_IPC_REQUIRED_MESSAGE}`
        : `guardian did not stop within ${STOP_TIMEOUT_MS}ms`,
    );
  }
  clackOutro(stopped ? 'stopped' : 'incomplete');
}

async function runStatusAction({ options }) {
  // W-C: assertPlatformSupported removed.
  const status = await getGuardianStatus();
  const result = { action: 'status', ...status };
  if (isJsonMode(options)) {
    printJson(result);
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(
      `guardian running:${status.running ? 'yes' : 'no'} pid:${status.pid ?? 'none'} socket:${status.socketPath}\n`
    );
    return;
  }
  clackIntro('OpenChamber Guardian');
  if (status.running) {
    logStatus('success', `running${status.pid ? ` (pid ${status.pid})` : ''}`);
  } else {
    logStatus('info', 'not running');
  }
  logStatus('info', `socket: ${status.socketPath}`);
  clackOutro('status complete');
}

async function reloadGuardianViaIpc({
  timeoutMs = STOP_TIMEOUT_MS,
  socketPath = getDefaultGuardianSocketPath(),
  portPath = getDefaultGuardianPortPath(),
} = {}) {
  const client = new GuardianClient({
    socketPath,
    portPath,
    connectTimeoutMs: Math.min(timeoutMs, 1500),
    requestTimeoutMs: timeoutMs,
  });
  try {
    await client.connect();
    return await client.reload();
  } finally {
    try { client.disconnect(); } catch { /* ignore */ }
  }
}

async function runReloadAction({
  options,
  killFn = process.kill,
  processIdentityFn = readProcessIdentity,
  processLivenessFn = probeProcessLiveness,
  reloadViaIpcFn = reloadGuardianViaIpc,
} = {}) {
  // W-C: assertPlatformSupported removed.
  const status = await getGuardianStatus();
  if (!status.running) {
    throw new TunnelCliError(
      'Guardian not running. Use `openchamber guardian start` before reloading.',
      EXIT_CODE.GENERAL_ERROR
    );
  }

  // POSIX uses SIGHUP; Windows uses SIGBREAK because Node does not deliver
  // SIGHUP there. Both signals restart the timer pair; config-file reload is
  // not yet wired.
  const reloadSignal = process.platform === 'win32' ? 'SIGBREAK' : 'SIGHUP';
  let ipcError = null;
  try {
    await reloadViaIpcFn({
      timeoutMs: STOP_TIMEOUT_MS,
      socketPath: status.socketPath,
      portPath: status.portPath,
    });
  } catch (error) {
    ipcError = error;
  }

  if (!ipcError) {
    const result = {
      action: 'reload',
      reloaded: true,
      signal: reloadSignal,
      controlPath: 'ipc',
      configReloaded: false,
      ...status,
    };
    if (isJsonMode(options)) {
      printJson(result);
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`guardian reload-signal:${reloadSignal} control:ipc pid:${status.pid ?? 'unknown'}\n`);
      return;
    }
    clackIntro('OpenChamber Guardian');
    logStatus('success', `guardian reload requested over authenticated IPC${status.pid ? ` (pid ${status.pid})` : ''}`);
    logStatus('info', `config reload is not yet wired; ${reloadSignal} only restarts timers with current values`);
    clackOutro('reloaded');
    return;
  }

  if (process.platform === 'win32') {
    throw new TunnelCliError(
      `Guardian reload failed: ${WINDOWS_GUARDIAN_IPC_REQUIRED_MESSAGE}`,
      EXIT_CODE.GENERAL_ERROR,
    );
  }

  const marker = readGuardianPidMarker(getDefaultGuardianPidFile());
  const verification = inspectGuardianPidMarker(marker, {
    readIdentity: processIdentityFn,
    liveness: processLivenessFn,
  });
  if (verification.state === 'stale' && verification.reason === 'recorded process is dead') {
    throw new TunnelCliError(
      `Guardian reload failed: process ${marker?.pid ?? status.pid ?? 'unknown'} is no longer alive.`,
      EXIT_CODE.GENERAL_ERROR,
    );
  }
  if (verification.state !== 'alive') {
    throw new TunnelCliError(
      `Guardian reload failed: persisted process identity is unresolved (${verification.reason || 'unknown'}); refusing to signal a PID fallback.`,
      EXIT_CODE.GENERAL_ERROR,
    );
  }

  try {
    killFn(marker.pid, reloadSignal);
  } catch (error) {
    const code = error?.code;
    if (code === 'ESRCH') {
      throw new TunnelCliError(
        `Guardian reload failed: process ${marker.pid} is no longer alive.`,
        EXIT_CODE.GENERAL_ERROR
      );
    }
    if (code === 'EPERM') {
      throw new TunnelCliError(
        `Guardian reload failed: insufficient permissions to signal pid ${marker.pid}.`,
        EXIT_CODE.GENERAL_ERROR
      );
    }
    throw new TunnelCliError(
      `Guardian reload failed: ${error?.message || String(error)}`,
      EXIT_CODE.GENERAL_ERROR
    );
  }

  const result = {
    action: 'reload',
    reloaded: true,
    signal: reloadSignal,
    controlPath: 'pid-fallback',
    configReloaded: false,
    ...status,
  };
  if (isJsonMode(options)) {
    printJson(result);
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`guardian reload-signal:${reloadSignal} pid:${status.pid ?? 'unknown'}\n`);
    return;
  }
  clackIntro('OpenChamber Guardian');
  logStatus('success', `guardian reload signal sent${status.pid ? ` (pid ${status.pid}, ${reloadSignal})` : ''}`);
  logStatus('info', `config reload is not yet wired; ${reloadSignal} only restarts timers with current values`);
  clackOutro('reloaded');
}

async function guardianCommand(options, action = 'status') {
  const normalized = typeof action === 'string' ? action.trim().toLowerCase() : 'status';
  if (normalized === 'help') {
    showGuardianHelp(options);
    return;
  }
  if (!['status', 'start', 'stop', 'reload'].includes(normalized)) {
    throw new TunnelCliError(
      `Unknown guardian subcommand '${action}'. Use 'openchamber guardian --help'.`,
      EXIT_CODE.USAGE_ERROR
    );
  }

  if (normalized === 'start') return runStartAction({ options });
  if (normalized === 'stop') return runStopAction({ options });
  if (normalized === 'reload') return runReloadAction({ options });
  return runStatusAction({ options });
}

function showGuardianHelp(options) {
  const payload = {
    action: 'help',
    subcommands: ['status', 'start', 'stop', 'reload'],
    options: ['--json', '-q, --quiet'],
    notes: [
      'Cross-platform: Linux/POSIX (Unix-domain socket mode 0600) and Windows (loopback TCP + per-user ACL on a discovery file under %LOCALAPPDATA%).',
      '`start` spawns the guardian process detached; `stop` issues a graceful shutdown RPC.',
      '`guardian stop` is administrative and stops all guardian-owned children; normal `openchamber stop` is owner-scoped.',
      '`reload` sends SIGHUP (SIGBREAK on Windows) to restart guardian timers. (Config reload is not yet wired.)',
      'Windows ACLs always use the current Windows user and require authenticated IPC; no CLI principal or PID fallback is accepted.',
    ],
  };
  if (isJsonMode(options)) {
    printJson(payload);
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write('guardian subcommands: status start stop reload\n');
    return;
  }
  clackIntro('OpenChamber Guardian');
  logStatus('info', 'subcommands: status | start | stop | reload');
  logStatus('info', 'default subcommand when omitted: status');
  logStatus('info', 'output: --json (machine-readable), -q/--quiet (minimal), default (human)');
  clackOutro('help complete');
}

export {
  startGuardianDetached,
  stopGuardianViaIpc,
  reloadGuardianViaIpc,
  maybeAutoStartGuardian,
  getGuardianStatus,
  shouldAutoStartGuardian,
  runReloadAction,
  _setProcessAliveOverrideForTest,
  guardianCommand,
  getDefaultGuardianSocketPath,
  getDefaultGuardianPortPath,
  getDefaultGuardianPidFile,
  _resetCachedGuardianPathsForTest,
  GUARDIAN_AUTOSTART_ENV,
  isSkipStartConfigured,
};
