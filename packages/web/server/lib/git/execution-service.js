import * as rawGit from './service.js';
import {
  createGitContextResolver,
} from './context-resolver.js';
import {
  createGitExecutionCoordinator,
  GIT_READ_ONLY_ENV,
  GIT_OPERATION_KIND,
} from './execution-coordinator.js';
import {
  runWithGitExecutionScope,
} from './execution-scope.js';

const operation = Object.freeze({
  read: GIT_OPERATION_KIND.READ,
  worktreeWrite: GIT_OPERATION_KIND.WORKTREE_WRITE,
  commonWrite: GIT_OPERATION_KIND.COMMON_WRITE,
  topologyWrite: GIT_OPERATION_KIND.TOPOLOGY_WRITE,
});

const operationKinds = Object.freeze({
  isGitRepository: operation.read,
  getStatus: operation.read,
  getGlobalIdentity: operation.read,
  getRemoteUrl: operation.read,
  getCurrentIdentity: operation.read,
  hasLocalIdentity: operation.read,
  getDiff: operation.read,
  listUntrackedPaths: operation.read,
  getUntrackedDiffs: operation.read,
  getRangeDiff: operation.read,
  getBranchBase: operation.read,
  getRangeFiles: operation.read,
  getFileDiff: operation.read,
  listStashes: operation.read,
  countStashFiles: operation.read,
  getBranches: operation.read,
  getWorktrees: operation.read,
  previewWorktreeCreate: operation.commonWrite,
  getLog: operation.read,
  getCommitFiles: operation.read,
  getCommitFileDiff: operation.read,
  getRemotes: operation.read,
  isLinkedWorktree: operation.read,
  validateWorktreeDirectory: operation.read,
  canonicalizeWorktreeState: operation.commonWrite,
  getConflictDetails: operation.read,
  getIntegrateConflictDetails: operation.read,
  getRepositoryRoot: operation.read,
  resolvePrimaryWorktreeRoot: operation.read,
  resolveWorktreeTopLevel: operation.read,
  getCommitSummaries: operation.read,
  isCherryPickInProgress: operation.read,
  collectDiffs: operation.read,
  revertFile: operation.worktreeWrite,
  stageFile: operation.worktreeWrite,
  stageFiles: operation.worktreeWrite,
  unstageFile: operation.worktreeWrite,
  unstageFiles: operation.worktreeWrite,
  applyHunk: operation.worktreeWrite,
  checkoutCommit: operation.worktreeWrite,
  cherryPick: operation.commonWrite,
  revertCommit: operation.worktreeWrite,
  resetToCommit: operation.commonWrite,
  checkoutBranch: operation.worktreeWrite,
  createBranch: operation.commonWrite,
  deleteBranch: operation.commonWrite,
  renameBranch: operation.commonWrite,
  deleteRemoteBranch: operation.commonWrite,
  setLocalIdentity: operation.commonWrite,
  removeRemote: operation.commonWrite,
  stashPush: operation.commonWrite,
  stashApply: operation.commonWrite,
  stashDrop: operation.commonWrite,
  stashPop: operation.commonWrite,
  commit: operation.commonWrite,
  push: operation.commonWrite,
  pull: operation.commonWrite,
  fetch: operation.commonWrite,
  rebase: operation.commonWrite,
  abortRebase: operation.commonWrite,
  continueRebase: operation.commonWrite,
  merge: operation.commonWrite,
  abortMerge: operation.commonWrite,
  continueMerge: operation.commonWrite,
  computeIntegratePlan: operation.commonWrite,
  abortIntegrate: operation.commonWrite,
  continueIntegrate: operation.commonWrite,
  integrateWorktreeCommits: operation.topologyWrite,
  validateWorktreeCreate: operation.commonWrite,
  createWorktree: operation.topologyWrite,
  removeWorktree: operation.topologyWrite,
  ensureWorktreeLongpaths: operation.worktreeWrite,
  populateWorktreeWithLockRecovery: operation.worktreeWrite,
});

