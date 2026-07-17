import fs from 'node:fs';
import path from 'node:path';

import {
  GitExecutionCancelledError,
  GitExecutionOverloadedError,
} from './git-execution-errors';

const GIT_CONTEXT_DISCOVERY_ARGS = Object.freeze([
  'rev-parse',
  '--show-toplevel',
  '--absolute-git-dir',
  '--git-common-dir',
] as const);

const DEFAULT_GIT_CONTEXT_LIMITS = Object.freeze({
  discoveryConcurrency: 2,
  maxPendingDiscoveries: 2048,
  maxInFlightAliases: 2048,
  maxInFlightContexts: 2048,
});

type GitDiscoveryCommandResult = {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  message?: string;
};

type GitRepositoryContext = {
  isRepository: true;
  requestedDirectory: string;
  topLevel: string;
  gitDir: string;
  commonDir: string;
  commonId: string;
  worktreeId: string;
};

type GitNonRepositoryContext = {
  isRepository: false;
  requestedDirectory: string;
  reason: 'not-a-repository';
};

export type GitResolvedContext = GitRepositoryContext | GitNonRepositoryContext;

type GitContextResolverOptions = {
  runGit: (
    cwd: string,
    args: string[],
  ) => Promise<GitDiscoveryCommandResult | string | Buffer>;
  realpath?: (value: string) => Promise<string>;
  pathImpl?: typeof path;
  platform?: NodeJS.Platform;
  discoveryConcurrency?: number;
  maxPendingDiscoveries?: number;
  maxInFlightAliases?: number;
  maxInFlightContexts?: number;
};

type ResolveOptions = {
  signal?: AbortSignal;
};

const asPositiveInteger = (value: number | undefined, fallback: number, name: string): number => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
};

const gitErrorText = (error: unknown): string => {
  const candidate = error as { stderr?: unknown; stdout?: unknown; message?: unknown } | null;
  return [candidate?.stderr, candidate?.stdout, candidate?.message]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n');
};

const isConfirmedNonRepositoryError = (error: unknown): boolean => (
  /not a git repository|not inside (?:a )?work tree|outside repository/i.test(gitErrorText(error))
);

const createDiscoveryError = (result: GitDiscoveryCommandResult): Error & GitDiscoveryCommandResult => {
  const error = new Error(result.message || result.stderr || 'Failed to discover Git repository context') as Error & GitDiscoveryCommandResult;
  error.exitCode = result.exitCode;
  error.stdout = String(result.stdout || '');
  error.stderr = String(result.stderr || '');
  return error;
};

const waitForSharedPromise = <T>(promise: Promise<T>, signal: AbortSignal | undefined, label: string): Promise<T> => {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new GitExecutionCancelledError(`${label} was cancelled`));
  }

  return new Promise<T>((resolve, reject) => {
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
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

type DiscoveryItem<T> = {
  task: () => Promise<T> | T;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

class BoundedDiscoveryPool {
  private readonly concurrency: number;
  private readonly maxPending: number;
  private active = 0;
  private readonly pending: DiscoveryItem<unknown>[] = [];

  constructor({ concurrency, maxPending }: { concurrency: number; maxPending: number }) {
    this.concurrency = concurrency;
    this.maxPending = maxPending;
  }

  run<T>(task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: DiscoveryItem<T> = { task, resolve, reject };
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
      this.pending.push(item as DiscoveryItem<unknown>);
    });
  }

  private start<T>(item: DiscoveryItem<T>): void {
    this.active += 1;
    Promise.resolve()
      .then(item.task)
      .then(
        (value) => {
          this.finish();
          item.resolve(value);
        },
        (error: unknown) => {
          this.finish();
          item.reject(error);
        },
      );
  }

  private finish(): void {
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

const normalizeRunResult = async (
  runGit: GitContextResolverOptions['runGit'],
  cwd: string,
): Promise<{ success: true; stdout: string } | { success: false; confirmedNonRepository: true }> => {
  try {
    const result = await runGit(cwd, [...GIT_CONTEXT_DISCOVERY_ARGS]);
    if (typeof result === 'string' || Buffer.isBuffer(result)) {
      return { success: true, stdout: String(result) };
    }
    if (result.success === false) {
      const error = createDiscoveryError(result);
      if (isConfirmedNonRepositoryError(error)) {
        return { success: false, confirmedNonRepository: true };
      }
      throw error;
    }
    return { success: true, stdout: String(result.stdout || '') };
  } catch (error) {
    if (isConfirmedNonRepositoryError(error)) {
      return { success: false, confirmedNonRepository: true };
    }
    throw error;
  }
};

const parseDiscoveryOutput = (stdout: string) => {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) {
    throw new Error('Git context discovery returned incomplete output');
  }
  return {
    topLevel: lines[0]!,
    gitDir: lines[1]!,
    commonDir: lines[2]!,
  };
};

export class GitContextResolver {
  private readonly runGit: GitContextResolverOptions['runGit'];
  private readonly realpath: (value: string) => Promise<string>;
  private readonly path: typeof path;
  private readonly platform: NodeJS.Platform;
  private readonly maxInFlightAliases: number;
  private readonly maxInFlightContexts: number;
  private readonly pool: BoundedDiscoveryPool;
  private readonly inFlight = new Map<string, Promise<GitResolvedContext>>();
  private readonly canonicalInFlight = new Map<string, Promise<GitResolvedContext>>();

  constructor({
    runGit,
    realpath = fs.promises.realpath,
    pathImpl = path,
    platform = process.platform,
    discoveryConcurrency = DEFAULT_GIT_CONTEXT_LIMITS.discoveryConcurrency,
    maxPendingDiscoveries = DEFAULT_GIT_CONTEXT_LIMITS.maxPendingDiscoveries,
    maxInFlightAliases = DEFAULT_GIT_CONTEXT_LIMITS.maxInFlightAliases,
    maxInFlightContexts = DEFAULT_GIT_CONTEXT_LIMITS.maxInFlightContexts,
  }: GitContextResolverOptions) {
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
  }

  private normalizeIdentity(value: string): string {
    const normalized = this.path.normalize(value);
    return this.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  private async canonicalizeInput(absoluteInput: string): Promise<string> {
    try {
      return this.path.normalize(await this.realpath(absoluteInput));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return this.path.normalize(absoluteInput);
      }
      throw error;
    }
  }

  private async canonicalizeDiscoveredPath(value: string, cwd: string): Promise<string> {
    const absolute = this.path.isAbsolute(value)
      ? this.path.resolve(value)
      : this.path.resolve(cwd, value);
    return this.path.normalize(await this.realpath(absolute));
  }

  private discoverCanonical(requestedDirectory: string): Promise<GitResolvedContext> {
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

    const shared = (async (): Promise<GitResolvedContext> => {
      const discovery = await normalizeRunResult(this.runGit, requestedDirectory);
      if (!discovery.success) {
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

  resolve(directory: string, { signal }: ResolveOptions = {}): Promise<GitResolvedContext> {
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

export const createGitContextResolver = (options: GitContextResolverOptions): GitContextResolver => (
  new GitContextResolver(options)
);
