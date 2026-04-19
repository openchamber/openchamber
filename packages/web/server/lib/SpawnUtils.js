import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { execa } from 'execa';

import { toNativePath } from './PathUtils.js';
import { IS_WIN } from './platform.js';

const TRY_CLOUDFLARE_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const DEFAULT_CLOUDFLARED_READY_PATTERNS = [
  /registered tunnel connection/i,
  /connection[^\n]*registered/i,
  /starting metrics server/i,
  /connected to edge/i,
];
const DEFAULT_CLOUDFLARED_FATAL_PATTERNS = [
  /error parsing.*config/i,
  /failed to .*config/i,
  /invalid token/i,
  /unauthorized/i,
  /credentials file .* not found/i,
  /provided tunnel credentials are invalid/i,
];

const mergeEnv = (env) => ({
  ...process.env,
  ...(env && typeof env === 'object' ? env : {}),
});

const normalizeCwd = (cwd) => {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return undefined;
  }
  return toNativePath(cwd);
};

const toError = (error) => error instanceof Error ? error : new Error(String(error));

const normalizeLine = (line) => line.replace(/\r$/, '');

export const calculateBackoffDelay = (attempt, baseDelayMs = 500, maxDelayMs = 5000) => {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.trunc(attempt) : 1;
  const safeBaseDelay = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 500;
  const safeMaxDelay = Number.isFinite(maxDelayMs) && maxDelayMs > 0 ? maxDelayMs : 5000;
  return Math.min(safeBaseDelay * Math.pow(2, safeAttempt - 1), safeMaxDelay);
};

const wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

const createStreamLineCollector = (handleLine) => {
  let pending = '';

  return {
    push(chunk) {
      const text = chunk.toString('utf8');
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const rawLine of lines) {
        handleLine(normalizeLine(rawLine));
      }
      return text;
    },
    flush() {
      if (!pending) {
        return;
      }
      handleLine(normalizeLine(pending));
      pending = '';
    },
  };
};

const buildSpawnOptions = (opts = {}) => ({
  cwd: normalizeCwd(opts.cwd),
  env: mergeEnv(opts.env),
  timeout: opts.timeout,
  shell: opts.useShell === true,
  windowsHide: true,
  reject: false,
  cleanup: false,
  stripFinalNewline: false,
  maxBuffer: opts.maxBuffer,
  stdio: opts.stdio,
  input: opts.input,
  encoding: opts.encoding,
});

export const spawnOnce = async (cmd, args = [], opts = {}) => {
  const result = await execa(cmd, args, buildSpawnOptions(opts));
  return {
    stdout: result.stdout ?? (opts.encoding === 'buffer' || opts.encoding === null ? Buffer.alloc(0) : ''),
    stderr: result.stderr ?? (opts.encoding === 'buffer' || opts.encoding === null ? Buffer.alloc(0) : ''),
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : -1,
    failed: result.failed === true,
  };
};

export const spawnOnceSync = (cmd, args = [], opts = {}) => {
  const result = spawnSync(cmd, args, {
    cwd: normalizeCwd(opts.cwd),
    env: mergeEnv(opts.env),
    timeout: opts.timeout,
    windowsHide: true,
    shell: opts.useShell === true,
    stdio: opts.stdio,
    input: opts.input,
    encoding: opts.encoding || 'utf8',
    maxBuffer: opts.maxBuffer,
  });

  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    exitCode: typeof result.status === 'number' ? result.status : -1,
    error: result.error || null,
    signal: typeof result.signal === 'string' ? result.signal : null,
  };
};

