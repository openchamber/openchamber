import * as core from './gitService';
import {
  gitExecutionRuntime,
} from './git-execution-runtime';
import type {
  GitExecutionContext,
  GitExecutionLease,
} from './git-execution-coordinator';
import {
  GIT_OPERATION_PROFILE,
  getGitOperationClassification,
  getGitServiceOperationClassification,
  type GitServiceOperationName,
} from './git-operation-classification';

export type {
  CreateGitWorktreePayload,
} from './gitService';

type OperationOptions = {
  network?: boolean;
  signal?: AbortSignal;
  queueTimeoutMs?: number;
};

type GitExecutionServiceDependencies = {
  core?: typeof core;
  runtime?: typeof gitExecutionRuntime;
};

const GIT_NOT_A_REPOSITORY_ERROR_CODE = 'GIT_NOT_A_REPOSITORY';

type NonRepositoryDiscoveryError = {
  code?: unknown;
  reason?: unknown;
  details?: unknown;
};

const isConfirmedNonRepositoryError = (error: unknown): error is NonRepositoryDiscoveryError => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as NonRepositoryDiscoveryError;
  if (candidate.code === GIT_NOT_A_REPOSITORY_ERROR_CODE || candidate.reason === 'not-a-repository') {
    return true;
  }

  if (!candidate.details || typeof candidate.details !== 'object') {
    return false;
  }

  return (candidate.details as { reason?: unknown }).reason === 'not-a-repository';
};

const isGitDiscoveryExecutableUnavailable = (error: unknown): boolean => {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
    return false;
  }
  if (!('details' in error) || !error.details || typeof error.details !== 'object') {
    return false;
  }
  return 'operation' in error.details && error.details.operation === 'git-context-discovery';
};

const remoteLikeRef = (value: string | undefined): boolean => {
  const normalized = String(value || '').trim();
  return normalized.startsWith('refs/remotes/')
    || normalized.startsWith('remotes/')
    || normalized.includes('/');
};

const worktreeMayUseNetwork = (input: core.CreateGitWorktreePayload | undefined): boolean => Boolean(
  input?.setUpstream
  || (input?.ensureRemoteName && input?.ensureRemoteUrl)
  || remoteLikeRef(input?.existingBranch)
  || remoteLikeRef(input?.startRef),
);

const createBackgroundScheduler = (
  runtime: typeof gitExecutionRuntime,
  outerContext: GitExecutionContext,
  outerNetwork: boolean,
): NonNullable<core.GitWorktreeExecutionOptions['scheduleBackground']> => (
  request,
  task,
) => {
  const classification = getGitOperationClassification(request.operation);
  const runTask = () => task();
  if (request.operation === 'worktreeAttachment') {
    return runtime.runInternalOperationInContext(
      request.operation,
      outerContext,
      runTask,
      { network: request.network || outerNetwork },
    );
  }
  return runtime.runInternalOperationWithCommonFallback(
    request.operation,
    request.contextDirectory,
    outerContext.commonId,
    runTask,
    { network: request.network || classification.network === 'required' },
  );
};

