import fs from 'node:fs';
import nodePath from 'node:path';

import {
  GitExecutionCancelledError,
  GitExecutionOverloadedError,
} from './execution-errors.js';

const GIT_CONTEXT_DISCOVERY_ARGS = Object.freeze([
  'rev-parse',
  '--show-toplevel',
  '--absolute-git-dir',
  '--git-common-dir',
]);

const DEFAULT_GIT_CONTEXT_LIMITS = Object.freeze({
  discoveryConcurrency: 2,
  maxPendingDiscoveries: 2048,
  maxInFlightAliases: 2048,
  maxInFlightContexts: 2048,
});

const asPositiveInteger = (value, fallback, name) => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
};

const gitErrorText = (error) => [error?.stderr, error?.stdout, error?.message]
  .map((value) => String(value || '').trim())
  .filter(Boolean)
  .join('\n');

const isConfirmedNonRepositoryError = (error) => (
  /not a git repository|not inside (?:a )?work tree|outside repository/i.test(gitErrorText(error))
);

const createDiscoveryError = (result) => {
  const error = new Error(result?.message || result?.stderr || 'Failed to discover Git repository context');
  error.exitCode = result?.exitCode;
  error.stdout = String(result?.stdout || '');
  error.stderr = String(result?.stderr || '');
  return error;
};

const waitForSharedPromise = (promise, signal, label) => {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new GitExecutionCancelledError(`${label} was cancelled`));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new GitExecutionCancelledError(`${label} was cancelled`));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

class BoundedDiscoveryPool {
  constructor({ concurrency, maxPending }) {
    this.concurrency = concurrency;
    this.maxPending = maxPending;
    this.active = 0;
    this.pending = [];
  }

  run(task) {
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject };
      if (this.active < this.concurrency) {
        this.start(item);
        return;
      }
      if (this.pending.length >= this.maxPending) {
        reject(new GitExecutionOverloadedError('Git context discovery queue is full', {
          limit: this.maxPending,
          scope: 'discovery-queue',
        }));
        return;
      }
      this.pending.push(item);
    });
  }

  start(item) {
    this.active += 1;
    Promise.resolve()
      .then(item.task)
      .then(
        (value) => {
          this.finish();
          item.resolve(value);
        },
        (error) => {
          this.finish();
          item.reject(error);
        },
      );
  }

  finish() {
    this.active -= 1;
    const next = this.pending.shift();
    if (next) {
      this.start(next);
    }
  }

  getStats() {
    return {
      active: this.active,
      pending: this.pending.length,
      concurrency: this.concurrency,
      maxPending: this.maxPending,
    };
  }
}

const normalizeRunResult = async (runGit, cwd) => {
  try {
    const result = await runGit(cwd, [...GIT_CONTEXT_DISCOVERY_ARGS]);
    if (typeof result === 'string' || Buffer.isBuffer(result)) {
      return { success: true, stdout: String(result) };
    }
    if (result?.success === false) {
      const error = createDiscoveryError(result);
      if (isConfirmedNonRepositoryError(error)) {
        return { success: false, confirmedNonRepository: true };
      }
      throw error;
    }
    return { success: true, stdout: String(result?.stdout || '') };
  } catch (error) {
    if (isConfirmedNonRepositoryError(error)) {
      return { success: false, confirmedNonRepository: true };
    }
    throw error;
  }
};

const parseDiscoveryOutput = (stdout) => {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) {
    throw new Error('Git context discovery returned incomplete output');
  }
  return {
    topLevel: lines[0],
    gitDir: lines[1],
    commonDir: lines[2],
  };
};

export class GitContextResolver {
  constructor({
    runGit,
    realpath = fs.promises.realpath,
    pathImpl = nodePath,
    platform = process.platform,
    discoveryConcurrency = DEFAULT_GIT_CONTEXT_LIMITS.discoveryConcurrency,
    maxPendingDiscoveries = DEFAULT_GIT_CONTEXT_LIMITS.maxPendingDiscoveries,
    maxInFlightAliases = DEFAULT_GIT_CONTEXT_LIMITS.maxInFlightAliases,
    maxInFlightContexts = DEFAULT_GIT_CONTEXT_LIMITS.maxInFlightContexts,
  } = {}) {
    if (typeof runGit !== 'function') {
      throw new TypeError('runGit is required');
    }
    if (typeof realpath !== 'function') {
      throw new TypeError('realpath must be a function');
    }

    this.runGit = runGit;
    this.realpath = realpath;
    this.path = pathImpl;
    this.platform = platform;
    this.maxInFlightAliases = asPositiveInteger(
      maxInFlightAliases,
      DEFAULT_GIT_CONTEXT_LIMITS.maxInFlightAliases,
      'maxInFlightAliases',
    );
    this.maxInFlightContexts = asPositiveInteger(
      maxInFlightContexts,
      DEFAULT_GIT_CONTEXT_LIMITS.maxInFlightContexts,
      'maxInFlightContexts',
    );
    this.pool = new BoundedDiscoveryPool({
      concurrency: asPositiveInteger(
        discoveryConcurrency,
        DEFAULT_GIT_CONTEXT_LIMITS.discoveryConcurrency,
        'discoveryConcurrency',
      ),
      maxPending: asPositiveInteger(
        maxPendingDiscoveries,
        DEFAULT_GIT_CONTEXT_LIMITS.maxPendingDiscoveries,
        'maxPendingDiscoveries',
      ),
    });
    this.inFlight = new Map();
    this.canonicalInFlight = new Map();
  }

