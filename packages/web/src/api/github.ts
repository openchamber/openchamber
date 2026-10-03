import type {
  GitHubAPI,
  GitHubAuthStatus,
  GitHubIssueCommentsResult,
  GitHubIssueGetResult,
  GitHubReferencesOptions,
  GitHubReferencesResult,
  GitHubReferenceDetailResult,
  GitHubPullRequestContextResult,
  GitHubPullRequestsListResult,
  GitHubPullRequest,
  GitHubPullRequestCreateInput,
  GitHubPullRequestMergeInput,
  GitHubPullRequestMergeResult,
  GitHubPullRequestReadyInput,
  GitHubPullRequestReadyResult,
  GitHubPullRequestUpdateInput,
  GitHubPullRequestStatus,
  GitHubPullRequestRef,
  GitHubPullRequestSummariesResult,
  GitHubRepoUpstreamResult,
  GitHubDeviceFlowComplete,
  GitHubDeviceFlowStart,
  GitHubUserSummary,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import type { RuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';
import { z } from 'zod';

const checksSummarySchema = z.object({
  state: z.enum(['success', 'failure', 'pending', 'unknown']),
  total: z.number(),
  success: z.number(),
  failure: z.number(),
  pending: z.number(),
  inProgress: z.number().optional(),
  queued: z.number().optional(),
  startedAt: z.string().optional(),
});

const prSummariesResultSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    fetchedAt: z.number(),
    summaries: z.array(z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number(),
      state: z.enum(['open', 'closed', 'merged']),
      draft: z.boolean(),
      title: z.string(),
      headSha: z.string().optional(),
      mergeable: z.boolean().nullable(),
      mergeableState: z.string().nullable(),
      checks: checksSummarySchema.nullable(),
    })),
    issueSummaries: z.array(z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number(),
      title: z.string(),
      state: z.enum(['open', 'completed', 'not_planned']),
    })),
  }),
]);

const referenceCommonShape = {
  number: z.number(),
  title: z.string(),
  url: z.string(),
  body: z.string(),
  bodyTruncated: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  author: z.object({ login: z.string(), avatarUrl: z.string().optional() }).nullable(),
  labels: z.array(z.object({ name: z.string(), color: z.string().optional() })),
  commentCount: z.number(),
  sourceRepo: z.object({ owner: z.string(), repo: z.string(), source: z.string() }),
};

const referencesResultSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    repo: z.object({ owner: z.string(), repo: z.string(), url: z.string() }).nullable(),
    items: z.array(z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('issue'),
        ...referenceCommonShape,
        state: z.enum(['open', 'completed', 'not_planned']),
      }),
      z.object({
        kind: z.literal('pull'),
        ...referenceCommonShape,
        state: z.enum(['open', 'closed', 'merged']),
        draft: z.boolean(),
        head: z.string(),
        base: z.string(),
        headSha: z.string(),
        headRepo: z.object({
          owner: z.string(),
          repo: z.string(),
          url: z.string(),
          cloneUrl: z.string().optional(),
          sshUrl: z.string().optional(),
        }).nullable(),
      }),
    ])),
    cursor: z.string().nullable(),
    hasMore: z.boolean(),
    total: z.number(),
  }),
]);

const referenceDetailResultSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    detail: z.object({
      number: z.number(),
      comments: z.array(z.object({
        author: z.object({ login: z.string(), avatarUrl: z.string().optional() }).nullable(),
        body: z.string(),
        createdAt: z.string().nullable(),
        url: z.string(),
        path: z.string().nullable(),
        line: z.number().nullable(),
        review: z.enum(['approved', 'changes_requested', 'commented', 'dismissed']).nullable(),
      })),
      commentTotal: z.number(),
      pull: z.object({
        reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).nullable(),
        additions: z.number(),
        deletions: z.number(),
        changedFiles: z.number(),
        checks: checksSummarySchema.nullable(),
      }).nullable(),
    }).nullable(),
  }),
]);

interface WebGitHubAPIOptions {
  urls: RuntimeUrlResolver;
}

const jsonOrNull = async <T>(response: Response): Promise<T | null> => {
  return (await response.json().catch(() => null)) as T | null;
};

