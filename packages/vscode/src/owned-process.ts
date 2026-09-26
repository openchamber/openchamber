import { execFile, spawn, type SpawnOptions } from 'node:child_process';

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null; error: Error | null };
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const WINDOWS_TERMINATION_TIMEOUT_MS = 1_000;
const POSIX_TERMINATION_GRACE_MS = 1_000;
const POSIX_GROUP_POLL_MS = 10;

type ProcessKill = (pid: number, signal?: NodeJS.Signals | number) => void;
type CleanupReconciliation = {
  promise: Promise<unknown>;
  retire: () => void;
};
type OwnedProcessDependencies = {
  platform?: NodeJS.Platform;
  processKill?: ProcessKill;
  terminationTimeoutMs?: number;
  terminationGraceMs?: number;
};

const hasTerminalExit = (child: { exitCode?: number | null; signalCode?: NodeJS.Signals | null }) => (
  (child.exitCode !== null && child.exitCode !== undefined)
  || (child.signalCode !== null && child.signalCode !== undefined)
);

const terminationFailure = (
  pid: number,
  cause: unknown,
  rootError: Error | null,
  rootClosed: boolean,
  message = `Failed to terminate the Windows process tree for PID ${pid}; descendant termination was not confirmed`,
  cleanupReconciliation?: CleanupReconciliation,
) => Object.assign(
  new Error(
    message,
  ),
  {
    code: 'ERR_PROCESS_TREE_TERMINATION',
    pid,
    descendantsTerminated: false,
    cleanupBlocked: true,
    rootClosed,
    cause: cause instanceof Error ? cause : String(cause),
    rootError: rootError || undefined,
    cleanupReconciliation,
  },
);

const observeProcessGroupGone = (pid: number, processKill: ProcessKill) => {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveGone: (gone: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((resolve) => { resolveGone = resolve; });
  const finish = (gone: boolean) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolveGone(gone);
  };
  const check = () => {
    try {
      processKill(-pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        finish(true);
        return;
      }
    }
    timer = setTimeout(check, POSIX_GROUP_POLL_MS);
  };
  check();
  return { promise, cancel: () => finish(false) };
};

// A successful taskkill is bound to the still-owned root. If its close arrives
// after the bounded wait, that original close promise can safely reconcile the
// retained runtime state. Do not issue a new PID-only taskkill after close:
// Windows may have reused the PID for an unrelated process by then.
const observeWindowsOwnedTreeClose = (closed: Promise<ProcessExit>): CleanupReconciliation => ({
  promise: closed.then(() => true),
  retire: () => undefined,
});

