import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  GitExecutionCancelledError,
  GitExecutionOverloadedError,
} from './execution-errors.js';

const DEFAULTS = Object.freeze({
  discoveryConcurrency: 8,
  maxPendingDiscoveries: 256,
  maxInFlightAliases: 2048,
  maxInFlightContexts: 1024,
  discoveryTimeoutMs: 30_000,
});

const normalizeDirectory = (directory) => {
  if (typeof directory !== 'string' || !directory.trim()) {
    throw new TypeError('Git directory is required');
  }
  return path.resolve(directory.trim());
};

const defaultPathExists = async (value) => {
  try {
    await fsp.stat(value);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
};

const statFingerprint = (stat) => [
  stat.dev,
  stat.ino,
  stat.mode,
  stat.size,
  stat.mtimeNs?.toString() || stat.mtimeMs,
  stat.ctimeNs?.toString() || stat.ctimeMs,
].join(':');

const defaultPathFingerprint = async (context) => {
  const paths = Array.from(new Set([
    context.topLevel,
    context.gitDir,
    context.commonDir,
    path.join(context.topLevel, '.git'),
    path.join(context.gitDir, 'config'),
    path.join(context.gitDir, 'HEAD'),
    path.join(context.gitDir, 'gitdir'),
    path.join(context.gitDir, 'commondir'),
    path.join(context.commonDir, 'config'),
  ]));
  let fingerprints;
  try {
    fingerprints = await Promise.all(paths.map(async (value) => {
      try {
        return `${value}\0${statFingerprint(await fsp.lstat(value))}`;
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return `${value}\0missing`;
        }
        throw error;
      }
    }));
  } catch {
    return null;
  }

  const requiredPaths = [context.topLevel, context.gitDir, context.commonDir, path.join(context.topLevel, '.git')];
  if (requiredPaths.some((value) => fingerprints.find((entry) => entry.startsWith(`${value}\0missing`)))) {
    return null;
  }
  return fingerprints.join('|');
};

const normalizeCommandResult = (result) => {
  if (Buffer.isBuffer(result)) {
    return { success: true, stdout: result.toString(), stderr: '' };
  }
  if (typeof result === 'string') {
    return { success: true, stdout: result, stderr: '' };
  }
  if (result instanceof Error) {
    throw result;
  }
  if (!result || typeof result !== 'object') {
    return { success: false, stdout: '', stderr: 'Git discovery failed' };
  }
  const success = result.success === undefined
    ? result.exitCode === undefined || result.exitCode === 0
    : result.success === true;
  return {
    success,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    message: String(result.message || result.error?.message || ''),
    code: result.code || result.error?.code,
    exitCode: result.exitCode,
    reason: result.reason || result.error?.reason,
    details: result.details || result.error?.details,
  };
};

const gitErrorText = (error) => [
  error?.stderr,
  error?.stdout,
  error?.message,
  error?.error?.message,
  error,
]
  .map((value) => String(value || '').trim())
  .filter(Boolean)
  .join('\n');

const gitErrorCode = (error) => String(
  error?.code
    || error?.error?.code
    || error?.details?.code
    || error?.details?.error?.code
    || '',
).toUpperCase();

const isExecutionFailure = (error) => {
  const code = gitErrorCode(error);
  if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') {
    return true;
  }
  return /access is denied|command not found|cannot execute|failed to spawn|no such file or directory|permission denied|spawn .*\b(?:eacces|enoent)\b/i.test(
    gitErrorText(error),
  );
};

const isConfirmedNonRepository = (error) => (
  !isExecutionFailure(error)
  && (
    error?.code === 'GIT_NOT_A_REPOSITORY'
    || error?.error?.code === 'GIT_NOT_A_REPOSITORY'
    || error?.details?.code === 'GIT_NOT_A_REPOSITORY'
    || error?.reason === 'not-a-repository'
    || error?.error?.reason === 'not-a-repository'
    || error?.details?.reason === 'not-a-repository'
    || /not a git repository|not inside (?:a )?work tree|this operation must be run in a work tree|outside repository/i.test(
      gitErrorText(error),
    )
  )
);

const createDiscoveryError = (result, cwd) => {
  const error = new Error(
    result?.message
      || result?.stderr
      || 'Failed to discover Git repository context',
  );
  if (result?.code !== undefined) {
    error.code = result.code;
  }
  if (result?.exitCode !== undefined) {
    error.exitCode = result.exitCode;
  }
  error.stdout = String(result?.stdout || '');
  error.stderr = String(result?.stderr || '');
  error.details = {
    operation: 'git-context-discovery',
    cwd,
    args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
    code: result?.code,
    exitCode: result?.exitCode,
    stdout: error.stdout,
    stderr: error.stderr,
  };
  return error;
};

