import fs from 'node:fs';
import path from 'node:path';

import { execGit as execGitPrimitive, type ExecGitOptions, type ExecGitResult } from './bridge-git-process-runtime';
import {
  createGitContextResolver,
  type GitContextResolver,
  type GitResolvedContext,
} from './git-context-resolver';
import {
  createGitExecutionCoordinator,
  GIT_OPERATION_KIND,
  GIT_READ_ONLY_ENV,
  type GitCloneLease,
  type GitExecutionContext,
  type GitExecutionCoordinator,
  type GitExecutionLease,
} from './git-execution-coordinator';
import {
  GIT_NETWORK_USAGE,
  GIT_OPERATION_PROFILE,
  getGitOperationClassification,
  getGitServiceOperationClassification,
  type GitInternalOperationName,
  type GitOperationClassification,
  type GitServiceOperationName,
} from './git-operation-classification';
import { isGitExecutionError } from './git-execution-errors';

type GitPrimitive = (args: string[], cwd: string, options?: ExecGitOptions) => Promise<ExecGitResult>;

type RuntimeOperationOptions = {
  network?: boolean;
  signal?: AbortSignal;
  queueTimeoutMs?: number;
  lease?: GitExecutionLease;
};

type RuntimeStatusOptions = {
  shape?: 'full' | 'light';
  signal?: AbortSignal;
  queueTimeoutMs?: number;
};

type GitExecutionRuntimeOptions = {
  executeGit?: GitPrimitive;
  resolver?: GitContextResolver;
  coordinator?: GitExecutionCoordinator;
  realpath?: (value: string) => Promise<string>;
  pathImpl?: typeof path;
  platform?: NodeJS.Platform;
};

const profileToCoordinatorOptions = (classification: GitOperationClassification) => {
  switch (classification.profile) {
    case GIT_OPERATION_PROFILE.READ:
      return { kind: GIT_OPERATION_KIND.READ, targetWorktree: false } as const;
    case GIT_OPERATION_PROFILE.WORKTREE_WRITE:
      return { kind: GIT_OPERATION_KIND.WORKTREE_WRITE, targetWorktree: false } as const;
    case GIT_OPERATION_PROFILE.COMMON_WRITE:
      return { kind: GIT_OPERATION_KIND.COMMON_WRITE, targetWorktree: false } as const;
    case GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE:
      return { kind: GIT_OPERATION_KIND.COMMON_WRITE, targetWorktree: true } as const;
    case GIT_OPERATION_PROFILE.TOPOLOGY_WRITE:
      return { kind: GIT_OPERATION_KIND.TOPOLOGY_WRITE, targetWorktree: false } as const;
    default:
      throw new TypeError(`Git operation profile ${classification.profile} does not acquire a repository lease`);
  }
};

const resolveNetwork = (classification: GitOperationClassification, requested: boolean | undefined): boolean => {
  if (classification.network === GIT_NETWORK_USAGE.REQUIRED) return true;
  if (classification.network === GIT_NETWORK_USAGE.CONDITIONAL) return requested === true;
  return false;
};

class GitExecutionRuntime {
  readonly resolver: GitContextResolver;
  readonly coordinator: GitExecutionCoordinator;
  private readonly executeGit: GitPrimitive;
  private readonly realpath: (value: string) => Promise<string>;
  private readonly path: typeof path;
  private readonly platform: NodeJS.Platform;