export const createWebGitHubAPI = ({ urls }: WebGitHubAPIOptions): GitHubAPI => ({
  async authStatus(): Promise<GitHubAuthStatus> {
    const response = await runtimeFetch('/api/github/auth/status', { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GitHubAuthStatus & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load GitHub status');
    }
    return payload;
  },

  async authStart(): Promise<GitHubDeviceFlowStart> {
    const response = await runtimeFetch('/api/github/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = await jsonOrNull<GitHubDeviceFlowStart & { error?: string }>(response);
    if (!response.ok || !payload || !('deviceCode' in payload)) {
      throw new Error((payload as { error?: string } | null)?.error || response.statusText || 'Failed to start GitHub auth');
    }
    return payload;
  },

  async authComplete(deviceCode: string): Promise<GitHubDeviceFlowComplete> {
    const response = await runtimeFetch('/api/github/auth/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ deviceCode }),
    });
    const payload = await jsonOrNull<GitHubDeviceFlowComplete & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error((payload as { error?: string } | null)?.error || response.statusText || 'Failed to complete GitHub auth');
    }
    return payload;
  },

  async authDisconnect(): Promise<{ removed: boolean }> {
    const response = await runtimeFetch('/api/github/auth', { method: 'DELETE', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<{ removed?: boolean; error?: string }>(response);
    if (!response.ok) {
      throw new Error(payload?.error || response.statusText || 'Failed to disconnect GitHub');
    }
    return { removed: Boolean(payload?.removed) };
  },

  async authActivate(accountId: string): Promise<GitHubAuthStatus> {
    const response = await runtimeFetch('/api/github/auth/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    const payload = await jsonOrNull<GitHubAuthStatus & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to activate GitHub account');
    }
    return payload;
  },

  async authSetGhCliDisabled(disabled: boolean): Promise<{ disabled: boolean }> {
    const response = await runtimeFetch('/api/github/auth/gh-cli', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ disabled }),
    });
    const payload = await jsonOrNull<{ disabled?: boolean; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to update gh CLI setting');
    }
    return { disabled: Boolean(payload.disabled) };
  },

  async me(): Promise<GitHubUserSummary> {
    const response = await runtimeFetch('/api/github/me', { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GitHubUserSummary & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to fetch GitHub user');
    }
    return payload;
  },

  async prStatus(directory: string, branch: string, remote?: string, options?: { force?: boolean }): Promise<GitHubPullRequestStatus> {
    const params = new URLSearchParams({
      directory,
      branch,
      ...(remote ? { remote } : {}),
      ...(options?.force ? { force: 'true' } : {}),
    });
    const response = await runtimeFetch(
      `/api/github/pr/status?${params.toString()}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const payload = await jsonOrNull<GitHubPullRequestStatus & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load PR status');
    }
    return payload;
  },

  async prSummaries(refs: GitHubPullRequestRef[], issueRefs: GitHubPullRequestRef[] = []): Promise<GitHubPullRequestSummariesResult> {
    const response = await runtimeFetch('/api/github/pr/summaries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refs, issueRefs }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = z.object({ error: z.string() }).safeParse(payload);
      throw new Error((failure.success && failure.data.error) || response.statusText || 'Failed to load PR summaries');
    }
    return prSummariesResultSchema.parse(payload);
  },

  async prCreate(payload: GitHubPullRequestCreateInput): Promise<GitHubPullRequest> {
    const response = await runtimeFetch('/api/github/pr/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await jsonOrNull<GitHubPullRequest & { error?: string }>(response);
    if (!response.ok || !body) {
      throw new Error((body as { error?: string } | null)?.error || response.statusText || 'Failed to create PR');
    }
    return body;
  },

  async prUpdate(payload: GitHubPullRequestUpdateInput): Promise<GitHubPullRequest> {
    const response = await runtimeFetch('/api/github/pr/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await jsonOrNull<GitHubPullRequest & { error?: string }>(response);
    if (!response.ok || !body) {
      throw new Error((body as { error?: string } | null)?.error || response.statusText || 'Failed to update PR');
    }
    return body;
  },

  async prMerge(payload: GitHubPullRequestMergeInput): Promise<GitHubPullRequestMergeResult> {
    const response = await runtimeFetch('/api/github/pr/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await jsonOrNull<GitHubPullRequestMergeResult & { error?: string }>(response);
    if (!response.ok || !body) {
      throw new Error((body as { error?: string } | null)?.error || response.statusText || 'Failed to merge PR');
    }
    return body;
  },

  async prReady(payload: GitHubPullRequestReadyInput): Promise<GitHubPullRequestReadyResult> {
    const response = await runtimeFetch('/api/github/pr/ready', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await jsonOrNull<GitHubPullRequestReadyResult & { error?: string }>(response);
    if (!response.ok || !body) {
      throw new Error((body as { error?: string } | null)?.error || response.statusText || 'Failed to mark PR ready');
    }
    return body;
  },

  async repoUpstream(directory: string): Promise<GitHubRepoUpstreamResult> {
    const response = await runtimeFetch(
      `/api/github/repo/upstream?directory=${encodeURIComponent(directory)}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const body = await jsonOrNull<GitHubRepoUpstreamResult & { error?: string }>(response);
    if (!response.ok || !body) {
      throw new Error(body?.error || response.statusText || 'Failed to detect upstream repo');
    }
    return body;
  },

  async repoBranches(owner: string, repo: string): Promise<string[]> {
    const response = await runtimeFetch(
      `/api/github/repo/branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const body = await jsonOrNull<{ branches?: string[]; error?: string }>(response);
    if (!response.ok || !body) {
      throw new Error(body?.error || response.statusText || 'Failed to fetch repo branches');
    }
    return body.branches ?? [];
  },

  async prsList(directory: string, options?: { page?: number; query?: string }): Promise<GitHubPullRequestsListResult> {
    const page = options?.page ?? 1;
    const params = new URLSearchParams({
      directory,
      page: String(page),
    });
    if (options?.query) {
      params.set('query', options.query);
    }
    const response = await runtimeFetch(
      `/api/github/pulls/list?${params.toString()}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const body = await jsonOrNull<GitHubPullRequestsListResult & { error?: string }>(response);
    if (!response.ok || !body) {
      throw new Error(body?.error || response.statusText || 'Failed to load pull requests');
    }
    return body;
  },

  async prContext(
    directory: string,
    number: number,
    options?: { includeDiff?: boolean; includeCheckDetails?: boolean; sourceRepo?: { owner: string; repo: string } | null }
  ): Promise<GitHubPullRequestContextResult> {
    const params = new URLSearchParams({ directory, number: String(number) });
    if (options?.includeDiff) {
      params.set('diff', '1');
    }
    if (options?.includeCheckDetails) {
      params.set('checkDetails', '1');
    }
    if (options?.sourceRepo?.owner && options.sourceRepo.repo) {
      params.set('owner', options.sourceRepo.owner);
      params.set('repo', options.sourceRepo.repo);
    }
    const response = await runtimeFetch(urls.api('/api/github/pulls/context', params), { method: 'GET', headers: { Accept: 'application/json' } });
    const body = await jsonOrNull<GitHubPullRequestContextResult & { error?: string }>(response);
    if (!response.ok || !body) {
      throw new Error(body?.error || response.statusText || 'Failed to load pull request context');
    }
    return body;
  },

  async references(directory: string, options: GitHubReferencesOptions): Promise<GitHubReferencesResult> {
    const params = new URLSearchParams({ directory, kind: options.kind });
    if (options.filter) params.set('filter', options.filter);
    if (options.query?.trim()) params.set('query', options.query.trim());
    if (options.cursor) params.set('cursor', options.cursor);
    const response = await runtimeFetch(urls.api('/api/github/references', params), { method: 'GET', headers: { Accept: 'application/json' } });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = z.object({ error: z.string() }).safeParse(payload);
      throw new Error((failure.success && failure.data.error) || response.statusText || 'Failed to load issues and pull requests');
    }
    return referencesResultSchema.parse(payload);
  },

  async referenceDetail(directory: string, item: GitHubPullRequestRef): Promise<GitHubReferenceDetailResult> {
    const params = new URLSearchParams({ directory, owner: item.owner, repo: item.repo, number: String(item.number) });
    const response = await runtimeFetch(urls.api('/api/github/references/detail', params), { method: 'GET', headers: { Accept: 'application/json' } });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = z.object({ error: z.string() }).safeParse(payload);
      throw new Error((failure.success && failure.data.error) || response.statusText || 'Failed to load issue or pull request detail');
    }
    return referenceDetailResultSchema.parse(payload);
  },

  async issueGet(directory: string, number: number, options?: { sourceRepo?: { owner: string; repo: string } | null }): Promise<GitHubIssueGetResult> {
    const params = new URLSearchParams({ directory, number: String(number) });
    if (options?.sourceRepo?.owner && options.sourceRepo.repo) {
      params.set('owner', options.sourceRepo.owner);
      params.set('repo', options.sourceRepo.repo);
    }
    const response = await runtimeFetch(urls.api('/api/github/issues/get', params), { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GitHubIssueGetResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load issue');
    }
    return payload;
  },

  async issueComments(directory: string, number: number, options?: { sourceRepo?: { owner: string; repo: string } | null }): Promise<GitHubIssueCommentsResult> {
    const params = new URLSearchParams({ directory, number: String(number) });
    if (options?.sourceRepo?.owner && options.sourceRepo.repo) {
      params.set('owner', options.sourceRepo.owner);
      params.set('repo', options.sourceRepo.repo);
    }
    const response = await runtimeFetch(urls.api('/api/github/issues/comments', params), { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GitHubIssueCommentsResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load issue comments');
    }
    return payload;
  },
});
