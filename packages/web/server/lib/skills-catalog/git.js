import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export function looksLikeAuthError(message) {
  const text = String(message || '');
  return (
    /permission denied/i.test(text) ||
    /publickey/i.test(text) ||
    /could not read from remote repository/i.test(text) ||
    /authentication failed/i.test(text) ||
    /fatal: could not/i.test(text)
  );
}

export async function runGit(args, options = {}) {
  const cwd = options.cwd;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : DEFAULT_MAX_BUFFER;

  const identity = options.identity || null;
  const normalizedArgs = Array.isArray(args) ? args.slice() : [];

  // Non-interactive git (avoid prompts / hangs)
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };

  if (identity?.sshKey) {
    const sshKeyPath = String(identity.sshKey).trim();
    if (sshKeyPath) {
      // Avoid interactive host key prompts; still safe against changed keys.
      const sshCommand = `ssh -i ${sshKeyPath} -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
      normalizedArgs.unshift(`core.sshCommand=${sshCommand}`);
      normalizedArgs.unshift('-c');
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync('git', normalizedArgs, {
      cwd,
      env,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer,
    });

    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (error) {
    const err = error;
    const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
    const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
    const message = err instanceof Error ? err.message : String(err);

    return {
      ok: false,
      stdout,
      stderr,
      message,
      code: typeof err?.code === 'number' ? err.code : null,
      signal: typeof err?.signal === 'string' ? err.signal : null,
    };
  }
}

export async function assertGitAvailable() {
  const result = await runGit(['--version'], { timeoutMs: 5_000 });
  if (!result.ok) {
    return { ok: false, error: { kind: 'gitUnavailable', message: 'Git is not available in PATH' } };
  }
  return { ok: true };
}