// Each background command gets its own POSIX group. Never signal the extension
// host's group, which can also contain unrelated extensions and editor work.
export function spawnOwnedProcess(
  binary: string,
  args: string[],
  options: Pick<SpawnOptions, 'cwd' | 'env'>,
  dependencies: OwnedProcessDependencies = {},
) {
  const platform = dependencies.platform || process.platform;
  const processKill: ProcessKill = dependencies.processKill || ((pid, signal) => process.kill(pid, signal));
  const terminationTimeoutMs = dependencies.terminationTimeoutMs ?? WINDOWS_TERMINATION_TIMEOUT_MS;
  const terminationGraceMs = dependencies.terminationGraceMs ?? POSIX_TERMINATION_GRACE_MS;
  const child = spawn(binary, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: platform !== 'win32',
  });
  let spawnError: Error | null = null;
  let childClosed = hasTerminalExit(child);
  const closed = new Promise<ProcessExit>((resolve) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => {
      childClosed = true;
      resolve({ code, signal, error: spawnError });
    });
  });
  const waitForClose = async (timeoutMs: number) => {
    if (childClosed) {
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { processKill(-child.pid, signal); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  };
  const killRoot = (): Error | null => {
    try {
      child.kill('SIGKILL');
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  let reportTerminationFailure: (error: Error) => void = () => undefined;
  const failedTermination = new Promise<Error>((resolve) => {
    reportTerminationFailure = resolve;
  });
  let termination: Promise<void> | null = null;
  const terminate = () => {
    if (termination) return termination;
    termination = (async () => {
      if (!child.pid) {
        // Test doubles and a child that failed before receiving a pid may still
        // expose a kill method; ask them to close so cancellation settles only
        // after the same close event as a real child.
        try { child.kill('SIGKILL'); } catch { /* already closed */ }
        await closed;
        return;
      }
      if (platform === 'win32') {
        // Node reports exitCode/signalCode before the close event. A closed
        // stdio stream is therefore not the only point at which the PID stops
        // identifying the owned root. Do not hand a terminal PID to taskkill:
        // Windows may have already reused it while close is still pending.
        if (childClosed || hasTerminalExit(child)) {
          throw terminationFailure(
            child.pid,
            new Error('Owned Windows process closed before tree termination could start'),
            null,
            true,
          );
        }
        let taskkillError: Error | null = null;
        // Start taskkill only while this root is still owned. A later retry by
        // PID could terminate an unrelated process after PID reuse.
        try {
          await new Promise<void>((resolve) => {
            execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true, timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
            }, (error) => {
              taskkillError = error || null;
              resolve();
            });
          });
        } catch (error) {
          taskkillError = error instanceof Error ? error : new Error(String(error));
        }
        if (taskkillError) {
          const rootError = hasTerminalExit(child) ? null : killRoot();
          const rootClosed = await waitForClose(WINDOWS_TERMINATION_TIMEOUT_MS);
          throw terminationFailure(
            child.pid,
            taskkillError,
            rootError,
            rootClosed || hasTerminalExit(child),
            undefined,
          );
        }
      } else {
        const groupObservation = observeProcessGroupGone(child.pid, processKill);
        try {
          signalGroup('SIGTERM');
          await waitForClose(terminationGraceMs);
          // A parent can exit while a tool ignores SIGTERM or holds its pipes.
          signalGroup('SIGKILL');
          const rootClosed = await waitForClose(terminationTimeoutMs);
          const groupGone = rootClosed
            ? await Promise.race([
                groupObservation.promise,
                new Promise<boolean>((resolve) => {
                  const timer = setTimeout(() => resolve(false), terminationTimeoutMs);
                  timer.unref?.();
                }),
              ])
            : false;
          if (rootClosed && groupGone) return;
          throw terminationFailure(
            child.pid,
            new Error(`POSIX process group for PID ${child.pid} did not close after SIGKILL`),
            null,
            rootClosed,
            `Failed to terminate the POSIX process tree for PID ${child.pid}; descendant termination was not confirmed`,
            {
              promise: Promise.all([closed, groupObservation.promise]),
              retire: () => groupObservation.cancel(),
            },
          );
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ERR_PROCESS_TREE_TERMINATION') throw error;
          const rootError = killRoot();
          const rootClosed = await waitForClose(terminationTimeoutMs);
          throw terminationFailure(
            child.pid,
            error,
            rootError,
            rootClosed,
            `Failed to terminate the POSIX process tree for PID ${child.pid}; descendant termination was not confirmed`,
            {
              promise: Promise.all([closed, groupObservation.promise]),
              retire: () => groupObservation.cancel(),
            },
          );
        }
      }
      if (!await waitForClose(terminationTimeoutMs)) {
        const cleanupReconciliation = platform === 'win32'
          ? observeWindowsOwnedTreeClose(closed)
          : undefined;
        throw terminationFailure(
          child.pid,
          new Error('Owned process did not close after termination'),
          null,
          false,
          `Failed to terminate owned process PID ${child.pid}; process close was not confirmed`,
          cleanupReconciliation,
        );
      }
    })();
    void termination.catch((error) => {
      reportTerminationFailure(error instanceof Error ? error : new Error(String(error)));
    });
    return termination;
  };
  return {
    child,
    closed,
    terminate,
    failedTermination,
    get termination() { return termination; },
  };
}