const isPathWithin = (candidate, parent) => (
  candidate === parent || candidate.startsWith(`${parent}${path.sep}`)
);

const isPathIdentity = (value) => (
  typeof value === 'string'
  && value.length > 0
  && !/[\u0000\r\n]/.test(value)
  && path.isAbsolute(value)
);

const validateDiscoveryIdentity = (requestedDirectory, lines, context) => {
  if (!isPathIdentity(context.topLevel)
    || !isPathIdentity(context.gitDir)
    || !isPathIdentity(context.commonDir)) {
    return 'Git context discovery returned non-absolute repository identity';
  }

  if (!isPathWithin(requestedDirectory, context.topLevel)) {
    return 'Git context discovery returned a repository root outside the requested directory';
  }

  if (context.gitDir === context.topLevel || context.commonDir === context.topLevel) {
    return 'Git context discovery returned an invalid repository identity';
  }

  // `--git-common-dir` may be emitted relative to the discovery CWD by Git.
  // Keep accepting fully relative command output for compatibility, while
  // validating the normal absolute form as a coherent Git identity.
  const allLinesRelative = lines.every((line) => !path.isAbsolute(line));
  if (!allLinesRelative && (!path.isAbsolute(lines[0]) || !path.isAbsolute(lines[1]))) {
    return 'Git context discovery returned a non-absolute repository identity';
  }
  if (!allLinesRelative
    && !isPathWithin(context.gitDir, context.commonDir)
    && !isPathWithin(context.commonDir, context.gitDir)) {
    return 'Git context discovery returned unrelated Git and common directories';
  }

  return null;
};

const abortError = (signal) => new GitExecutionCancelledError(
  'Git context discovery was cancelled',
  { reason: signal?.reason },
);

const createQueue = (concurrency, maxPending) => {
  const pending = [];
  let active = 0;

  const drain = () => {
    while (active < concurrency && pending.length > 0) {
      const entry = pending.shift();
      if (entry.cancelled) {
        continue;
      }
      entry.started = true;
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(
          (value) => { entry.result = { success: true, value }; },
          (error) => { entry.result = { success: false, error }; },
        )
        .finally(() => {
          active -= 1;
          const result = entry.result;
          if (result?.success) {
            entry.resolve(result.value);
          } else {
            entry.reject(result?.error);
          }
          drain();
        });
    }
  };

  const enqueue = (task, signal) => {
    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }
    if (active >= concurrency && pending.length >= maxPending) {
      return Promise.reject(new GitExecutionOverloadedError(
        'Git discovery queue is overloaded',
        { active, pending: pending.length, maxPending },
      ));
    }

    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject, cancelled: false };
      let onAbort;
      if (signal) {
        onAbort = () => {
          if (entry.cancelled) {
            return;
          }
          if (entry.started) {
            // The task owns termination of an active process. Keep the queue
            // slot and promise until its close lifecycle completes.
            return;
          }
          entry.cancelled = true;
          const index = pending.indexOf(entry);
          if (index !== -1) {
            pending.splice(index, 1);
          }
          reject(abortError(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const resolveEntry = (value) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const rejectEntry = (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      };
      entry.resolve = resolveEntry;
      entry.reject = rejectEntry;
      pending.push(entry);
      drain();
    });
  };

  return {
    enqueue,
    getStats: () => ({ active, pending: pending.length }),
  };
};

export class GitContextResolver {
  constructor(options) {
    if (!options || typeof options.runGit !== 'function') {
      throw new TypeError('runGit is required');
    }

    this.runGit = options.runGit;
    this.realpath = options.realpath || ((value) => fsp.realpath(value));
    this.pathExists = options.pathExists || defaultPathExists;
    this.getPathFingerprint = options.getPathFingerprint || defaultPathFingerprint;
    this.discoveryConcurrency = Math.max(1, Math.floor(options.discoveryConcurrency ?? DEFAULTS.discoveryConcurrency));
    this.maxPendingDiscoveries = Math.max(0, Math.floor(options.maxPendingDiscoveries ?? DEFAULTS.maxPendingDiscoveries));
    this.maxInFlightAliases = Math.max(1, Math.floor(options.maxInFlightAliases ?? DEFAULTS.maxInFlightAliases));
    this.maxInFlightContexts = Math.max(1, Math.floor(options.maxInFlightContexts ?? DEFAULTS.maxInFlightContexts));
    this.discoveryTimeoutMs = Math.max(1, Math.floor(options.discoveryTimeoutMs ?? DEFAULTS.discoveryTimeoutMs));
    this.setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer || ((handle) => clearTimeout(handle));
    this.aliases = new Map();
    this.inFlightAliases = new Map();
    this.contexts = new Map();
    this.inFlightContexts = new Set();
    this.queue = createQueue(this.discoveryConcurrency, this.maxPendingDiscoveries);
  }

