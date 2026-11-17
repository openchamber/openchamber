// Self-handoff: a running OpenChamber starts a successor on the same listening socket, and stops
// accepting only after the successor reports that it is serving in its own process.
//
// Protocol (POSIX only; the listener is passed as fd 3 with LISTEN_FDS/LISTEN_PID, as systemd does):
//   1. The predecessor (this process) receives SIGURG, or `openchamber handoff` sends it.
//   2. It spawns the successor with its listening socket as fd 3 and an IPC channel. The successor
//      is started through `sh -c 'export LISTEN_PID=$$ ...; exec'`, so LISTEN_PID is its own pid.
//   3. The successor adopts the managed OpenCode child through state.json (same pid, same port).
//   4. The successor reports ready once `isServing()` holds in its process, then sends READY=1 and
//      MAINPID to $NOTIFY_SOCKET when systemd set one, then sends `openchamber:handoff-ready`.
//   5. The predecessor closes its listener and drains. It leaves OpenCode running and exits.
//   If the successor does not report ready in time, or exits first, the predecessor kills it and
//   keeps serving.
import { spawnSync } from 'node:child_process';

// The listener slot the successor sees, matching systemd socket activation (LISTEN_FDS=1 names fd 3).
export const INHERITED_LISTEN_FD = 3;
export const SELF_HANDOFF_SIGNAL = 'SIGURG';
export const HANDOFF_READY_MESSAGE = 'openchamber:handoff-ready';
export const HANDOFF_FROM_ENV = 'OPENCHAMBER_HANDOFF_FROM';

const DEFAULT_HANDOFF_TIMEOUT_MS = 30_000;
const TERMINATE_GRACE_MS = 3_000;
const SYSTEMD_SETTLE_MS = 500;
const SUCCESSOR_EXEC_SCRIPT = 'export LISTEN_PID=$$ LISTEN_FDS=1; exec "$@"';

// Disabled with OPENCHAMBER_SELF_HANDOFF=0: the signal is not handled and the restart falls back to
// stop-then-start, which drops connections for the gap.
export const isSelfHandoffEnabled = (env = process.env) => env.OPENCHAMBER_SELF_HANDOFF !== '0';

export const resolveHandoffTimeoutMs = (env = process.env) => {
  // Only a plain decimal spelling counts: a bare Number(...) would silently
  // honour '1e3' (a 1 s grace period), '0x10' (16 ms), '+5000', and '5000.0'.
  const raw = String(env.OPENCHAMBER_HANDOFF_TIMEOUT_MS ?? '').trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_HANDOFF_TIMEOUT_MS;
  const value = Number(raw);
  // A delay above Node's timer maximum (2^31 - 1 ms) fires after ~1 ms
  // instead, so a larger configured timeout falls back to the default
  // rather than killing every handoff successor immediately.
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : DEFAULT_HANDOFF_TIMEOUT_MS;
};

// The successor runs the same CLI entry in foreground mode, so it writes its own pid and instance
// files and takes the inherited listener on the same port.
export const buildSuccessorCommand = ({ execPath, execArgv, entry, port, host, apiOnly }) => ({
  command: '/bin/sh',
  args: [
    '-c',
    SUCCESSOR_EXEC_SCRIPT,
    'openchamber-successor',
    execPath,
    ...execArgv,
    entry,
    'serve',
    '--foreground',
    '--port',
    String(port),
    '--host',
    host,
    ...(apiOnly ? ['--api-only'] : []),
  ],
});

const signalProcessGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
};

const waitForChildExit = (child, timeoutMs) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve(true);
    return;
  }
  const timer = setTimeout(() => {
    child.off('exit', onExit);
    resolve(false);
  }, timeoutMs);
  const onExit = () => {
    clearTimeout(timer);
    resolve(true);
  };
  child.once('exit', onExit);
});

