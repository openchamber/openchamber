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
  GitHubAPI,
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
  ForgeTimelineResult,
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
  mapGiteaStatuses,
  mapGithubCommits,
  mapGithubContext,
  mapGithubIssue,
  mapGithubIssueComment,
  mapGithubPr,
  mapGithubRepoRef,
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
