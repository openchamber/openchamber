/**
 * Forge provider adapters.
 *
 * Each adapter implements `ForgeProvider` against one provider's wire API
 * (`GitHubAPI` / `GitLabAPI` / `GiteaAPI` from `@/lib/api/types.ts`) and
 * normalizes results through `./normalize`. Adapters are deliberately
 * defensive: when the underlying runtime API or a specific method is missing,
 * or the wire call throws, they return the graceful envelope (`connected:
 * false`, empty collections) instead of throwing — the caller treats
 * `connected: false` as "no authoritative data", never as an empty success.
 */

import type {
  GiteaAPI,
  GiteaPullReviewInput,
  GitHubAPI,
  GitHubPullRequestReviewEvent,
  GitHubRepoSelector,
  GitLabAPI,
} from '@/lib/api/types';
import type {
  ForgeChecksResult,
  ForgeCommitsResult,
  ForgeIssueDetail,
  ForgeIssuesResult,
  ForgeProvider,
  ForgePullRequestContext,
  ForgePullRequestsResult,
  ForgeReviewEvent,
  ForgeTimelineResult,
  ForgeUpdateResult,
} from './provider';
import type { ForgeProviderCapabilities, ForgeProviderKind } from './types';
import {
  mapGiteaCommits,
  mapGiteaComment,
  mapGiteaContext,
  mapGiteaIssue,
  mapGiteaPr,
  mapGiteaRepoRef,
  mapGiteaReviewsToEvents,
  mapGiteaReview,
  mapGiteaStatuses,
  mapGithubCommits,
  mapGithubContext,
  mapGithubIssue,
  mapGithubIssueComment,
  mapGithubPr,
  mapGithubRepoRef,
  mapGithubReview,
  mapGithubReviewCommentReply,
  mapGithubTimelineEvents,
  mapGitlabCommits,
  mapGitlabContext,
  mapGitlabIssue,
  mapGitlabMr,
  mapGitlabNoteComment,
  mapGitlabRepoRef,
  mapGitlabTimelineEvents,
} from './normalize';

const GITHUB_CAPABILITIES: ForgeProviderCapabilities = {
  checks: 'check-runs',
  reviews: 'submit',
  draft: true,
  labels: true,
  assignees: true,
  milestones: true,
  timelineEvents: true,
  inlineComments: true,
  threads: true,
};

const GITLAB_CAPABILITIES: ForgeProviderCapabilities = {
  checks: 'none',
  reviews: 'approve-only',
  draft: true,
  labels: true,
  assignees: true,
  milestones: true,
  timelineEvents: true,
  inlineComments: false,
  threads: true,
};

const GITEA_CAPABILITIES: ForgeProviderCapabilities = {
  checks: 'commit-statuses',
  reviews: 'submit',
  draft: false,
  labels: true,
  assignees: true,
  milestones: true,
  timelineEvents: true,
  inlineComments: true,
  threads: true,
};

// Gitea's 'commit-statuses' checks and inline comments land once Slice B adds
// the commit-status / review-comment routes to the Gitea wire API.

const EMPTY_PR_LIST = (page: number): ForgePullRequestsResult => ({
  connected: false,
  repo: null,
  prs: [],
  page,
  hasMore: false,
});

const EMPTY_ISSUE_LIST = (page: number): ForgeIssuesResult => ({
  connected: false,
  repo: null,
  issues: [],
  page,
  hasMore: false,
});

const EMPTY_CONTEXT: ForgePullRequestContext = {
  connected: false,
  repo: null,
  pr: null,
  issueComments: [],
  reviewComments: [],
  files: [],
  checks: null,
};

const EMPTY_ISSUE_DETAIL: ForgeIssueDetail = {
  connected: false,
  repo: null,
  issue: null,
  comments: [],
  commentsError: null,
};

// Stable, detail-free marker for comment-fetch failures: surfaces the partial
// result without leaking the underlying error message.
const COMMENTS_ERROR = 'comments failed to load';

// Stable, detail-free marker for rich-view (commits/timeline/checks) fetch
// failures; callers distinguish "not attempted" (no error) from "failed".
const LOAD_ERROR = 'failed to load';

const EMPTY_COMMITS: ForgeCommitsResult = { connected: false, repo: null, commits: [] };

const EMPTY_TIMELINE: ForgeTimelineResult = { connected: false, repo: null, events: [] };

const EMPTY_CHECKS: ForgeChecksResult = { connected: false, repo: null, checks: null };

/**
 * Split a `"owner/repo"` selector into its parts, as used by the
 * `sourceRepo` option of the forge interface. Returns null for anything that
 * does not carry both segments.
 */
