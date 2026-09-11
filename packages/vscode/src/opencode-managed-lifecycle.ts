/**
 * Manages the lifetime of the `opencode serve` child spawned by the VS Code
 * extension host.
 *
 * Ownership is established at spawn: the allocated port is already known, so
 * the child is registered in the shared managed-process registry before we wait
 * for its listening line. Every startup failure path (timeout, unparsable line,
 * early exit, spawn error, registration rejection) owns the child to a
 * confirmed exit: a live child is terminated (process-tree kill + SIGTERM), an
 * already-exited child is left alone, the registry entry is dropped once exit
 * is confirmed, and only then does the error propagate — so no path can leave a
 * live, unregistered child for retries to multiply.
 *
 * Kept free of `vscode` imports so it is unit-tested directly; process spawn,
 * registry, and process-tree kill are injectable. The registry module and the
 * process-tree kill semantics are shared with packages/web, so the on-disk
 * registry stays the single source of truth.
 */

import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import {
  registerManagedProcess as defaultRegisterManagedProcess,
  unregisterManagedProcess as defaultUnregisterManagedProcess,
} from './opencodeProcessRegistry';

const CHILD_EXIT_WAIT_TIMEOUT_MS = 2500;

const MAC_APP_BUNDLE_HINT = ' The configured binary appears to point at the macOS desktop app bundle; OpenChamber needs the standalone opencode CLI.';

/** Minimal readable-stream surface the startup waiter consumes. */
export interface ManagedProcessOutput {
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  off(event: 'data', listener: (chunk: Buffer) => void): void;
}

/**
 * Minimal child-process surface this module owns. `spawn()` returns the full
 * `ChildProcess`; tests provide a compatible fake with no real pids.
 */
export interface ManagedChildProcess {
  pid?: number;
  stdout: ManagedProcessOutput | null;
  stderr: ManagedProcessOutput | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
}

export interface ManagedProcessRegistration {
  pid: number | undefined;
  ownerPid: number;
  port: number;
  binary: string;
  runtime: string;
}

export type SpawnManagedProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ManagedChildProcess;
export type RegisterManagedProcess = (entry: ManagedProcessRegistration) => Promise<void>;
export type UnregisterManagedProcess = (pid: number | undefined) => Promise<void>;
export type KillProcessTree = (pid: number | undefined) => void;

export interface ManagedOpenCodeLifecycleDependencies {
  spawnProcess?: SpawnManagedProcess;
  registerManagedProcess?: RegisterManagedProcess;
  unregisterManagedProcess?: UnregisterManagedProcess;
  killProcessTree?: KillProcessTree;
}

export interface CreateManagedOpenCodeServerOptions {
  /** Binary recorded in diagnostics and error messages (before launch-spec resolution). */
  binary: string;
  /** Executable actually spawned (Windows batch shims resolve to cmd.exe). */
  launchBinary: string;
  launchArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  port: number;
  timeoutMs: number;
  /** True when `binary` points at the macOS desktop app bundle instead of the CLI. */
  binaryIsMacAppBundle: boolean;
}

export interface ManagedOpenCodeServerHandle {
  url: string;
  close: () => Promise<void>;
}

const hasChildProcessExited = (child: ManagedChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

const waitForChildProcessClose = (child: ManagedChildProcess, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (hasChildProcessExited(child)) {
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

const defaultKillProcessTree: KillProcessTree = (pid) => {
  if (!Number.isInteger(pid)) return;
  // Windows has no signal-based tree kill; taskkill covers grandchildren that a
  // cmd.exe shim would otherwise leave behind. POSIX gets the child.kill signal.
  if (process.platform !== 'win32') return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore', timeout: 5000, windowsHide: true,
    });
  } catch {
    // ignore
  }
};

