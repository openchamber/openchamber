import type {
  ForgeChecksSummary,
  ForgeComment,
  ForgeCommit,
  ForgeFileChange,
  ForgeIssue,
  ForgeLabel,
  ForgeMilestone,
  ForgeProviderCapabilities,
  ForgeProviderKind,
  ForgePullRequest,
  ForgeRepoRef,
  ForgeReview,
  ForgeTimelineEvent,
  ForgeUser,
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

/** Commits on a PR/MR (see `github prCommits`, `gitlab mrCommits`, `gitea prCommits`). */
export interface ForgeCommitsResult {
  connected: boolean;
  repo?: ForgeRepoRef | null;
  commits: ForgeCommit[];
  /** Set when the wire call failed after resolving a repo — never a valid empty success. */
  error?: string | null;
}

/** Activity timeline for a PR/MR (see `github prTimeline`, `gitlab mrTimeline`, gitea reviews). */
export interface ForgeTimelineResult {
  connected: boolean;
  repo?: ForgeRepoRef | null;
  events: ForgeTimelineEvent[];
  error?: string | null;
}

/**
 * Repo-scoped user lookup for mentions/assignees. Wraps the per-provider
 * assignable-user endpoints (github `issues.listAssignees`, gitlab project
 * members, gitea repo assignees). `connected: false` means the lookup failed —
 * never treat it as an authoritative empty list.
 */
export interface ForgeUsersResult {
  connected: boolean;
  repo?: ForgeRepoRef | null;
  users: ForgeUser[];
  error?: string | null;
}

/** Repo-scoped label lookup for pickers. */
export interface ForgeLabelsResult {
  connected: boolean;
  repo?: ForgeRepoRef | null;
  labels: ForgeLabel[];
  error?: string | null;
}

/** Repo-scoped milestone lookup for pickers. */
export interface ForgeMilestonesResult {
  connected: boolean;
  repo?: ForgeRepoRef | null;
  milestones: ForgeMilestone[];
  error?: string | null;
}

/** Repo-scoped branch lookup. */
export interface ForgeBranchesResult {
  connected: boolean;
  repo?: ForgeRepoRef | null;
  branches: string[];
  error?: string | null;
}

/** Repo-scoped tag lookup. */
export interface ForgeTagsResult {
  connected: boolean;
  repo?: ForgeRepoRef | null;
  tags: string[];
  error?: string | null;
}

/** Rolled-up checks for a PR/MR; only non-null for providers with a dedicated checks surface. */
export interface ForgeChecksResult {
  connected: boolean;
  repo?: ForgeRepoRef | null;
  checks: ForgeChecksSummary | null;
  error?: string | null;
}

// --- Write operations ---

/** Open/closed state a write may set on an issue or PR ('merged' is not writable). */
export type ForgeWriteState = 'open' | 'closed';

/** Review events the facade can submit; providers map them onto their own vocabulary. */
export type ForgeReviewEvent = 'approve' | 'request-changes' | 'comment';

/** Target of a write operation: an issue or a pull request, by number. */
export interface ForgeEntityRef {
  kind: 'issue' | 'pull';
  number: number;
}

/**
 * Reply/inline comment input. `inReplyToId` anchors a thread reply; `path` and
 * `line` place a new inline review comment (GitHub review comments only).
 */
export interface ForgeCommentInput {
  body: string;
  inReplyToId?: string | null;
  path?: string | null;
  line?: number | null;
}

/** Result of posting a comment; `ok: false` with `error` means nothing was posted. */
export interface ForgeCommentResult {
  ok: boolean;
  error?: string | null;
  comment?: ForgeComment | null;
}

/** Input for creating an issue; `labels` is a full-set list of label names. */
export interface ForgeIssueCreateInput {
  title: string;
  body?: string;
  labels?: string[];
}

/** Result of creating an issue; `issue` is the created entity when `ok`. */
export interface ForgeIssueCreateResult {
  ok: boolean;
  error?: string | null;
  issue?: ForgeIssue | null;
}

/** Result of an entity update; `entity` is the refreshed issue/PR when `ok`. */
export interface ForgeUpdateResult {
  ok: boolean;
  error?: string | null;
  entity?: ForgeIssue | ForgePullRequest | null;
}

/** Result of submitting a review; GitLab approvals synthesize a minimal review. */
export interface ForgeReviewResult {
  ok: boolean;
  error?: string | null;
  review?: ForgeReview | null;
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

  // --- Rich entity view (commits / timeline / checks) ---

  /**
   * Commits on a pull request. Wraps `github prCommits`, `gitlab mrCommits`,
   * and `gitea prCommits`. Optional: providers without a commits route do not
   * implement it, and the UI gates on method presence.
   */
  getCommits?(directory: string, number: number, options?: { sourceRepo?: string | null }): Promise<ForgeCommitsResult>;

  /**
   * Activity timeline for a pull request. Wraps `github prTimeline`,
   * `gitlab mrTimeline`, and (for gitea, which has no timeline endpoint) a
   * timeline synthesized from its reviews. Optional like `getCommits`.
   */
  getTimeline?(directory: string, number: number, options?: { sourceRepo?: string | null }): Promise<ForgeTimelineResult>;

  /**
   * Rolled-up checks for a pull request. Only gitea has a dedicated surface
   * (`gitea prStatuses`); GitHub check runs ride on
   * `getPullRequestContext().checks` and GitLab has no checks surface, so both
   * return null here. `null` return means the provider exposes no checks
   * through this method.
   */
  getChecks?(directory: string, number: number, options?: { sourceRepo?: string | null }): Promise<ForgeChecksResult | null>;

// --- Rich lookups (pickers / mentions) ---
  //
  // Repo-scoped searches for the fields the UI offers as pickers. Every method
  // resolves the target repo from the working directory (remotes + connected
  // accounts) and takes a directory argument, matching the per-provider APIs.
  // All are optional and capability-flagged (`capabilities.userSearch`,
  // `.labelSearch`, `.milestoneSearch`, `.branchSearch`, `.tagSearch`); the UI
  // gates on method presence plus the flag before enabling an affordance.
  // Results return `{ connected: false }` — never throw — when the runtime API
  // is missing, the wire call fails, or the provider cannot resolve the repo.

  /**
   * Search the repo's assignable users (matches for assignees and mentions).
   * Wraps github `issues.listAssignees`, gitlab project members, and gitea repo
   * assignees; `query` is a free-text substring (case-insensitive). `sourceRepo`
   * selects a cross-repo (fork) repository.
   */
  searchUsers?(directory: string, query: string, options?: { sourceRepo?: string | null }): Promise<ForgeUsersResult>;

  /**
   * Search the repo's labels. Wraps github `issues.listLabelsForRepo`, gitlab
   * project labels, and gitea repo labels.
   */
  searchLabels?(directory: string, query: string, options?: { sourceRepo?: string | null }): Promise<ForgeLabelsResult>;

  /**
   * Search the repo's milestones. Wraps github `issues.listMilestonesForRepo`,
   * gitlab project milestones, and gitea repo milestones.
   */
  searchMilestones?(directory: string, query: string, options?: { sourceRepo?: string | null }): Promise<ForgeMilestonesResult>;

  /** Search the repo's branches. */
  searchBranches?(directory: string, query: string, options?: { sourceRepo?: string | null }): Promise<ForgeBranchesResult>;

  /** Search the repo's tags. */
  searchTags?(directory: string, query: string, options?: { sourceRepo?: string | null }): Promise<ForgeTagsResult>;

  // --- Write operations ---
  //
  // Every write method is optional and capability-flagged: the UI gates on
  // method presence plus `capabilities` before enabling an affordance. Methods
  // return `{ ok: false, error }` — never throw — when the runtime API is
  // missing, the wire call fails, or the provider does not support the
  // operation.

  /**
   * Post a comment on an issue or pull request (the issue-thread comment, not a
   * review comment). Providers route by `ref.kind`, so issues and PRs both get
   * their thread comment. Wraps `github issueComment`/`prComment`, `gitlab
   * issueComment`/`mrComment`, and `gitea issueComment`/`prComment`.
   * `sourceRepo` selects a cross-repo (fork) repository.
   */
  addComment?(
    directory: string,
    ref: ForgeEntityRef,
    input: { body: string },
    options?: { sourceRepo?: string | null },
  ): Promise<ForgeCommentResult>;

  /**
   * Create a new issue in the repository. Wraps `github issueCreate`, `gitlab
   * issueCreate`, and `gitea issueCreate`; labels are a full-set list of names
   * on the create payload (provider-dependent support).
   */
  createIssue?(
    directory: string,
    input: ForgeIssueCreateInput,
    options?: { sourceRepo?: string | null },
  ): Promise<ForgeIssueCreateResult>;

  /**
   * Reply to a comment thread. On GitHub this posts a proper inline
   * review-comment reply via `prReviewComment` (anchored on `inReplyToId`);
   * GitLab and Gitea have no thread-reply API wired up yet, so they fall back
   * to a flat comment on the thread.
   */
  replyToThread?(
    directory: string,
    ref: ForgeEntityRef,
    input: ForgeCommentInput,
    options?: { sourceRepo?: string | null },
  ): Promise<ForgeCommentResult>;

  /**
   * Update an issue/PR: title, body, or open/closed state. Wraps `github
   * issueUpdate`/`prUpdate`, `gitlab issueUpdate`/`mrUpdate`, and `gitea
   * issueUpdate`/`prUpdate`. GitHub's PR route requires a title, so the adapter
   * fetches the current title first when the input omits it.
   */
  updateEntity?(
    directory: string,
    ref: ForgeEntityRef,
    input: { title?: string; body?: string; state?: ForgeWriteState },
    options?: { sourceRepo?: string | null },
  ): Promise<ForgeUpdateResult>;

  /**
   * Submit a review on a pull request. GitHub maps the normalized events onto
   * `APPROVE`/`REQUEST_CHANGES`/`COMMENT`; Gitea onto `APPROVED`/
   * `REQUEST_CHANGES`/`COMMENT`; GitLab supports approvals only —
   * `request-changes` and `comment` return `{ ok: false, error: 'not
   * supported' }` because GitLab exposes no such MR review events.
   */
  submitReview?(
    directory: string,
    ref: ForgeEntityRef,
    input: { event: ForgeReviewEvent; body?: string },
    options?: { sourceRepo?: string | null },
  ): Promise<ForgeReviewResult>;

  /**
   * Toggle draft state. GitHub sets `pulls.update.draft`; GitLab prepends or
   * strips the `Draft: ` title prefix (fetching the current title first);
   * Gitea has no draft concept (`capabilities.draft: false`) and leaves this
   * method undefined.
   */
  toggleDraft?(
    directory: string,
    ref: ForgeEntityRef,
    draft: boolean,
    options?: { sourceRepo?: string | null },
  ): Promise<ForgeUpdateResult>;

  /**
   * Update issue/PR metadata: labels (full-set replace), assignees (logins;
   * not applied on GitLab, which assigns by user ID — no id lookup yet), and
   * milestone (a title the server resolves, or `null` to clear). Wraps the
   * per-provider issue/PR update routes.
   */
  updateMetadata?(
    directory: string,
    ref: ForgeEntityRef,
    input: { labels?: string[]; assignees?: string[]; milestone?: string | null },
    options?: { sourceRepo?: string | null },
  ): Promise<ForgeUpdateResult>;
}
