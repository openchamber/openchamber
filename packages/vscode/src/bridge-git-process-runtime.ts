import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { getGitExecutablePath } from './gitService';
import { getGitExecutionEnv } from './git-execution-scope';

const execFileAsync = promisify(execFile);
const gpgconfCandidates = ['gpgconf', '/opt/homebrew/bin/gpgconf', '/usr/local/bin/gpgconf'];

export type GitProcessRuntimeOptions = {
  resolveGitExecutable?: () => Promise<string | undefined>;
};

export type GitProcessExecutionOptions = {
  signal?: AbortSignal;
};

const isSocketPath = async (candidate: string): Promise<boolean> => {
  if (!candidate) {
    return false;
  }
  try {
    const stat = await fs.promises.stat(candidate);
    return typeof stat.isSocket === 'function' && stat.isSocket();
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

const getErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
};

const processFailure = (error: unknown): { stdout: string; stderr: string; exitCode: number; code?: string } => ({
  stdout: '',
  stderr: error instanceof Error ? error.message : String(error),
  exitCode: 1,
  code: getErrorCode(error),
});

export const createGitProcessRuntime = ({
  resolveGitExecutable = getGitExecutablePath,
}: GitProcessRuntimeOptions = {}) => {
  const execGit = async (
    args: string[],
    cwd: string,
    options: GitProcessExecutionOptions = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number; code?: string }> => {
    let env: NodeJS.ProcessEnv;
    let configuredPath: string | undefined;
    try {
      [env, configuredPath] = await Promise.all([
        buildGitEnv(),
        resolveGitExecutable(),
      ]);
    } catch (error) {
      return processFailure(error);
    }
    const gitExecutable = configuredPath?.trim() || 'git';

    if (options.signal?.aborted) {
      return processFailure(options.signal.reason || new Error('Git process was cancelled'));
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let terminationRequested = false;

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(gitExecutable, args, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...env, ...getGitExecutionEnv() },
          windowsHide: true,
        });
      } catch (error) {
        resolve(processFailure(error));
        return;
      }

      const cleanup = () => {
        options.signal?.removeEventListener('abort', onAbort);
      };
      const finish = (result: { stdout: string; stderr: string; exitCode: number; code?: string }) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onAbort = () => {
        if (settled || terminationRequested) return;
        terminationRequested = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          // The process may already have exited.
        }
      };

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        finish({ stdout, stderr, exitCode: code ?? (terminationRequested ? 1 : 0) });
      });

      proc.on('error', (error) => {
        finish(terminationRequested ? {
          stdout,
          stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
          exitCode: 1,
          code: getErrorCode(error),
        } : processFailure(error));
      });

      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  return Object.freeze({ execGit });
};

export const { execGit } = createGitProcessRuntime();