const parseOwnerRepo = (sourceRepo?: string | null): GitHubRepoSelector | null => {
  if (!sourceRepo) return null;
  const [owner, repo] = sourceRepo.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
};

/**
 * Split a GitLab `"group/sub/project"` selector into namespace + project: the
 * last segment is the project, everything before it the (possibly multi-segment)
 * namespace. Returns an empty object for anything without both parts.
 */
const parseGitlabNamespace = (sourceRepo?: string | null): { namespace?: string; project?: string } => {
  if (!sourceRepo) return {};
  const segments = sourceRepo.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return {};
  const project = segments.pop() as string;
  return { namespace: segments.join('/'), project };
};

// Stable, detail-free marker for write failures: surfaces the failure without
// leaking the underlying error message, mirroring LOAD_ERROR for rich views.
const WRITE_ERROR = 'failed to load';

/**
 * Fetch the current PR title so a write that omits it can still satisfy the
 * provider's title-required update route (GitHub). Returns null when the title
 * cannot be resolved (missing API or wire failure) so callers degrade.
 */
const resolvePrTitle = async (
  api: Pick<GitHubAPI, 'prContext'>,
  directory: string,
  number: number,
): Promise<string | null> => {
  if (!api.prContext) return null;
  try {
    const context = await api.prContext(directory, number);
    return context.pr?.title ?? null;
  } catch {
    return null;
  }
};

// Normalized review events → provider wire events. Explicit maps, because a
// simple toUpperCase() would mangle 'request-changes' (hyphen) into
// 'REQUEST-CHANGES' while GitHub/Gitea expect 'REQUEST_CHANGES' (underscore).
const GITHUB_REVIEW_EVENTS: Record<ForgeReviewEvent, GitHubPullRequestReviewEvent> = {
  approve: 'APPROVE',
  'request-changes': 'REQUEST_CHANGES',
  comment: 'COMMENT',
};

const GITEA_REVIEW_EVENTS: Record<ForgeReviewEvent, GiteaPullReviewInput['event']> = {
  approve: 'APPROVED',
  'request-changes': 'REQUEST_CHANGES',
  comment: 'COMMENT',
};

const WRITE_NOT_SUPPORTED: ForgeUpdateResult = { ok: false, error: 'not supported' };