  normalizeIdentity(value) {
    const normalized = this.path.normalize(value);
    return this.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  async canonicalizeInput(absoluteInput) {
    try {
      return this.path.normalize(await this.realpath(absoluteInput));
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return this.path.normalize(absoluteInput);
      }
      throw error;
    }
  }

  async canonicalizeDiscoveredPath(value, cwd) {
    const absolute = this.path.isAbsolute(value)
      ? this.path.resolve(value)
      : this.path.resolve(cwd, value);
    return this.path.normalize(await this.realpath(absolute));
  }

  discoverCanonical(requestedDirectory) {
    const canonicalKey = this.normalizeIdentity(requestedDirectory);
    const existing = this.canonicalInFlight.get(canonicalKey);
    if (existing) {
      return existing;
    }
    if (this.canonicalInFlight.size >= this.maxInFlightContexts) {
      return Promise.reject(new GitExecutionOverloadedError('Too many canonical Git contexts are being discovered', {
        limit: this.maxInFlightContexts,
        scope: 'canonical-discoveries',
      }));
    }

    const shared = (async () => {
      const discovery = await normalizeRunResult(this.runGit, requestedDirectory);
      if (discovery.confirmedNonRepository) {
        return {
          isRepository: false,
          requestedDirectory,
          reason: 'not-a-repository',
        };
      }

      const parsed = parseDiscoveryOutput(discovery.stdout);
      const [topLevel, gitDir, commonDir] = await Promise.all([
        this.canonicalizeDiscoveredPath(parsed.topLevel, requestedDirectory),
        this.canonicalizeDiscoveredPath(parsed.gitDir, requestedDirectory),
        this.canonicalizeDiscoveredPath(parsed.commonDir, requestedDirectory),
      ]);
      const commonId = this.normalizeIdentity(commonDir);
      const gitDirId = this.normalizeIdentity(gitDir);
      const topLevelId = this.normalizeIdentity(topLevel);

      return {
        isRepository: true,
        requestedDirectory,
        topLevel,
        gitDir,
        commonDir,
        commonId,
        worktreeId: JSON.stringify([gitDirId, topLevelId]),
      };
    })();

    this.canonicalInFlight.set(canonicalKey, shared);
    const clear = () => {
      if (this.canonicalInFlight.get(canonicalKey) === shared) {
        this.canonicalInFlight.delete(canonicalKey);
      }
    };
    shared.then(clear, clear);
    return shared;
  }

  resolve(directory, { signal } = {}) {
    if (typeof directory !== 'string' || !directory.trim()) {
      return Promise.reject(new TypeError('directory is required for Git context discovery'));
    }
    if (signal?.aborted) {
      return Promise.reject(new GitExecutionCancelledError('Git context discovery was cancelled'));
    }

    const absoluteInput = this.path.resolve(directory.trim());
    const aliasKey = this.normalizeIdentity(absoluteInput);
    const existing = this.inFlight.get(aliasKey);
    if (existing) {
      return waitForSharedPromise(existing, signal, 'Git context discovery');
    }
    if (this.inFlight.size >= this.maxInFlightAliases) {
      return Promise.reject(new GitExecutionOverloadedError('Too many Git context aliases are being discovered', {
        limit: this.maxInFlightAliases,
        scope: 'discovery-aliases',
      }));
    }

    const shared = this.pool.run(async () => {
      const requestedDirectory = await this.canonicalizeInput(absoluteInput);
      return this.discoverCanonical(requestedDirectory);
    });

    this.inFlight.set(aliasKey, shared);
    const clear = () => {
      if (this.inFlight.get(aliasKey) === shared) {
        this.inFlight.delete(aliasKey);
      }
    };
    shared.then(clear, clear);
    return waitForSharedPromise(shared, signal, 'Git context discovery');
  }

  getStats() {
    return {
      inFlightAliases: this.inFlight.size,
      maxInFlightAliases: this.maxInFlightAliases,
      inFlightContexts: this.canonicalInFlight.size,
      maxInFlightContexts: this.maxInFlightContexts,
      discovery: this.pool.getStats(),
    };
  }
}

export const createGitContextResolver = (options) => new GitContextResolver(options);