  async canonicalize(value) {
    const resolved = path.resolve(value);
    try {
      const real = await this.realpath(resolved);
      return path.resolve(String(real || resolved));
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return resolved;
      }
      throw error;
    }
  }

  evictContexts() {
    while (this.contexts.size > this.maxInFlightContexts) {
      const oldest = this.contexts.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.contexts.delete(oldest);
    }
  }

  rememberAlias(alias, context, fingerprint) {
    if (!fingerprint) {
      return;
    }
    this.aliases.delete(alias);
    this.aliases.set(alias, { context, fingerprint });
    while (this.aliases.size > this.maxInFlightAliases) {
      const oldest = this.aliases.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.aliases.delete(oldest);
    }
  }

  forgetContext(context) {
    for (const [alias, entry] of this.aliases) {
      if (entry.context === context) {
        this.aliases.delete(alias);
      }
    }
  }

  async discover(directory, requestedDirectory, signal) {
    let result;
    try {
      result = normalizeCommandResult(await this.queue.enqueue(
        () => this.runGit(
          directory,
          ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
          { signal },
        ),
        signal,
      ));
    } catch (error) {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      if (error instanceof GitExecutionCancelledError || error instanceof GitExecutionOverloadedError) {
        throw error;
      }
      if (isConfirmedNonRepository(error)) {
        return { isRepository: false, requestedDirectory, reason: 'not-a-repository' };
      }
      throw createDiscoveryError(error, directory);
    }
    if (signal?.aborted) {
      throw abortError(signal);
    }
    if (!result.success) {
      if (isConfirmedNonRepository(result)) {
        return { isRepository: false, requestedDirectory, reason: 'not-a-repository' };
      }
      throw createDiscoveryError(result, directory);
    }

    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length !== 3) {
      throw createDiscoveryError({
        message: 'Git context discovery returned incomplete output',
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
        exitCode: result.exitCode,
      }, directory);
    }

    const canonicalizeDiscoveredPath = async (value) => {
      try {
        const result = await this.canonicalize(path.isAbsolute(value)
          ? value
          : path.resolve(directory, value));
        if (signal?.aborted) {
          throw abortError(signal);
        }
        return result;
      } catch (error) {
        if (error instanceof GitExecutionCancelledError) {
          throw error;
        }
        throw createDiscoveryError(error, directory);
      }
    };
    const topLevel = await canonicalizeDiscoveredPath(lines[0]);
    const gitDir = await canonicalizeDiscoveredPath(lines[1]);
    const commonDir = await canonicalizeDiscoveredPath(lines[2]);
    const context = {
      isRepository: true,
      requestedDirectory,
      topLevel,
      gitDir,
      commonDir,
      commonId: commonDir,
      worktreeId: topLevel,
    };
    const identityError = validateDiscoveryIdentity(directory, lines, context);
    if (identityError) {
      throw createDiscoveryError({
        message: identityError,
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
        exitCode: result.exitCode,
      }, directory);
    }
    if (signal?.aborted) {
      throw abortError(signal);
    }
    const fingerprint = await this.getPathFingerprint(context);
    if (signal?.aborted) {
      throw abortError(signal);
    }
    this.contexts.set(`${context.commonId}\0${context.worktreeId}`, context);
    this.evictContexts();
    this.rememberAlias(directory, context, fingerprint);
    this.rememberAlias(topLevel, context, fingerprint);
    return context;
  }

  createDiscoveryEntry(canonicalDirectory, requestedDirectory) {
    const controller = new AbortController();
    const entry = {
      promise: null,
      controller,
      consumers: 0,
      settled: false,
      abortScheduled: false,
      abortTimer: undefined,
      timer: undefined,
    };

    this.inFlightContexts.add(canonicalDirectory);
    entry.promise = this.discover(canonicalDirectory, requestedDirectory, controller.signal)
      .finally(() => {
        entry.settled = true;
        if (entry.timer !== undefined) {
          this.clearTimer(entry.timer);
          entry.timer = undefined;
        }
        if (entry.abortTimer !== undefined) {
          this.clearTimer(entry.abortTimer);
          entry.abortTimer = undefined;
        }
        this.inFlightContexts.delete(canonicalDirectory);
        if (this.inFlightAliases.get(canonicalDirectory) === entry) {
          this.inFlightAliases.delete(canonicalDirectory);
        }
      });
    this.inFlightAliases.set(canonicalDirectory, entry);
    entry.timer = this.setTimer(() => {
      if (!entry.settled && !controller.signal.aborted) {
        controller.abort(new GitExecutionCancelledError(
          'Git context discovery timed out',
          { reason: 'timeout', timeoutMs: this.discoveryTimeoutMs },
        ));
      }
    }, this.discoveryTimeoutMs);
    entry.timer?.unref?.();
    return entry;
  }

  releaseDiscoveryConsumer(entry) {
    entry.consumers = Math.max(0, entry.consumers - 1);
    if (entry.consumers !== 0 || entry.settled || entry.abortScheduled) {
      return;
    }

    // Let resolve() calls already in their asynchronous path acquire the
    // shared entry before canceling its process. This preserves the shared
    // waiter contract without leaving an uncancelable race window.
    entry.abortScheduled = true;
    entry.abortTimer = this.setTimer(() => {
      entry.abortTimer = undefined;
      entry.abortScheduled = false;
      if (entry.consumers === 0 && !entry.settled && !entry.controller.signal.aborted) {
        entry.controller.abort(new GitExecutionCancelledError(
          'Git context discovery no longer has consumers',
          { reason: 'no-consumers' },
        ));
      }
    }, 0);
    entry.abortTimer?.unref?.();
  }

  waitForDiscovery(entry, signal) {
    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }

    entry.consumers += 1;
    if (entry.abortTimer !== undefined) {
      this.clearTimer(entry.abortTimer);
      entry.abortTimer = undefined;
      entry.abortScheduled = false;
    }
    if (!signal) {
      return entry.promise.finally(() => this.releaseDiscoveryConsumer(entry));
    }

    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        signal.removeEventListener('abort', onAbort);
        this.releaseDiscoveryConsumer(entry);
      };
      const onAbort = () => {
        release();
        reject(abortError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      entry.promise.then(
        (value) => {
          release();
          resolve(value);
        },
        (error) => {
          release();
          reject(error);
        },
      );
    });
  }

  resolve(directory, options = {}) {
    const requestedDirectory = normalizeDirectory(directory);
    if (options.signal?.aborted) {
      return Promise.reject(abortError(options.signal));
    }

    const resolveExistingDirectory = async () => this.canonicalize(requestedDirectory).catch((error) => {
      throw createDiscoveryError(error, requestedDirectory);
    }).then(async (canonicalDirectory) => {
      if (options.signal?.aborted) {
        throw abortError(options.signal);
      }
      const cachedEntry = this.aliases.get(canonicalDirectory);
      if (cachedEntry) {
        const fingerprint = await this.getPathFingerprint(cachedEntry.context).catch(() => null);
        if (fingerprint !== null && fingerprint === cachedEntry.fingerprint) {
          this.aliases.delete(canonicalDirectory);
          this.aliases.set(canonicalDirectory, cachedEntry);
          return cachedEntry.context;
        }
        this.forgetContext(cachedEntry.context);
      }

      const inFlight = this.inFlightAliases.get(canonicalDirectory);
      if (inFlight) {
        return this.waitForDiscovery(inFlight, options.signal);
      }
      if (this.inFlightAliases.size >= this.maxInFlightAliases) {
        throw new GitExecutionOverloadedError(
          'Git context alias capacity is exhausted',
          { maxInFlightAliases: this.maxInFlightAliases },
        );
      }
      if (this.inFlightContexts.size >= this.maxInFlightContexts) {
        throw new GitExecutionOverloadedError(
          'Git context discovery capacity is exhausted',
          { maxInFlightContexts: this.maxInFlightContexts },
        );
      }

      const discovery = this.createDiscoveryEntry(canonicalDirectory, requestedDirectory);
      return this.waitForDiscovery(discovery, options.signal);
    });

    return this.pathExists(requestedDirectory).then((exists) => {
      if (options.signal?.aborted) {
        throw abortError(options.signal);
      }
      if (!exists) {
        return { isRepository: false, requestedDirectory, reason: 'not-a-repository' };
      }
      return resolveExistingDirectory();
    });
  }

  getStats() {
    const discovery = this.queue.getStats();
    return {
      inFlightAliases: this.inFlightAliases.size,
      maxInFlightAliases: this.maxInFlightAliases,
      inFlightContexts: this.inFlightContexts.size,
      maxInFlightContexts: this.maxInFlightContexts,
      discovery: {
        ...discovery,
        concurrency: this.discoveryConcurrency,
        maxPending: this.maxPendingDiscoveries,
        timeoutMs: this.discoveryTimeoutMs,
      },
    };
  }
}

export const createGitContextResolver = (options) => new GitContextResolver(options);