const networkOperations = new Set(['push', 'pull', 'fetch', 'deleteRemoteBranch', 'getBranches']);
const repositoryInputOperations = new Set([
  'computeIntegratePlan',
  'integrateWorktreeCommits',
  'abortIntegrate',
  'continueIntegrate',
]);

const operationDirectory = (name, args) => (
  repositoryInputOperations.has(name) ? args[0]?.repoRoot : args[0]
);

const errorText = (error) => [
  error?.message,
  error?.stderr,
  error?.stdout,
  error,
].map((value) => String(value || '').trim()).filter(Boolean).join('\n');

const normalizeDiscoveryCode = (value) => {
  if (value === undefined || value === null) return {};
  if (Number.isFinite(value)) return { exitCode: value };
  return { code: String(value) };
};

const createDiscoveryRunner = (gitModule = rawGit) => async (cwd, args, options = {}) => {
  try {
    const git = await gitModule.createGit(cwd, {
      envOverrides: GIT_READ_ONLY_ENV,
      signal: options.signal,
    });
    return { success: true, stdout: await git.raw(args), stderr: '' };
  } catch (error) {
    const code = normalizeDiscoveryCode(error?.code);
    return {
      success: false,
      ...code,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
      message: errorText(error),
    };
  }
};

const worktreeMayUseNetwork = (input) => Boolean(
  input?.setUpstream
  || (input?.ensureRemoteName && input?.ensureRemoteUrl)
  || String(input?.existingBranch || '').includes('/')
  || String(input?.startRef || '').includes('/'),
);

