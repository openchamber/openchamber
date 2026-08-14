import type {
  ForgeChecksSummary,
  ForgeComment,
  ForgeFileChange,
  ForgeIssue,
  ForgeProviderCapabilities,
  ForgeProviderKind,
  ForgePullRequest,
  ForgeRepoRef,
} from './types';

/**
 * Provider-agnostic git-forge facade.
 *
 * Adapters implement this interface against the per-provider wire APIs declared
 * in `@/lib/api/types.ts` and normalize the results onto the shapes in
 * `./types.ts`. Consumers (issue/PR views) depend only on this interface plus
 * the capability flags, never on a specific provider's API.
 *
 * Result envelopes mirror the existing wire envelopes (`{ connected, repo, ... }`)
 * from `@/lib/api/types.ts`, so `connected: false` keeps the same meaning: the
 * forge was not reachable/authenticated and no authoritative data was fetched.
 * Callers must never treat a `connected: false` envelope as an empty success.
 */

/** Paginated pull request list result (see `GitHubPullRequestsListResult` / `GitLabMergeRequestsListResult`). */
export interface ForgePullRequestsResult {
  connected: boolean;
  repo?: ForgeRepoRef | null;
  prs: ForgePullRequest[];
  page: number;
  hasMore: boolean;
}

/**
 * Full context for one pull request: comments, review comments, files, diff,
 * and check summary. Roughly the union of `GitHubPullRequestContextResult`
 * (comments + review comments + files + diff + checkDetails), the GitLab
 * merge-request context (comments + files + diff), and the Gitea PR context
 * (comments + files + diff).
 */
export interface ForgePullRequestContext {
  connected: boolean;
  repo?: ForgeRepoRef | null;
  pr?: ForgePullRequest | null;
  issueComments: ForgeComment[];
  reviewComments: ForgeComment[];
  files: ForgeFileChange[];
  diff?: string;
  checks?: ForgeChecksSummary | null;
  /** Timestamp (epoch ms) the context was fetched at; adapters may set it for staleness. */
  fetchedAt?: number;
}

/** Paginated issue list result (see `GitHubIssuesListResult` / `GitLabIssuesListResult`). */
export interface ForgeIssuesResult {
  connected: boolean;
  repo?: ForgeRepoRef | null;
  issues: ForgeIssue[];
  page: number;
  hasMore: boolean;
}

/** Issue detail plus its comments (see `GitHubIssueGetResult` + `issueComments`, `GitLabIssueGetResult`). */
export interface ForgeIssueDetail {
  connected: boolean;
  repo?: ForgeRepoRef | null;
  issue?: ForgeIssue | null;
  comments: ForgeComment[];
  /**
   * Set when the issue loaded but its comments failed to fetch — never
   * masquerade as authoritative empty. null when comments fetched cleanly or
   * were never attempted (e.g. the whole fetch failed).
   */
  commentsError?: string | null;
}

/**
 * Provider-agnostic forge operations. Every method resolves the target
 * repository from the working directory (remotes + connected accounts) and
 * takes a directory argument, matching the per-provider APIs in
 * `@/lib/api/types.ts`.
 */
export interface ForgeProvider {
  readonly kind: ForgeProviderKind;
  readonly capabilities: ForgeProviderCapabilities;

  // --- Pull requests ---

  /**
   * Resolve the PR/MR open on `branch` (falling back to the merged one), or
   * null when there is none. Wraps `github prStatus` (GitHubPullRequestStatus),
   * `gitlab mrsList` filtered by `sourceBranch`, and `gitea prsList` filtered
   * by `sourceBranch`. Used to link the current worktree branch to its PR.
   */
  getPullRequestForBranch(directory: string, branch: string, options?: { remote?: string }): Promise<ForgePullRequest | null>;

  /**
   * List pull requests, paginated. Wraps `github prsList`, `gitlab mrsList`,
   * and `gitea prsList`; `query` is passed through to the provider's search
   * where supported. Normalization intent: `state` maps to the provider's
   * open/merged/closed vocabulary and `draft` is always a boolean.
   */
  listPullRequests(directory: string, options?: { page?: number; query?: string }): Promise<ForgePullRequestsResult>;

  /**
   * Full context for one PR: issue comments + review comments + files + diff +
   * checks. Wraps `github prContext`, `gitlab mrContext`, and `gitea prContext`,
   * plus the checks APIs where the provider exposes them. `sourceRepo` selects
   * a cross-repo (fork) repository, mirroring `GitHubRepoSelector`.
   */
  getPullRequestContext(
    directory: string,
    number: number,
    options?: { includeDiff?: boolean; sourceRepo?: string | null },
  ): Promise<ForgePullRequestContext>;

  // --- Issues ---

  /**
   * List issues, paginated. Wraps `github issuesList`, `gitlab issuesList`,
   * and `gitea issuesList`. `query` passes through to the provider's search
   * where supported.
   */
  listIssues(directory: string, options?: { page?: number; query?: string }): Promise<ForgeIssuesResult>;

  /**
   * Fetch a single issue plus its comments. Wraps `github issueGet` +
   * `issueComments`, `gitlab issueGet` + `issueComments`, and `gitea issueGet`
   * + `issueComments`. `sourceRepo` selects a cross-repo (fork) repository.
   */
  getIssue(directory: string, number: number, options?: { sourceRepo?: string | null }): Promise<ForgeIssueDetail>;

  // NOTE: Slice B (next chunk) will add getCommits / getTimeline / checks for
  // the rich entity view. Do NOT add them here yet.
}
