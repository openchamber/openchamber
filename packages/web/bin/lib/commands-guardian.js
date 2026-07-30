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
import { resolveManagedOpenCodeHandoffV2Root } from '../../server/lib/opencode/managed-opencode-handoff-v2/filesystem.js';
import { GuardianClient } from '../../server/lib/guardian/guardian-client.js';
import { defaultIpcPaths } from '../../server/lib/guardian/ipc-transport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GUARDIAN_ENTRY = path.resolve(__dirname, '..', 'openchamber-guardian.js');

const DEFAULT_GUARDIAN_DATA_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.local',
  'state',
  'openchamber',
  'managed-opencode-handoff-v2',
);

/**
 * Resolve the v2 root that the entrypoint and the CLI both use for the
 * guardian's PID file and IPC socket. Honors OPENCHAMBER_DATA_DIR when it
 * is set to a valid absolute path; otherwise falls back to the per-user
 * default under ~/.local/state/openchamber/managed-opencode-handoff-v2.
 *
 * `resolveManagedOpenCodeHandoffV2Root` requires an absolute path. Relative
 * values of OPENCHAMBER_DATA_DIR are rejected so the CLI never silently
 * agrees with the entrypoint on a CWD-relative path that would diverge.
 */
function resolveGuardianDataDir() {
  const envValue = process.env.OPENCHAMBER_DATA_DIR;
  if (typeof envValue === 'string' && envValue.trim().length > 0) {
    if (path.isAbsolute(envValue)) {
      try {
        return resolveManagedOpenCodeHandoffV2Root(envValue);
      } catch {
        // Fall through to the default if the env value is invalid.
      }
    }
  }
  return DEFAULT_GUARDIAN_DATA_DIR;
}

let cachedGuardianPaths = null;
function getDefaultGuardianPaths() {
  if (cachedGuardianPaths === null) {
    const rootDir = resolveGuardianDataDir();
    // W-C: resolve both per-platform IPC paths through the factory
    // (`defaultIpcPaths`) so the consumer never branches on
    // `process.platform`. On Linux `portPath` is undefined; on Windows
    // `socketPath` is undefined.
    const ipc = defaultIpcPaths({
      platform: process.platform,
      rootDir,
      portDir: rootDir,
    });
    cachedGuardianPaths = {
      rootDir,
      socketPath: ipc.socketPath ?? getGuardianSocketPath(rootDir),
      portPath: ipc.portPath,
      pidFile: path.join(rootDir, 'guardian.pid'),
    };
  }
  return cachedGuardianPaths;
}

const GUARDIAN_AUTOSTART_ENV = 'OPENCHAMBER_GUARDIAN_AUTOSTART';
const GUARDIAN_LOG_FILE = 'guardian.log';
const PROBE_READY_TIMEOUT_MS = 5000;
const PROBE_POLL_INTERVAL_MS = 100;
const STOP_TIMEOUT_MS = 3000;

let guardianAutoStarted = false;

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
  try {
    const content = fs.readFileSync(getDefaultGuardianPidFile(), 'utf8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

let processAliveOverride = null;
async function isProcessAlive(pid) {
  if (typeof processAliveOverride === 'function') {
    return Boolean(processAliveOverride(pid));
  }
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function _setProcessAliveOverrideForTest(fn) {
  processAliveOverride = fn;
}

async function waitForGuardianReady({
  socketPath = getDefaultGuardianSocketPath(),
  portPath = getDefaultGuardianPortPath(),
  timeoutMs = PROBE_READY_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isGuardianRunning(socketPath, portPath)) return true;
    await new Promise((r) => setTimeout(r, PROBE_POLL_INTERVAL_MS));
  }
  return false;
}

async function waitForPidFileRemoved({ timeoutMs = STOP_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPidFile();
    if (!pid) return true;
    if (!(await isProcessAlive(pid))) return true;
    await new Promise((r) => setTimeout(r, PROBE_POLL_INTERVAL_MS));
  }
  return false;
}

async function startGuardianDetached({
  logFd,
  env,
  socketPath = getDefaultGuardianSocketPath(),
  portPath = getDefaultGuardianPortPath(),
  spawnFn = spawn,
} = {}) {
  // W-C: the Windows early-rejection is removed. The standalone
  // guardian process now starts on every platform; the IPC transport
  // factory inside it dispatches per-platform. `windowsHide: true`
  // remains defense-in-depth against a console flash on Windows.

  const args = [GUARDIAN_ENTRY];
  if (typeof socketPath === 'string' && socketPath && socketPath !== getDefaultGuardianSocketPath()) {
    args.push('--socket-path', socketPath);
  }
  if (typeof portPath === 'string' && portPath && portPath !== getDefaultGuardianPortPath()) {
    args.push('--port-path', portPath);
  }
  if (process.env.OPENCHAMBER_DATA_DIR) {
    args.push('--data-dir', process.env.OPENCHAMBER_DATA_DIR);
  }

  const child = spawnFn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, ...(env || {}) },
    windowsHide: true,
  });

  if (child && typeof child.unref === 'function') {
    child.unref();
  }

  const pid = child && Number.isFinite(child.pid) ? child.pid : 0;
  return { pid, socketPath, portPath, child };
}