export const createGithubForgeProvider = (api: GitHubAPI): ForgeProvider => ({
  kind: 'github',
  capabilities: GITHUB_CAPABILITIES,

  async getPullRequestForBranch(directory, branch, options) {
    if (!api.prStatus) return null;
    try {
      const status = await api.prStatus(directory, branch, options?.remote);
      return status.pr ? mapGithubPr(status.pr) : null;
    } catch {
      return null;
    }
  },

  async listPullRequests(directory, options) {
    if (!api.prsList) return EMPTY_PR_LIST(options?.page ?? 1);
    try {
      const result = await api.prsList(directory, { page: options?.page, query: options?.query });
      return {
        connected: result.connected,
        repo: result.repo ? mapGithubRepoRef(result.repo) : null,
        prs: (result.prs ?? []).map(mapGithubPr),
        page: result.page ?? 1,
        hasMore: result.hasMore ?? false,
      };
    } catch {
      return EMPTY_PR_LIST(options?.page ?? 1);
    }
  },

  async getPullRequestContext(directory, number, options) {
    if (!api.prContext) return EMPTY_CONTEXT;
    try {
      const result = await api.prContext(directory, number, {
        includeDiff: options?.includeDiff,
        sourceRepo: parseOwnerRepo(options?.sourceRepo),
      });
      return mapGithubContext(result);
    } catch {
      return EMPTY_CONTEXT;
    }
  },

  async listIssues(directory, options) {
    if (!api.issuesList) return EMPTY_ISSUE_LIST(options?.page ?? 1);
    try {
      const result = await api.issuesList(directory, { page: options?.page, query: options?.query });
      return {
        connected: result.connected,
        repo: result.repo ? mapGithubRepoRef(result.repo) : null,
        issues: (result.issues ?? []).map(mapGithubIssue),
        page: result.page ?? 1,
        hasMore: result.hasMore ?? false,
      };
    } catch {
      return EMPTY_ISSUE_LIST(options?.page ?? 1);
    }
  },

  async getIssue(directory, number, options) {
    if (!api.issueGet) return EMPTY_ISSUE_DETAIL;
    try {
      const result = await api.issueGet(directory, number, { sourceRepo: parseOwnerRepo(options?.sourceRepo) });
      if (!result.connected) {
        return { connected: false, repo: result.repo ? mapGithubRepoRef(result.repo) : null, issue: null, comments: [], commentsError: null };
      }
      let comments: ForgePullRequestContext['issueComments'] = [];
      let commentsError: string | null = null;
      if (api.issueComments) {
        try {
          const commentsResult = await api.issueComments(directory, number, {
            sourceRepo: parseOwnerRepo(options?.sourceRepo),
          });
          comments = (commentsResult.comments ?? []).map(mapGithubIssueComment);
        } catch {
          // The issue itself is authoritative; a comment failure must not hide
          // it, but it also must not masquerade as an authoritative empty list.
          comments = [];
          commentsError = COMMENTS_ERROR;
        }
      }
      return {
        connected: true,
        repo: result.repo ? mapGithubRepoRef(result.repo) : null,
        issue: result.issue ? mapGithubIssue(result.issue) : null,
        comments,
        commentsError,
      };
    } catch {
      return EMPTY_ISSUE_DETAIL;
    }
  },

  async getCommits(directory, number, options) {
    if (!api.prCommits) return EMPTY_COMMITS;
    try {
      const result = await api.prCommits(directory, number, {
        sourceRepo: parseOwnerRepo(options?.sourceRepo),
      });
      return {
        connected: result.connected,
        repo: result.repo ? mapGithubRepoRef(result.repo) : null,
        commits: result.commits ? mapGithubCommits(result.commits) : [],
      };
    } catch {
      return { ...EMPTY_COMMITS, error: LOAD_ERROR };
    }
  },

  async getTimeline(directory, number, options) {
    if (!api.prTimeline) return EMPTY_TIMELINE;
    try {
      const result = await api.prTimeline(directory, number, {
        sourceRepo: parseOwnerRepo(options?.sourceRepo),
      });
      return {
        connected: result.connected,
        repo: result.repo ? mapGithubRepoRef(result.repo) : null,
        events: result.events ? mapGithubTimelineEvents(result.events) : [],
      };
    } catch {
      return { ...EMPTY_TIMELINE, error: LOAD_ERROR };
    }
  },

  // GitHub check runs ride on getPullRequestContext().checks.
  async getChecks() {
    return null;
  },

  async addComment(directory, ref, input, options) {
    const selector = parseOwnerRepo(options?.sourceRepo);
    const owner = selector?.owner;
    const repo = selector?.repo;
    if (ref.kind === 'issue') {
      if (!api.issueComment) return { ok: false, error: WRITE_ERROR };
      try {
        const result = await api.issueComment({ directory, number: ref.number, body: input.body, owner, repo });
        if (!result.connected) return { ok: false, error: WRITE_ERROR };
        return { ok: true, comment: result.comment ? mapGithubIssueComment(result.comment) : null };
      } catch {
        return { ok: false, error: WRITE_ERROR };
      }
    }
    if (!api.prComment) return { ok: false, error: WRITE_ERROR };
    try {
      const result = await api.prComment({ directory, number: ref.number, body: input.body, owner, repo });
      if (!result.connected) return { ok: false, error: WRITE_ERROR };
      return { ok: true, comment: result.comment ? mapGithubIssueComment(result.comment) : null };
    } catch {
      return { ok: false, error: WRITE_ERROR };
    }
  },

  async replyToThread(directory, ref, input, options) {
    if (ref.kind !== 'pull') {
      // Issues have no inline review comments; reply as a flat thread comment.
      return this.addComment!(directory, ref, { body: input.body }, options);
    }
    if (!api.prReviewComment) return { ok: false, error: WRITE_ERROR };
    try {
      const selector = parseOwnerRepo(options?.sourceRepo);
      const result = await api.prReviewComment({
        directory,
        number: ref.number,
        body: input.body,
        inReplyToId: input.inReplyToId != null ? Number(input.inReplyToId) : undefined,
        path: input.path ?? undefined,
        line: input.line ?? undefined,
        owner: selector?.owner,
        repo: selector?.repo,
      });
      if (!result.connected) return { ok: false, error: WRITE_ERROR };
      return { ok: true, comment: result.comment ? mapGithubReviewCommentReply(result.comment) : null };
    } catch {
      return { ok: false, error: WRITE_ERROR };
    }
  },

  async updateEntity(directory, ref, input, options) {
    const selector = parseOwnerRepo(options?.sourceRepo);
    const owner = selector?.owner;
    const repo = selector?.repo;
    if (ref.kind === 'issue') {
      if (!api.issueUpdate) return { ok: false, error: WRITE_ERROR };
      try {
        const result = await api.issueUpdate({
          directory,
          number: ref.number,
          title: input.title,
          body: input.body,
          state: input.state,
          owner,
          repo,
        });
        if (!result.connected) return { ok: false, error: WRITE_ERROR };
        return { ok: true, entity: result.issue ? mapGithubIssue(result.issue) : null };
      } catch {
        return { ok: false, error: WRITE_ERROR };
      }
    }
    if (!api.prUpdate) return { ok: false, error: WRITE_ERROR };
    try {
      // GitHub's PR update route requires a title and resolves the repo from
      // the directory (no sourceRepo override), so resolve the current title
      // when the caller only changes state/metadata.
      const title = input.title ?? await resolvePrTitle(api, directory, ref.number);
      if (!title) return { ok: false, error: WRITE_ERROR };
      const pr = await api.prUpdate({
        directory,
        number: ref.number,
        title,
        body: input.body,
        state: input.state,
      });
      return { ok: true, entity: mapGithubPr(pr) };
    } catch {
      return { ok: false, error: WRITE_ERROR };
    }
  },

  async submitReview(directory, ref, input, options) {
    if (ref.kind !== 'pull') return WRITE_NOT_SUPPORTED;
    if (!api.prSubmitReview) return { ok: false, error: WRITE_ERROR };
    try {
      const selector = parseOwnerRepo(options?.sourceRepo);
      const result = await api.prSubmitReview({
        directory,
        number: ref.number,
        event: GITHUB_REVIEW_EVENTS[input.event],
        body: input.body,
        owner: selector?.owner,
        repo: selector?.repo,
      });
      if (!result.connected) return { ok: false, error: WRITE_ERROR };
      return { ok: true, review: result.review ? mapGithubReview(result.review) : null };
    } catch {
      return { ok: false, error: WRITE_ERROR };
    }
  },

  async toggleDraft(directory, ref, draft) {
    if (ref.kind !== 'pull') return WRITE_NOT_SUPPORTED;
    if (!api.prUpdate) return { ok: false, error: WRITE_ERROR };
    try {
      const title = await resolvePrTitle(api, directory, ref.number);
      if (!title) return { ok: false, error: WRITE_ERROR };
      const pr = await api.prUpdate({
        directory,
        number: ref.number,
        title,
        draft,
      });
      return { ok: true, entity: mapGithubPr(pr) };
    } catch {
      return { ok: false, error: WRITE_ERROR };
    }
  },

  async updateMetadata(directory, ref, input, options) {
    const selector = parseOwnerRepo(options?.sourceRepo);
    const owner = selector?.owner;
    const repo = selector?.repo;
    if (ref.kind === 'issue') {
      if (!api.issueUpdate) return { ok: false, error: WRITE_ERROR };
      try {
        const result = await api.issueUpdate({
          directory,
          number: ref.number,
          labels: input.labels,
          assignees: input.assignees,
          milestone: input.milestone,
          owner,
          repo,
        });
        if (!result.connected) return { ok: false, error: WRITE_ERROR };
        return { ok: true, entity: result.issue ? mapGithubIssue(result.issue) : null };
      } catch {
        return { ok: false, error: WRITE_ERROR };
      }
    }
    if (!api.prUpdate) return { ok: false, error: WRITE_ERROR };
    try {
      const title = await resolvePrTitle(api, directory, ref.number);
      if (!title) return { ok: false, error: WRITE_ERROR };
      const pr = await api.prUpdate({
        directory,
        number: ref.number,
        title,
        labels: input.labels,
        assignees: input.assignees,
        milestone: input.milestone,
      });
      return { ok: true, entity: mapGithubPr(pr) };
    } catch {
      return { ok: false, error: WRITE_ERROR };
    }
  },
});

