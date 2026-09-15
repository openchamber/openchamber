import { execGit } from './bridge-git-process-runtime';
import {
  createGitContextResolver,
} from './git-context-resolver';
import {
  createGitExecutionCoordinator,
  GIT_OPERATION_KIND,
} from './git-execution-coordinator';
import type {
  GitExecutionContext,
  GitExecutionCoordinator,
  GitExecutionLease,
  GitOperationKind,
  GitStatusShape,
} from './git-execution-coordinator';
import {
  getGitOperationClassification,
  GIT_OPERATION_PROFILE,
} from './git-operation-classification';
import type { GitOperationClassification } from './git-operation-classification';
import {
  runWithGitExecutionScope,
} from './git-execution-scope';
import type {
  GitContextResolver,
  GitResolvedContext,
} from './git-context-resolver';

type OperationOptions = {
  network?: boolean;
  signal?: AbortSignal;
  queueTimeoutMs?: number;
  lease?: GitExecutionLease;
};

type GitExecutionRuntimeOptions = {
  coordinator?: GitExecutionCoordinator;
  resolver?: GitContextResolver;
};

const profileToKind = (classification: GitOperationClassification): GitOperationKind => {
  switch (classification.profile) {
    case GIT_OPERATION_PROFILE.READ:
      return GIT_OPERATION_KIND.READ;
    case GIT_OPERATION_PROFILE.WORKTREE_WRITE:
      return GIT_OPERATION_KIND.WORKTREE_WRITE;
    case GIT_OPERATION_PROFILE.TOPOLOGY_WRITE:
      return GIT_OPERATION_KIND.TOPOLOGY_WRITE;
    case GIT_OPERATION_PROFILE.BOOTSTRAP:
    case GIT_OPERATION_PROFILE.MEMORY:
    case GIT_OPERATION_PROFILE.COMMON_WRITE:
    case GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE:
      return GIT_OPERATION_KIND.COMMON_WRITE;
    default:
      return GIT_OPERATION_KIND.COMMON_WRITE;
  }
};

const fallbackLease = (context: GitExecutionContext, kind: GitOperationKind): GitExecutionLease => ({
  commonId: context.commonId,
  worktreeId: context.worktreeId,
  kind,
  targetWorktree: kind !== GIT_OPERATION_KIND.COMMON_WRITE,
  network: false,
  active: true,
});

const isGitDiscoveryExecutableUnavailable = (error: unknown): boolean => {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
    return false;
  }
  if (!('details' in error) || !error.details || typeof error.details !== 'object') {
    return false;
  }
  return 'operation' in error.details && error.details.operation === 'git-context-discovery';
};

const fallbackContext = (directory: string): GitExecutionContext => ({
  isRepository: true,
  commonId: directory,
  worktreeId: directory,
});

