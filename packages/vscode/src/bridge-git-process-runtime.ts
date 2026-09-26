import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { spawnOwnedProcess } from './owned-process';
import { getGitExecutablePath } from './gitService';
import { getGitExecutionEnv } from './git-execution-scope';
import {
  copyGitProcessMetadata,
  getGitProcessCleanupReconciliation,
} from './git-execution-errors';

const execFileAsync = promisify(execFile);
const gpgconfCandidates = ['gpgconf', '/opt/homebrew/bin/gpgconf', '/usr/local/bin/gpgconf'];

export type GitProcessRuntimeOptions = {
  resolveGitExecutable?: () => Promise<string | undefined>;
};

export type GitProcessExecutionOptions = {
  signal?: AbortSignal;
  binary?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
};

export type GitProcessExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  code?: string;
  cleanupBlocked?: boolean;
  descendantsTerminated?: boolean;
  rootClosed?: boolean;
  pid?: number;
  cause?: Error | string | null;
  rootError?: Error;
  operationError?: Error;
  cleanupReconciliation?: { promise: Promise<unknown>; retire: () => void };
};

const isSocketPath = async (candidate: string): Promise<boolean> => {
  if (!candidate) {
    return false;
  }
  try {
    const stat = await fs.promises.stat(candidate);
    return stat.isSocket();
  } catch {
    return false;
  }
};

const resolveSshAuthSock = async (): Promise<string | undefined> => {
  const existing = (process.env.SSH_AUTH_SOCK || '').trim();
  if (existing) {
    return existing;
  }

  if (process.platform === 'win32') {
    return undefined;
  }

  const gpgSock = path.join(os.homedir(), '.gnupg', 'S.gpg-agent.ssh');
  if (await isSocketPath(gpgSock)) {
    return gpgSock;
  }

  const runGpgconf = async (args: string[]): Promise<string> => {
    for (const candidate of gpgconfCandidates) {
      try {
        const { stdout } = await execFileAsync(candidate, args);
        return String(stdout || '');
      } catch {
        continue;
      }
    }
    return '';
  };

  const candidate = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
  if (candidate && await isSocketPath(candidate)) {
    return candidate;
  }

  if (candidate) {
    await runGpgconf(['--launch', 'gpg-agent']);
    const retried = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
    if (retried && await isSocketPath(retried)) {
      return retried;
    }
  }

  return undefined;
};

const buildGitEnv = async (): Promise<NodeJS.ProcessEnv> => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!env.SSH_AUTH_SOCK || !env.SSH_AUTH_SOCK.trim()) {
    const resolved = await resolveSshAuthSock();
    if (resolved) {
      env.SSH_AUTH_SOCK = resolved;
    }
  }
  return env;
};

const getErrorCode = (error: Error): string | undefined => {
  // SAFETY: child-process failures use Node's optional errno code field.
  const code = (error as NodeJS.ErrnoException).code;
  return String(code) === code ? code : undefined;
};

type OwnedProcessFailure = Error & {
  cleanupBlocked?: boolean;
  descendantsTerminated?: boolean;
  rootClosed?: boolean;
  pid?: number;
  rootError?: Error;
  operationError?: Error;
};

const processFailure = (error: OwnedProcessFailure): GitProcessExecutionResult => {
  const result: GitProcessExecutionResult = {
    stdout: '',
    stderr: error.message,
    exitCode: 1,
    code: getErrorCode(error),
  };
  return copyGitProcessMetadata(result, error);
};