const terminateManagedChildProcess = async (
  child: ManagedChildProcess,
  killProcessTree: KillProcessTree,
): Promise<void> => {
  // Never signal an already-exited child: the OS may have recycled its pid.
  if (!hasChildProcessExited(child)) {
    killProcessTree(child.pid);
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  await waitForChildProcessClose(child, CHILD_EXIT_WAIT_TIMEOUT_MS);
};

const closeManagedChildProcess = async (
  child: ManagedChildProcess,
  killProcessTree: KillProcessTree,
  unregisterManagedProcess: UnregisterManagedProcess,
): Promise<void> => {
  await terminateManagedChildProcess(child, killProcessTree);
  // Drop the registry entry only after confirmed exit. A child that survived
  // teardown stays registered so the next startup's reaper can still find it.
  if (hasChildProcessExited(child)) {
    await unregisterManagedProcess(child.pid).catch(() => {});
  }
};

export async function createManagedOpenCodeServerProcess(
  options: CreateManagedOpenCodeServerOptions,
  dependencies: ManagedOpenCodeLifecycleDependencies = {},
): Promise<ManagedOpenCodeServerHandle> {
  const {
    spawnProcess = spawn,
    registerManagedProcess = defaultRegisterManagedProcess,
    unregisterManagedProcess = defaultUnregisterManagedProcess,
    killProcessTree = defaultKillProcessTree,
  } = dependencies;

  const {
    binary,
    launchBinary,
    launchArgs,
    cwd,
    env,
    port,
    timeoutMs,
    binaryIsMacAppBundle,
  } = options;

  const child = spawnProcess(launchBinary, launchArgs, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // The startup waiter is created before the registration await: the child can
  // exit or emit an error while registration is in flight, and a ChildProcess
  // 'error' with no listener is an uncaught exception. All startup listeners
  // therefore attach synchronously in the spawn tick.
  const startupUrlPromise = new Promise<string>((resolve, reject) => {
    let output = '';
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };

    const onStdout = (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        if (!line.startsWith('opencode server listening')) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          cleanup();
          reject(new Error(`Failed to parse server url from output: ${line}`));
          return;
        }
        cleanup();
        resolve(match[1]);
        return;
      }
    };

    const onStderr = (chunk: Buffer) => {
      output += chunk.toString();
    };

    const onExit = (code: number | null) => {
      cleanup();
      const appBundleHint = binaryIsMacAppBundle ? MAC_APP_BUNDLE_HINT : '';
      reject(new Error(`OpenCode process exited before serving with code ${code}. Binary used: ${binary}.${appBundleHint} Output: ${output}`));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const timer = setTimeout(() => {
      cleanup();
      // Surface whatever OpenCode printed while we waited — otherwise a hung or
      // misconfigured start is indistinguishable from a slow one in the status
      // report, leaving no thread to pull on.
      const trimmedOutput = output.trim();
      const outputHint = trimmedOutput ? ` Output: ${trimmedOutput}` : ' Output: (none — process printed nothing)';
      reject(new Error(`Timeout waiting for server to start after ${timeoutMs}ms.${outputHint}`));
    }, timeoutMs);

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('exit', onExit);
    child.on('error', onError);
  });
  // Registration can finish after an early startup failure; shield the rejected
  // promise from becoming an unhandled rejection before it is awaited.
  startupUrlPromise.catch(() => {});

  // Own the child from spawn to exit: the allocated port is already known, so
  // register immediately. A rejected registration is a fatal startup failure —
  // continuing would leave an untracked live child.
  try {
    await registerManagedProcess({
      pid: child.pid,
      ownerPid: process.pid,
      port,
      binary,
      runtime: 'vscode',
    });
  } catch (error) {
    await closeManagedChildProcess(child, killProcessTree, unregisterManagedProcess);
    throw error;
  }

  let url: string;
  try {
    url = await startupUrlPromise;
  } catch (error) {
    // No failure path may leave a live unowned child behind: terminate, await
    // confirmed exit, unregister, then let the original error propagate.
    await closeManagedChildProcess(child, killProcessTree, unregisterManagedProcess);
    throw error;
  }

  let closePromise: Promise<void> | null = null;
  return {
    url,
    close: () => {
      // Memoized: repeated close() calls share one teardown, so the child is
      // killed and unregistered exactly once. Registration has already settled
      // before this handle exists, preserving the registration-before-
      // unregistration order on the shared registry file.
      if (closePromise === null) {
        closePromise = closeManagedChildProcess(child, killProcessTree, unregisterManagedProcess);
      }
      return closePromise;
    },
  };
}