export const createGitExecutionRuntime = (options: GitExecutionRuntimeOptions = {}) => {
  const coordinator = options.coordinator || createGitExecutionCoordinator();
  const resolver = options.resolver || createGitContextResolver({
    runGit: async (cwd, args, options = {}) => {
      const result = await runWithGitExecutionScope(true, () => execGit(args, cwd, {
        signal: options.signal,
      }));
      return {
        success: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        code: result.code,
      };
    },
  });

  const discover = (directory: string, resolveOptions?: { signal?: AbortSignal }): Promise<GitResolvedContext> => (
    resolver.resolve(directory, resolveOptions)
  );

  const runServiceOperation = async <T>(
    operationName: string,
    directory: string,
    task: (lease: GitExecutionLease) => Promise<T> | T,
    operationOptions: OperationOptions = {},
  ): Promise<T> => {
    const classification = getGitOperationClassification(operationName);
    const kind = profileToKind(classification);
    let context: GitResolvedContext;
    try {
      context = await discover(directory, { signal: operationOptions.signal });
    } catch (error) {
      if (!isGitDiscoveryExecutableUnavailable(error)) {
        throw error;
      }
      return runWithGitExecutionScope(kind === GIT_OPERATION_KIND.READ, () => task(
        fallbackLease(fallbackContext(directory), kind),
      ));
    }
    if (!context.isRepository) {
      return runWithGitExecutionScope(kind === GIT_OPERATION_KIND.READ, () => task(
        fallbackLease({
          isRepository: true,
          commonId: context.requestedDirectory,
          worktreeId: context.requestedDirectory,
        }, kind),
      ));
    }
    return coordinator.run({
      context,
      kind,
      targetWorktree: kind !== GIT_OPERATION_KIND.COMMON_WRITE,
      network: operationOptions.network ?? classification.network === 'required',
      lease: operationOptions.lease,
      signal: operationOptions.signal,
      queueTimeoutMs: operationOptions.queueTimeoutMs,
      label: operationName,
    }, (lease) => runWithGitExecutionScope(kind === GIT_OPERATION_KIND.READ, () => task(lease)));
  };

  const runStatus = async <T, R = T>(
    directory: string,
    task: (shape: GitStatusShape, signal?: AbortSignal) => Promise<T> | T,
    options: {
      shape?: GitStatusShape;
      signal?: AbortSignal;
      queueTimeoutMs?: number;
      projectResult?: (value: T, requestedShape: GitStatusShape, sourceShape: GitStatusShape) => R;
    } = {},
  ): Promise<R> => {
    const requestedShape = options.shape === 'light' ? 'light' : 'full';
    let context: GitResolvedContext;
    try {
      context = await discover(directory, { signal: options.signal });
    } catch (error) {
      if (!isGitDiscoveryExecutableUnavailable(error)) {
        throw error;
      }
      const value = await runWithGitExecutionScope(true, () => task(requestedShape, options.signal));
      return typeof options.projectResult === 'function'
        ? options.projectResult(value, requestedShape, requestedShape)
        : value as R;
    }
    if (!context.isRepository) {
      const value = await runWithGitExecutionScope(true, () => task(requestedShape, options.signal));
      return typeof options.projectResult === 'function'
        ? options.projectResult(value, requestedShape, requestedShape)
        : value as R;
    }
    return coordinator.runStatus({
      context,
      shape: requestedShape,
      signal: options.signal,
      queueTimeoutMs: options.queueTimeoutMs,
      projectResult: options.projectResult,
      label: `status:${requestedShape}`,
    }, (sourceShape, sourceSignal) => runWithGitExecutionScope(true, () => task(sourceShape, sourceSignal)));
  };

  const runDirectoryFallbackRead = <T>(directory: string, task: () => Promise<T> | T): Promise<T> => (
    runWithGitExecutionScope(true, task)
  );

  const runInternalOperationInContext = <T>(
    operationName: string,
    context: GitExecutionContext,
    task: () => Promise<T> | T,
    operationOptions: OperationOptions = {},
  ): Promise<T> => {
    const classification = getGitOperationClassification(operationName);
    const kind = profileToKind(classification);
    return coordinator.run({
      context,
      kind,
      network: operationOptions.network ?? classification.network === 'required',
      lease: operationOptions.lease,
      signal: operationOptions.signal,
      queueTimeoutMs: operationOptions.queueTimeoutMs,
      label: operationName,
    }, () => runWithGitExecutionScope(kind === GIT_OPERATION_KIND.READ, task));
  };

  const runInternalOperationWithCommonFallback = <T>(
    operationName: string,
    contextDirectory: string,
    commonId: string,
    task: () => Promise<T> | T,
    operationOptions: OperationOptions = {},
  ): Promise<T> => {
    const classification = getGitOperationClassification(operationName);
    const kind = profileToKind(classification);
    const context: GitExecutionContext = {
      isRepository: true,
      commonId,
      worktreeId: contextDirectory,
    };
    return coordinator.run({
      context,
      kind,
      network: operationOptions.network ?? classification.network === 'required',
      signal: operationOptions.signal,
      queueTimeoutMs: operationOptions.queueTimeoutMs,
      label: operationName,
    }, () => runWithGitExecutionScope(kind === GIT_OPERATION_KIND.READ, task));
  };

  const withRawRead = <T>(
    directory: string,
    task: () => Promise<T> | T,
    options: Pick<OperationOptions, 'signal' | 'queueTimeoutMs'> = {},
  ): Promise<T> => (
    discover(directory, { signal: options.signal }).then((context) => {
      if (!context.isRepository) {
        return runDirectoryFallbackRead(directory, task);
      }
      return coordinator.run({
        context,
        kind: GIT_OPERATION_KIND.READ,
        targetWorktree: true,
        label: 'raw-read',
        signal: options.signal,
        queueTimeoutMs: options.queueTimeoutMs,
      }, () => runWithGitExecutionScope(true, task));
    })
  );

  return Object.freeze({
    coordinator,
    resolver,
    discover,
    runServiceOperation,
    runStatus,
    runDirectoryFallbackRead,
    runInternalOperationInContext,
    runInternalOperationWithCommonFallback,
    withRawRead,
  });
};

export const gitExecutionRuntime = createGitExecutionRuntime();