const checkoutBranchMayUseNetwork = async (raw, directory, branchName) => {
  const requested = String(branchName || '').trim();
  if (!requested || !requested.includes('/')) {
    return false;
  }

  const remoteRef = requested.replace(/^refs\/remotes\//, '').replace(/^remotes\//, '');
  const remoteName = remoteRef.split('/', 1)[0];
  const localBranch = remoteRef.slice(remoteName.length + 1);
  if (!remoteName || !localBranch || localBranch === 'HEAD') {
    return false;
  }

  const explicitRemoteRef = remoteRef !== requested;
  if (!raw.getRemotes) {
    return true;
  }

  let configuredRemote = explicitRemoteRef;
  try {
    const remotes = await raw.getRemotes(directory);
    configuredRemote = Array.isArray(remotes) && remotes.some((remote) => remote?.name === remoteName);
  } catch {
    // Let the checkout operation report the underlying Git error, but do not
    // allow a failed remote lookup to bypass network admission.
    return true;
  }

  if (!configuredRemote) {
    return false;
  }

  // checkoutBranch prefers a local branch, including one whose name contains
  // slashes, before it considers a remote-tracking ref. Do not probe that
  // local ref here: it can disappear before the checkout is admitted, after
  // which the service may fetch or update shared refs. A configured remote
  // therefore keeps this potentially remote checkout network-coordinated.
  return true;
};

const checkoutBranchClassification = async (
  raw,
  coordinator,
  context,
  directory,
  branchName,
  options,
) => {
  const requested = String(branchName || '').trim();
  const explicitRemoteRef = requested.startsWith('remotes/')
    || requested.startsWith('refs/remotes/');
  if (explicitRemoteRef || !requested.includes('/')) {
    const network = explicitRemoteRef;
    return {
      kind: network ? GIT_OPERATION_KIND.COMMON_WRITE : GIT_OPERATION_KIND.WORKTREE_WRITE,
      network,
    };
  }

  // The remote-name probe is part of checkout's decision, so it must use
  // coordinator admission too. It is a local read; the checkout is upgraded
  // to a common/network mutation when the lookup shows that Git may fetch or
  // update shared refs.
  const network = await coordinator.run({
    context,
    kind: GIT_OPERATION_KIND.READ,
    targetWorktree: true,
    network: false,
    label: 'checkout-branch-preflight',
    signal: options.signal,
    queueTimeoutMs: options.queueTimeoutMs,
  }, () => runWithGitExecutionScope(true, () => checkoutBranchMayUseNetwork(
    raw,
    directory,
    branchName,
  )));
  return {
    kind: network ? GIT_OPERATION_KIND.COMMON_WRITE : GIT_OPERATION_KIND.WORKTREE_WRITE,
    network,
  };
};

export const createGitExecutionService = (dependencies = {}) => {
  const raw = dependencies.raw || rawGit;
  const coordinator = dependencies.coordinator || createGitExecutionCoordinator();
  const resolver = dependencies.resolver || createGitContextResolver({
    runGit: dependencies.runGit || createDiscoveryRunner(raw),
  });

  const createBackgroundScheduler = (outerContext, outerNetwork) => async (request, task) => {
    const context = request.operation === 'worktreeAttachment'
      ? outerContext
      : await resolver.resolve(request.contextDirectory);
    return coordinator.run({
      context,
      kind: GIT_OPERATION_KIND.TOPOLOGY_WRITE,
      targetWorktree: true,
      network: request.network === true
        || (request.operation === 'worktreeAttachment' && outerNetwork === true),
      label: request.operation,
      signal: request.signal,
      queueTimeoutMs: request.queueTimeoutMs,
    }, () => runWithGitExecutionScope(false, task));
  };

  const runOperation = async (name, directory, args, options = {}) => {
    let kind = operationKinds[name];
    if (!kind) {
      throw new TypeError(`Unclassified Git service operation: ${name}`);
    }
    const context = await resolver.resolve(directory, { signal: options.signal });
    if (!context.isRepository) {
      return runWithGitExecutionScope(kind === GIT_OPERATION_KIND.READ, () => raw[name](...args));
    }
    let network = options.network ?? networkOperations.has(name);
    if (name === 'checkoutBranch') {
      const classification = await checkoutBranchClassification(
        raw,
        coordinator,
        context,
        directory,
        args[1],
        options,
      );
      kind = classification.kind;
      network = classification.network;
    }
    return coordinator.run({
      context,
      kind,
      targetWorktree: options.targetWorktree ?? kind !== GIT_OPERATION_KIND.COMMON_WRITE,
      network,
      label: name,
      lease: options.lease,
      signal: options.signal,
      queueTimeoutMs: options.queueTimeoutMs,
    }, () => runWithGitExecutionScope(
      kind === GIT_OPERATION_KIND.READ,
      () => raw[name](
        ...args,
        ...(name === 'createWorktree'
           ? [{ scheduleBackground: createBackgroundScheduler(context, options.network) }]
          : []),
      ),
    ));
  };

  const runStatus = async (directory, options) => {
    const context = await resolver.resolve(directory, { signal: options?.signal });
    if (!context.isRepository) {
      return runWithGitExecutionScope(true, () => raw.getStatus(directory, options));
    }
    const statusMode = options?.mode === 'light' ? 'light' : 'full';
    return coordinator.runStatus({
      context,
      'shape': statusMode,
      signal: options?.signal,
      queueTimeoutMs: options?.queueTimeoutMs,
      label: `status:${statusMode}`,
    }, (sourceMode, sourceSignal) => runWithGitExecutionScope(true, () => {
      const sourceOptions = sourceSignal ? { signal: sourceSignal } : {};
      const statusOptions = sourceMode === 'light'
        ? { mode: 'light', ...sourceOptions }
        : sourceSignal ? sourceOptions : undefined;
      return raw.getStatus(directory, statusOptions);
    }));
  };

  const withRawRead = (directory, task, options = {}) => (
    resolver.resolve(directory, { signal: options.signal }).then((context) => {
      if (!context.isRepository) {
        return runWithGitExecutionScope(true, task);
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

  const checkIsGitRepository = async (directory) => (
    (await resolver.resolve(directory)).isRepository
  );

  const wrapped = {};
  for (const name of Object.keys(operationKinds)) {
    if (name === 'isGitRepository' || name === 'getStatus') {
      continue;
    }
    wrapped[name] = (...args) => runOperation(name, operationDirectory(name, args), args, {
      network: name === 'validateWorktreeCreate' || name === 'createWorktree'
        ? worktreeMayUseNetwork(args[1])
        : undefined,
    });
  }

  wrapped.setLocalIdentity = (directory, profile, options) => runOperation(
    'setLocalIdentity',
    directory,
    [directory, profile],
    options,
  );

  wrapped.isGitRepository = checkIsGitRepository;
  wrapped.getStatus = runStatus;
  wrapped.getGlobalIdentity = (...args) => coordinator.run({
    context: {
      isRepository: true,
      commonId: 'openchamber:git-global-config',
      worktreeId: 'openchamber:git-global-config',
    },
    kind: GIT_OPERATION_KIND.READ,
    targetWorktree: false,
    label: 'getGlobalIdentity',
  }, () => runWithGitExecutionScope(true, () => raw.getGlobalIdentity(...args)));
  wrapped.getWorktreeBootstrapStatus = (...args) => raw.getWorktreeBootstrapStatus(...args);
  wrapped.getRepositoryRoot = (...args) => runOperation('getRepositoryRoot', args[0], args);
  wrapped.getIntegrateConflictDetails = (...args) => runOperation(
    'getIntegrateConflictDetails',
    args[0],
    args,
  );
  wrapped.getRemoteUrl = (...args) => runOperation('getRemoteUrl', args[0], args);
  wrapped.getCurrentIdentity = (...args) => runOperation('getCurrentIdentity', args[0], args);
  wrapped.hasLocalIdentity = (...args) => runOperation('hasLocalIdentity', args[0], args);

  return Object.freeze({ ...raw, ...wrapped, coordinator, resolver, withRawRead });
};

const defaultService = createGitExecutionService();

export const {
  isGitRepository,
  getStatus,
  getGlobalIdentity,
  getRemoteUrl,
  getCurrentIdentity,
  hasLocalIdentity,
  getDiff,
  listUntrackedPaths,
  getUntrackedDiffs,
  getRangeDiff,
  getBranchBase,
  getRangeFiles,
  getFileDiff,
  listStashes,
  countStashFiles,
  stashPush,
  stashApply,
  stashDrop,
  stashPop,
  getBranches,
  getWorktrees,
  validateWorktreeCreate,
  previewWorktreeCreate,
  createWorktree,
  getWorktreeBootstrapStatus,
  removeWorktree,
  getLog,
  getCommitFiles,
  getCommitFileDiff,
  getRemotes,
  removeRemote,
  isLinkedWorktree,
  validateWorktreeDirectory,
  canonicalizeWorktreeState,
  getConflictDetails,
  getIntegrateConflictDetails,
  getRepositoryRoot,
  revertFile,
  stageFile,
  stageFiles,
  unstageFile,
  unstageFiles,
  applyHunk,
  checkoutCommit,
  cherryPick,
  revertCommit,
  resetToCommit,
  checkoutBranch,
  createBranch,
  deleteBranch,
  renameBranch,
  deleteRemoteBranch,
  setLocalIdentity,
  commit,
  push,
  pull,
  fetch,
  rebase,
  abortRebase,
  continueRebase,
  merge,
  abortMerge,
  continueMerge,
  computeIntegratePlan,
  abortIntegrate,
  continueIntegrate,
  integrateWorktreeCommits,
  resolvePrimaryWorktreeRoot,
  resolveWorktreeTopLevel,
  getCommitSummaries,
  isCherryPickInProgress,
  collectDiffs,
  ensureWorktreeLongpaths,
  populateWorktreeWithLockRecovery,
  coordinator,
  resolver,
  withRawRead,
} = defaultService;

export { defaultService as gitExecutionService };
