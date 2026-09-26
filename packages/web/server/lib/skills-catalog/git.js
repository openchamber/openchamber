import { buildSshCommand, getGitBinary } from '../git/service.js';
import {
  execFileProcessTree,
  isProcessTreeCleanupBlocked,
} from '../git/process-tree.js';
import { copyGitProcessMetadata } from '../git/execution-errors.js';
import { getGitExecutionEnv } from '../git/execution-scope.js';

export { isProcessTreeCleanupBlocked };
export { copyGitProcessMetadata };

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const isStringValue = (value) => Object.prototype.toString.call(value) === '[object String]';

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
  const execute = options.execFileAsync ?? ((command, commandArgs, execOptions) => execFileProcessTree({
    command,
    args: commandArgs,
    ...execOptions,
  }));
  const resolveGitBinaryForSpawn = options.resolveGitBinaryForSpawn ?? getGitBinary;

  const identity = options.identity || null;
  const normalizedArgs = Array.isArray(args) ? args.slice() : [];

  // Non-interactive git (avoid prompts / hangs)
  const env = {
    ...process.env,
    ...getGitExecutionEnv(),
    GIT_TERMINAL_PROMPT: '0',
  };

  if (identity?.sshKey) {
    const sshKeyPath = String(identity.sshKey).trim();
    if (sshKeyPath) {
      // Avoid interactive host key prompts; still safe against changed keys.
      const sshCommand = `${buildSshCommand(sshKeyPath)} -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
      normalizedArgs.unshift(`core.sshCommand=${sshCommand}`);
      normalizedArgs.unshift('-c');
    }
  }

  try {
    const { stdout, stderr } = await execute(resolveGitBinaryForSpawn(), normalizedArgs, {
      cwd,
      env,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer,
      signal: options.signal,
    });

    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (error) {
    const err = error;
    const stdout = isStringValue(err?.stdout) ? err.stdout : '';
    const stderr = isStringValue(err?.stderr) ? err.stderr : '';
    const message = err instanceof Error ? err.message : String(err);

    const result = copyGitProcessMetadata({
      ok: false,
      stdout,
      stderr,
      message,
      code: err?.code ?? null,
      signal: isStringValue(err?.signal) ? err.signal : null,
    }, err);
    return result;
  }
}

export const runWithGitCloneReservation = ({
  destination,
  label,
  queueTimeoutMs,
  signal,
  gitExecutionService,
}, task) => {
  const coordinator = gitExecutionService?.coordinator;
  if (coordinator?.runClone) {
    const cloneOptions = {
      destination,
      label,
      queueTimeoutMs,
    };
    if (signal) cloneOptions.signal = signal;
    return coordinator.runClone(cloneOptions, task);
  }
  return task({ releaseNetwork: () => {} });
};

export async function assertGitAvailable(runGitCommand = runGit, { signal = undefined } = {}) {
  const result = await runGitCommand(['--version'], { timeoutMs: 5_000, signal });
  if (!result.ok) {
    if (isProcessTreeCleanupBlocked(result)) {
      const metadata = copyGitProcessMetadata({}, result);
      const error = copyGitProcessMetadata({
        kind: 'networkError',
        message: 'Git process cleanup was not confirmed; Git availability is unknown',
      }, result);
      return { ok: false, error, cleanupBlocked: true, ...metadata };
    }
    return { ok: false, error: { kind: 'gitUnavailable', message: 'Git is not available in PATH' } };
  }
  return { ok: true };
}
