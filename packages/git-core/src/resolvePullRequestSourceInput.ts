import { cleanBranchName, parseBranchSegment } from './branchName.js';
import { parseGitHubPullRequestHeadRef } from './parseGitHubPullRequestHeadRef.js';
import type { PullRequestFork, PullRequestSourceInput } from './types.js';

/**
 * Fields consumed from a worktree-create payload when resolving a PR.
 *
 * The web server's `CreateGitWorktreeRequest` and VS Code's
 * `CreateGitWorktreePayload` both expose these field names. The shared
 * core uses structural typing so it stays decoupled from the consumer
 * payload's full type.
 */
export interface CreateGitWorktreePrFields {
  prNumber?: unknown;
  upstreamBranch?: unknown;
  existingBranch?: unknown;
  ensureRemoteName?: unknown;
  ensureRemoteUrl?: unknown;
  baseRemote?: unknown;
}

const trimmed = (value: unknown): string => String(value || '').trim();

export const hasPullRequestIdentity = (input: CreateGitWorktreePrFields | null | undefined): boolean => {
  const value = input?.prNumber;
  return value !== undefined && value !== null && String(value).trim() !== '';
};

/**
 * Best-effort head branch name resolution. Prefers an explicit
 * `upstreamBranch`; falls back to the existing branch's branch segment
 * when the caller only knows the qualified ref (`<remote>/<branch>`,
 * `remotes/<remote>/<branch>`, or `refs/remotes/<remote>/<branch>`).
 */
const resolvePullRequestHeadBranch = (input: CreateGitWorktreePrFields): string => {
  const upstreamBranch = cleanBranchName(trimmed(input?.upstreamBranch));
  if (upstreamBranch) {
    return upstreamBranch;
  }

  const requestedExistingBranch = trimmed(input?.existingBranch);
  const branch = parseBranchSegment(requestedExistingBranch);
  return cleanBranchName(branch ?? requestedExistingBranch);
};

/**
 * Build a normalised PR source description from the worktree payload,
 * or `null` if no PR is attached. The result is the only input the rest
 * of the shared core consumes — callers can build this once and pass
 * the result through.
 */
export const resolvePullRequestSourceInput = (
  input: CreateGitWorktreePrFields | null | undefined,
): PullRequestSourceInput | null => {
  const pullRequest = parseGitHubPullRequestHeadRef(input?.prNumber);
  if (!pullRequest) {
    return null;
  }

  const forkRemote = trimmed(input?.ensureRemoteName);
  const forkUrl = trimmed(input?.ensureRemoteUrl);
  const headBranch = resolvePullRequestHeadBranch(input ?? {});
  const baseRemote = trimmed(input?.baseRemote);

  const fork: PullRequestFork | null =
    forkRemote && forkUrl && headBranch
      ? { remote: forkRemote, url: forkUrl, branch: headBranch }
      : null;

  return {
    pullRequest,
    headBranch,
    baseRemote,
    fork,
  };
};
