import type {
  GitHubAPI,
  GitHubAuthStatus,
  GitHubIssueCommentsResult,
  GitHubIssueGetResult,
  GitHubIssuesListResult,
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
  GitHubRepoUpstreamResult,
  GitHubDeviceFlowComplete,
  GitHubDeviceFlowStart,
  GitHubUserSummary,
} from '@openchamber/ui/lib/api/types';
import type { GitHubApiErrorCode } from '@openchamber/ui/lib/api/github-errors';
import { parseGitHubApiErrorCode } from '@openchamber/ui/lib/api/github-errors';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import type { RuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';

interface WebGitHubAPIOptions {
  urls: RuntimeUrlResolver;
}

const jsonOrNull = async <T>(response: Response): Promise<T | null> => {
  return (await response.json().catch(() => null)) as T | null;
};

type GitHubListPayload<T> = T & { error?: string; code?: unknown };

// List failures carry a server code so the UI can distinguish a timed-out
// search, a missing item, and an unavailable repo from a generic error.
function throwListError(payload: { error?: string; code?: unknown } | null, response: Response, fallback: string): never {
  const error: Error & { code?: GitHubApiErrorCode } = new Error(payload?.error || response.statusText || fallback);
  const code = payload ? parseGitHubApiErrorCode(payload.code) : null;
  if (code) {
    error.code = code;
  }
  throw error;
}

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

  async prsList(directory: string, options?: { page?: number; query?: string; signal?: AbortSignal }): Promise<GitHubPullRequestsListResult> {
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
      { method: 'GET', headers: { Accept: 'application/json' }, signal: options?.signal }
    );
    const body = await jsonOrNull<GitHubListPayload<GitHubPullRequestsListResult>>(response);
    if (!response.ok || !body) {
      throwListError(body, response, 'Failed to load pull requests');
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

  async issuesList(directory: string, options?: { page?: number; query?: string; signal?: AbortSignal }): Promise<GitHubIssuesListResult> {
    const page = options?.page ?? 1;
    const params = new URLSearchParams({
      directory,
      page: String(page),
    });
    if (options?.query) {
      params.set('query', options.query);
    }
    const response = await runtimeFetch(
      `/api/github/issues/list?${params.toString()}`,
      { method: 'GET', headers: { Accept: 'application/json' }, signal: options?.signal }
    );
    const payload = await jsonOrNull<GitHubListPayload<GitHubIssuesListResult>>(response);
    if (!response.ok || !payload) {
      throwListError(payload, response, 'Failed to load issues');
    }
    return payload;
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
