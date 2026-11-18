
const OPENCODE_STDIN_SHUTDOWN_GRACE_MS = 5000;
const FORCE_KILL_CLOSE_WAIT_MS = 3000;

export const hasChildProcessExited = (child: Pick<ChildProcess, 'exitCode' | 'signalCode'> | null | undefined) => !child
  || (child.exitCode !== null && child.exitCode !== undefined)
  || (child.signalCode !== null && child.signalCode !== undefined);

export const waitForChildProcessClose = (child: ChildProcess | null | undefined, timeoutMs: number) => new Promise<boolean>((resolve) => {
  if (!child || hasChildProcessExited(child)) {
    resolve(true);
    return;
  }

  let done = false;
  const finish = (closed: boolean) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    child.off('close', onClose);
    child.off('error', onError);
    resolve(closed);
  };

  const onClose = () => finish(true);
  const onError = () => finish(hasChildProcessExited(child));
  const timer = setTimeout(() => finish(hasChildProcessExited(child)), timeoutMs);

  child.once('close', onClose);
  child.once('error', onError);
});

export const stopOpenCodeByClosingStdin = async (child: ChildProcess, {
  forceKillTree,
  graceMs = OPENCODE_STDIN_SHUTDOWN_GRACE_MS,
}: OpenCodeStdinStopOptions) => {
  if (hasChildProcessExited(child)) return 'exited';

  const stdin = child.stdin;
  if (stdin && !stdin.destroyed) {
    try {
      stdin.end();
    } catch {
      void 0;
    }
    if (await waitForChildProcessClose(child, graceMs)) return 'exited';
  }

  forceKillTree(child.pid);
  await waitForChildProcessClose(child, FORCE_KILL_CLOSE_WAIT_MS);
  return 'killed';
};
import type { ChildProcess } from 'node:child_process';

export interface OpenCodeStdinStopOptions {
  forceKillTree: (pid: number | undefined) => void;
  graceMs?: number;
}
