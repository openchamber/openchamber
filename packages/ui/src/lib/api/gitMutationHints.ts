import type { GitAPI } from '@/lib/api/types';
import { sessionEvents } from '@/lib/sessionEvents';

function wrapMutating<A extends unknown[], R>(fn: (directory: string, ...args: A) => Promise<R>): (directory: string, ...args: A) => Promise<R>;
function wrapMutating<A extends unknown[], R>(fn: ((directory: string, ...args: A) => Promise<R>) | undefined): ((directory: string, ...args: A) => Promise<R>) | undefined;
function wrapMutating<A extends unknown[], R>(fn: ((directory: string, ...args: A) => Promise<R>) | undefined) {
  if (!fn) {
    return undefined;
  }
  return async (directory: string, ...args: A) => {
    const result = await fn(directory, ...args);
    if (directory) {
      sessionEvents.requestGitRefresh({ directory });
    }
    return result;
  };
}

export const withGitMutationRefreshHints = (git: GitAPI): GitAPI => ({
  ...git,
  stageGitFile: wrapMutating(git.stageGitFile),
  stageGitFiles: wrapMutating(git.stageGitFiles),
  unstageGitFile: wrapMutating(git.unstageGitFile),
  unstageGitFiles: wrapMutating(git.unstageGitFiles),
  stageGitHunk: wrapMutating(git.stageGitHunk),
  unstageGitHunk: wrapMutating(git.unstageGitHunk),
  revertGitHunk: wrapMutating(git.revertGitHunk),
  revertGitFile: wrapMutating(git.revertGitFile),
  createGitCommit: wrapMutating(git.createGitCommit),
  gitPush: wrapMutating(git.gitPush),
  gitPull: wrapMutating(git.gitPull),
  gitFetch: wrapMutating(git.gitFetch),
  stashGitChanges: wrapMutating(git.stashGitChanges),
  applyGitStash: wrapMutating(git.applyGitStash),
  popGitStash: wrapMutating(git.popGitStash),
  dropGitStash: wrapMutating(git.dropGitStash),
  checkoutBranch: wrapMutating(git.checkoutBranch),
  createBranch: wrapMutating(git.createBranch),
  createGitTag: wrapMutating(git.createGitTag),
  renameBranch: wrapMutating(git.renameBranch),
  deleteGitBranch: wrapMutating(git.deleteGitBranch),
  deleteRemoteBranch: wrapMutating(git.deleteRemoteBranch),
  removeRemote: wrapMutating(git.removeRemote),
  rebase: wrapMutating(git.rebase),
  abortRebase: wrapMutating(git.abortRebase),
  continueRebase: wrapMutating(git.continueRebase),
  merge: wrapMutating(git.merge),
  abortMerge: wrapMutating(git.abortMerge),
  continueMerge: wrapMutating(git.continueMerge),
  checkoutCommit: wrapMutating(git.checkoutCommit),
  cherryPick: wrapMutating(git.cherryPick),
  revertCommit: wrapMutating(git.revertCommit),
  resetToCommit: wrapMutating(git.resetToCommit),
  stash: wrapMutating(git.stash),
  stashPop: wrapMutating(git.stashPop),
  createGitWorktree: wrapMutating(git.createGitWorktree),
  deleteGitWorktree: wrapMutating(git.deleteGitWorktree),
});
