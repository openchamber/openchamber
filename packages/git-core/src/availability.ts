import { checkRemoteBranchExists } from './remote.js';
import type { GitRunner, PullRequestSource, PullRequestSourceInput } from './types.js';

/**
 * Check whether the base remote exposes `refs/pull/<n>/head`. Used as
 * the fallback path when the fork remote is missing or doesn't carry
 * the head branch.
 */
export const checkPullRequestHeadRefExists = async (
  runner: GitRunner,
  primaryWorktree: string,
  source: PullRequestSourceInput,
): Promise<{ success: boolean; found: boolean }> => {
  if (!source.baseRemote || !source.pullRequest.sourceRef) {
    return { success: false, found: false };
  }

  const lsRemote = await runner.run(primaryWorktree, [
    'ls-remote',
    '--',
    source.baseRemote,
    source.pullRequest.sourceRef,
  ]);
  if (!lsRemote.success) {
    return { success: false, found: false };
  }

  return {
    success: true,
    found: Boolean(String(lsRemote.stdout ?? '').trim()),
  };
};

/**
 * Cheap availability probe used by worktree validation flows.
 *
 * Returns the upstream we would attach (the fork's matching branch)
 * when the fork has it, or `upstream: null` when only the base
 * remote's `refs/pull/<n>/head` ref is reachable. Returns `null` when
 * neither path is reachable — caller treats that as "fail".
 */
export const checkPullRequestSourceAvailability = async (
  runner: GitRunner,
  primaryWorktree: string,
  source: PullRequestSourceInput,
): Promise<Pick<PullRequestSource, 'headBranch' | 'upstream'> | null> => {
  if (!source) {
    return null;
  }

  if (source.fork) {
    const fork = await checkRemoteBranchExists(
      runner,
      primaryWorktree,
      source.fork.remote,
      source.fork.branch,
      source.fork.url,
    );
    if (fork.success && fork.found) {
      return {
        headBranch: source.headBranch,
        upstream: { remote: source.fork.remote, branch: source.fork.branch },
      };
    }
  }

  const base = await checkPullRequestHeadRefExists(runner, primaryWorktree, source);
  if (!base.success || !base.found) {
    return null;
  }

  return {
    headBranch: source.headBranch,
    upstream: null,
  };
};
