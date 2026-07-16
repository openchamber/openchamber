export const GIT_OPERATION_PROFILE = Object.freeze({
  BOOTSTRAP: 'bootstrap',
  PURE: 'pure',
  MEMORY: 'memory',
  GLOBAL_READ: 'global-read',
  READ: 'read',
  WORKTREE_WRITE: 'worktree-write',
  COMMON_WRITE: 'common-write',
  COMMON_WORKTREE_WRITE: 'common-worktree-write',
  TOPOLOGY_WRITE: 'topology-write',
  CLONE_RESERVATION: 'clone-reservation',
});

export const GIT_NETWORK_USAGE = Object.freeze({
  NONE: 'none',
  CONDITIONAL: 'conditional',
  REQUIRED: 'required',
});

const operation = (profile, network = GIT_NETWORK_USAGE.NONE) => Object.freeze({ profile, network });

// This table is the closed resource inventory for every exported service operation.
// Tests compare it with the actual exports so new operations cannot silently bypass
// execution classification.
export const GIT_SERVICE_OPERATION_CLASSIFICATION = Object.freeze({
  resolvePrimaryWorktreeRoot: operation(GIT_OPERATION_PROFILE.BOOTSTRAP),
  resolveWorktreeTopLevel: operation(GIT_OPERATION_PROFILE.BOOTSTRAP),
  getCommitSummaries: operation(GIT_OPERATION_PROFILE.READ),
  computeIntegratePlan: operation(GIT_OPERATION_PROFILE.COMMON_WRITE),
  getIntegrateConflictDetails: operation(GIT_OPERATION_PROFILE.READ),
  isCherryPickInProgress: operation(GIT_OPERATION_PROFILE.READ),
  integrateWorktreeCommits: operation(GIT_OPERATION_PROFILE.TOPOLOGY_WRITE, GIT_NETWORK_USAGE.CONDITIONAL),
  abortIntegrate: operation(GIT_OPERATION_PROFILE.TOPOLOGY_WRITE),
  continueIntegrate: operation(GIT_OPERATION_PROFILE.TOPOLOGY_WRITE),
  isGitRepository: operation(GIT_OPERATION_PROFILE.BOOTSTRAP),
  getGlobalIdentity: operation(GIT_OPERATION_PROFILE.GLOBAL_READ),
  getRemoteUrl: operation(GIT_OPERATION_PROFILE.READ),
  getIgnoredPaths: operation(GIT_OPERATION_PROFILE.READ),
  getCurrentIdentity: operation(GIT_OPERATION_PROFILE.READ),
  hasLocalIdentity: operation(GIT_OPERATION_PROFILE.READ),
  setLocalIdentity: operation(GIT_OPERATION_PROFILE.COMMON_WRITE),
  getStatus: operation(GIT_OPERATION_PROFILE.READ),
  getDiff: operation(GIT_OPERATION_PROFILE.READ),
  getRangeDiff: operation(GIT_OPERATION_PROFILE.READ),
  getRangeFiles: operation(GIT_OPERATION_PROFILE.READ),
  getFileDiff: operation(GIT_OPERATION_PROFILE.READ),
  revertFile: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  applyHunk: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  collectDiffs: operation(GIT_OPERATION_PROFILE.READ),
  pull: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE, GIT_NETWORK_USAGE.REQUIRED),
  listStashes: operation(GIT_OPERATION_PROFILE.READ),
  countStashFiles: operation(GIT_OPERATION_PROFILE.READ),
  stashPush: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  stashApply: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  stashDrop: operation(GIT_OPERATION_PROFILE.COMMON_WRITE),
  stashPop: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  push: operation(GIT_OPERATION_PROFILE.COMMON_WRITE, GIT_NETWORK_USAGE.REQUIRED),
  deleteRemoteBranch: operation(GIT_OPERATION_PROFILE.COMMON_WRITE, GIT_NETWORK_USAGE.REQUIRED),
  fetch: operation(GIT_OPERATION_PROFILE.COMMON_WRITE, GIT_NETWORK_USAGE.REQUIRED),
  stageFile: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  stageFiles: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  unstageFile: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  unstageFiles: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  commit: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  getBranches: operation(GIT_OPERATION_PROFILE.READ, GIT_NETWORK_USAGE.CONDITIONAL),
  createBranch: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  checkoutBranch: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  checkoutCommit: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  cherryPick: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  revertCommit: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  resetToCommit: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  getWorktrees: operation(GIT_OPERATION_PROFILE.READ),
  validateWorktreeCreate: operation(GIT_OPERATION_PROFILE.COMMON_WRITE, GIT_NETWORK_USAGE.CONDITIONAL),
  previewWorktreeCreate: operation(GIT_OPERATION_PROFILE.READ),
  createWorktree: operation(GIT_OPERATION_PROFILE.TOPOLOGY_WRITE, GIT_NETWORK_USAGE.CONDITIONAL),
  getWorktreeBootstrapStatus: operation(GIT_OPERATION_PROFILE.MEMORY),
  removeWorktree: operation(GIT_OPERATION_PROFILE.TOPOLOGY_WRITE),
  deleteBranch: operation(GIT_OPERATION_PROFILE.COMMON_WRITE),
  resolveBaseRefForLog: operation(GIT_OPERATION_PROFILE.PURE),
  getLog: operation(GIT_OPERATION_PROFILE.READ),
  isLinkedWorktree: operation(GIT_OPERATION_PROFILE.READ),
  validateWorktreeDirectory: operation(GIT_OPERATION_PROFILE.BOOTSTRAP),
  canonicalizeWorktreeState: operation(GIT_OPERATION_PROFILE.READ),
  getCommitFiles: operation(GIT_OPERATION_PROFILE.READ),
  renameBranch: operation(GIT_OPERATION_PROFILE.COMMON_WRITE),
  getRemotes: operation(GIT_OPERATION_PROFILE.READ),
  removeRemote: operation(GIT_OPERATION_PROFILE.COMMON_WRITE),
  rebase: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  abortRebase: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  merge: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  abortMerge: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  continueRebase: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  continueMerge: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  getConflictDetails: operation(GIT_OPERATION_PROFILE.READ),
  getCommitFileDiff: operation(GIT_OPERATION_PROFILE.READ),
  cloneRepository: operation(GIT_OPERATION_PROFILE.CLONE_RESERVATION, GIT_NETWORK_USAGE.REQUIRED),
  withGitCloneReservation: operation(GIT_OPERATION_PROFILE.CLONE_RESERVATION, GIT_NETWORK_USAGE.REQUIRED),
});

