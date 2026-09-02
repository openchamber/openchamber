import { createPullRequestSourceUnavailableError } from './errors.js';
import { fetchRemoteBranchRef } from './remote.js';
import { resolvePullRequestForkRemote } from './resolvePullRequestForkRemote.js';
import type { GitRunner, PullRequestFork, PullRequestSource, PullRequestSourceInput } from './types.js';

/**
 * Fetch the PR's head ref via the base remote into a stable
 * `refs/remotes/<base>/pull/<n>/head` ref. Returns the destination ref
 * on success, `null` on any failure.
 */
export const fetchPullRequestHeadRef = async (
  runner: GitRunner,
  primaryWorktree: string,
  source: PullRequestSourceInput,
): Promise<string | null> => {
  if (!source?.baseRemote || !source?.pullRequest?.sourceRef) {
    return null;
  }

  const destinationRef = `refs/remotes/${source.baseRemote}/pull/${source.pullRequest.number}/head`;
  const fetched = await runner.run(primaryWorktree, [
    'fetch',
    '--',
    source.baseRemote,
    `+${source.pullRequest.sourceRef}:${destinationRef}`,
  ]);
  if (!fetched.success) {
    return null;
  }

  const exists = await runner.run(primaryWorktree, [
    'show-ref',
    '--verify',
    '--quiet',
    destinationRef,
  ]);
  return exists.success ? destinationRef : null;
};

/**
 * Try the fork-first path: ensure a fork remote is configured for the
 * fork URL, fetch the head branch, and verify it landed.
 *
 * Returns `{ checkoutRef, fork }` on success. `checkoutRef` is the local
 * tracking ref to check out; `fork` is the allocated remote/branch pair
 * to use as upstream.
 */
export const fetchPullRequestForkBranch = async (
  runner: GitRunner,
  primaryWorktree: string,
  source: PullRequestSourceInput,
): Promise<{ checkoutRef: string; fork: PullRequestFork } | null> => {
  if (!source?.fork) {
    return null;
  }

  const fork = await resolvePullRequestForkRemote(runner, primaryWorktree, source);
  if (!fork) {
    return null;
  }

  try {
    await fetchRemoteBranchRef(runner, primaryWorktree, fork.remote, fork.branch);
  } catch {
    return null;
  }

  const destinationRef = `refs/remotes/${fork.remote}/${fork.branch}`;
  const exists = await runner.run(primaryWorktree, [
    'show-ref',
    '--verify',
    '--quiet',
    destinationRef,
  ]);
  return exists.success ? { checkoutRef: destinationRef, fork } : null;
};

/**
 * Resolve a PR source into a concrete checkout ref + upstream tracking
 * target. Prefers the fork path; falls back to the base remote's
 * `refs/pull/<n>/head`. Throws {@link PullRequestSourceUnavailableError}
 * when neither path is reachable — callers should map that to the
 * `pull_request_unavailable` transport error code.
 */
export const resolvePullRequestSource = async (
  runner: GitRunner,
  primaryWorktree: string,
  source: PullRequestSourceInput,
): Promise<PullRequestSource> => {
  const forkSource = await fetchPullRequestForkBranch(runner, primaryWorktree, source);
  if (forkSource) {
    return {
      checkoutRef: forkSource.checkoutRef,
      headBranch: source.headBranch,
      upstream: { remote: forkSource.fork.remote, branch: forkSource.fork.branch },
    };
  }

  const baseRef = await fetchPullRequestHeadRef(runner, primaryWorktree, source);
  if (baseRef) {
    return {
      checkoutRef: baseRef,
      headBranch: source.headBranch,
      upstream: null,
    };
  }

  throw createPullRequestSourceUnavailableError();
};
