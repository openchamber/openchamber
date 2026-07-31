import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { probeProcessLiveness } from './process-identity.js';

/**
 * Windows process-termination helpers (W-D).
 *
 * The Unix `ManagedOpenCodeGuardian.#terminateChild` uses
 * `process.kill(-pid, 'SIGTERM')` and `child.kill('SIGTERM')` then
 * escalates to `SIGKILL` after `STOP_SIGNAL_TIMEOUT_MS`. None of that
 * works on Windows: there is no `setpgid(0,0)` (no process groups via
 * `process.kill(-pid, ...)`), and `child.kill('SIGTERM')` translates to
 * a `TerminateProcess` on Node.js which is the moral equivalent of
 * `SIGKILL` (no graceful shutdown). The Windows-correct primitive is
 * `taskkill.exe`. We use it with `/F /PID <pid>` (force, no `/T`):
 *
 *   - `/F` is required because there is no graceful SIGTERM equivalent
 *     for arbitrary Node.js children on Windows; `CTRL+C` only works
 *     when the child has a console and a signal handler, neither of
 *     which we can rely on for a detached `opencode serve` child.
 *   - `/T` (tree kill) is intentionally NOT used: it would walk the
 *     child process tree and kill the OpenCode child's own children
 *     (e.g. a wrapped shim or a future bundled process). The T2 design
 *     invariant says we only kill the spawned OpenCode PID (see the
 *     plan's risk register: "taskkill /pid /f kills our own process
 *     group via accidental /t" — High).
 *   - Exit code 128 ("process not found") is treated as success
 *     because it means the process is already gone.
 *   - `ESRCH` errors are treated as success because the process was never
 *     present. `EPERM` remains an error: permission loss is ambiguous and
 *     must not be mistaken for a terminated child.
 *
 * The helper is **synchronous inside an async wrapper** for parity
 * with the Unix path, which calls `process.kill` synchronously
 * before awaiting a close-wait. Live ChildProcess objects use their
 * `close` event; rehydrated children use an operating-system liveness poll.
 *
 * No raw secret / password / token is ever logged or persisted here.
 */

const TASKKILL_TIMEOUT_MS = 5000;
// `taskkill` exit code 128 == "process not found" (the OS error
// `ERROR_INVALID_PARAMETER` mapped by `taskkill.exe` to its own
// status). Treat as already-gone.
const TASKKILL_EXIT_NOT_FOUND = 128;
const PROCESS_POLL_INTERVAL_MS = 25;

const assertIntegerPid = (pid, label) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError(`windows-process: ${label} must be a positive integer (got ${pid})`);
  }
};

const hasChildExited = (child) =>
  !child || child.exitCode !== null || child.signalCode !== null;

const isRehydratedChild = (child) => child?.isRehydrated === true;

const defaultIsProcessAlive = probeProcessLiveness;

const normalizeLiveness = (value) => {
  if (value === false || value === 'dead') return 'dead';
  if (value === true || value === 'alive') return 'alive';
  return 'unknown';
};

const readLiveness = (pid, isProcessAlive) => {
  try {
    return normalizeLiveness(isProcessAlive(pid));
  } catch {
    // A failed liveness probe is not proof that a process is gone.  Keep the
    // termination attempt fail-closed and let taskkill make the next decision.
    return 'unknown';
  }
};

const waitForClose = (child, timeoutMs) => new Promise((resolve) => {
  if (hasChildExited(child)) {
    resolve(true);
    return;
  }
  const timer = setTimeout(() => resolve(hasChildExited(child)), timeoutMs);
  child.once('close', () => {
    clearTimeout(timer);
    resolve(true);
  });
});

