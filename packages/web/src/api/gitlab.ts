import type {
  GitLabAPI,
  GitLabAuthStatus,
  GitLabBranchesResult,
  GitLabIssueCommentsResult,
  GitLabIssueGetResult,
  GitLabIssuesListResult,
  GitLabMergeRequest,
  GitLabMergeRequestContextResult,
  GitLabMergeRequestCreateInput,
  GitLabMergeRequestCreateResult,
  GitLabMergeRequestMergeInput,
  GitLabMergeRequestMergeResult,
  GitLabMergeRequestsListResult,
  GitLabMergeRequestUpdateInput,
  GitLabMergeRequestUpdateResult,
  GitLabUserSummary,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import type { RuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';

interface WebGitLabAPIOptions {
  urls: RuntimeUrlResolver;
}

const jsonOrNull = async <T>(response: Response): Promise<T | null> => {
  return (await response.json().catch(() => null)) as T | null;
};

export const createWebGitLabAPI = ({ urls }: WebGitLabAPIOptions): GitLabAPI => ({
  async authStatus(): Promise<GitLabAuthStatus> {
    const response = await runtimeFetch('/api/gitlab/auth/status', { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GitLabAuthStatus & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load GitLab status');
    }
    return payload;
  },

  async authConnect(input: { accessToken: string; baseUrl?: string }): Promise<GitLabAuthStatus> {
    const response = await runtimeFetch('/api/gitlab/auth/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await jsonOrNull<GitLabAuthStatus & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to connect GitLab');
    }
    return payload;
  },

  async authActivate(accountId: string): Promise<GitLabAuthStatus> {
    const response = await runtimeFetch('/api/gitlab/auth/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    const payload = await jsonOrNull<GitLabAuthStatus & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to activate GitLab account');
    }
    return payload;
  },

  async authDisconnect(): Promise<{ removed: boolean }> {
    const response = await runtimeFetch('/api/gitlab/auth', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ removed?: boolean; error?: string }>(response);
    if (!response.ok) {
      throw new Error(payload?.error || response.statusText || 'Failed to disconnect GitLab');
    }
    return { removed: Boolean(payload?.removed) };
  },

  async me(): Promise<GitLabUserSummary> {
    const response = await runtimeFetch('/api/gitlab/me', { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GitLabUserSummary & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to fetch GitLab user');
    }
    return payload;
  },

  async issuesList(directory: string, options?: { page?: number; query?: string }): Promise<GitLabIssuesListResult> {
    const page = options?.page ?? 1;
    const params = new URLSearchParams({
      directory,
      page: String(page),
    });
    if (options?.query) {
      params.set('query', options.query);
    }
    const response = await runtimeFetch(
      `/api/gitlab/issues/list?${params.toString()}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const payload = await jsonOrNull<GitLabIssuesListResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load GitLab issues');
    }
    return payload;
  },

  async issueGet(directory: string, number: number, options?: { namespace?: string; project?: string }): Promise<GitLabIssueGetResult> {
    const params = new URLSearchParams({ directory, number: String(number) });
    if (options?.namespace) {
      params.set('namespace', options.namespace);
    }
    if (options?.project) {
      params.set('project', options.project);
    }
    const response = await runtimeFetch(urls.api('/api/gitlab/issues/get', params), { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GitLabIssueGetResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load GitLab issue');
    }
    return payload;
  },

  async issueComments(directory: string, number: number, options?: { namespace?: string; project?: string }): Promise<GitLabIssueCommentsResult> {
    const params = new URLSearchParams({ directory, number: String(number) });
    if (options?.namespace) {
      params.set('namespace', options.namespace);
    }
    if (options?.project) {
      params.set('project', options.project);
    }
    const response = await runtimeFetch(urls.api('/api/gitlab/issues/comments', params), { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GitLabIssueCommentsResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load GitLab issue comments');
    }
    return payload;
  },

  async mrsList(directory: string, options?: { page?: number; query?: string; sourceBranch?: string }): Promise<GitLabMergeRequestsListResult> {
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
      `/api/gitlab/mrs/list?${params.toString()}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const payload = await jsonOrNull<GitLabMergeRequestsListResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load GitLab merge requests');
    }
    return payload;
  },

  async mrContext(
    directory: string,
    number: number,
    options?: { includeDiff?: boolean; namespace?: string; project?: string }
  ): Promise<GitLabMergeRequestContextResult> {
    const params = new URLSearchParams({ directory, number: String(number) });
    if (options?.includeDiff) {
      params.set('diff', '1');
    }
    if (options?.namespace) {
      params.set('namespace', options.namespace);
    }
    if (options?.project) {
      params.set('project', options.project);
    }
    const response = await runtimeFetch(urls.api('/api/gitlab/mrs/context', params), { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GitLabMergeRequestContextResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load GitLab merge request context');
    }
    return payload;
  },

  async mrCreate(input: GitLabMergeRequestCreateInput): Promise<GitLabMergeRequest> {
    const response = await runtimeFetch('/api/gitlab/mrs/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await jsonOrNull<GitLabMergeRequestCreateResult & { error?: string }>(response);
    if (!response.ok || !payload?.mr) {
      throw new Error(payload?.error || response.statusText || 'Failed to create GitLab merge request');
    }
    return payload.mr;
  },

  async mrUpdate(input: GitLabMergeRequestUpdateInput): Promise<GitLabMergeRequest> {
    const response = await runtimeFetch('/api/gitlab/mrs/update', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await jsonOrNull<GitLabMergeRequestUpdateResult & { error?: string }>(response);
    if (!response.ok || !payload?.mr) {
      throw new Error(payload?.error || response.statusText || 'Failed to update GitLab merge request');
    }
    return payload.mr;
  },

  async mrMerge(input: GitLabMergeRequestMergeInput): Promise<GitLabMergeRequestMergeResult> {
    const response = await runtimeFetch('/api/gitlab/mrs/merge', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await jsonOrNull<GitLabMergeRequestMergeResult & { error?: string }>(response);
    // The server rejects non-mergeable requests with 405/409/422 and a
    // `{ connected, merged: false, message }` body — parse it and return it
    // instead of throwing. Only throw when there is no parseable payload
    // (network failure) or the server surfaced a real `{ error }`.
    if (!payload) {
      throw new Error(response.statusText || 'Failed to merge GitLab merge request');
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

  async repoBranches(namespace: string, project: string): Promise<string[]> {
    const response = await runtimeFetch(
      `/api/gitlab/repo/branches?namespace=${encodeURIComponent(namespace)}&project=${encodeURIComponent(project)}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const body = await jsonOrNull<GitLabBranchesResult & { error?: string }>(response);
    if (!response.ok || !body) {
      throw new Error(body?.error || response.statusText || 'Failed to fetch GitLab repo branches');
    }
    return body.branches ?? [];
  },
});
