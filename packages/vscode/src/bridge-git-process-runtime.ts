import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { StringDecoder } from 'node:string_decoder';
import { spawnOwnedProcess } from './owned-process';

const execFileAsync = promisify(execFile);
const gpgconfCandidates = ['gpgconf', '/opt/homebrew/bin/gpgconf', '/usr/local/bin/gpgconf'];
// A gpgconf that never answers (a locked gpg-agent, a smartcard prompt)
// must not wedge every Git command: buildGitEnv resolves the SSH socket
// per command, before Git's own probe timeouts can apply (#862).
const GPGCONF_TIMEOUT_MS = 5_000;
const GPGCONF_MAX_BUFFER = 1024 * 1024;

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
        const { stdout } = await execFileAsync(candidate, args, { timeout: GPGCONF_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: GPGCONF_MAX_BUFFER });
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

// An env value is judged by its whole text, not by what `Number(...)` can
// reinterpret: '' or ' ' must not read as 0, and '1e3', '0x10' or '5.9' must
// not become a number the user never wrote. The web copies of these readers
// judge the same variables this way (`packages/web/server/lib/fs/routes.js`).
const parsePlainDecimalInt = (raw: string | undefined): number | null => {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
};

export const GIT_EXEC_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const GIT_EXEC_DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export const createGitExecTimeoutMs = () => {
  const raw = parsePlainDecimalInt(process.env.OPENCHAMBER_GIT_EXEC_TIMEOUT_MS);
  // A delay above Node's timer maximum (2^31 - 1 ms) fires after ~1 ms
  // instead, so a larger configured deadline falls back to the default
  // rather than expiring every command immediately.
  if (raw !== null && raw >= 0 && raw <= 2_147_483_647) return raw;
  return GIT_EXEC_DEFAULT_TIMEOUT_MS;
};

export const createGitExecMaxOutputBytes = () => {
  const raw = parsePlainDecimalInt(process.env.OPENCHAMBER_GIT_EXEC_OUTPUT_MAX_BYTES);
  if (raw !== null && raw > 0) return raw;
  return GIT_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
};

export const execGit = async (
  args: string[], cwd: string, options: { binary?: string; timeoutMs?: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  // A caller deadline wins over the default. A caller that passes 0 runs
  // with no deadline, for a command that must stay timeless.
  const timeoutMs = options.timeoutMs === undefined ? createGitExecTimeoutMs() : options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes !== undefined && options.maxOutputBytes > 0
    ? options.maxOutputBytes
    : createGitExecMaxOutputBytes();
  const env = { ...(await buildGitEnv()), ...options.env };
  if (shutdown) return { stdout: '', stderr: 'Git runtime is shutting down', exitCode: 1 };
  const process = spawnOwnedProcess(options.binary ?? 'git', args, { cwd, env });
  activeProcesses.add(process);
  let stdout = '';
  let stderr = '';
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let outputTooLarge = false;
  let termination: Promise<void> | undefined;
  let rejectExit: ((error: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Append at most the bytes left under the per-stream cap and report
  // overflow, so a capped stream is truncated to the cap and never grows
  // past it. Overflow terminates the child: a verbose command otherwise
  // grows extension-host memory without bound.
  const appendChunk = (chunk: Buffer, isStderr: boolean) => {
    if (outputTooLarge) return;
    const decoder = isStderr ? stderrDecoder : stdoutDecoder;
    const currentBytes = isStderr ? stderrBytes : stdoutBytes;
    const remaining = maxOutputBytes - currentBytes;
    if (chunk.length > remaining) {
      const kept = remaining > 0 ? decoder.write(chunk.subarray(0, remaining)) : '';
      if (isStderr) {
        stderr += kept;
        stderrBytes = maxOutputBytes;
      } else {
        stdout += kept;
        stdoutBytes = maxOutputBytes;
      }
      outputTooLarge = true;
      termination = process.terminate();
      // Handle a termination failure as it happens, like the timeout
      // path: the promise can reject before the close await below
      // reaches it, and an unhandled rejection can crash the host.
      void termination.catch((error: Error) => rejectExit?.(error));
      return;
    }
    const decoded = decoder.write(chunk);
    if (isStderr) {
      stderr += decoded;
      stderrBytes += chunk.length;
    } else {
      stdout += decoded;
      stdoutBytes += chunk.length;
    }
  };
  process.child.stdout.on('data', (data: Buffer) => appendChunk(data, false));
  process.child.stderr.on('data', (data: Buffer) => appendChunk(data, true));
  try {
    const exit = await new Promise<Awaited<typeof process.closed>>((resolve, reject) => {
      rejectExit = reject;
      void process.closed.then(resolve);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          termination = process.terminate();
          void termination.catch(reject);
        }, timeoutMs);
      }
    });
    await termination;
    // Overflow can leave a decoder holding the partial character cut by the
    // cap. Ending it here would append U+FFFD beyond the retained prefix.
    if (!outputTooLarge) {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
    }
    if (outputTooLarge) return { stdout, stderr: `Git command output exceeded the ${maxOutputBytes} byte limit (output-too-large)`, exitCode: 1 };
    if (timedOut) return { stdout, stderr: `Git command timed out after ${timeoutMs}ms`, exitCode: 1 };
    if (exit.error) return { stdout, stderr: exit.error.message, exitCode: 1 };
    return { stdout, stderr: stderr || (exit.signal ? `Git terminated by ${exit.signal}` : ''), exitCode: exit.code ?? 1 };
  } finally {
    clearTimeout(timer);
    void process.closed.then(() => activeProcesses.delete(process));
  }
};
