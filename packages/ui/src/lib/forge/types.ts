/**
 * Normalized, provider-agnostic entities for the git-forge facade.
 *
 * Every type here is a projection of the per-provider wire shapes defined in
 * `@/lib/api/types.ts` (GitHubAPI / GitLabAPI / GiteaAPI) plus provider-native
 * APIs (GitHub checks, GitLab review approvals). Adapters map provider payloads
 * onto these shapes in a follow-up chunk; this file declares the contract only
 * and contains no runtime code.
 *
 * Provider terminology differences are intentional:
 * - GitHub: issues + pull requests (PR), checks via Check Runs / Commit Statuses.
 * - GitLab: issues + merge requests (MR), pipelines/statuses as commit statuses.
 * - Gitea/Forgejo: issues + pull requests (PR), GitHub-style REST v1.
 * The normalized vocabulary always uses the GitHub-ish noun ("pull request",
 * "check run"), with the provider-specific term documented where it differs.
 */

/** Which git-forge backend an adapter talks to. */
export type ForgeProviderKind = 'github' | 'gitlab' | 'gitea';

/** What the provider exposes for CI/status on a PR/MR. */
export type ForgeChecksCapability = 'check-runs' | 'commit-statuses' | 'none';
/** What the provider lets the UI do with reviews. */
export type ForgeReviewsCapability = 'submit' | 'approve-only' | 'none';

/**
 * Declared capabilities of a forge provider.
 *
 * The UI uses these to enable/disable affordances (draft toggle, label editor,
 * per-line review comments, ...) rather than guessing from the provider kind.
 * A provider must be honest here: `submit` reviews implies the API also exposes
 * review objects with distinct states (see `ForgeReview.state`).
 */
export interface ForgeProviderCapabilities {
  checks: ForgeChecksCapability;
  reviews: ForgeReviewsCapability;
  /** Draft <-> ready toggle supported (GitHub draft PRs; GitLab/Gitea draft markers). */
  draft: boolean;
  labels: boolean;
  assignees: boolean;
  milestones: boolean;
  /** Provider exposes distinct event types (opened/approved/merged markers), not just comments. */
  timelineEvents: boolean;
  /** Per-line (path:line) review comments. */
  inlineComments: boolean;
  /** Comment threads that can be replied to. */
  threads: boolean;
  /** Repo-scoped user search (assignable users) for mentions/assignees. */
  userSearch: boolean;
  /** Repo-scoped label search for the label picker. */
  labelSearch: boolean;
  /** Repo-scoped milestone search for the milestone picker. */
  milestoneSearch: boolean;
  /** Repo-scoped branch search. */
  branchSearch: boolean;
  /** Repo-scoped tag search. */
  tagSearch: boolean;
}

/** A person as surfaced by the forge (issue author, reviewer, commit author, ...). */
export interface ForgeUser {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  url?: string;
}

/** A label as displayed on issues/PRs. GitHub colors are hex; GitLab/Gitea carry none. */
export interface ForgeLabel {
  name: string;
  color?: string;
  description?: string;
}

/** A milestone a PR/issue can be attached to. `active` is GitLab's open-milestone state. */
export interface ForgeMilestone {
  title: string;
  state?: 'open' | 'closed' | 'active';
}

/**
 * A repository reference scoped to its forge.
 *
 * GitHub and Gitea are flat `owner/repo`. GitLab uses a top-level namespace as
 * `owner` with multi-segment project paths (e.g. `group/sub`) in `namespace`;
 * the combined project path is `namespace + '/' + repo` when `namespace` is set.
 */
export interface ForgeRepoRef {
  /** For gitlab: top-level namespace; multi-segment namespaces go in `namespace`. */
  owner: string;
  /** GitLab multi-segment namespace path (e.g. 'group/sub'). */
  namespace?: string;
  repo: string;
  url?: string;
  /** Provider API base (for self-hosted gitlab/gitea). */
  baseUrl?: string;
  provider: ForgeProviderKind;
}

/** Open/closed lifecycle state, shared by issues and PRs/MRs. 'merged' is PR-only. */
export type ForgeEntityState = 'open' | 'closed' | 'merged';

/** A normalized issue (GitLab issue / Gitea issue map 1:1; GitHub issue maps directly). */
export interface ForgeIssue {
  number: number;
  title: string;
  body?: string;
  state: ForgeEntityState;
  author?: ForgeUser;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string;
  labels: ForgeLabel[];
  assignees: ForgeUser[];
  milestone?: ForgeMilestone | null;
  commentsCount?: number;
  url?: string;
}

/** A branch reference on a PR/MR. `repo` is present for cross-repo (fork) head/base. */
export interface ForgeBranchRef {
  ref: string;
  /** Cross-repo (fork) head/base; null/absent means the same repository. */
  repo?: ForgeRepoRef | null;
}

