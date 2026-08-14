import type {
  GiteaAPI,
  GiteaAuthStatus,
  GiteaBranchesResult,
  GiteaIssueCommentsResult,
  GiteaIssueGetResult,
  GiteaIssuesListResult,
  GiteaPullRequest,
  GiteaPullRequestContextResult,
  GiteaPullRequestCreateInput,
  GiteaPullRequestMergeInput,
  GiteaPullRequestMergeResult,
  GiteaPullRequestsListResult,
  GiteaPullRequestUpdateInput,
  GiteaUserSummary,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import type { RuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';

interface WebGiteaAPIOptions {
  urls: RuntimeUrlResolver;
}

interface GiteaPullRequestWriteResult {
  connected: boolean;
  repo?: { owner: string; repo: string; url?: string } | null;
  pr?: GiteaPullRequest;
}

const jsonOrNull = async <T>(response: Response): Promise<T | null> => {
  return (await response.json().catch(() => null)) as T | null;
};

export const createWebGiteaAPI = ({ urls }: WebGiteaAPIOptions): GiteaAPI => ({
  async authStatus(): Promise<GiteaAuthStatus> {
    const response = await runtimeFetch('/api/gitea/auth/status', { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GiteaAuthStatus & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load Gitea status');
    }
    return payload;
  },

  async authConnect(input: { accessToken: string; baseUrl: string }): Promise<GiteaAuthStatus> {
    const response = await runtimeFetch('/api/gitea/auth/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await jsonOrNull<GiteaAuthStatus & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to connect Gitea');
    }
    return payload;
  },

  async authActivate(accountId: string): Promise<GiteaAuthStatus> {
    const response = await runtimeFetch('/api/gitea/auth/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    const payload = await jsonOrNull<GiteaAuthStatus & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to activate Gitea account');
    }
    return payload;
  },

  async authDisconnect(): Promise<{ removed: boolean }> {
    const response = await runtimeFetch('/api/gitea/auth', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ removed?: boolean; error?: string }>(response);
    if (!response.ok) {
      throw new Error(payload?.error || response.statusText || 'Failed to disconnect Gitea');
    }
    return { removed: Boolean(payload?.removed) };
  },

  async me(): Promise<GiteaUserSummary> {
    const response = await runtimeFetch('/api/gitea/me', { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GiteaUserSummary & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to fetch Gitea user');
    }
    return payload;
  },

  async issuesList(directory: string, options?: { page?: number; query?: string }): Promise<GiteaIssuesListResult> {
    const page = options?.page ?? 1;
    const params = new URLSearchParams({
      directory,
      page: String(page),
    });
    if (options?.query) {
      params.set('query', options.query);
    }
    const response = await runtimeFetch(
      `/api/gitea/issues/list?${params.toString()}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const payload = await jsonOrNull<GiteaIssuesListResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load Gitea issues');
    }
    return payload;
  },

  async issueGet(directory: string, number: number, options?: { owner?: string; repo?: string }): Promise<GiteaIssueGetResult> {
    const params = new URLSearchParams({ directory, number: String(number) });
    if (options?.owner) {
      params.set('owner', options.owner);
    }
    if (options?.repo) {
      params.set('repo', options.repo);
    }
    const response = await runtimeFetch(urls.api('/api/gitea/issues/get', params), { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GiteaIssueGetResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load Gitea issue');
    }
    return payload;
  },

  async issueComments(directory: string, number: number, options?: { owner?: string; repo?: string }): Promise<GiteaIssueCommentsResult> {
    const params = new URLSearchParams({ directory, number: String(number) });
    if (options?.owner) {
      params.set('owner', options.owner);
    }
    if (options?.repo) {
      params.set('repo', options.repo);
    }
    const response = await runtimeFetch(urls.api('/api/gitea/issues/comments', params), { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GiteaIssueCommentsResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load Gitea issue comments');
    }
    return payload;
  },

  async prsList(directory: string, options?: { page?: number; query?: string; sourceBranch?: string }): Promise<GiteaPullRequestsListResult> {
    const page = options?.page ?? 1;
    const params = new URLSearchParams({
      directory,
      page: String(page),
    });
    if (options?.query) {
      params.set('query', options.query);
    }
    if (options?.sourceBranch) {
      params.set('sourceBranch', options.sourceBranch);
    }
    const response = await runtimeFetch(
      `/api/gitea/prs/list?${params.toString()}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const payload = await jsonOrNull<GiteaPullRequestsListResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load Gitea pull requests');
    }
    return payload;
  },

  async prContext(
    directory: string,
    number: number,
    options?: { includeDiff?: boolean; owner?: string; repo?: string }
  ): Promise<GiteaPullRequestContextResult> {
    const params = new URLSearchParams({ directory, number: String(number) });
    if (options?.includeDiff) {
      params.set('includeDiff', '1');
    }
    if (options?.owner) {
      params.set('owner', options.owner);
    }
    if (options?.repo) {
      params.set('repo', options.repo);
    }
    const response = await runtimeFetch(urls.api('/api/gitea/pr/context', params), { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GiteaPullRequestContextResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load Gitea pull request context');
    }
    return payload;
  },

  async prCreate(input: GiteaPullRequestCreateInput): Promise<GiteaPullRequest> {
    const response = await runtimeFetch('/api/gitea/pr/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await jsonOrNull<GiteaPullRequestWriteResult & { error?: string }>(response);
    if (!response.ok || !payload?.pr) {
      throw new Error(payload?.error || response.statusText || 'Failed to create Gitea pull request');
    }
    return payload.pr;
  },

  async prUpdate(input: GiteaPullRequestUpdateInput): Promise<GiteaPullRequest> {
    const response = await runtimeFetch('/api/gitea/pr/update', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await jsonOrNull<GiteaPullRequestWriteResult & { error?: string }>(response);
    if (!response.ok || !payload?.pr) {
      throw new Error(payload?.error || response.statusText || 'Failed to update Gitea pull request');
    }
    return payload.pr;
  },

  async prMerge(input: GiteaPullRequestMergeInput): Promise<GiteaPullRequestMergeResult> {
    const response = await runtimeFetch('/api/gitea/pr/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await jsonOrNull<GiteaPullRequestMergeResult & { error?: string }>(response);
    // The server rejects non-mergeable requests with 405/409/422 and a
    // `{ connected, merged: false, message }` body — parse it and return it
    // instead of throwing. Only throw when there is no parseable payload
    // (network failure) or the server surfaced a real `{ error }`.
    if (!payload) {
      throw new Error(response.statusText || 'Failed to merge Gitea pull request');
    }
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      connected: Boolean(payload.connected),
      merged: Boolean(payload.merged),
      ...(payload.message ? { message: payload.message } : {}),
    };
  },

  async repoBranches(owner: string, repo: string): Promise<GiteaBranchesResult> {
    const response = await runtimeFetch(
      `/api/gitea/repo/branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const body = await jsonOrNull<GiteaBranchesResult & { error?: string }>(response);
    if (!response.ok || !body) {
      throw new Error(body?.error || response.statusText || 'Failed to fetch Gitea repo branches');
    }
    return {
      branches: body.branches ?? [],
      defaultBranch: body.defaultBranch ?? null,
    };
  },
});