export const createGitlabForgeProvider = (api: GitLabAPI): ForgeProvider => ({
  kind: 'gitlab',
  capabilities: GITLAB_CAPABILITIES,

  async getPullRequestForBranch(directory, branch) {
    if (!api.mrsList) return null;
    try {
      const result = await api.mrsList(directory, { sourceBranch: branch });
      const mrs = result.mrs ?? [];
      const mr = mrs.find((item) => item.state === 'opened')
        ?? mrs.find((item) => item.state === 'merged')
        ?? null;
      return mr ? mapGitlabMr(mr) : null;
    } catch {
      return null;
    }
  },

  async listPullRequests(directory, options) {
    if (!api.mrsList) return EMPTY_PR_LIST(options?.page ?? 1);
    try {
      const result = await api.mrsList(directory, { page: options?.page, query: options?.query });
      return {
        connected: result.connected,
        repo: result.repo ? mapGitlabRepoRef(result.repo) : null,
        prs: result.mrs.map(mapGitlabMr),
        page: result.page,
        hasMore: result.hasMore,
      };
    } catch {
      return EMPTY_PR_LIST(options?.page ?? 1);
    }
  },

  async getPullRequestContext(directory, number, options) {
    if (!api.mrContext) return EMPTY_CONTEXT;
    try {
      const result = await api.mrContext(directory, number, { includeDiff: options?.includeDiff });
      return mapGitlabContext(result);
    } catch {
      return EMPTY_CONTEXT;
    }
  },

  async listIssues(directory, options) {
    if (!api.issuesList) return EMPTY_ISSUE_LIST(options?.page ?? 1);
    try {
      const result = await api.issuesList(directory, { page: options?.page, query: options?.query });
      return {
        connected: result.connected,
        repo: result.repo ? mapGitlabRepoRef(result.repo) : null,
        issues: result.issues.map(mapGitlabIssue),
        page: result.page,
        hasMore: result.hasMore,
      };
    } catch {
      return EMPTY_ISSUE_LIST(options?.page ?? 1);
    }
  },

  async getIssue(directory, number, options) {
    if (!api.issueGet) return EMPTY_ISSUE_DETAIL;
    try {
      const selector = parseOwnerRepo(options?.sourceRepo);
      const result = await api.issueGet(directory, number, {
        namespace: selector?.owner,
        project: selector?.repo,
      });
      if (!result.connected) {
        return { connected: false, repo: result.repo ? mapGitlabRepoRef(result.repo) : null, issue: null, comments: [], commentsError: null };
      }
      let comments: ForgePullRequestContext['issueComments'] = [];
      let commentsError: string | null = null;
      if (api.issueComments) {
        try {
          const commentsResult = await api.issueComments(directory, number, {
            namespace: selector?.owner,
            project: selector?.repo,
          });
          comments = commentsResult.comments.map(mapGitlabNoteComment);
        } catch {
          // The issue itself is authoritative; a comment failure must not hide
          // it, but it also must not masquerade as an authoritative empty list.
          comments = [];
          commentsError = COMMENTS_ERROR;
        }
      }
      return {
        connected: true,
        repo: result.repo ? mapGitlabRepoRef(result.repo) : null,
        issue: result.issue ? mapGitlabIssue(result.issue) : null,
        comments,
        commentsError,
      };
    } catch {
      return EMPTY_ISSUE_DETAIL;
    }
  },

  async getCommits(directory, number, options) {
    if (!api.mrCommits) return EMPTY_COMMITS;
    try {
      const selector = parseOwnerRepo(options?.sourceRepo);
      const result = await api.mrCommits(directory, number, {
        namespace: selector?.owner,
        project: selector?.repo,
      });
      return {
        connected: result.connected,
        repo: result.repo ? mapGitlabRepoRef(result.repo) : null,
        commits: result.commits ? mapGitlabCommits(result.commits) : [],
      };
    } catch {
      return { ...EMPTY_COMMITS, error: LOAD_ERROR };
    }
  },

  async getTimeline(directory, number, options) {
    if (!api.mrTimeline) return EMPTY_TIMELINE;
    try {
      const selector = parseOwnerRepo(options?.sourceRepo);
      const result = await api.mrTimeline(directory, number, {
        namespace: selector?.owner,
        project: selector?.repo,
      });
      return {
        connected: result.connected,
        repo: result.repo ? mapGitlabRepoRef(result.repo) : null,
        events: result.events ? mapGitlabTimelineEvents(result.events) : [],
      };
    } catch {
      return { ...EMPTY_TIMELINE, error: LOAD_ERROR };
    }
  },

  // GitLab exposes no checks surface.
  async getChecks() {
    return null;
  },

  async addComment(directory, ref, input, options) {
    const { namespace, project } = parseGitlabNamespace(options?.sourceRepo);
    if (ref.kind === 'issue') {
      if (!api.issueComment) return { ok: false, error: WRITE_ERROR };
      try {
        const result = await api.issueComment({ directory, number: ref.number, body: input.body, namespace, project });
        if (!result.connected) return { ok: false, error: WRITE_ERROR };
        return { ok: true, comment: result.comment ? mapGitlabNoteComment(result.comment) : null };
      } catch {
        return { ok: false, error: WRITE_ERROR };
      }
    }
    if (!api.mrComment) return { ok: false, error: WRITE_ERROR };
    try {
      const result = await api.mrComment({ directory, number: ref.number, body: input.body, namespace, project });
      if (!result.connected) return { ok: false, error: WRITE_ERROR };
      return { ok: true, comment: result.comment ? mapGitlabNoteComment(result.comment) : null };
    } catch {
      return { ok: false, error: WRITE_ERROR };
    }
  },

  async replyToThread(directory, ref, input, options) {
    // GitLab's note-reply API is not wired up yet; reply as a flat comment.
    return this.addComment!(directory, ref, { body: input.body }, options);
  },

  async updateEntity(directory, ref, input, options) {
    const { namespace, project } = parseGitlabNamespace(options?.sourceRepo);
    if (ref.kind === 'issue') {
      if (!api.issueUpdate) return { ok: false, error: WRITE_ERROR };
      try {
        const result = await api.issueUpdate({
          directory,
          number: ref.number,
          title: input.title,
          body: input.body,
          state: input.state,
          namespace,
          project,
        });
        if (!result.connected) return { ok: false, error: WRITE_ERROR };
        return { ok: true, entity: result.issue ? mapGitlabIssue(result.issue) : null };
      } catch {
        return { ok: false, error: WRITE_ERROR };
      }
    }
    if (!api.mrUpdate) return { ok: false, error: WRITE_ERROR };
    try {
      // The MR update route takes `description` (not `body`) and has no
      // namespace/project override fields.
      const mr = await api.mrUpdate({
        directory,
        number: ref.number,
        title: input.title,
        description: input.body,
        state: input.state,
      });
      return { ok: true, entity: mapGitlabMr(mr) };
    } catch {
      return { ok: false, error: WRITE_ERROR };
    }
  },

  async submitReview(directory, ref, input, options) {
    if (ref.kind !== 'pull') return { ok: false, error: 'not supported' };
    // GitLab exposes approvals only; request-changes/comment have no MR review
    // events on the wire API.
    if (input.event !== 'approve') return { ok: false, error: 'not supported' };
    if (!api.mrApprove) return { ok: false, error: WRITE_ERROR };
    try {
      const { namespace, project } = parseGitlabNamespace(options?.sourceRepo);
      const result = await api.mrApprove({ directory, number: ref.number, namespace, project });
      if (!result.connected || !result.approved) return { ok: false, error: WRITE_ERROR };
      // GitLab approvals return no review object; synthesize a minimal marker.
      return { ok: true, review: { id: '', state: 'approved' } };
    } catch {
      return { ok: false, error: WRITE_ERROR };
    }
  },

  async toggleDraft(directory, ref, draft, options) {
    if (ref.kind !== 'pull') return WRITE_NOT_SUPPORTED;
    if (!api.mrUpdate) return { ok: false, error: WRITE_ERROR };
    try {
      const context = await this.getPullRequestContext(directory, ref.number, options);
      const title = context.pr?.title;
      if (!title) return { ok: false, error: WRITE_ERROR };
      const nextTitle = draft
        ? (/^Draft:\s*/.test(title) ? title : `Draft: ${title}`)
        : title.replace(/^Draft:\s*/, '');
      const mr = await api.mrUpdate({ directory, number: ref.number, title: nextTitle });
      return { ok: true, entity: mapGitlabMr(mr) };
    } catch {
      return { ok: false, error: WRITE_ERROR };
    }
  },

  async updateMetadata(directory, ref, input, options) {
    const { namespace, project } = parseGitlabNamespace(options?.sourceRepo);
    if (ref.kind === 'issue') {
      if (!api.issueUpdate) return { ok: false, error: WRITE_ERROR };
      try {
        // GitLab assigns by user ID, not login; the facade takes logins, so
        // assignees are left unset until an id lookup exists.
        const result = await api.issueUpdate({
          directory,
          number: ref.number,
          labels: input.labels,
          milestone: input.milestone,
          namespace,
          project,
        });
        if (!result.connected) return { ok: false, error: WRITE_ERROR };
        return { ok: true, entity: result.issue ? mapGitlabIssue(result.issue) : null };
      } catch {
        return { ok: false, error: WRITE_ERROR };
      }
    }
    if (!api.mrUpdate) return { ok: false, error: WRITE_ERROR };
    try {
      const mr = await api.mrUpdate({
        directory,
        number: ref.number,
        labels: input.labels,
        milestone: input.milestone,
      });
      return { ok: true, entity: mapGitlabMr(mr) };
    } catch {
      return { ok: false, error: WRITE_ERROR };
    }
  },
});

