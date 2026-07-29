/**
 * Public types for `@openchamber/git-core`.
 *
 * This module is the single source of truth for pull-request-related git
 * resolution shared between the web server runtime and the VS Code
 * extension host. It has no Express, React, or `vscode` imports — it
 * consumes a `GitRunner` injected by the caller.
 */

/**
 * Result of a raw git invocation. The shape is what the web server's
 * `runGitCommand` helper and the VS Code extension host's `execGit`
 * helper both already produce; it is the contract between consumers
 * and the shared core.
 */
export interface GitCommandResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  message?: string;
}

/**
 * Thin executor over `git` — the only thing the shared core needs to
 * know about the host runtime. Implementations are responsible for
 * choosing the binary, env, and `spawn` flags.
 */
export interface GitRunner {
  run(cwd: string, args: string[]): Promise<GitCommandResult>;
}

/** Pull-request head ref as resolved from `refs/pull/<n>/head`. */
export interface PullRequestHeadRef {
  number: number;
  sourceRef: string;
}

/** Fork remote representation, used when a PR is from a fork. */
export interface PullRequestFork {
  remote: string;
  url: string;
  branch: string;
}

/**
 * Normalised PR-resolution input. Constructed from the runtime payload
 * (web server's `CreateGitWorktreeRequest` or VS Code's
 * `CreateGitWorktreePayload`) by `resolvePullRequestSourceInput`.
 */
export interface PullRequestSourceInput {
  pullRequest: PullRequestHeadRef;
  headBranch: string;
  baseRemote: string;
  fork: PullRequestFork | null;
}

/** Successful PR-resolution result — used by worktree creation to
 *  pick the right checkout ref and the upstream tracking target. */
export interface PullRequestSource {
  checkoutRef: string;
  headBranch: string;
  upstream: { remote: string; branch: string } | null;
}

/** Error code attached to `PullRequestSourceUnavailableError`. */
export const PULL_REQUEST_SOURCE_UNAVAILABLE_CODE = 'pull_request_unavailable';

/** Maximum suffix space when allocating a collision-safe fork remote. */
export const PULL_REQUEST_REMOTE_SUFFIX_LIMIT = 100;