  constructor({
    executeGit = execGitPrimitive,
    resolver,
    coordinator = createGitExecutionCoordinator(),
    realpath = fs.promises.realpath,
    pathImpl = path,
    platform = process.platform,
  }: GitExecutionRuntimeOptions = {}) {
    this.executeGit = executeGit;
    this.realpath = realpath;
    this.path = pathImpl;
    this.platform = platform;
    this.resolver = resolver ?? createGitContextResolver({
      realpath,
      pathImpl,
      platform,
      runGit: async (cwd, args) => {
        const result = await executeGit(args, cwd, { env: GIT_READ_ONLY_ENV });
        return {
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
    });
    this.coordinator = coordinator;
  }

  discover(directory: string, options: { signal?: AbortSignal } = {}): Promise<GitResolvedContext> {
    return this.resolver.resolve(directory, options);
  }

  private normalizeIdentity(value: string): string {
    const normalized = this.path.normalize(value);
    return this.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  private async unresolvedContext(directory: string, commonIdHint?: string): Promise<GitExecutionContext> {
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new TypeError('directory is required for Git execution');
    }
    const absolute = this.path.resolve(directory.trim());
    const canonical = await this.realpath(absolute).catch(() => absolute);
    const identity = this.normalizeIdentity(canonical);
    const commonId = commonIdHint || `unresolved:${identity}`;
    return {
      isRepository: true,
      commonId,
      worktreeId: JSON.stringify([`unresolved-git-dir:${identity}`, identity]),
    };
  }

  async resolveExecutionContext(directory: string, options: { signal?: AbortSignal } = {}): Promise<GitExecutionContext> {
    try {
      const context = await this.discover(directory, options);
      if (context.isRepository) return context;
    } catch (error) {
      if (isGitExecutionError(error)) {
        throw error;
      }
      // The existing VS Code service may still succeed through the built-in Git
      // extension even when PATH-based discovery fails. Preserve that behavior
      // while bounding the call under a canonical directory-local fallback key.
    }
    return this.unresolvedContext(directory);
  }

  private runClassifiedInContext<T>(
    classification: GitOperationClassification,
    label: string,
    context: GitExecutionContext,
    task: (lease: GitExecutionLease) => Promise<T> | T,
    options: RuntimeOperationOptions = {},
  ): Promise<T> {
    const profile = profileToCoordinatorOptions(classification);
    return this.coordinator.run({
      context,
      kind: profile.kind,
      targetWorktree: profile.targetWorktree,
      network: resolveNetwork(classification, options.network),
      label,
      signal: options.signal,
      queueTimeoutMs: options.queueTimeoutMs,
      lease: options.lease,
    }, task);
  }

  private async runClassified<T>(
    classification: GitOperationClassification,
    label: string,
    directory: string,
    task: (lease: GitExecutionLease) => Promise<T> | T,
    options: RuntimeOperationOptions = {},
  ): Promise<T> {
    const context = await this.resolveExecutionContext(directory, { signal: options.signal });
    return this.runClassifiedInContext(classification, label, context, task, options);
  }

  runServiceOperation<T>(
    operationName: GitServiceOperationName,
    directory: string,
    task: (lease: GitExecutionLease) => Promise<T> | T,
    options: RuntimeOperationOptions = {},
  ): Promise<T> {
    const classification = getGitServiceOperationClassification(operationName);
    return this.runClassified(classification, `VS Code Git ${operationName}`, directory, task, options);
  }

  runInternalOperation<T>(
    operationName: GitInternalOperationName,
    directory: string,
    task: (lease: GitExecutionLease) => Promise<T> | T,
    options: RuntimeOperationOptions = {},
  ): Promise<T> {
    const classification = getGitOperationClassification(operationName);
    return this.runClassified(classification, `VS Code Git ${operationName}`, directory, task, options);
  }

  runInternalOperationInContext<T>(
    operationName: GitInternalOperationName,
    context: GitExecutionContext,
    task: (lease: GitExecutionLease) => Promise<T> | T,
    options: RuntimeOperationOptions = {},
  ): Promise<T> {
    const classification = getGitOperationClassification(operationName);
    return this.runClassifiedInContext(
      classification,
      `VS Code Git ${operationName}`,
      context,
      task,
      options,
    );
  }

  async runInternalOperationWithCommonFallback<T>(
    operationName: GitInternalOperationName,
    directory: string,
    commonIdHint: string,
    task: (lease: GitExecutionLease) => Promise<T> | T,
    options: RuntimeOperationOptions = {},
  ): Promise<T> {
    let context: GitExecutionContext;
    let usedFallback = false;
    try {
      const discovered = await this.discover(directory, { signal: options.signal });
      if (discovered.isRepository) {
        context = discovered;
      } else {
        usedFallback = true;
        context = await this.unresolvedContext(directory, commonIdHint);
      }
    } catch (error) {
      if (isGitExecutionError(error)) throw error;
      usedFallback = true;
      context = await this.unresolvedContext(directory, commonIdHint);
    }

    const declared = getGitOperationClassification(operationName);
    const classification = usedFallback && declared.profile === GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE
      ? { ...declared, profile: GIT_OPERATION_PROFILE.TOPOLOGY_WRITE }
      : declared;
    return this.runClassifiedInContext(
      classification,
      `VS Code Git ${operationName}`,
      context,
      task,
      options,
    );
  }

  async runStatus<T>(
    directory: string,
    task: (shape: 'full' | 'light') => Promise<T> | T,
    options: RuntimeStatusOptions = {},
  ): Promise<T> {
    const context = await this.resolveExecutionContext(directory, { signal: options.signal });
    return this.coordinator.runStatus<T>({
      context,
      shape: options.shape,
      signal: options.signal,
      queueTimeoutMs: options.queueTimeoutMs,
      label: 'VS Code Git status',
    }, task);
  }

  async withRawRead<T>(
    directory: string,
    task: (executeRead: (args: string[]) => Promise<ExecGitResult>, lease: GitExecutionLease) => Promise<T> | T,
    options: Omit<RuntimeOperationOptions, 'network'> = {},
  ): Promise<T> {
    return this.runServiceOperation('getGitStatus', directory, (lease) => task(
      (args) => this.executeGit(args, directory, { env: GIT_READ_ONLY_ENV }),
      lease,
    ), options);
  }

  async runDirectoryFallbackRead<T>(directory: string, task: () => Promise<T> | T): Promise<T> {
    const context = await this.unresolvedContext(directory);
    return this.coordinator.run({
      context,
      kind: GIT_OPERATION_KIND.READ,
      label: 'VS Code Git bootstrap fallback',
    }, task);
  }

  runRawObservation(args: string[], directory: string): Promise<ExecGitResult> {
    return this.withRawRead(directory, (executeRead) => executeRead(args));
  }

  runClone<T>(
    destination: string,
    task: (lease: GitCloneLease) => Promise<T> | T,
    options: Omit<RuntimeOperationOptions, 'network' | 'lease'> = {},
  ): Promise<T> {
    return this.coordinator.runClone({
      destination,
      label: 'VS Code Git clone',
      signal: options.signal,
      queueTimeoutMs: options.queueTimeoutMs,
    }, task);
  }

  getStats() {
    return {
      resolver: this.resolver.getStats(),
      coordinator: this.coordinator.getStats(),
    };
  }
}

export const createGitExecutionRuntime = (options: GitExecutionRuntimeOptions = {}): GitExecutionRuntime => (
  new GitExecutionRuntime(options)
);

export const gitExecutionRuntime = createGitExecutionRuntime();

export const runGitObservation = (args: string[], cwd: string): Promise<ExecGitResult> => (
  gitExecutionRuntime.runRawObservation(args, cwd)
);

export const withGitRawRead = <T>(
  cwd: string,
  task: (executeRead: (args: string[]) => Promise<ExecGitResult>) => Promise<T> | T,
): Promise<T> => gitExecutionRuntime.withRawRead(cwd, task);

export const withGitCloneReservation = <T>(
  destination: string,
  task: (lease: GitCloneLease) => Promise<T> | T,
): Promise<T> => gitExecutionRuntime.runClone(destination, task);
