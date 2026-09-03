export const GIT_OPERATION_PROFILE = Object.freeze({
  BOOTSTRAP: 'bootstrap',
  MEMORY: 'memory',
  READ: 'read',
  WORKTREE_WRITE: 'worktree-write',
  COMMON_WRITE: 'common-write',
  COMMON_WORKTREE_WRITE: 'common-worktree-write',
  TOPOLOGY_WRITE: 'topology-write',
} as const);

export const GIT_NETWORK_USAGE = Object.freeze({
  NONE: 'none',
  CONDITIONAL: 'conditional',
  REQUIRED: 'required',
} as const);

export type GitOperationProfile = typeof GIT_OPERATION_PROFILE[keyof typeof GIT_OPERATION_PROFILE];
export type GitNetworkUsage = typeof GIT_NETWORK_USAGE[keyof typeof GIT_NETWORK_USAGE];
export type GitOperationClassification = Readonly<{
  profile: GitOperationProfile;
  network: GitNetworkUsage;
}>;

const operation = (
  profile: GitOperationProfile,
  network: GitNetworkUsage = GIT_NETWORK_USAGE.NONE,
): GitOperationClassification => Object.freeze({ profile, network });

export const GIT_SERVICE_OPERATION_CLASSIFICATION = Object.freeze({
  checkIsGitRepository: operation(GIT_OPERATION_PROFILE.BOOTSTRAP),
  isLinkedWorktree: operation(GIT_OPERATION_PROFILE.READ),
  getGitStatus: operation(GIT_OPERATION_PROFILE.READ),
  getGitBranches: operation(GIT_OPERATION_PROFILE.READ),
  checkoutBranch: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  createBranch: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  deleteGitBranch: operation(GIT_OPERATION_PROFILE.COMMON_WRITE),
  deleteRemoteBranch: operation(GIT_OPERATION_PROFILE.COMMON_WRITE, GIT_NETWORK_USAGE.REQUIRED),
  listGitWorktrees: operation(GIT_OPERATION_PROFILE.READ),
  validateWorktreeCreate: operation(GIT_OPERATION_PROFILE.COMMON_WRITE, GIT_NETWORK_USAGE.CONDITIONAL),
  previewWorktreeCreate: operation(GIT_OPERATION_PROFILE.COMMON_WRITE),
  createWorktree: operation(GIT_OPERATION_PROFILE.TOPOLOGY_WRITE, GIT_NETWORK_USAGE.CONDITIONAL),
  getWorktreeBootstrapStatus: operation(GIT_OPERATION_PROFILE.MEMORY),
  removeWorktree: operation(GIT_OPERATION_PROFILE.TOPOLOGY_WRITE),
  getGitDiff: operation(GIT_OPERATION_PROFILE.READ),
  getGitRangeDiff: operation(GIT_OPERATION_PROFILE.READ),
  getGitRangeFiles: operation(GIT_OPERATION_PROFILE.READ),
  getGitFileDiff: operation(GIT_OPERATION_PROFILE.READ),
  revertGitFile: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  stageGitFiles: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  unstageGitFiles: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  applyGitHunk: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  createGitCommit: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  gitPush: operation(GIT_OPERATION_PROFILE.COMMON_WRITE, GIT_NETWORK_USAGE.REQUIRED),
  gitPull: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE, GIT_NETWORK_USAGE.REQUIRED),
  listGitStashes: operation(GIT_OPERATION_PROFILE.READ),
  countGitStashFiles: operation(GIT_OPERATION_PROFILE.READ),
  stashGitChanges: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  applyGitStash: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  dropGitStash: operation(GIT_OPERATION_PROFILE.COMMON_WRITE),
  popGitStash: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  gitFetch: operation(GIT_OPERATION_PROFILE.COMMON_WRITE, GIT_NETWORK_USAGE.REQUIRED),
  getGitLog: operation(GIT_OPERATION_PROFILE.READ),
  getCommitFiles: operation(GIT_OPERATION_PROFILE.READ),
  getCommitFileDiff: operation(GIT_OPERATION_PROFILE.READ),
  getCurrentGitIdentity: operation(GIT_OPERATION_PROFILE.READ),
  setGitIdentity: operation(GIT_OPERATION_PROFILE.COMMON_WRITE),
  getRemotes: operation(GIT_OPERATION_PROFILE.READ),
  removeRemote: operation(GIT_OPERATION_PROFILE.COMMON_WRITE),
  rebase: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  abortRebase: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  merge: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  abortMerge: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  continueRebase: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  continueMerge: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  checkoutCommit: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  cherryPick: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  revertCommit: operation(GIT_OPERATION_PROFILE.WORKTREE_WRITE),
  resetToCommit: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE),
  validateWorktreeDirectory: operation(GIT_OPERATION_PROFILE.BOOTSTRAP),
  canonicalizeWorktreeState: operation(GIT_OPERATION_PROFILE.COMMON_WRITE),
} as const);

export type GitServiceOperationName = keyof typeof GIT_SERVICE_OPERATION_CLASSIFICATION;

export const GIT_INTERNAL_OPERATION_CLASSIFICATION = Object.freeze({
  worktreeAttachment: operation(GIT_OPERATION_PROFILE.TOPOLOGY_WRITE, GIT_NETWORK_USAGE.CONDITIONAL),
  worktreeBootstrap: operation(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE, GIT_NETWORK_USAGE.CONDITIONAL),
} as const);

export const getGitServiceOperationClassification = (
  operationName: string,
): GitOperationClassification => {
  const classification = GIT_SERVICE_OPERATION_CLASSIFICATION[operationName as GitServiceOperationName];
  if (!classification) {
    throw new TypeError(`Unclassified Git service operation: ${operationName}`);
  }
  return classification;
};

export const getGitOperationClassification = (
  operationName: string,
): GitOperationClassification => {
  const classification = GIT_SERVICE_OPERATION_CLASSIFICATION[operationName as GitServiceOperationName]
    || GIT_INTERNAL_OPERATION_CLASSIFICATION[operationName as keyof typeof GIT_INTERNAL_OPERATION_CLASSIFICATION];
  if (!classification) {
    throw new TypeError(`Unclassified Git operation: ${operationName}`);
  }
  return classification;
};