async function stopGuardianViaIpc({
  timeoutMs = STOP_TIMEOUT_MS,
  socketPath = getDefaultGuardianSocketPath(),
  portPath = getDefaultGuardianPortPath(),
  killFn = process.kill,
  logWarning,
} = {}) {
  // W-C: the Windows early-return is removed. The IPC shutdown RPC is
  // platform-agnostic inside the guardian; the transport factory dials
  // the right backend.

  const emitWarning = (message) => {
    if (typeof logWarning === 'function') {
      logWarning(message);
    } else {
      // Best-effort fallback: never throw out of a cleanup helper.
      try { console.warn(`Warning: ${message}`); } catch { /* ignore */ }
    }
  };

  let ipcError = null;
  try {
    const client = new GuardianClient({
      socketPath,
      portPath,
      connectTimeoutMs: Math.min(timeoutMs, 1500),
      requestTimeoutMs: timeoutMs,
    });
    try {
      await client.connect();
      await client.shutdown();
    } finally {
      try { client.disconnect(); } catch { /* ignore */ }
    }
    if (await waitForPidFileRemoved({ timeoutMs })) {
      return true;
    }
    ipcError = new Error('IPC shutdown completed but PID file was not removed within timeout');
  } catch (error) {
    ipcError = error;
  }

  // IPC path failed (connect refused, hung, stale socket, ...). Escalate to direct
  // signaling. The PID file is the same one the entrypoint writes via O_EXCL.
  emitWarning(
    `Guardian IPC shutdown failed (${ipcError?.message || String(ipcError)}); escalating to SIGTERM.`
  );

  const pid = readPidFile();
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  if (!(await isProcessAlive(pid))) {
    return true;
  }

  try {
    killFn(pid, 'SIGTERM');
  } catch (error) {
    emitWarning(
      `Guardian SIGTERM failed (${error?.message || String(error)}); trying SIGKILL.`
    );
  }

  if (await waitForPidFileRemoved({ timeoutMs })) {
    return true;
  }

  if (await isProcessAlive(pid)) {
    try {
      killFn(pid, 'SIGKILL');
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

function shouldAutoStartGuardian({ options } = {}) {
  // W-C: Windows is supported; the only opt-outs remain the CLI flags
  // (`--no-guardian`, `--no-handoff`) and the env-var kill switch.
  if (!options || options.guardian === false) return false;
  if (options.handoff === false) return false;
  if (process.env[GUARDIAN_AUTOSTART_ENV] === 'disabled') return false;
  return true;
}

async function maybeAutoStartGuardian({ logFd, options, emitNotice, spawnFn } = {}) {
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
      // Our spawned child died before the PID file was observed; surface
      // the failure rather than reporting a fake success.
      if (typeof emitNotice === 'function') {
        emitNotice({
          level: 'warning',
          code: 'GUARDIAN_AUTOSTART_FAILED',
          message: `guardian autostart failed: spawned pid ${pid} exited unexpectedly`,
        });
      }
      return { started: false, reason: 'spawn-failed' };
    }
    guardianAutoStarted = true;
    if (typeof emitNotice === 'function') {
      emitNotice({
        level: 'info',
        code: 'GUARDIAN_AUTOSTARTED',
        message: `guardian autostarted${pid ? ` (pid ${pid})` : ''}`,
      });
    }
    return { started: true, pid: Number.isFinite(pid) ? pid : null };
  } catch (error) {
    if (typeof emitNotice === 'function') {
      emitNotice({
        level: 'warning',
        code: 'GUARDIAN_AUTOSTART_FAILED',
        message: `guardian autostart failed: ${error?.message || String(error)}`,
      });
    }
    return { started: false, reason: 'spawn-failed', error: error?.message || String(error) };
  }
}

function isGuardianAutoStarted() {
  return guardianAutoStarted;
}

function resetGuardianAutoStarted() {
  guardianAutoStarted = false;
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
  if (!status.running) {
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
    action: 'stop',
    stopped,
    pid: status.pid,
    socketPath: status.socketPath,
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
    logStatus('warning', `guardian did not stop within ${STOP_TIMEOUT_MS}ms`);
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

async function runReloadAction({ options, killFn = process.kill } = {}) {
  // W-C: assertPlatformSupported removed.
  const status = await getGuardianStatus();
  if (!status.running || !Number.isFinite(status.pid) || status.pid <= 0) {
    throw new TunnelCliError(
      'Guardian not running. Use `openchamber guardian start` before reloading.',
      EXIT_CODE.GENERAL_ERROR
    );
  }

  // SIGHUP is the entrypoint's reload signal (openchamber-guardian.js:132-137).
  // It stops + restarts the timer pair. Config-file reload is not yet wired.
  try {
    killFn(status.pid, 'SIGHUP');
  } catch (error) {
    const code = error?.code;
    if (code === 'ESRCH') {
      throw new TunnelCliError(
        `Guardian reload failed: process ${status.pid} is no longer alive.`,
        EXIT_CODE.GENERAL_ERROR
      );
    }
    if (code === 'EPERM') {
      throw new TunnelCliError(
        `Guardian reload failed: insufficient permissions to signal pid ${status.pid}.`,
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
    signal: 'SIGHUP',
    configReloaded: false,
    ...status,
  };
  if (isJsonMode(options)) {
    printJson(result);
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`guardian reload-signal:SIGHUP pid:${status.pid ?? 'unknown'}\n`);
    return;
  }
  clackIntro('OpenChamber Guardian');
  logStatus('success', `guardian reload signal sent${status.pid ? ` (pid ${status.pid}, SIGHUP)` : ''}`);
  logStatus('info', 'config reload is not yet wired; SIGHUP only restarts timers with current values');
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
      '`reload` sends SIGHUP to the guardian so it reloads its timers. (Currently a no-op for config; config reload is not yet wired.)',
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
  maybeAutoStartGuardian,
  getGuardianStatus,
  isGuardianAutoStarted,
  resetGuardianAutoStarted,
  shouldAutoStartGuardian,
  runReloadAction,
  _setProcessAliveOverrideForTest,
  guardianCommand,
  getDefaultGuardianSocketPath,
  getDefaultGuardianPortPath,
  getDefaultGuardianPidFile,
  _resetCachedGuardianPathsForTest,
  GUARDIAN_AUTOSTART_ENV,
};
