/**
 * Pure normalization mappers from the per-provider wire shapes
 * (`@/lib/api/types.ts`: GitHubAPI / GitLabAPI / GiteaAPI) onto the
 * provider-agnostic `Forge*` entities (`./types`).
 *
 * Every mapper is a pure projection — no network, no state, no throw. Missing
 * optional fields are dropped from the output, and list-shaped fields default
 * to `[]` so consumers never see `undefined` where the contract promises an
 * array. All mappers are exported so tests can feed them fixture payloads and
 * spot-check the field mapping.
 */

import type {
  GiteaComment,
  GiteaCommitStatus,
  GiteaIssue,
  GiteaIssueSummary,
  GiteaPullRequest,
  GiteaPullRequestCommit,
  GiteaPullRequestContextResult,
  GiteaReview,
  GiteaUserSummary,
  GitHubCheckRun,
  GitHubChecksSummary,
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueSummary,
  GitHubPullRequestCommit,
  GitHubPullRequestContextResult,
  GitHubPullRequestReview,
  GitHubPullRequestSummary,
  GitHubTimelineEvent,
  GitHubUserSummary,
  GitLabIssue,
  GitLabIssueComment,
  GitLabIssueSummary,
  GitLabMergeRequest,
  GitLabMergeRequestCommit,
  GitLabMergeRequestContextResult,
  GitLabRepoRef,
  GitLabTimelineEvent,
  GitLabUserSummary,
} from '@/lib/api/types';
import type { ForgePullRequestContext } from './provider';
import type {
  ForgeCheck,
  ForgeCheckState,
  ForgeChecksSummary,
  ForgeComment,
  ForgeCommit,
  ForgeEntityState,
  ForgeFileChange,
  ForgeIssue,
  ForgePullRequest,
  ForgeRepoRef,
  ForgeReview,
  ForgeTimelineEvent,
  ForgeTimelineEventType,
  ForgeUser,
} from './types';