export const createGitProcessRuntime = ({
  resolveGitExecutable = getGitExecutablePath,
}: GitProcessRuntimeOptions = {}) => {
  const activeProcesses = new Set<ReturnType<typeof spawnOwnedProcess>>();
  const cleanupBlockedProcesses = new Set<ReturnType<typeof spawnOwnedProcess>>();
  let shutdown: Promise<void> | null = null;
  let cleanupBlocked = false;
  let unreconciledCleanupBlocked = false;

  const stopGitProcesses = (): Promise<void> => {
    if (!shutdown) shutdown = (async () => {
      const results = await Promise.allSettled([...activeProcesses].map((process) => process.terminate()));
      for (const result of results) {
        if (result.status === 'rejected') console.warn('Failed to stop a Git process:', result.reason);
      }
    })();
    return shutdown;
  };

  const resetGitProcesses = async (): Promise<void> => {
    if (shutdown) await shutdown;
    if (cleanupBlocked || activeProcesses.size > 0 || cleanupBlockedProcesses.size > 0) {
      throw new Error('Cannot reset the Git runtime while processes are still active');
    }
    shutdown = null;
  };

  const execGit = async (
    args: string[],
    cwd: string,
    options: GitProcessExecutionOptions = {},
  ): Promise<GitProcessExecutionResult> => {
    let env: NodeJS.ProcessEnv;
    let configuredPath: string | undefined;
    try {
      [env, configuredPath] = await Promise.all([
        buildGitEnv(),
        resolveGitExecutable(),
      ]);
    } catch (error) {
      return processFailure(error instanceof Error ? error : new Error(String(error)));
    }
    if (shutdown || cleanupBlocked) {
      const result: GitProcessExecutionResult = {
        stdout: '',
        stderr: cleanupBlocked
          ? 'Git runtime cleanup is not confirmed'
          : 'Git runtime is shutting down',
        exitCode: 1,
      };
      if (cleanupBlocked) result.cleanupBlocked = true;
      return result;
    }
    if (options.signal?.aborted) {
      return processFailure(options.signal.reason || new Error('Git process was cancelled'));
    }

    const process = spawnOwnedProcess(options.binary?.trim() || configuredPath?.trim() || 'git', args, {
      cwd,
      env: { ...env, ...options.env, ...getGitExecutionEnv() },
    });
    activeProcesses.add(process);
    let processReleased = false;
    const forgetProcess = () => {
      if (processReleased) return;
      processReleased = true;
      activeProcesses.delete(process);
    };
    let cleanupReconciliationWatched = false;
    const reconcileCleanup = (failure: Error) => {
      if (cleanupReconciliationWatched) return;
      cleanupReconciliationWatched = true;
      const reconciliation = getGitProcessCleanupReconciliation(failure);
      if (!reconciliation) {
        unreconciledCleanupBlocked = true;
        cleanupBlocked = true;
        return;
      }
      cleanupBlockedProcesses.add(process);
      cleanupBlocked = true;
      void Promise.resolve(reconciliation.promise).then(
        (confirmed) => {
          if (confirmed === false) {
            unreconciledCleanupBlocked = true;
            cleanupBlocked = true;
            return;
          }
          cleanupBlockedProcesses.delete(process);
          cleanupBlocked = unreconciledCleanupBlocked || cleanupBlockedProcesses.size > 0;
          forgetProcess();
        },
        () => {
          unreconciledCleanupBlocked = true;
          cleanupBlocked = true;
        },
      );
    };
    let cleanupWatchStarted = false;
    const forgetAfterCleanup = () => {
      if (cleanupWatchStarted) return;
      cleanupWatchStarted = true;
      const cleanup = process.termination;
      if (cleanup) {
        void cleanup.then(forgetProcess, reconcileCleanup);
        return;
      }
      forgetProcess();
    };
    // A root close only ends the command's stdio. If termination has already
    // started, retain the registry entry until taskkill/process-group cleanup
    // settles so deactivation cannot release ownership early.
    void process.closed.then(forgetAfterCleanup);
    void process.failedTermination.then((failure) => reconcileCleanup(failure));
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let outputLimitExceeded: string | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let termination: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const maxBuffer = options.maxBuffer !== undefined
      && Number.isFinite(options.maxBuffer)
      && options.maxBuffer >= 0
      ? options.maxBuffer
      : Number.POSITIVE_INFINITY;
    const appendOutput = (stream: 'stdout' | 'stderr', data: Buffer) => {
      if (outputLimitExceeded) return;
      const text = data.toString();
      if (stream === 'stdout') {
        stdoutBytes += Buffer.byteLength(text);
        if (stdoutBytes > maxBuffer) {
          outputLimitExceeded = `Git command stdout exceeded maxBuffer of ${maxBuffer} bytes`;
        } else {
          stdout += text;
        }
      } else {
        stderrBytes += Buffer.byteLength(text);
        if (stderrBytes > maxBuffer) {
          outputLimitExceeded = `Git command stderr exceeded maxBuffer of ${maxBuffer} bytes`;
        } else {
          stderr += text;
        }
      }
      if (outputLimitExceeded && !termination) {
        termination = process.terminate();
        void termination.catch(() => undefined);
      }
    };
    const onAbort = () => {
      if (termination) return;
      cancelled = true;
      termination = process.terminate();
      void termination.catch(() => undefined);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    process.child.stdout?.on('data', (data: Buffer) => appendOutput('stdout', data));
    process.child.stderr?.on('data', (data: Buffer) => appendOutput('stderr', data));
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        termination = process.terminate();
        void termination.catch(() => undefined);
      }, options.timeoutMs);
    }
    try {
      const exit = await Promise.race([
        process.closed,
        process.failedTermination.then((error) => Promise.reject(error)),
      ]);
      if (process.termination) {
        await process.termination;
      }
      if (timedOut) {
        return {
          stdout,
          stderr: `Git command timed out after ${options.timeoutMs}ms`,
          exitCode: 1,
        };
      }
      if (cancelled) {
        return {
          stdout,
          stderr: stderr || 'Git process was cancelled',
          exitCode: 1,
        };
      }
      if (outputLimitExceeded) {
        return {
          stdout,
          stderr: outputLimitExceeded,
          exitCode: 1,
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        };
      }
      if (exit.error) return processFailure(exit.error);
      return {
        stdout,
        stderr: stderr || (exit.signal ? `Git terminated by ${exit.signal}` : ''),
        exitCode: exit.code ?? 1,
      };
    } catch (error) {
      return processFailure(error instanceof Error ? error : new Error(String(error)));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void process.closed.then(forgetAfterCleanup);
    }
  };

  return Object.freeze({ execGit, stopGitProcesses, resetGitProcesses });
};

const defaultRuntime = createGitProcessRuntime();

export const execGit = defaultRuntime.execGit;
export const stopGitProcesses = defaultRuntime.stopGitProcesses;
export const resetGitProcesses = defaultRuntime.resetGitProcesses;
