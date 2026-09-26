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
import { copyGitProcessMetadata } from './execution-errors.js';
import { isUnsupportedRepositoryContext } from './repository-root.js';

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
  getPathDiff: operation.read,
  getFileDiff: operation.read,
  listStashes: operation.read,
  countStashFiles: operation.read,
  getBranches: operation.read,
  getUnpushedBranchCounts: operation.read,
  getWorktrees: operation.read,
  previewWorktreeCreate: operation.commonWrite,
  getLog: operation.read,
  getCommitFiles: operation.read,
  getCommitDiff: operation.read,
  getCommitFileDiff: operation.read,
  getTrackingBranch: operation.read,
  isAncestorOfHead: operation.read,
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

// integrateWorktreeCommits fast-forwards the target branch through
// `maybeFastForwardIntegrateUpstream`, which runs `git fetch` whenever the
// target tracks an upstream. The fetch is conditional, but admission is not:
// every path that can touch the network must hold network capacity before the
// integrate flow starts.
const networkOperations = new Set(['push', 'pull', 'fetch', 'deleteRemoteBranch', 'getBranches', 'integrateWorktreeCommits']);
const repositoryInputOperations = new Set([
  'computeIntegratePlan',
  'integrateWorktreeCommits',
  'abortIntegrate',
  'continueIntegrate',
]);

const operationDirectory = (name, args) => (
  repositoryInputOperations.has(name) ? args[0]?.repoRoot : args[0]
);

const operationExecutionOptions = (name, args) => {
  const options = name === 'getUntrackedDiffs'
    || name === 'isAncestorOfHead'
    || name === 'getBranchBase'
    || name === 'getUnpushedBranchCounts'
    || name === 'countStashFiles'
    ? args[2]
    : args[1];
  if (!options || Object.prototype.toString.call(options) !== '[object Object]') return {};
  const executionOptions = {};
  if (options.signal) executionOptions.signal = options.signal;
  if (Number.isFinite(options.queueTimeoutMs)) executionOptions.queueTimeoutMs = options.queueTimeoutMs;
  return executionOptions;
};

const errorText = (error) => [
  error?.message,
  error?.stderr,
  error?.stdout,
  error,
].map((value) => String(value || '').trim()).filter(Boolean).join('\n');

const unsupportedRepositoryError = (context) => Object.assign(
  new Error(`Git repository root is unsupported (${context.unsupportedRoot})`),
  {
    code: 'GIT_NOT_A_REPOSITORY',
    reason: 'not-a-repository',
    details: {
      reason: 'not-a-repository',
      unsupportedRoot: context.unsupportedRoot,
      repositoryRoot: context.topLevel,
    },
  },
);

const unsupportedRepositoryStatus = () => ({
  isGitRepository: false,
  files: [],
  branch: null,
  ahead: 0,
  behind: 0,
});

const normalizeDiscoveryCode = (value) => {
  if (value === undefined || value === null) return {};
  if (Number.isFinite(value)) return { exitCode: value };
  return { code: String(value) };
};

const createDiscoveryRunner = (gitModule = rawGit) => async (cwd, args, options = {}) => {
  try {
    const git = await gitModule.createGit(cwd, {
      envOverrides: GIT_READ_ONLY_ENV,
      ownedProcessTree: true,
      signal: options.signal,
    });
    return { success: true, stdout: await git.raw(args), stderr: '' };
  } catch (error) {
    const code = normalizeDiscoveryCode(error?.code);
    return copyGitProcessMetadata({
      success: false,
      ...code,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
      message: errorText(error),
    }, error);
  }
};

const worktreeMayUseNetwork = (input) => Boolean(
  input?.setUpstream
  || (input?.ensureRemoteName && input?.ensureRemoteUrl)
  || String(input?.existingBranch || '').includes('/')
  || String(input?.startRef || '').includes('/'),
);