export const GIT_INTERNAL_OPERATION_CLASSIFICATION = Object.freeze({
  worktreeBootstrap: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE, GIT_NETWORK_USAGE.CONDITIONAL),
});

export const GIT_RUNTIME_OWNER_KIND = Object.freeze({
  CLASSIFIED_SERVICE: 'classified-service',
  CLASSIFIED_READ: 'classified-read',
  CLONE_RESERVATION: 'clone-reservation',
  SERVICE_DELEGATE: 'service-delegate',
  BOOTSTRAP_DISCOVERY: 'bootstrap-discovery',
  CAPABILITY_PROBE: 'capability-probe',
  USER_SHELL_BYPASS: 'user-shell-bypass',
  PROCESS_TREE_BYPASS: 'process-tree-bypass',
  EXTERNAL_PROCESS_BYPASS: 'external-process-bypass',
});

const owner = (kind) => Object.freeze({ kind });

// Direct runtime owners and intentional process-local non-guarantees. Migration
// tests use these stable owner IDs instead of inferring behavior from command text.
export const GIT_RUNTIME_OWNER_CLASSIFICATION = Object.freeze({
  'git/service': owner(GIT_RUNTIME_OWNER_KIND.CLASSIFIED_SERVICE),
  'git/context-discovery': owner(GIT_RUNTIME_OWNER_KIND.BOOTSTRAP_DISCOVERY),
  'fs/clone': owner(GIT_RUNTIME_OWNER_KIND.SERVICE_DELEGATE),
  'fs/exec': owner(GIT_RUNTIME_OWNER_KIND.USER_SHELL_BYPASS),
  'fs/list-check-ignore': owner(GIT_RUNTIME_OWNER_KIND.SERVICE_DELEGATE),
  'fs/search-check-ignore': owner(GIT_RUNTIME_OWNER_KIND.SERVICE_DELEGATE),
  'skills-catalog/git-version': owner(GIT_RUNTIME_OWNER_KIND.CAPABILITY_PROBE),
  'skills-catalog/clone-repository': owner(GIT_RUNTIME_OWNER_KIND.CLONE_RESERVATION),
  'notifications/branch': owner(GIT_RUNTIME_OWNER_KIND.SERVICE_DELEGATE),
  'git/hooks-and-helpers': owner(GIT_RUNTIME_OWNER_KIND.PROCESS_TREE_BYPASS),
  'external-git-processes': owner(GIT_RUNTIME_OWNER_KIND.EXTERNAL_PROCESS_BYPASS),
  'worktree/start-command': owner(GIT_RUNTIME_OWNER_KIND.USER_SHELL_BYPASS),
});

export const getGitServiceOperationClassification = (operationName) => {
  const classification = GIT_SERVICE_OPERATION_CLASSIFICATION[operationName];
  if (!classification) {
    throw new TypeError(`Unclassified Git service operation: ${operationName}`);
  }
  return classification;
};

export const getGitOperationClassification = (operationName) => {
  const classification = GIT_SERVICE_OPERATION_CLASSIFICATION[operationName]
    || GIT_INTERNAL_OPERATION_CLASSIFICATION[operationName];
  if (!classification) {
    throw new TypeError(`Unclassified Git operation: ${operationName}`);
  }
  return classification;
};
