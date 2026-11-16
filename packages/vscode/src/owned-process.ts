import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null; error: Error | null };

const isRunning = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

const closesWithin = async (closed: Promise<unknown>, timeoutMs: number) => {
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

// external: #5129 Windows taskkill ends OpenCode before it records cancelled turns; closing the stdio lease allows graceful shutdown.
export async function stopWindowsProcessTree(
  child: ChildProcess,
  closed: Promise<unknown>,
  { stdinLeaseGraceMs, killTree }: { stdinLeaseGraceMs?: number; killTree: (pid: number) => Promise<void> },
) {
  if (stdinLeaseGraceMs !== undefined && isRunning(child) && child.stdin && !child.stdin.destroyed) {
    child.stdin.end();
    await closesWithin(closed, stdinLeaseGraceMs);
  }
  if (isRunning(child) && child.pid) await killTree(child.pid);
}

const taskkillTree = (child: ChildProcess) => (pid: number) => new Promise<void>((resolve, reject) => {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true, timeout: 5000,
  }, (error) => {
    if (error && isRunning(child)) reject(error);
    else resolve();
  });
});

type OwnedProcessOptions = Pick<SpawnOptions, 'cwd' | 'env'> & {
  input?: string;
  stdinLeaseGraceMs?: number;
};

export function spawnOwnedProcess(binary: string, args: string[], options: OwnedProcessOptions) {
  const { stdinLeaseGraceMs, input, ...spawnOptions } = options;
  const shared = { ...spawnOptions, windowsHide: true, detached: process.platform !== 'win32' };
  const child = stdinLeaseGraceMs === undefined && input === undefined
    ? spawn(binary, args, { ...shared, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(binary, args, { ...shared, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin?.on('error', () => {});
  if (input !== undefined) child.stdin?.end(input);
  let spawnError: Error | null = null;
  const closed = new Promise<ProcessExit>((resolve) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal, error: spawnError }));
  });
  const waitForClose = (timeoutMs: number) => closesWithin(closed, timeoutMs);
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
        await stopWindowsProcessTree(child, closed, { stdinLeaseGraceMs, killTree: taskkillTree(child) });
      } else {
        signalGroup('SIGTERM');
        await waitForClose(1000);
        signalGroup('SIGKILL');
      }
      if (!await waitForClose(1000)) throw new Error('Owned process did not close after termination');
    })();
    return termination;
  };
  return { child, closed, terminate };
}