const checkoutBranchMayUseNetwork = async (raw, directory, branchName, signal) => {
  const requested = String(branchName || '').trim();
  if (!requested || !requested.includes('/')) {
    return false;
  }

  // The checkout service gives an existing local branch precedence over a
  // remote-looking name. Prove that branch exists before choosing a
  // non-network lease; when it does not, a remote can be added after this
  // admission probe and the service may fetch it, so the conservative answer
  // is to reserve common/network capacity up front.
  let localBranchExists = null;
  if (raw.createGit instanceof Function) {
    try {
      const git = await raw.createGit(directory, {
        envOverrides: GIT_READ_ONLY_ENV,
        ownedProcessTree: true,
        signal,
      });
      await git.raw(['show-ref', '--verify', '--quiet', `refs/heads/${requested}`]);
      localBranchExists = true;
    } catch (error) {
      if (String(error?.code || '') === '1' || Number(error?.code) === 1) {
        localBranchExists = false;
      } else {
        // A failed local-ref probe is not evidence that the checkout is local.
        // Admit it as network work so a later remote lookup cannot fetch under
        // a worktree-only lease.
        localBranchExists = false;
      }
    }
  }

  const remoteRef = requested.replace(/^refs\/remotes\//, '').replace(/^remotes\//, '');
  const remoteName = remoteRef.split('/', 1)[0];
  const localBranch = remoteRef.slice(remoteName.length + 1);
  if (!remoteName || !localBranch || localBranch === 'HEAD') {
    return false;
  }

  const explicitRemoteRef = remoteRef !== requested;
  if (!raw.getRemotes) {
    return localBranchExists === true ? false : true;
  }

  let configuredRemote = explicitRemoteRef;
  try {
    const remotes = await raw.getRemotes(directory, signal ? { signal } : {});
    configuredRemote = Array.isArray(remotes) && remotes.some((remote) => remote?.name === remoteName);
  } catch {
    // Let the checkout operation report the underlying Git error, but do not
    // allow a failed remote lookup to bypass network admission.
    return true;
  }

  if (configuredRemote) {
    // checkoutBranch prefers a local branch, including one whose name contains
    // slashes, before it considers a remote-tracking ref. Keep a configured
    // remote network-coordinated anyway: the local ref can disappear between
    // this probe and the checkout, after which the service may fetch.
    return true;
  }

  // Without a configured remote, a confirmed local branch is safe to keep in
  // worktree admission. If no local ref was confirmed, a remote can be added
  // before the service's own resolution and make the checkout fetch-capable.
  return localBranchExists === true ? false : true;
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
    options.signal,
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

  const createBackgroundScheduler = (outerContext, outerNetwork, outerSignal) => async (request, task) => {
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
      signal: request.signal || outerSignal,
      queueTimeoutMs: request.queueTimeoutMs,
    }, () => runWithGitExecutionScope(false, task));
  };

  const runOperation = async (name, directory, args, options = {}) => {
    let kind = operationKinds[name];
    if (!kind) {
      throw new TypeError(`Unclassified Git service operation: ${name}`);
    }
    const context = await resolver.resolve(directory, { signal: options.signal });
    const rawArgs = () => [
      ...args,
      ...((name === 'validateWorktreeCreate' || name === 'previewWorktreeCreate')
        ? [{ signal: options.signal }]
        : (name === 'createWorktree'
          ? [{
            scheduleBackground: createBackgroundScheduler(context, options.network, options.signal),
            signal: options.signal,
          }]
          : [])),
    ];
    if (!context.isRepository) {
      if (isUnsupportedRepositoryContext(context)) {
        throw unsupportedRepositoryError(context);
      }
      return runWithGitExecutionScope(kind === GIT_OPERATION_KIND.READ, () => raw[name](...rawArgs()));
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
      waitForCleanup: options.waitForCleanup === true,
    }, () => runWithGitExecutionScope(
      kind === GIT_OPERATION_KIND.READ,
      () => raw[name](...rawArgs()),
    ));
  };

  const runStatus = async (directory, options) => {
    const context = await resolver.resolve(directory, { signal: options?.signal });
    if (!context.isRepository) {
      if (isUnsupportedRepositoryContext(context)) {
        return runWithGitExecutionScope(true, unsupportedRepositoryStatus);
      }
      return runWithGitExecutionScope(true, () => raw.getStatus(directory, options));
    }
    const statusMode = options?.mode === 'light' ? 'light' : 'full';
    return coordinator.runStatus({
      context,
      mode: statusMode,
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
        if (isUnsupportedRepositoryContext(context)) {
          throw unsupportedRepositoryError(context);
        }
        return runWithGitExecutionScope(true, task);
      }
      return coordinator.run({
        context,
        kind: GIT_OPERATION_KIND.READ,
        targetWorktree: true,
        label: 'raw-read',
        signal: options.signal,
        queueTimeoutMs: options.queueTimeoutMs,
        waitForCleanup: options.waitForCleanup === true,
      }, () => runWithGitExecutionScope(true, task));
    })
  );

  const checkIsGitRepository = async (directory, options = {}) => (
    (await resolver.resolve(directory, { signal: options?.signal })).isRepository
  );

  const wrapped = {};
  const committedReadExecutionOptions = (options) => {
    const executionOptions = {};
    if (options?.signal) {
      executionOptions.signal = options.signal;
      executionOptions.waitForCleanup = true;
    }
    if (Number.isFinite(options?.queueTimeoutMs)) {
      executionOptions.queueTimeoutMs = options.queueTimeoutMs;
    }
    return executionOptions;
  };
  for (const name of Object.keys(operationKinds)) {
    if (name === 'isGitRepository' || name === 'getStatus') {
      continue;
    }
    if (name === 'validateWorktreeCreate' || name === 'createWorktree') {
      // These operations can reach the network, so callers need the same
      // cancellation and queue-deadline controls as every other admission.
      // The caller's execution options stay on the coordinator side; runOperation
      // supplies the raw service's own options object (scheduleBackground).
      wrapped[name] = (directory, input, executionOptions = {}) => runOperation(
        name,
        directory,
        [directory, input],
        {
          ...executionOptions,
          network: worktreeMayUseNetwork(input),
        },
      );
      continue;
    }
    if (name === 'previewWorktreeCreate') {
      wrapped[name] = (directory, input, executionOptions = {}) => runOperation(
        name,
        directory,
        [directory, input],
        executionOptions,
      );
      continue;
    }
    wrapped[name] = (...args) => runOperation(
      name,
      operationDirectory(name, args),
      args,
      { network: undefined, ...operationExecutionOptions(name, args) },
    );
  }

  wrapped.setLocalIdentity = (directory, profile, options) => runOperation(
    'setLocalIdentity',
    directory,
    [directory, profile],
    options,
  );

  wrapped.getCommitDiff = (directory, options = {}) => {
    return runOperation(
      'getCommitDiff',
      directory,
      [directory, options],
      committedReadExecutionOptions(options),
    );
  };

  wrapped.getCommitFiles = (directory, commitHash, options = {}) => {
    return runOperation(
      'getCommitFiles',
      directory,
      [directory, commitHash, options],
      committedReadExecutionOptions(options),
    );
  };

  wrapped.getCommitFileDiff = (directory, hash, filePath, isBinary, options = {}) => {
    return runOperation(
      'getCommitFileDiff',
      directory,
      [directory, hash, filePath, isBinary, options],
      committedReadExecutionOptions(options),
    );
  };

  wrapped.getTrackingBranch = (directory, options = {}) => {
    const executionOptions = options?.signal ? { signal: options.signal } : {};
    return runOperation('getTrackingBranch', directory, [directory, options], executionOptions);
  };

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
  wrapped.getRepositoryRoot = (directory, options = {}) => runOperation(
    'getRepositoryRoot',
    directory,
    [directory, options],
    options,
  );
  wrapped.getIntegrateConflictDetails = (...args) => runOperation(
    'getIntegrateConflictDetails',
    args[0],
    args,
  );
  wrapped.getRemoteUrl = (directory, remoteName = 'origin', options = {}) => runOperation(
    'getRemoteUrl',
    directory,
    [directory, remoteName, options],
    operationExecutionOptions('getRemoteUrl', [directory, options]),
  );
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
  getPathDiff,
  getFileDiff,
  listStashes,
  countStashFiles,
  stashPush,
  stashApply,
  stashDrop,
  stashPop,
  getBranches,
  getUnpushedBranchCounts,
  getWorktrees,
  validateWorktreeCreate,
  previewWorktreeCreate,
  createWorktree,
  getWorktreeBootstrapStatus,
  removeWorktree,
  getLog,
  getCommitFiles,
  getCommitDiff,
  getCommitFileDiff,
  getTrackingBranch,
  isAncestorOfHead,
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