// GitHubPullRequestReviewComment is not exported from '@/lib/api/types';
// redeclare the subset the mapper consumes.
type GithubReviewComment = {
  id: number;
  url: string;
  body: string;
  author?: GitHubUserSummary | null;
  path?: string;
  line?: number | null;
  position?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Map a provider state string onto the normalized lifecycle state. GitLab uses
 * 'opened' where GitHub/Gitea use 'open'; anything unrecognized collapses to
 * 'closed' so an unknown state never renders as an active (open) entity.
 */
export const stateOf = (value: string | null | undefined): ForgeEntityState => {
  switch (value) {
    case 'open':
    case 'opened':
      return 'open';
    case 'merged':
      return 'merged';
    default:
      return 'closed';
  }
};

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const mapGithubUser = (user: GitHubUserSummary): ForgeUser => ({
  id: user.login,
  login: user.login,
  name: user.name,
  avatarUrl: user.avatarUrl,
});

export const mapGitlabUser = (user: GitLabUserSummary): ForgeUser => ({
  id: String(user.id ?? user.username),
  login: user.username,
  name: user.name,
  avatarUrl: user.avatarUrl,
  url: user.webUrl,
});

export const mapGiteaUser = (user: GiteaUserSummary): ForgeUser => ({
  id: String(user.id ?? user.username),
  login: user.username,
  name: user.name,
  avatarUrl: user.avatarUrl,
  url: user.webUrl,
});

// ---------------------------------------------------------------------------
// Repo-scoped lookup results
// ---------------------------------------------------------------------------

/** Map a GitHub repo assignee item onto `ForgeUser` (same shape as GitHubUserSummary). */
export const mapGithubAssignee = (assignee: GitHubUserSummary): ForgeUser => ({
  id: assignee.login,
  login: assignee.login,
  name: assignee.name,
  avatarUrl: assignee.avatarUrl,
});

/** Map a GitLab project member (wire `members/all` item) onto `ForgeUser`. */
export const mapGitlabMember = (member: GitLabUserSummary): ForgeUser => ({
  id: String(member.id ?? member.username),
  login: member.username,
  name: member.name,
  avatarUrl: member.avatarUrl,
  url: member.webUrl,
});

/** Map a Gitea repo-assignee item onto `ForgeUser` (same shape as GiteaUserSummary). */
export const mapGiteaAssignee = (assignee: GiteaUserSummary): ForgeUser => ({
  id: String(assignee.id ?? assignee.username),
  login: assignee.username,
  name: assignee.name,
  avatarUrl: assignee.avatarUrl,
  url: assignee.webUrl,
});

// ---------------------------------------------------------------------------
// Pull requests / merge requests
// ---------------------------------------------------------------------------

export const mapGithubPr = (pr: GitHubPullRequestSummary): ForgePullRequest => ({
  number: pr.number,
  title: pr.title,
  body: pr.body,
  state: stateOf(pr.state),
  draft: !!pr.draft,
  author: pr.author ? mapGithubUser(pr.author) : undefined,
  createdAt: pr.createdAt,
  updatedAt: pr.updatedAt,
  base: { ref: pr.base ?? '' },
  head: { ref: pr.head ?? '', repo: null },
  headSha: pr.headSha,
  mergeable: pr.mergeable ?? null,
  mergeableState: pr.mergeableState ?? null,
  // The enriched summary fields are optional (older route responses may omit
  // them), so the projections degrade to empty instead of leaking undefined
  // into consumers.
  labels: (pr.labels ?? []).map((label) => ({ name: label.name, color: label.color })),
  assignees: (pr.assignees ?? []).map(mapGithubUser),
  milestone: pr.milestone ? { title: pr.milestone.title } : null,
  commentsCount: pr.commentsCount,
  url: pr.url,
});

export const mapGitlabMr = (mr: GitLabMergeRequest): ForgePullRequest => ({
  number: mr.number,
  title: mr.title,
  body: mr.body,
  state: stateOf(mr.state),
  draft: !!mr.draft || /^Draft:/.test(mr.title),
  author: mapGitlabUser(mr.author),
  createdAt: mr.createdAt,
  updatedAt: mr.updatedAt,
  base: { ref: mr.targetBranch ?? '' },
  head: { ref: mr.sourceBranch ?? '' },
  headSha: mr.headSha,
  labels: [],
  assignees: [],
  milestone: null,
  url: mr.url,
});

export const mapGiteaPr = (pr: GiteaPullRequest): ForgePullRequest => ({
  number: pr.number,
  title: pr.title,
  body: pr.body,
  state: stateOf(pr.state),
  // Gitea/Forgejo have no draft concept: PRs are either open or mergeable.
  draft: false,
  author: mapGiteaUser(pr.author),
  createdAt: pr.createdAt,
  updatedAt: pr.updatedAt,
  base: { ref: pr.targetBranch ?? '' },
  head: { ref: pr.sourceBranch ?? '' },
  mergeable: pr.mergeable ?? null,
  labels: (pr.labels ?? []).map((name) => ({ name })),
  assignees: [],
  milestone: null,
  url: pr.url,
});

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

// The list API returns summaries (no body/assignees/createdAt/updatedAt), the
// detail API returns the full issue. The mapper accepts both by reading the
// detail fields as optional, so the same projection serves both call sites.
type GithubIssueInput = GitHubIssueSummary & Partial<Pick<GitHubIssue, 'body' | 'assignees' | 'createdAt' | 'updatedAt'>>;

export const mapGithubIssue = (issue: GithubIssueInput): ForgeIssue => ({
  number: issue.number,
  title: issue.title,
  body: issue.body,
  state: stateOf(issue.state),
  author: issue.author ? mapGithubUser(issue.author) : undefined,
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
  labels: (issue.labels ?? []).map((label) => ({ name: label.name, color: label.color })),
  assignees: (issue.assignees ?? []).map(mapGithubUser),
  milestone: null,
  url: issue.url,
});

type GitlabIssueInput = GitLabIssueSummary & Partial<Pick<GitLabIssue, 'body' | 'assignees' | 'createdAt' | 'updatedAt'>>;

export const mapGitlabIssue = (issue: GitlabIssueInput): ForgeIssue => ({
  number: issue.number,
  title: issue.title,
  body: issue.body,
  state: stateOf(issue.state),
  author: mapGitlabUser(issue.author),
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
  labels: (issue.labels ?? []).map((name) => ({ name })),
  assignees: (issue.assignees ?? []).map(mapGitlabUser),
  milestone: null,
  url: issue.url,
});

type GiteaIssueInput = GiteaIssueSummary & Partial<Pick<GiteaIssue, 'body' | 'createdAt' | 'updatedAt'>>;

export const mapGiteaIssue = (issue: GiteaIssueInput): ForgeIssue => ({
  number: issue.number,
  title: issue.title,
  body: issue.body,
  state: stateOf(issue.state),
  author: mapGiteaUser(issue.author),
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
  labels: (issue.labels ?? []).map((name) => ({ name })),
  // Gitea's wire issue type carries no assignees.
  assignees: [],
  milestone: null,
  url: issue.url,
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export const mapGithubIssueComment = (comment: GitHubIssueComment): ForgeComment => ({
  id: String(comment.id),
  body: comment.body,
  author: comment.author ? mapGithubUser(comment.author) : undefined,
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  url: comment.url,
  inReplyToId: null,
  path: null,
  line: null,
  commitSha: null,
});

export const mapGithubReviewComment = (comment: GithubReviewComment): ForgeComment => ({
  id: String(comment.id),
  body: comment.body,
  author: comment.author ? mapGithubUser(comment.author) : undefined,
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  url: comment.url,
  path: comment.path,
  line: comment.line ?? comment.position ?? null,
  inReplyToId: null,
  commitSha: null,
});

export const mapGitlabNoteComment = (comment: GitLabIssueComment): ForgeComment => ({
  id: String(comment.id),
  body: comment.body,
  author: mapGitlabUser(comment.author),
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  url: comment.url,
});

export const mapGiteaComment = (comment: GiteaComment): ForgeComment => ({
  id: String(comment.id),
  body: comment.body,
  author: mapGiteaUser(comment.author),
  createdAt: comment.createdAt,
  url: comment.url,
});

/**
 * GitHub review-comment replies carry the same wire shape as review comments,
 * so the reply maps through the review-comment projection. Kept as a distinct
 * export so the adapter's reply path is self-documenting.
 */
export const mapGithubReviewCommentReply = (comment: GithubReviewComment): ForgeComment => ({
  ...mapGithubReviewComment(comment),
});

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/**
 * Map a provider review state onto the normalized vocabulary. GitHub uses
 * 'CHANGES_REQUESTED' where Gitea uses 'REQUEST_CHANGES'; both collapse to
 * 'requested-changes'. Anything unrecognized collapses to 'pending' so an
 * unknown marker never renders as a completed review.
 */
export const mapReviewState = (state: string): ForgeReview['state'] => {
  switch (state.toLowerCase()) {
    case 'approved':
      return 'approved';
    case 'changes_requested':
    case 'request_changes':
    case 'requested-changes':
      return 'requested-changes';
    case 'commented':
    case 'comment':
      return 'commented';
    case 'dismissed':
      return 'dismissed';
    default:
      return 'pending';
  }
};

export const mapGithubReview = (review: GitHubPullRequestReview): ForgeReview => ({
  id: review.id,
  state: mapReviewState(review.state),
  author: review.author ? mapGithubUser(review.author) : undefined,
  submittedAt: review.submittedAt,
  body: review.body ?? undefined,
  commitSha: review.commitSha ?? undefined,
});

export const mapGiteaReview = (review: GiteaReview): ForgeReview => ({
  id: review.id,
  state: mapReviewState(review.state),
  author: review.author ? mapGiteaUser(review.author) : undefined,
  submittedAt: review.submittedAt,
  body: review.body ?? undefined,
  commitSha: review.commitSha ?? undefined,
});

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Map a GitHub Check Run status/conclusion pair onto the normalized check
 * state. A conclusion always wins; absent conclusions fall back to the run
 * status (anything not yet 'completed' is pending).
 */
export const mapCheckRunState = (status?: string, conclusion?: string | null): ForgeCheckState => {
  const c = conclusion;
  if (c && c !== '') {
    switch (c) {
      case 'success':
      case 'neutral':
        return 'success';
      case 'failure':
      case 'error':
      case 'timed_out':
      case 'startup_failure':
      case 'deadline_exceeded':
        return 'failure';
      case 'cancelled':
        return 'cancelled';
      case 'skipped':
      case 'stale':
        return 'skipped';
      case 'action_required':
        return 'pending';
      default:
        return 'unknown';
    }
  }
  // No conclusion yet: queued, in_progress, waiting, ... are all still running.
  return status === 'completed' ? 'unknown' : 'pending';
};

export const mapGithubCheckSummary = (
  checks: GitHubChecksSummary,
  checkRuns?: GitHubCheckRun[],
): ForgeChecksSummary => ({
  state: checks.state,
  total: checks.total,
  success: checks.success,
  failure: checks.failure,
  pending: checks.pending,
  checks: (checkRuns ?? []).map((run): ForgeCheck => ({
    kind: 'check-run',
    name: run.name,
    state: mapCheckRunState(run.status, run.conclusion),
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    url: run.detailsUrl,
    description: run.output?.summary,
    details: {
      title: run.output?.title,
      summary: run.output?.summary,
      text: run.output?.text,
      annotations: (run.annotations ?? []).map((annotation) => ({
        path: annotation.path,
        startLine: annotation.startLine,
        endLine: annotation.endLine,
        level: annotation.level,
        message: annotation.message,
        title: annotation.title,
      })),
    },
  })),
});

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

export const mapGithubContext = (result: GitHubPullRequestContextResult): ForgePullRequestContext => ({
  connected: result.connected,
  repo: result.repo ? mapGithubRepoRef(result.repo) : null,
  pr: result.pr ? mapGithubPr(result.pr) : null,
  issueComments: (result.issueComments ?? []).map(mapGithubIssueComment),
  reviewComments: (result.reviewComments ?? []).map(mapGithubReviewComment),
  files: (result.files ?? []).map(mapFileChange),
  diff: result.diff,
  checks: result.checks ? mapGithubCheckSummary(result.checks, result.checkRuns) : null,
  fetchedAt: result.fetchedAt,
});

export const mapGitlabContext = (result: GitLabMergeRequestContextResult): ForgePullRequestContext => ({
  connected: result.connected,
  repo: result.repo ? mapGitlabRepoRef(result.repo) : null,
  pr: result.mr ? mapGitlabMr(result.mr) : null,
  issueComments: (result.comments ?? []).map(mapGitlabNoteComment),
  reviewComments: [],
  files: (result.files ?? []).map(mapFileChange),
  diff: result.diff,
  checks: null,
});

export const mapGiteaContext = (result: GiteaPullRequestContextResult): ForgePullRequestContext => ({
  connected: result.connected,
  repo: result.repo ? mapGiteaRepoRef(result.repo) : null,
  pr: result.pr ? mapGiteaPr(result.pr) : null,
  issueComments: (result.comments ?? []).map(mapGiteaComment),
  reviewComments: [],
  files: (result.files ?? []).map(mapFileChange),
  diff: result.diff,
  checks: null,
});

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

/** First line of a commit message, used as the row summary when absent. */
export const firstLine = (message: string): string => message.split('\n')[0] ?? message;

const mapCommit = (
  c: { sha: string; shortSha?: string; message: string; summary?: string; committedAt?: string; parents?: string[] },
  author: ForgeUser | undefined,
): ForgeCommit => ({
  sha: c.sha,
  shortSha: c.shortSha ?? c.sha.slice(0, 7),
  message: c.message,
  summary: c.summary ?? firstLine(c.message),
  author,
  committedAt: c.committedAt,
  parents: c.parents ?? [],
});

export const mapGithubCommits = (commits: GitHubPullRequestCommit[]): ForgeCommit[] =>
  commits.map((c) => mapCommit(c, c.author ? mapGithubUser(c.author) : undefined));

export const mapGitlabCommits = (commits: GitLabMergeRequestCommit[]): ForgeCommit[] =>
  commits.map((c) => {
    const author = c.authorName
      ? { id: c.authorName, login: c.authorName, name: c.authorName }
      : undefined;
    return mapCommit(c, author);
  });

export const mapGiteaCommits = (commits: GiteaPullRequestCommit[]): ForgeCommit[] =>
  commits.map((c) => mapCommit(c, c.author ? mapGiteaUser(c.author) : undefined));

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * Map a provider timeline event type onto the normalized vocabulary.
 * Provider types are lowercase; anything unrecognized collapses to 'other' so
 * an unknown marker never crashes the label lookup.
 */
export const normalizeEventType = (raw: string): ForgeTimelineEventType => {
  switch (raw) {
    case 'cross-referenced':
      return 'referenced';
    case 'committed':
    case 'opened':
    case 'reopened':
    case 'closed':
    case 'merged':
    case 'reviewed':
    case 'approved':
    case 'requested-changes':
    case 'commented':
    case 'referenced':
    case 'labeled':
    case 'unlabeled':
    case 'assigned':
    case 'unassigned':
    case 'milestoned':
    case 'demilestoned':
      return raw;
    default:
      return 'other';
  }
};

export const mapGithubTimelineEvents = (events: GitHubTimelineEvent[]): ForgeTimelineEvent[] =>
  events.map((event) => ({
    id: String(event.id),
    type: normalizeEventType(event.type),
    author: event.author ? mapGithubUser(event.author) : undefined,
    createdAt: event.createdAt,
    body: event.body ?? undefined,
    commitSha: event.commitSha ?? undefined,
    source: 'github-timeline',
  }));

export const mapGitlabTimelineEvents = (events: GitLabTimelineEvent[]): ForgeTimelineEvent[] =>
  events.map((event) => ({
    id: String(event.id),
    type: normalizeEventType(event.type),
    author: event.author ? mapGitlabUser(event.author) : undefined,
    createdAt: event.createdAt,
    body: event.body ?? undefined,
    source: 'gitlab-system-note',
  }));

/**
 * Gitea has no timeline endpoint; its pull-request reviews are the closest
 * activity signal, so the adapter synthesizes timeline events from them.
 */
export const mapGiteaReviewsToEvents = (reviews: GiteaReview[]): ForgeTimelineEvent[] =>
  reviews.flatMap((review) => {
    const type = normalizeReviewState(review.state);
    if (!type) return [];
    return [{
      id: String(review.id),
      type,
      author: review.author ? mapGiteaUser(review.author) : undefined,
      createdAt: review.submittedAt,
      body: review.body ?? undefined,
      commitSha: review.commitSha ?? undefined,
      source: 'gitea-review',
    }];
  });

const normalizeReviewState = (state: string): ForgeTimelineEventType | null => {
  switch (state) {
    case 'APPROVED':
      return 'approved';
    case 'REQUEST_CHANGES':
      return 'requested-changes';
    case 'COMMENT':
      return 'commented';
    case 'DISMISSED':
      return 'other';
    default:
      // PENDING and anything unknown produce no event.
      return null;
  }
};

// ---------------------------------------------------------------------------
// Checks (commit statuses)
// ---------------------------------------------------------------------------

/**
 * Map a flat commit-status state onto the normalized check state. 'error'
 * counts as a failure, 'warning' as still running (pending), and anything
 * unrecognized collapses to 'unknown'.
 */
export const mapStatusState = (state: string): ForgeCheckState => {
  switch (state) {
    case 'success':
      return 'success';
    case 'failure':
      return 'failure';
    case 'error':
      return 'failure';
    case 'pending':
      return 'pending';
    case 'warning':
      return 'pending';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    default:
      return 'unknown';
  }
};

/**
 * Aggregate a status list into one state: any failure/error wins, else any
 * pending, else success.
 */
export const aggregateStatusState = (statuses: GiteaCommitStatus[]): ForgeCheckState => {
  if (statuses.some((s) => s.state === 'failure' || s.state === 'error')) return 'failure';
  if (statuses.some((s) => s.state === 'pending' || s.state === 'warning')) return 'pending';
  return 'success';
};

export const mapGiteaStatuses = (statuses: GiteaCommitStatus[]): ForgeChecksSummary => ({
  state: aggregateStatusState(statuses),
  total: statuses.length,
  success: statuses.filter((s) => s.state === 'success').length,
  failure: statuses.filter((s) => s.state === 'failure' || s.state === 'error').length,
  pending: statuses.filter((s) => s.state === 'pending' || s.state === 'warning').length,
  checks: statuses.map((status): ForgeCheck => ({
    kind: 'commit-status',
    name: status.name,
    state: mapStatusState(status.state),
    url: status.url ?? undefined,
    description: status.description ?? undefined,
    startedAt: status.createdAt,
    completedAt: status.createdAt,
  })),
});

// ---------------------------------------------------------------------------
// Internal helpers (repo refs and file changes; not part of the public API)
// ---------------------------------------------------------------------------

export const mapGithubRepoRef = (ref: { owner: string; repo: string; url: string }): ForgeRepoRef => ({
  owner: ref.owner,
  repo: ref.repo,
  url: ref.url,
  provider: 'github',
});

export const mapGitlabRepoRef = (ref: GitLabRepoRef): ForgeRepoRef => ({
  owner: ref.namespace,
  repo: ref.project,
  url: ref.url,
  baseUrl: ref.baseUrl,
  provider: 'gitlab',
});

export const mapGiteaRepoRef = (ref: { owner: string; repo: string; url?: string }): ForgeRepoRef => ({
  owner: ref.owner,
  repo: ref.repo,
  url: ref.url,
  provider: 'gitea',
});

type WireFileChange = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
};

const mapFileChange = (file: WireFileChange): ForgeFileChange => ({
  filename: file.filename,
  status: file.status,
  additions: file.additions,
  deletions: file.deletions,
  patch: file.patch,
});