export const createGitExecutionService = ({
  core: coreImpl = core,
  runtime = gitExecutionRuntime,
}: GitExecutionServiceDependencies = {}) => {
  const runCore = <T>(
    operationName: GitServiceOperationName,
    directory: string,
    task: (lease: GitExecutionLease) => Promise<T> | T,
    options: OperationOptions = {},
  ): Promise<T> => {
    const classification = getGitServiceOperationClassification(operationName);
    if (classification.profile === GIT_OPERATION_PROFILE.MEMORY) {
      return Promise.resolve(task({
        commonId: directory,
        worktreeId: directory,
        kind: 'read',
        targetWorktree: false,
        network: false,
        active: true,
      }));
    }
    return runtime.runServiceOperation(operationName, directory, task, options);
  };

  const checkIsGitRepository: typeof core.checkIsGitRepository = async (directory) => {
    try {
      return (await runtime.discover(directory)).isRepository;
    } catch (error) {
      if (!isConfirmedNonRepositoryError(error) && !isGitDiscoveryExecutableUnavailable(error)) {
        throw error;
      }
      return runtime.runDirectoryFallbackRead(directory, () => coreImpl.checkIsGitRepository(directory));
    }
  };

  const isLinkedWorktree: typeof core.isLinkedWorktree = (directory) => (
    runCore('isLinkedWorktree', directory, () => coreImpl.isLinkedWorktree(directory))
  );

  const getGitStatus: typeof core.getGitStatus = async (directory, options) => {
    const shape = options?.mode === 'light' ? 'light' : 'full';
    return runtime.runStatus(
      directory,
      (sourceShape, sourceSignal) => coreImpl.getGitStatus(
        directory,
        {
          mode: sourceShape === 'light' ? 'light' : undefined,
          signal: sourceSignal,
        },
      ),
      {
        shape,
        signal: options?.signal,
        queueTimeoutMs: options?.queueTimeoutMs,
      },
    );
  };

  const getGitBranches: typeof core.getGitBranches = (directory) => (
    runCore('getGitBranches', directory, () => coreImpl.getGitBranches(directory))
  );
  const checkoutBranch: typeof core.checkoutBranch = (directory, branch) => (
    runCore('checkoutBranch', directory, () => coreImpl.checkoutBranch(directory, branch))
  );
  const createBranch: typeof core.createBranch = (directory, name, startPoint) => (
    runCore('createBranch', directory, () => coreImpl.createBranch(directory, name, startPoint))
  );
  const deleteGitBranch: typeof core.deleteGitBranch = (directory, branch, force) => (
    runCore('deleteGitBranch', directory, () => coreImpl.deleteGitBranch(directory, branch, force))
  );
  const deleteRemoteBranch: typeof core.deleteRemoteBranch = (directory, branch, remote) => (
    runCore('deleteRemoteBranch', directory, () => coreImpl.deleteRemoteBranch(directory, branch, remote), { network: true })
  );
  const listGitWorktrees: typeof core.listGitWorktrees = (directory) => (
    runCore('listGitWorktrees', directory, () => coreImpl.listGitWorktrees(directory))
  );
  const validateWorktreeCreate: typeof core.validateWorktreeCreate = (directory, input) => (
    runCore('validateWorktreeCreate', directory, () => coreImpl.validateWorktreeCreate(directory, input), {
      network: worktreeMayUseNetwork(input),
    })
  );
  const previewWorktreeCreate: typeof core.previewWorktreeCreate = (directory, input) => (
    runCore('previewWorktreeCreate', directory, () => coreImpl.previewWorktreeCreate(directory, input))
  );
  const createWorktree: typeof core.createWorktree = (directory, input) => {
    const network = worktreeMayUseNetwork(input);
    return runCore('createWorktree', directory, (lease) => coreImpl.createWorktree(directory, input, {
      scheduleBackground: createBackgroundScheduler(runtime, {
        isRepository: true,
        commonId: lease.commonId,
        worktreeId: lease.worktreeId,
      }, network),
    }), {
      network,
    });
  };
  const getWorktreeBootstrapStatus: typeof core.getWorktreeBootstrapStatus = (directory) => (
    coreImpl.getWorktreeBootstrapStatus(directory)
  );
  const removeWorktree: typeof core.removeWorktree = (directory, input) => (
    runCore('removeWorktree', directory, () => coreImpl.removeWorktree(directory, input))
  );
  const getGitDiff: typeof core.getGitDiff = (directory, filePath, staged, contextLines) => (
    runCore('getGitDiff', directory, () => coreImpl.getGitDiff(directory, filePath, staged, contextLines))
  );
  const getGitRangeDiff: typeof core.getGitRangeDiff = (
    directory,
    base,
    head,
    filePath,
    contextLines,
    options,
  ) => (
    runCore(
      'getGitRangeDiff',
      directory,
      () => options === undefined
        ? coreImpl.getGitRangeDiff(directory, base, head, filePath, contextLines)
        : coreImpl.getGitRangeDiff(directory, base, head, filePath, contextLines, options),
      options,
    )
  );
  const getGitRangeFiles: typeof core.getGitRangeFiles = (directory, base, head, options) => (
    runCore(
      'getGitRangeFiles',
      directory,
      () => options === undefined
        ? coreImpl.getGitRangeFiles(directory, base, head)
        : coreImpl.getGitRangeFiles(directory, base, head, options),
      options,
    )
  );
  const getGitFileDiff: typeof core.getGitFileDiff = (directory, filePath, staged) => (
    runCore('getGitFileDiff', directory, () => coreImpl.getGitFileDiff(directory, filePath, staged))
  );
  const revertGitFile: typeof core.revertGitFile = (directory, filePath, options) => (
    runCore('revertGitFile', directory, () => coreImpl.revertGitFile(directory, filePath, options))
  );
  const stageGitFiles: typeof core.stageGitFiles = (directory, filePaths) => (
    runCore('stageGitFiles', directory, () => coreImpl.stageGitFiles(directory, filePaths))
  );
  const unstageGitFiles: typeof core.unstageGitFiles = (directory, filePaths) => (
    runCore('unstageGitFiles', directory, () => coreImpl.unstageGitFiles(directory, filePaths))
  );
  const applyGitHunk: typeof core.applyGitHunk = (directory, filePath, patch, action) => (
    runCore('applyGitHunk', directory, () => coreImpl.applyGitHunk(directory, filePath, patch, action))
  );
  const createGitCommit: typeof core.createGitCommit = (directory, message, options) => (
    runCore('createGitCommit', directory, () => coreImpl.createGitCommit(directory, message, options))
  );
  const gitPush: typeof core.gitPush = (directory, options) => (
    runCore('gitPush', directory, () => coreImpl.gitPush(directory, options), { network: true })
  );
  const gitPull: typeof core.gitPull = (directory, options) => (
    runCore('gitPull', directory, () => coreImpl.gitPull(directory, options), { network: true })
  );
  const listGitStashes: typeof core.listGitStashes = (directory) => (
    runCore('listGitStashes', directory, () => coreImpl.listGitStashes(directory))
  );
  const countGitStashFiles: typeof core.countGitStashFiles = (directory, refs) => (
    runCore('countGitStashFiles', directory, () => coreImpl.countGitStashFiles(directory, refs))
  );
  const stashGitChanges: typeof core.stashGitChanges = (directory, options) => (
    runCore('stashGitChanges', directory, () => coreImpl.stashGitChanges(directory, options))
  );
  const applyGitStash: typeof core.applyGitStash = (directory, options) => (
    runCore('applyGitStash', directory, () => coreImpl.applyGitStash(directory, options))
  );
  const dropGitStash: typeof core.dropGitStash = (directory, options) => (
    runCore('dropGitStash', directory, () => coreImpl.dropGitStash(directory, options))
  );
  const popGitStash: typeof core.popGitStash = (directory, options) => (
    runCore('popGitStash', directory, () => coreImpl.popGitStash(directory, options))
  );
  const gitFetch: typeof core.gitFetch = (directory, options) => (
    runCore('gitFetch', directory, () => coreImpl.gitFetch(directory, options), { network: true })
  );
  const getGitLog: typeof core.getGitLog = (directory, options) => (
    runCore('getGitLog', directory, () => coreImpl.getGitLog(directory, options))
  );
  const getCommitFiles: typeof core.getCommitFiles = (directory, hash) => (
    runCore('getCommitFiles', directory, () => coreImpl.getCommitFiles(directory, hash))
  );
  const getCommitFileDiff: typeof core.getCommitFileDiff = (directory, hash, filePath, isBinary) => (
    runCore('getCommitFileDiff', directory, () => coreImpl.getCommitFileDiff(directory, hash, filePath, isBinary))
  );
  const getCurrentGitIdentity: typeof core.getCurrentGitIdentity = (directory) => (
    runCore('getCurrentGitIdentity', directory, () => coreImpl.getCurrentGitIdentity(directory))
  );
  const setGitIdentity: typeof core.setGitIdentity = (directory, userName, userEmail, sshKey, signCommits, signingKey) => (
    runCore('setGitIdentity', directory, () => coreImpl.setGitIdentity(directory, userName, userEmail, sshKey, signCommits, signingKey))
  );
  const getRemotes: typeof core.getRemotes = (directory) => (
    runCore('getRemotes', directory, () => coreImpl.getRemotes(directory))
  );
  const removeRemote: typeof core.removeRemote = (directory, remote) => (
    runCore('removeRemote', directory, () => coreImpl.removeRemote(directory, remote))
  );
  const rebase: typeof core.rebase = (directory, options) => (
    runCore('rebase', directory, () => coreImpl.rebase(directory, options))
  );
  const abortRebase: typeof core.abortRebase = (directory) => (
    runCore('abortRebase', directory, () => coreImpl.abortRebase(directory))
  );
  const merge: typeof core.merge = (directory, options) => (
    runCore('merge', directory, () => coreImpl.merge(directory, options))
  );
  const abortMerge: typeof core.abortMerge = (directory) => (
    runCore('abortMerge', directory, () => coreImpl.abortMerge(directory))
  );
  const continueRebase: typeof core.continueRebase = (directory) => (
    runCore('continueRebase', directory, () => coreImpl.continueRebase(directory))
  );
  const continueMerge: typeof core.continueMerge = (directory) => (
    runCore('continueMerge', directory, () => coreImpl.continueMerge(directory))
  );
  const checkoutCommit: typeof core.checkoutCommit = (directory, hash) => (
    runCore('checkoutCommit', directory, () => coreImpl.checkoutCommit(directory, hash))
  );
  const cherryPick: typeof core.cherryPick = (directory, hash) => (
    runCore('cherryPick', directory, () => coreImpl.cherryPick(directory, hash))
  );
  const revertCommit: typeof core.revertCommit = (directory, hash) => (
    runCore('revertCommit', directory, () => coreImpl.revertCommit(directory, hash))
  );
  const resetToCommit: typeof core.resetToCommit = (directory, hash, mode, force) => (
    runCore('resetToCommit', directory, () => coreImpl.resetToCommit(directory, hash, mode, force))
  );
  const validateWorktreeDirectory: typeof core.validateWorktreeDirectory = (directory, worktreeRoot) => (
    runtime.withRawRead(directory, () => coreImpl.validateWorktreeDirectory(directory, worktreeRoot))
  );
  const canonicalizeWorktreeState: typeof core.canonicalizeWorktreeState = (directory) => (
    runCore('canonicalizeWorktreeState', directory, () => coreImpl.canonicalizeWorktreeState(directory))
  );

  return Object.freeze({
    checkIsGitRepository,
    isLinkedWorktree,
    getGitStatus,
    getGitBranches,
    checkoutBranch,
    createBranch,
    deleteGitBranch,
    deleteRemoteBranch,
    listGitWorktrees,
    validateWorktreeCreate,
    previewWorktreeCreate,
    createWorktree,
    getWorktreeBootstrapStatus,
    removeWorktree,
    getGitDiff,
    getGitRangeDiff,
    getGitRangeFiles,
    getGitFileDiff,
    revertGitFile,
    stageGitFiles,
    unstageGitFiles,
    applyGitHunk,
    createGitCommit,
    gitPush,
    gitPull,
    listGitStashes,
    countGitStashFiles,
    stashGitChanges,
    applyGitStash,
    dropGitStash,
    popGitStash,
    gitFetch,
    getGitLog,
    getCommitFiles,
    getCommitFileDiff,
    getCurrentGitIdentity,
    setGitIdentity,
    getRemotes,
    removeRemote,
    rebase,
    abortRebase,
    merge,
    abortMerge,
    continueRebase,
    continueMerge,
    checkoutCommit,
    cherryPick,
    revertCommit,
    resetToCommit,
    validateWorktreeDirectory,
    canonicalizeWorktreeState,
  });
};