export const createGiteaForgeProvider = (api: GiteaAPI): ForgeProvider => ({
  kind: 'gitea',
  capabilities: GITEA_CAPABILITIES,

  async getPullRequestForBranch(directory, branch) {
    if (!api.prsList) return null;
    try {
      const result = await api.prsList(directory, { sourceBranch: branch });
      const prs = result.prs ?? [];
      const pr = prs.find((item) => item.state === 'open')
        ?? prs.find((item) => item.state === 'merged')
        ?? null;
      return pr ? mapGiteaPr(pr) : null;
    } catch {
      return null;
    }
  },

  async listPullRequests(directory, options) {
    if (!api.prsList) return EMPTY_PR_LIST(options?.page ?? 1);
    try {
      const result = await api.prsList(directory, { page: options?.page, query: options?.query });
      return {
        connected: result.connected,
        repo: result.repo ? mapGiteaRepoRef(result.repo) : null,
        prs: result.prs.map(mapGiteaPr),
        page: result.page,
        hasMore: result.hasMore,
      };
    } catch {
      return EMPTY_PR_LIST(options?.page ?? 1);
    }
  },

  async getPullRequestContext(directory, number, options) {
    if (!api.prContext) return EMPTY_CONTEXT;
    try {
      const selector = parseOwnerRepo(options?.sourceRepo);
      const result = await api.prContext(directory, number, {
        includeDiff: options?.includeDiff,
        owner: selector?.owner,
        repo: selector?.repo,
      });
      return mapGiteaContext(result);
    } catch {
      return EMPTY_CONTEXT;
    }
  },

  async listIssues(directory, options) {
    if (!api.issuesList) return EMPTY_ISSUE_LIST(options?.page ?? 1);
    try {
      const result = await api.issuesList(directory, { page: options?.page, query: options?.query });
      return {
        connected: result.connected,
        repo: result.repo ? mapGiteaRepoRef(result.repo) : null,
        issues: result.issues.map(mapGiteaIssue),
        page: result.page,
        hasMore: result.hasMore,
      };
    } catch {
      return EMPTY_ISSUE_LIST(options?.page ?? 1);
    }
  },

  async getIssue(directory, number, options) {
    if (!api.issueGet) return EMPTY_ISSUE_DETAIL;
    try {
      const selector = parseOwnerRepo(options?.sourceRepo);
      const result = await api.issueGet(directory, number, {
        owner: selector?.owner,
        repo: selector?.repo,
      });
      if (!result.connected) {
        return { connected: false, repo: result.repo ? mapGiteaRepoRef(result.repo) : null, issue: null, comments: [], commentsError: null };
      }
      let comments: ForgePullRequestContext['issueComments'] = [];
      let commentsError: string | null = null;
      if (api.issueComments) {
        try {
          const commentsResult = await api.issueComments(directory, number, {
            owner: selector?.owner,
            repo: selector?.repo,
          });
          comments = commentsResult.comments.map(mapGiteaComment);
        } catch {
          // The issue itself is authoritative; a comment failure must not hide
          // it, but it also must not masquerade as an authoritative empty list.
          comments = [];
          commentsError = COMMENTS_ERROR;
        }
      }
      return {
        connected: true,
        repo: result.repo ? mapGiteaRepoRef(result.repo) : null,
        issue: result.issue ? mapGiteaIssue(result.issue) : null,
        comments,
        commentsError,
      };
    } catch {
      return EMPTY_ISSUE_DETAIL;
    }
  },

  async getCommits(directory, number, options) {
    if (!api.prCommits) return EMPTY_COMMITS;
    try {
      const selector = parseOwnerRepo(options?.sourceRepo);
      const result = await api.prCommits(directory, number, {
        owner: selector?.owner,
        repo: selector?.repo,
      });
      return {
        connected: result.connected,
        repo: result.repo ? mapGiteaRepoRef(result.repo) : null,
        commits: result.commits ? mapGiteaCommits(result.commits) : [],
      };
    } catch {
      return { ...EMPTY_COMMITS, error: LOAD_ERROR };
    }
  },

  // Gitea has no timeline endpoint; synthesize one from its reviews.
  async getTimeline(directory, number, options) {
    if (!api.prReviews) return EMPTY_TIMELINE;
    try {
      const selector = parseOwnerRepo(options?.sourceRepo);
      const result = await api.prReviews(directory, number, {
        owner: selector?.owner,
        repo: selector?.repo,
      });
      return {
        connected: result.connected,
        repo: result.repo ? mapGiteaRepoRef(result.repo) : null,
        events: result.reviews ? mapGiteaReviewsToEvents(result.reviews) : [],
      };
    } catch {
      return { ...EMPTY_TIMELINE, error: LOAD_ERROR };
    }
  },

  async getChecks(directory, number, options) {
    if (!api.prStatuses) return EMPTY_CHECKS;
    try {
      const selector = parseOwnerRepo(options?.sourceRepo);
      const result = await api.prStatuses(directory, number, {
        owner: selector?.owner,
        repo: selector?.repo,
      });
      return {
        connected: result.connected,
        repo: result.repo ? mapGiteaRepoRef(result.repo) : null,
        checks: result.statuses ? mapGiteaStatuses(result.statuses) : null,
      };
    } catch {
      return { ...EMPTY_CHECKS, error: LOAD_ERROR };
    }
  },

  async addComment(directory, ref, input, options) {
    const selector = parseOwnerRepo(options?.sourceRepo);
    const owner = selector?.owner;
    const repo = selector?.repo;
    if (ref.kind === 'issue') {
      if (!api.issueComment) return { ok: false, error: WRITE_ERROR };
      try {
        const result = await api.issueComment({ directory, number: ref.number, body: input.body, owner, repo });
        if (!result.connected) return { ok: false, error: WRITE_ERROR };
        return { ok: true, comment: result.comment ? mapGiteaComment(result.comment) : null };
      } catch {
        return { ok: false, error: WRITE_ERROR };
      }
    }
    if (!api.prComment) return { ok: false, error: WRITE_ERROR };
    try {
      const result = await api.prComment({ directory, number: ref.number, body: input.body, owner, repo });
      if (!result.connected) return { ok: false, error: WRITE_ERROR };
      return { ok: true, comment: result.comment ? mapGiteaComment(result.comment) : null };
    } catch {
      return { ok: false, error: WRITE_ERROR };
    }
  },

  async replyToThread(directory, ref, input, options) {
    // Gitea's thread-reply API is not wired up yet; reply as a flat comment.
    return this.addComment!(directory, ref, { body: input.body }, options);
  },

  async updateEntity(directory, ref, input, options) {
    const selector = parseOwnerRepo(options?.sourceRepo);
    if (ref.kind === 'issue') {
      if (!api.issueUpdate) return { ok: false, error: WRITE_ERROR };
      try {
        const result = await api.issueUpdate({
          directory,
          number: ref.number,
          title: input.title,
          body: input.body,
          state: input.state,
          owner: selector?.owner,
          repo: selector?.repo,
        });
        if (!result.connected) return { ok: false, error: WRITE_ERROR };
        return { ok: true, entity: result.issue ? mapGiteaIssue(result.issue) : null };
      } catch {
        return { ok: false, error: WRITE_ERROR };
      }
    }
    if (!api.prUpdate) return { ok: false, error: WRITE_ERROR };
    try {
      // The Gitea PR update route takes `description` (not `body`) and carries
      // no owner/repo override fields.
      const pr = await api.prUpdate({
        directory,
        number: ref.number,
        title: input.title,
        description: input.body,
        state: input.state,
      });
      return { ok: true, entity: mapGiteaPr(pr) };
    } catch {
      return { ok: false, error: WRITE_ERROR };
    }
  },

  async submitReview(directory, ref, input, options) {
    if (ref.kind !== 'pull') return { ok: false, error: 'not supported' };
    if (!api.prSubmitReview) return { ok: false, error: WRITE_ERROR };
    try {
      const selector = parseOwnerRepo(options?.sourceRepo);
      const result = await api.prSubmitReview({
        directory,
        number: ref.number,
        event: GITEA_REVIEW_EVENTS[input.event],
        body: input.body,
        owner: selector?.owner,
        repo: selector?.repo,
      });
      if (!result.connected) return { ok: false, error: WRITE_ERROR };
      return { ok: true, review: result.review ? mapGiteaReview(result.review) : null };
    } catch {
      return { ok: false, error: WRITE_ERROR };
    }
  },

  // Gitea has no draft concept (`capabilities.draft: false`); toggleDraft is
  // intentionally left undefined so the UI gates on method presence.

  async updateMetadata(directory, ref, input, options) {
    const selector = parseOwnerRepo(options?.sourceRepo);
    if (ref.kind === 'issue') {
      if (!api.issueUpdate) return { ok: false, error: WRITE_ERROR };
      try {
        const result = await api.issueUpdate({
          directory,
          number: ref.number,
          labels: input.labels,
          assignees: input.assignees,
          milestone: input.milestone,
          owner: selector?.owner,
          repo: selector?.repo,
        });
        if (!result.connected) return { ok: false, error: WRITE_ERROR };
        return { ok: true, entity: result.issue ? mapGiteaIssue(result.issue) : null };
      } catch {
        return { ok: false, error: WRITE_ERROR };
      }
    }
    // Gitea's PR update route carries only title/description/state — no
    // labels/assignees/milestone — so PR metadata writes are unsupported.
    return WRITE_NOT_SUPPORTED;
  },
});

/**
 * Build the adapter for `kind` from the available runtime APIs, or null when
 * the provider's API is not present in the runtime.
 */
export const buildForgeProvider = (
  kind: ForgeProviderKind,
  apis: { github?: GitHubAPI; gitlab?: GitLabAPI; gitea?: GiteaAPI },
): ForgeProvider | null => {
  switch (kind) {
    case 'github':
      return apis.github ? createGithubForgeProvider(apis.github) : null;
    case 'gitlab':
      return apis.gitlab ? createGitlabForgeProvider(apis.gitlab) : null;
    case 'gitea':
      return apis.gitea ? createGiteaForgeProvider(apis.gitea) : null;
    default:
      return null;
  }
};