export const launchDetached = (cmd, args = [], opts = {}) => {
  const child = spawn(cmd, args, {
    cwd: normalizeCwd(opts.cwd),
    env: mergeEnv(opts.env),
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
  return child.pid ?? null;
};

export const killByPid = async (pid, options = {}) => {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) {
    return;
  }

  const force = options.force !== false;
  const tree = options.tree !== false;

  if (IS_WIN) {
    const args = ['/pid', String(numericPid)];
    if (force) {
      args.push('/f');
    }
    if (tree) {
      args.push('/t');
    }
    try {
      await spawnOnce('taskkill', args, { timeout: 5000 });
    } catch {
    }
    return;
  }

  try {
    process.kill(numericPid, force ? 'SIGKILL' : (options.signal || 'SIGTERM'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') {
      return;
    }
    throw error;
  }
};

const isExecutableFile = (filePath) => {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    if (IS_WIN) {
      return true;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const resolveExecutable = (command, options = {}) => {
  if (typeof command !== 'string') {
    return null;
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  if (path.isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    const absoluteCandidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed);
    return isExecutableFile(absoluteCandidate) ? absoluteCandidate : null;
  }

  const pathValue = typeof options.pathValue === 'string' ? options.pathValue : (process.env.PATH || '');
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = IS_WIN
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
        .split(';')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [''];

  for (const dir of pathEntries) {
    const baseCandidate = path.join(dir, trimmed);
    const candidates = IS_WIN && path.extname(trimmed) === ''
      ? extensions.map((ext) => baseCandidate.endsWith(ext) ? baseCandidate : `${baseCandidate}${ext}`)
      : [baseCandidate];

    for (const candidate of candidates) {
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
};

export const spawnManaged = async (cmd, args = [], opts = {}) => {
  const maxRetries = Number.isFinite(opts.maxRetries) && opts.maxRetries > 0 ? Math.trunc(opts.maxRetries) : 0;
  const startupTimeoutMs = Number.isFinite(opts.startupTimeoutMs) && opts.startupTimeoutMs > 0
    ? Math.trunc(opts.startupTimeoutMs)
    : 30000;
  const baseRetryDelayMs = Number.isFinite(opts.baseRetryDelayMs) && opts.baseRetryDelayMs > 0
    ? Math.trunc(opts.baseRetryDelayMs)
    : 500;
  const maxRetryDelayMs = Number.isFinite(opts.maxRetryDelayMs) && opts.maxRetryDelayMs > 0
    ? Math.trunc(opts.maxRetryDelayMs)
    : 5000;

  let currentChild = null;
  let currentExitPromise = null;
  let combinedOutput = '';
  let stdoutText = '';
  let stderrText = '';

  const attachOutput = (child, resolve, reject) => {
    let settled = false;
    let startupTimer = null;
    let sawOutput = false;
    let livenessTimer = null;

    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
      }
      if (livenessTimer) {
        clearTimeout(livenessTimer);
      }
      stdoutCollector.flush();
      stderrCollector.flush();
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
      handler(value);
    };

    const handleReadyFallback = () => {
      if (!settled && sawOutput && Number.isFinite(opts.readyWhenOutputSeenAfterMs) && opts.readyWhenOutputSeenAfterMs > 0) {
        finish(resolve, null);
      }
    };

    const handleLine = (line, stream) => {
      if (!line) {
        return;
      }

      sawOutput = true;
      if (!livenessTimer && Number.isFinite(opts.readyWhenOutputSeenAfterMs) && opts.readyWhenOutputSeenAfterMs > 0) {
        livenessTimer = setTimeout(handleReadyFallback, opts.readyWhenOutputSeenAfterMs);
      }

      if (typeof opts.onLine === 'function') {
        opts.onLine(line, stream);
      }

      if (typeof opts.isFatalLine === 'function') {
        const fatal = opts.isFatalLine(line, stream);
        if (fatal) {
          finish(reject, fatal instanceof Error ? fatal : new Error(String(fatal)));
          return;
        }
      }

      if (typeof opts.isReadyLine === 'function') {
        const readyValue = opts.isReadyLine(line, stream);
        if (readyValue) {
          finish(resolve, readyValue === true ? null : readyValue);
        }
      }
    };

    const stdoutCollector = createStreamLineCollector((line) => handleLine(line, 'stdout'));
    const stderrCollector = createStreamLineCollector((line) => handleLine(line, 'stderr'));

    const onStdout = (chunk) => {
      const text = stdoutCollector.push(chunk);
      stdoutText += text;
      combinedOutput += text;
      if (typeof opts.onStdout === 'function') {
        opts.onStdout(text);
      }
    };

    const onStderr = (chunk) => {
      const text = stderrCollector.push(chunk);
      stderrText += text;
      combinedOutput += text;
      if (typeof opts.onStderr === 'function') {
        opts.onStderr(text);
      }
    };

    const onExit = (code, signal) => {
      const detail = code === null
        ? `signal ${signal || 'unknown'}`
        : `code ${code}`;
      finish(reject, new Error(`Process exited before readiness check passed (${detail})`));
    };

    const onError = (error) => {
      finish(reject, toError(error));
    };

    startupTimer = setTimeout(() => {
      finish(reject, new Error(`Timed out waiting for process readiness after ${startupTimeoutMs}ms`));
    }, startupTimeoutMs);

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const child = execa(cmd, args, {
        ...buildSpawnOptions(opts),
        buffer: false,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      currentChild = child;
      currentExitPromise = child.catch(() => null);

      const readyValue = await new Promise((resolve, reject) => attachOutput(child, resolve, reject));

      return {
        get pid() {
          return currentChild?.pid;
        },
        get process() {
          return currentChild;
        },
        readyValue,
        getOutput: () => combinedOutput,
        getStdout: () => stdoutText,
        getStderr: () => stderrText,
        waitForExit: async () => {
          await currentExitPromise;
        },
        stop: async (stopOptions = {}) => {
          const pid = currentChild?.pid;
          if (!pid) {
            return;
          }

          const force = stopOptions.force === true;

          if (IS_WIN) {
            try {
              currentChild.kill();
            } catch {
            }

            if (!force) {
              await wait(250);
            }
            await killByPid(pid, { force: true, tree: true });
            return;
          }

          try {
            currentChild.kill(force ? 'SIGKILL' : 'SIGTERM');
          } catch {
          }

          if (!force) {
            await wait(500);
          }

          await killByPid(pid, { force, tree: false, signal: force ? 'SIGKILL' : 'SIGTERM' });
        },
      };
    } catch (error) {
      const normalizedError = toError(error);
      const canRetry = attempt < maxRetries;
      if (!canRetry) {
        if (combinedOutput && !normalizedError.message.includes('Output:')) {
          normalizedError.message = `${normalizedError.message}. Output: ${combinedOutput}`;
        }
        throw normalizedError;
      }

      const retryDelayMs = calculateBackoffDelay(attempt + 1, baseRetryDelayMs, maxRetryDelayMs);
      await wait(retryDelayMs);
    }
  }

  throw new Error('Managed spawn failed unexpectedly');
};

export const spawnCloudflaredTunnel = async (options) => {
  const {
    binaryPath = 'cloudflared',
    args = [],
    env,
    mode = 'quick',
    startupTimeoutMs = mode === 'quick' ? 30000 : 20000,
    readyPatterns = DEFAULT_CLOUDFLARED_READY_PATTERNS,
    fatalPatterns = DEFAULT_CLOUDFLARED_FATAL_PATTERNS,
    livenessFallbackMs = mode === 'quick' ? 0 : 6000,
    onStdout,
    onStderr,
  } = options || {};

  let publicUrl = null;

  const managed = await spawnManaged(binaryPath, args, {
    env: {
      CF_TELEMETRY_DISABLE: '1',
      ...env,
    },
    startupTimeoutMs,
    readyWhenOutputSeenAfterMs: livenessFallbackMs,
    onStdout,
    onStderr,
    isReadyLine: (line) => {
      if (mode === 'quick') {
        const match = line.match(TRY_CLOUDFLARE_URL_REGEX);
        if (match) {
          publicUrl = match[0];
          return { publicUrl };
        }
        return false;
      }

      if (readyPatterns.some((pattern) => pattern.test(line))) {
        return { publicUrl: null };
      }

      return false;
    },
    isFatalLine: (line) => {
      if (fatalPatterns.some((pattern) => pattern.test(line))) {
        return new Error(`cloudflared reported a fatal startup error: ${line}`);
      }
      return null;
    },
  });

  if (managed.readyValue?.publicUrl) {
    publicUrl = managed.readyValue.publicUrl;
  }

  return {
    get pid() {
      return managed.pid;
    },
    get process() {
      return managed.process;
    },
    getPublicUrl: () => publicUrl,
    getOutput: managed.getOutput,
    stop: managed.stop,
    waitForExit: managed.waitForExit,
  };
};
