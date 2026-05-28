import { describe, expect, it, vi } from 'vitest';

vi.mock('@openchamber/ui/lib/gitApiHttp', () => ({
  checkIsGitRepository: vi.fn(),
  getGitStatus: vi.fn(),
  getGitDiff: vi.fn(),
  getGitFileDiff: vi.fn(),
  revertGitFile: vi.fn(),
  stageGitFile: vi.fn(),
  stageGitFiles: vi.fn(),
  unstageGitFile: vi.fn(),
  unstageGitFiles: vi.fn(),
  isLinkedWorktree: vi.fn(),
  getGitBranches: vi.fn(),
  deleteGitBranch: vi.fn(),
  deleteRemoteBranch: vi.fn(),
  setBranchUpstream: vi.fn(),
  removeRemote: vi.fn(),
  generateCommitMessage: vi.fn(),
  generatePullRequestDescription: vi.fn(),
  listGitWorktrees: vi.fn(),
  validateGitWorktree: vi.fn(),
  createGitWorktree: vi.fn(),
  deleteGitWorktree: vi.fn(),
  validateWorktreeDirectory: vi.fn(),
  canonicalizeWorktreeState: vi.fn(),
  createGitCommit: vi.fn(),
  gitPush: vi.fn(),
  gitPull: vi.fn(),
  gitFetch: vi.fn(),
  listGitStashes: vi.fn(),
  countGitStashFiles: vi.fn(),
  stashGitChanges: vi.fn(),
  applyGitStash: vi.fn(),
  popGitStash: vi.fn(),
  dropGitStash: vi.fn(),
  checkoutBranch: vi.fn(),
  createBranch: vi.fn(),
  renameBranch: vi.fn(),
  getGitLog: vi.fn(),
  getCommitFiles: vi.fn(),
  getCurrentGitIdentity: vi.fn(),
  hasLocalIdentity: vi.fn(),
  setGitIdentity: vi.fn(),
  getGitIdentities: vi.fn(),
  createGitIdentity: vi.fn(),
  updateGitIdentity: vi.fn(),
  deleteGitIdentity: vi.fn(),
  getRemotes: vi.fn(),
  rebase: vi.fn(),
  abortRebase: vi.fn(),
  continueRebase: vi.fn(),
  merge: vi.fn(),
  abortMerge: vi.fn(),
  continueMerge: vi.fn(),
  stash: vi.fn(),
  stashPop: vi.fn(),
  getConflictDetails: vi.fn(),
}));

describe('createWebGitAPI', () => {
  it('exposes bulk stage and unstage methods', async () => {
    const { createWebGitAPI } = await import('./git');
    const api = createWebGitAPI();

    expect(typeof api.stageGitFiles).toBe('function');
    expect(typeof api.unstageGitFiles).toBe('function');
  });
});
