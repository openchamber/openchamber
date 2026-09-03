import { getGitExecutionEnv, runWithGitExecutionScope } from '../git/execution-scope.js';

const DEFAULT_TIMEOUT_MS = 2500;

const resolveTimeoutMs = () => {
  const value = Number(process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TIMEOUT_MS;
};

const isExecutionFailure = (result) => {
  const code = String(result?.code || '').toUpperCase();
  if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') {
    return true;
  }
  return /access is denied|command not found|cannot execute|failed to spawn|no such file or directory|permission denied|spawn .*\b(?:eacces|enoent)\b/i.test(
    `${result?.stderr || ''}\n${result?.stdout || ''}`,
  );
};

const parseResult = (result, cwd) => {
  if (result?.aborted) {
    throw new Error(`Gitignore discovery timed out for ${cwd}`);
  }

  if (result?.exitCode === 0) {
    return new Set(
      String(result.stdout || '')
        .split('\0')
        .filter((name) => name.length > 0),
    );
  }

  if (result?.exitCode === 1 && !String(result.stderr || '').trim() && !isExecutionFailure(result)) {
    return new Set();
  }

  if (!isExecutionFailure(result) && /not a git repository|not inside (?:a )?work tree|this operation must be run in a work tree/i.test(
    `${result?.stderr || ''}\n${result?.stdout || ''}`,
  )) {
    return new Set();
  }

  const detail = String(result?.stderr || '').trim()
    || String(result?.stdout || '').trim()
    || `Git exited with code ${result?.exitCode}`;
  throw new Error(`Gitignore discovery failed for ${cwd}: ${detail}`);
};

const runCheckIgnore = ({ spawn, resolveGitBinaryForSpawn, cwd, names, signal }) => new Promise((resolve, reject) => {
  let child;
  try {
    child = spawn(resolveGitBinaryForSpawn(), ['check-ignore', '-z', '--', ...names], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...getGitExecutionEnv() },
    });
  } catch (error) {
    reject(error);
    return;
  }

  let stdout = '';
  let stderr = '';
  let settled = false;
  let terminationRequested = false;

  const finish = (result) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    resolve(result);
  };

  const onAbort = () => {
    if (settled || terminationRequested) return;
    terminationRequested = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may already have exited.
    }
  };

  child.stdout?.on('data', (data) => { stdout += data.toString(); });
  child.stderr?.on('data', (data) => { stderr += data.toString(); });
  child.on('close', (exitCode) => finish({
    stdout,
    stderr,
    exitCode: exitCode ?? (terminationRequested ? 1 : 0),
    aborted: terminationRequested,
  }));
  child.on('error', (error) => {
    finish({
      stdout,
      stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
      exitCode: undefined,
      code: error?.code,
      aborted: terminationRequested,
    });
  });

  if (signal?.aborted) {
    onAbort();
    return;
  }
  signal?.addEventListener('abort', onAbort, { once: true });
});

export const createGitIgnoreReader = ({
  spawn,
  resolveGitBinaryForSpawn,
  gitExecutionService,
  timeoutMs = resolveTimeoutMs(),
}) => {
  const getIgnoredNames = async (cwd, names, { signal } = {}) => {
    if (!Array.isArray(names) || names.length === 0) {
      return new Set();
    }

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(signal.reason);
    let timer;
    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => controller.abort('Gitignore discovery timed out'), timeoutMs);
    }

    const read = () => runCheckIgnore({
      spawn,
      resolveGitBinaryForSpawn,
      cwd,
      names,
      signal: controller.signal,
    });

    try {
      const result = gitExecutionService?.withRawRead
        ? await gitExecutionService.withRawRead(
          cwd,
          read,
          {
            signal: controller.signal,
            queueTimeoutMs: timeoutMs > 0 ? timeoutMs : undefined,
          },
        )
        : await runWithGitExecutionScope(true, read);
      return parseResult(result, cwd);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  };

  return Object.freeze({ getIgnoredNames });
};
