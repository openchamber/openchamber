import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { spawnOwnedProcess } from './owned-process';

const execFileAsync = promisify(execFile);
const gpgconfCandidates = ['gpgconf', '/opt/homebrew/bin/gpgconf', '/usr/local/bin/gpgconf'];

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

const activeProcesses = new Set<ReturnType<typeof spawnOwnedProcess>>();
let shutdown: Promise<void> | null = null;

export const stopGitProcesses = (): Promise<void> => {
  if (!shutdown) shutdown = (async () => {
    const results = await Promise.allSettled([...activeProcesses].map((process) => process.terminate()));
    for (const result of results) {
      if (result.status === 'rejected') console.warn('Failed to stop a Git process:', result.reason);
    }
  })();
  return shutdown;
};

export const execGit = async (
  args: string[], cwd: string, options: { binary?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const env = await buildGitEnv();
  if (shutdown) return { stdout: '', stderr: 'Git runtime is shutting down', exitCode: 1 };
  const process = spawnOwnedProcess(options.binary ?? 'git', args, { cwd, env });
  activeProcesses.add(process);
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let termination: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  process.child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  process.child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  try {
    const exit = await new Promise<Awaited<typeof process.closed>>((resolve, reject) => {
      void process.closed.then(resolve);
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          termination = process.terminate();
          void termination.catch(reject);
        }, options.timeoutMs);
      }
    });
    await termination;
    if (timedOut) return { stdout, stderr: `Git command timed out after ${options.timeoutMs}ms`, exitCode: 1 };
    if (exit.error) return { stdout, stderr: exit.error.message, exitCode: 1 };
    return { stdout, stderr: stderr || (exit.signal ? `Git terminated by ${exit.signal}` : ''), exitCode: exit.code ?? 1 };
  } finally {
    clearTimeout(timer);
    void process.closed.then(() => activeProcesses.delete(process));
  }
};