const waitForProcessExit = (pid, timeoutMs, isProcessAlive) => new Promise((resolve) => {
  const deadline = Date.now() + timeoutMs;
  const check = () => {
    if (readLiveness(pid, isProcessAlive) === 'dead') {
      resolve(true);
      return;
    }
    if (Date.now() >= deadline) {
      resolve(false);
      return;
    }
    setTimeout(check, Math.min(PROCESS_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  };
  check();
});

/**
 * Run `taskkill.exe /F /PID <pid>` synchronously and translate the
 * outcome into a `{ status, reason }` envelope. Exposed for unit
 * tests; the public API is `terminateChildWindows`.
 *
 * The result envelope is:
 *   - `{ status: 'killed' }` — `taskkill` accepted the request against
 *     a live process (exit 0). The caller should wait for the child
 *     `close` event, or poll a rehydrated child's OS liveness, to confirm
 *     the kill landed.
 *   - `{ status: 'already-gone' }` — `taskkill` confirmed the process
 *     is no longer reachable (exit 128 = "process not found", or
 *     `ESRCH` spawn error). The caller can return success without waiting
 *     for a close event that will never fire.
 *   - `{ status: 'error', reason }` — unexpected failure
 *     (`ENOENT` for missing binary, non-zero non-128 exit, killed
 *     by signal, etc.).
 *
 * Note: `spawnSync` does not throw on `EPERM`/`ESRCH`; it returns
 * `{ error: <Error>, status: null, ... }`. We detect by `result.error`
 * (and `result.error.code`) rather than try/catch.
 *
 * @param {object} options
 * @param {number} options.pid
 * @param {typeof defaultSpawnSync} [options.spawnSync]
 * @returns {{ status: 'killed' } | { status: 'already-gone' } | { status: 'error', reason: string }}
 */
export function runTaskkillForce({ pid, spawnSync = defaultSpawnSync } = {}) {
  assertIntegerPid(pid, 'pid');
  // The PID is a positive integer validated by `assertIntegerPid`
  // above; we coerce via `String()` for the argument list so the
  // values flow through Node's `args` array (not a shell string) and
  // therefore need no shell-style quoting. `assertIntegerPid` is the
  // defense-in-depth boundary.
  const args = ['/F', '/PID', String(pid)];
  const result = spawnSync('taskkill.exe', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TASKKILL_TIMEOUT_MS,
  });
  if (result.error) {
    if (result.error.code === 'ESRCH') {
      return { status: 'already-gone' };
    }
    if (result.error.code === 'ENOENT') {
      return { status: 'error', reason: 'taskkill.exe not found on PATH' };
    }
    return { status: 'error', reason: `taskkill.exe spawn failed: ${result.error.message}` };
  }
  if (result.signal) {
    // The taskkill.exe process itself was killed by a signal (e.g.
    // a parent timeout fired). Treat as a real failure.
    return { status: 'error', reason: `taskkill.exe terminated by signal ${result.signal}` };
  }
  if (result.status === TASKKILL_EXIT_NOT_FOUND) {
    return { status: 'already-gone' };
  }
  if (result.status === 0) {
    return { status: 'killed' };
  }
  const stderr = String(result.stderr ?? '').trim();
  return { status: 'error', reason: `taskkill.exe exited with code ${result.status}${stderr ? `: ${stderr}` : ''}` };
}

/**
 * Terminate an OpenCode child on Windows via `taskkill /F /PID <pid>`.
 *
 * Behavior:
 *   1. If the child has already exited (`exitCode !== null` or
 *      `signalCode !== null`), return `{ ok: true }` immediately.
 *   2. Otherwise, invoke `taskkill /F /PID <pid>` (no `/T`).
 *   3. Wait up to `timeoutMs` for the child's `close` event, or poll the
 *      operating-system liveness of a rehydrated child (which has no live
 *      ChildProcess handle and therefore cannot emit `close`).
 *   4. Return `{ ok: true }` on observed close; `{ ok: false, reason: 'still-running' }` otherwise.
 *
 * `ESRCH` from `taskkill` and exit code 128 ("process not found") are
 * treated as success because they indicate the process is no longer
 * reachable. `EPERM` remains a failure because it does not prove that the
 * child is gone. A live ChildProcess may emit `close`, while a rehydrated
 * child is checked with the OS liveness probe instead.
 *
 * @param {object} child - A Node.js ChildProcess handle or a guardian
 *   rehydrated child. Must have a numeric `pid`; live handles expose
 *   `exitCode`, `signalCode`, and a `close` event, while rehydrated handles
 *   set `isRehydrated: true`.
 * @param {object} [options]
 * @param {number} [options.timeoutMs=2500] - Outer close-wait or liveness-poll
 *   window. Matches the Unix `STOP_SIGNAL_TIMEOUT_MS` so both
 *   platforms spend the same wall-clock time waiting for the child
 *   to die before reporting failure.
 * @param {typeof defaultSpawnSync} [options.spawnSync] - Override for tests.
 * @param {(pid: number) => ('alive'|'dead'|'unknown'|boolean)} [options.isProcessAlive]
 *   Operating system liveness probe used for rehydrated children; defaults to
 *   the shared tri-state `process.kill(pid, 0)` probe. Unknown is never dead.
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'still-running' }>}
 */
export async function terminateChildWindows(
  child,
  { timeoutMs = 2500, spawnSync = defaultSpawnSync, isProcessAlive = defaultIsProcessAlive } = {},
) {
  const rehydrated = isRehydratedChild(child);
  if (!rehydrated && hasChildExited(child)) {
    return { ok: true };
  }
  const pid = child?.pid;
  if (!pid) {
    // No PID means we cannot construct the taskkill command. The
    // Unix path returns silently in the same situation; mirror that.
    return { ok: true };
  }

  if (rehydrated) {
    if (readLiveness(pid, isProcessAlive) === 'dead') return { ok: true };
  }

  const result = runTaskkillForce({ pid, spawnSync });
  if (result.status === 'error') {
    // Surface as still-running; the caller (`#terminateChild`) treats
    // the result as a hint and will not retry. We deliberately do not
    // throw here because the Unix path also swallows kill errors.
    // The error reason is preserved for diagnostics; consumers can
    // log it via a future hook if needed.
    return { ok: false, reason: result.reason };
  }
  if (result.status === 'already-gone') {
    // `taskkill` confirmed the process is no longer reachable
    // (exit 128 = "process not found", or ESRCH). No close
    // event will ever fire from the missing process; treat the
    // operation as immediately successful.
    return { ok: true };
  }
  // result.status === 'killed': wait for the JS-side `close` event to
  // confirm a live ChildProcess kill, or poll the OS for a rehydrated
  // synthetic child that has no process handle to emit that event.
  if (!rehydrated && hasChildExited(child)) {
    return { ok: true };
  }
  if (rehydrated) {
    if (await waitForProcessExit(pid, timeoutMs, isProcessAlive)) {
      return { ok: true };
    }
    return { ok: false, reason: 'still-running' };
  }
  if (await waitForClose(child, timeoutMs)) {
    return { ok: true };
  }
  return { ok: false, reason: 'still-running' };
}

// Exported for unit tests; not part of the public surface.
export const __test__ = { TASKKILL_TIMEOUT_MS, TASKKILL_EXIT_NOT_FOUND, hasChildExited };