// The predecessor's side. `getServer` returns the running http.Server; `gracefulShutdown` is the
// shutdown runtime's entry point, which stops accepting first when `handoff` is set.
export const createSelfHandoffRuntime = ({
  process: runtimeProcess = process,
  getServer,
  spawn,
  gracefulShutdown,
  isShuttingDown,
  entry,
  apiOnly = false,
  env = process.env,
  timeoutMs = resolveHandoffTimeoutMs(env),
  log = console,
}) => {
  let inFlight = null;

  const spawnSuccessor = (server, address) => {
    const { command, args } = buildSuccessorCommand({
      execPath: runtimeProcess.execPath,
      execArgv: runtimeProcess.execArgv,
      entry,
      port: address.port,
      host: address.address,
      apiOnly,
    });
    // The listener lands at INHERITED_LISTEN_FD, the slot LISTEN_FDS=1 names; the IPC channel follows it.
    const stdio = ['ignore', 'inherit', 'inherit'];
    stdio[INHERITED_LISTEN_FD] = server._handle.fd;
    stdio.push('ipc');
    return spawn(command, args, {
      detached: true,
      stdio,
      env: { ...env, [HANDOFF_FROM_ENV]: String(runtimeProcess.pid) },
    });
  };

  const awaitSuccessorReady = (child) => new Promise((resolve) => {
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    const onMessage = (message) => {
      if (message?.type === HANDOFF_READY_MESSAGE) finish({ ok: true, successorPid: child.pid });
    };
    const onExit = (code, signal) => finish({ ok: false, reason: 'exited', code, signal });
    const onError = (error) => finish({ ok: false, reason: 'error', message: error?.message });
    function finish(result) {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      resolve(result);
    }
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
  });

  const terminateSuccessor = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    signalProcessGroup(child.pid, 'SIGTERM');
    if (await waitForChildExit(child, TERMINATE_GRACE_MS)) return;
    signalProcessGroup(child.pid, 'SIGKILL');
    await waitForChildExit(child, TERMINATE_GRACE_MS);
  };

  const runHandoff = async ({ exitProcess }) => {
    if (isShuttingDown()) return { ok: false, reason: 'shutting-down' };
    const server = getServer();
    const address = server?.listening ? server.address() : null;
    if (!address) return { ok: false, reason: 'not-listening' };
    // Only Node exposes the listening socket's descriptor. Bun's server, which the daemon runs under when
    // Bun is installed, does not, so such a process keeps serving and says so.
    const listenerFd = server._handle?.fd;
    if (typeof listenerFd !== 'number' || listenerFd < 0) {
      log.warn(`[handoff] the listening socket is not reachable from ${runtimeProcess.versions?.bun ? 'Bun' : 'this runtime'}; use a Node foreground server (systemd unit). Still serving`);
      return { ok: false, reason: 'no-listener-fd' };
    }

    let child;
    try {
      child = spawnSuccessor(server, address);
    } catch (error) {
      log.warn(`[handoff] could not start the successor: ${error?.message ?? error}; still serving`);
      return { ok: false, reason: 'spawn-failed' };
    }
    log.log(`[handoff] starting successor ${child.pid} on port ${address.port}`);

    const outcome = await awaitSuccessorReady(child);
    if (!outcome.ok) {
      log.warn(`[handoff] successor did not become ready (${outcome.reason}); still serving`);
      await terminateSuccessor(child);
      return outcome;
    }

    // The successor is serving on the socket now. Release the IPC channel so this process can exit
    // without touching the successor, and detach it from this process's lifetime.
    if (child.connected) child.disconnect();
    child.unref();
    // systemd reads the successor's MAINPID datagram and this process's exit in one event loop, and does
    // not order them. Under systemd, give it time to read the datagram before the old main process exits.
    if (env.NOTIFY_SOCKET) await new Promise((resolve) => setTimeout(resolve, SYSTEMD_SETTLE_MS));
    log.log(`[handoff] successor ${outcome.successorPid} is serving; stopping this process`);
    await gracefulShutdown({ exitProcess, keepOpenCode: true, handoff: true });
    return { ok: true, successorPid: outcome.successorPid };
  };

  // Concurrent requests share one handoff, so a second signal cannot start a second successor.
  const requestHandoff = ({ exitProcess = true } = {}) => {
    if (!isSelfHandoffEnabled(env)) return Promise.resolve({ ok: false, reason: 'disabled' });
    if (!inFlight) {
      inFlight = runHandoff({ exitProcess })
        .catch((error) => ({ ok: false, reason: 'failed', message: error?.message ?? String(error) }))
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  };

  return { requestHandoff };
};

// The successor's side. Reads the predecessor's pid once and removes it from the environment, so
// OpenCode and other children do not inherit it.
export const takeHandoffPredecessor = (env = process.env) => {
  const raw = env[HANDOFF_FROM_ENV];
  delete env[HANDOFF_FROM_ENV];
  if (raw === undefined) return null;
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

// Polls in-process state. The predecessor enforces the timeout and kills this process if it never holds.
export const waitUntilServing = (isServing, { intervalMs = 100 } = {}) => new Promise((resolve) => {
  const check = () => {
    if (isServing()) {
      resolve(true);
      return;
    }
    setTimeout(check, intervalMs);
  };
  check();
});

// systemd socket units and `Type=notify` services name the main pid through $NOTIFY_SOCKET. Node has
// no unix datagram sockets, so this goes through systemd-notify. No-op outside systemd.
export const notifySystemdReady = ({ pid, env = process.env, run = spawnSync }) => {
  if (!env.NOTIFY_SOCKET) return false;
  const result = run('systemd-notify', ['--ready', `--pid=${pid}`], { env, stdio: 'ignore', timeout: 5000 });
  return result.status === 0;
};
