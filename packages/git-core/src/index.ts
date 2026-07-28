/**
 * `@openchamber/git-core` — shared pull-request and worktree-helper
 * resolution logic for the web server and the VS Code extension host.
 *
 * The runtime consumers inject a {@link GitRunner} so the shared core
 * stays free of any runtime-specific dependencies (no `simple-git`, no
 * `vscode`, no Express).
 */

export type {
  GitCommandResult,
  GitRunner,
  PullRequestFork,
  PullRequestHeadRef,
  PullRequestSource,
  PullRequestSourceInput,
} from './types.js';
export { PULL_REQUEST_REMOTE_SUFFIX_LIMIT, PULL_REQUEST_SOURCE_UNAVAILABLE_CODE } from './types.js';

export { cleanBranchName, parseBranchSegment } from './branchName.js';
export { PullRequestSourceUnavailableError, createPullRequestSourceUnavailableError } from './errors.js';
export type { ChildProcessGitRunnerOptions } from './gitRunner.js';
export { createChildProcessGitRunner } from './gitRunner.js';
export { parseGitHubPullRequestHeadRef } from './parseGitHubPullRequestHeadRef.js';
export { checkRemoteBranchExists, fetchRemoteBranchRef } from './remote.js';
export { checkPullRequestHeadRefExists, checkPullRequestSourceAvailability } from './availability.js';
export {
  fetchPullRequestForkBranch,
  fetchPullRequestHeadRef,
  resolvePullRequestSource,
} from './resolvePullRequestSource.js';
export { resolvePullRequestForkRemote } from './resolvePullRequestForkRemote.js';
export type { CreateGitWorktreePrFields } from './resolvePullRequestSourceInput.js';
export { hasPullRequestIdentity, resolvePullRequestSourceInput } from './resolvePullRequestSourceInput.js';
export { clearBranchTracking } from './clearBranchTracking.js';