export const gitExecutionService = createGitExecutionService();

export const {
  checkIsGitRepository,
  isLinkedWorktree,
  getGitStatus,
  getGitBranches,
  checkoutBranch,
  createBranch,
  deleteGitBranch,
  deleteRemoteBranch,
  listGitWorktrees,
  validateWorktreeCreate,
  previewWorktreeCreate,
  createWorktree,
  getWorktreeBootstrapStatus,
  removeWorktree,
  getGitDiff,
  getGitRangeDiff,
  getGitRangeFiles,
  getGitFileDiff,
  revertGitFile,
  stageGitFiles,
  unstageGitFiles,
  applyGitHunk,
  createGitCommit,
  gitPush,
  gitPull,
  listGitStashes,
  countGitStashFiles,
  stashGitChanges,
  applyGitStash,
  dropGitStash,
  popGitStash,
  gitFetch,
  getGitLog,
  getCommitFiles,
  getCommitFileDiff,
  getCurrentGitIdentity,
  setGitIdentity,
  getRemotes,
  removeRemote,
  rebase,
  abortRebase,
  merge,
  abortMerge,
  continueRebase,
  continueMerge,
  checkoutCommit,
  cherryPick,
  revertCommit,
  resetToCommit,
  validateWorktreeDirectory,
  canonicalizeWorktreeState,
} = gitExecutionService;