/** A normalized pull request / merge request. */
export interface ForgePullRequest {
  number: number;
  title: string;
  body?: string;
  state: ForgeEntityState;
  draft: boolean;
  author?: ForgeUser;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string;
  base: ForgeBranchRef;
  head: ForgeBranchRef;
  /** HEAD sha of the source branch; nil for forks when not expanded by the provider. */
  headSha?: string;
  mergeable?: boolean | null;
  /** Provider mergeability detail (GitHub `mergeable_state`, GitLab `detailed_merge_status`). */
  mergeableState?: string | null;
  labels: ForgeLabel[];
  assignees: ForgeUser[];
  milestone?: ForgeMilestone | null;
  commentsCount?: number;
  url?: string;
}

/**
 * A normalized comment.
 *
 * One shape for both issue comments and review comments: inline review comments
 * carry `path`/`line`/`commitSha`, and thread replies carry `inReplyToId`
 * (GitHub review-comment reply, GitLab note reply).
 */
export interface ForgeComment {
  id: string;
  body: string;
  author?: ForgeUser;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  /** Thread reply anchor (github review comment / gitlab note reply). */
  inReplyToId?: string | null;
  /** For inline (review) comments: file path. */
  path?: string | null;
  /** For inline comments: line number. */
  line?: number | null;
  /** For review comments. */
  commitSha?: string | null;
}

/**
 * Distinct timeline/activity event kinds.
 *
 * Which of these actually occur depends on the provider's `timelineEvents`
 * capability: GitHub exposes a rich timeline (opened/approved/merged markers),
 * GitLab exposes system notes, Gitea typically only comments.
 */
export type ForgeTimelineEventType =
  | 'opened' | 'reopened' | 'closed' | 'merged'
  | 'committed' | 'reviewed' | 'approved' | 'requested-changes'
  | 'commented' | 'referenced' | 'labeled' | 'unlabeled' | 'assigned' | 'unassigned'
  | 'milestoned' | 'demilestoned' | 'other';

/** A single entry in an issue/PR timeline. */
export interface ForgeTimelineEvent {
  id: string;
  type: ForgeTimelineEventType;
  author?: ForgeUser;
  createdAt?: string;
  body?: string;
  commitSha?: string;
  /**
   * Provider name for provenance, e.g. 'github-timeline' | 'gitlab-system-note'
   * | 'gitea-synthesized'.
   */
  source: string;
}

/** A normalized commit. */
export interface ForgeCommit {
  sha: string;
  shortSha: string;
  message: string;
  /** First line of the message. */
  summary?: string;
  author?: ForgeUser;
  committer?: ForgeUser;
  committedAt?: string;
  parents: string[];
}

/** A file changed by a PR/MR, with diff stats and optional patch. */
export interface ForgeFileChange {
  filename: string;
  /** 'added' | 'modified' | 'removed' | 'renamed'. */
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

/**
 * Rolled-up CI/status state of a PR/MR.
 * 'success' also covers GitLab/Gitea statuses where a passing pipeline is 'success'.
 */
export type ForgeCheckState = 'success' | 'failure' | 'pending' | 'cancelled' | 'skipped' | 'unknown';
/** Whether the check is a GitHub Check Run or a flat status (commit status / GitLab pipeline). */
export type ForgeCheckKind = 'check-run' | 'commit-status';

/** An annotation attached to a check run, pointing at a file/line range. */
export interface ForgeCheckAnnotation {
  path?: string;
  startLine?: number;
  endLine?: number;
  level?: string;
  message?: string;
  title?: string;
}

/** A single check run or commit status on a PR/MR. */
export interface ForgeCheck {
  kind: ForgeCheckKind;
  name: string;
  state: ForgeCheckState;
  startedAt?: string;
  completedAt?: string;
  url?: string;
  description?: string;
  details?: {
    title?: string;
    summary?: string;
    text?: string;
    annotations?: ForgeCheckAnnotation[];
  };
}

/** Aggregate check state for a PR/MR plus the individual checks. */
export interface ForgeChecksSummary {
  state: ForgeCheckState;
  total: number;
  success: number;
  failure: number;
  pending: number;
  checks: ForgeCheck[];
}

/**
 * A review submitted on a PR/MR.
 * GitLab's single approval maps to 'approved'; GitHub pull-request reviews map
 * directly onto the states.
 */
export interface ForgeReview {
  id: string;
  state: 'approved' | 'requested-changes' | 'commented' | 'pending' | 'dismissed';
  author?: ForgeUser;
  submittedAt?: string;
  body?: string;
  commitSha?: string;
}
