import type { GitCommandResult, GitRunner } from './types.js';

/**
 * `git config --unset-all` exits with code 5 (and empty output) when
 * the key is already missing. We treat that as a no-op so cleanup is
 * idempotent and safe to call on every worktree creation.
 */
const isExpectedMissingGitConfigKey = (result: GitCommandResult): boolean =>
  !result.success &&
  result.exitCode === 5 &&
  !String(result.stdout ?? '').trim() &&
  !String(result.stderr ?? '').trim();

const clearBranchTrackingKey = async (
  runner: GitRunner,
  worktreeDirectory: string,
  key: string,
): Promise<void> => {
  const result = await runner.run(worktreeDirectory, ['config', '--unset-all', key]);
  if (result.success || isExpectedMissingGitConfigKey(result)) {
    return;
  }
  throw new Error(result.message || 'Failed to clear branch tracking configuration');
};

/**
 * Drop the upstream tracking for a freshly-created branch. This is used
 * when the worktree should NOT inherit `branch.<name>.remote` and
 * `branch.<name>.merge` from a prior reference, e.g. a PR checkout
 * where the upstream will be re-attached based on the resolved PR
 * source.
 */
export const clearBranchTracking = async (
  runner: GitRunner,
  worktreeDirectory: string,
  localBranch: string,
): Promise<void> => {
  if (!localBranch) {
    return;
  }

  await clearBranchTrackingKey(runner, worktreeDirectory, `branch.${localBranch}.remote`);
  await clearBranchTrackingKey(runner, worktreeDirectory, `branch.${localBranch}.merge`);
};
