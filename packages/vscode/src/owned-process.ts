import { execFile, spawn, type SpawnOptions } from 'node:child_process';

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null; error: Error | null };

// Each background command gets its own POSIX group. Never signal the extension
// host's group, which can also contain unrelated extensions and editor work.
export function spawnOwnedProcess(binary: string, args: string[], options: Pick<SpawnOptions, 'cwd' | 'env'>) {
  const child = spawn(binary, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let spawnError: Error | null = null;
  const closed = new Promise<ProcessExit>((resolve) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal, error: spawnError }));
  });
  const waitForClose = async (timeoutMs: number) => {
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
    try { process.kill(-child.pid, signal); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  };
  let termination: Promise<void> | null = null;
  const terminate = () => {
    if (termination) return termination;
    termination = (async () => {
      if (!child.pid) { await closed; return; }
      if (process.platform === 'win32') {
        if (child.exitCode === null && child.signalCode === null) {
          // Keep the parent alive until Windows has enumerated its descendants.
          await new Promise<void>((resolve, reject) => {
            execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true, timeout: 5000,
            }, (error) => {
              if (error && child.exitCode === null && child.signalCode === null) reject(error);
              else resolve();
            });
          });
        }
      } else {
        signalGroup('SIGTERM');
        await waitForClose(1000);
        // A parent can exit while a tool ignores SIGTERM or holds its pipes.
        signalGroup('SIGKILL');
      }
      if (!await waitForClose(1000)) throw new Error('Owned process did not close after termination');
    })();
    return termination;
  };
  return { child, closed, terminate };
}
