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

const jsonOrNull = async <T>(response: Response): Promise<T | null> => {
  return (await response.json().catch(() => null)) as T | null;
};

export const createWebGitHubAPI = (): GitHubAPI => ({
  async authStatus(): Promise<GitHubAuthStatus> {
    const response = await fetch('/api/github/auth/status', { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GitHubAuthStatus & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load GitHub status');
    }
    return payload;
  },

  async authStart(): Promise<GitHubDeviceFlowStart> {
    const response = await fetch('/api/github/auth/start', {
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
    const response = await fetch('/api/github/auth/complete', {
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
    const response = await fetch('/api/github/auth', { method: 'DELETE', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<{ removed?: boolean; error?: string }>(response);
    if (!response.ok) {
      throw new Error(payload?.error || response.statusText || 'Failed to disconnect GitHub');
    }
    return { removed: Boolean(payload?.removed) };
  },

  async authActivate(accountId: string): Promise<GitHubAuthStatus> {
    const response = await fetch('/api/github/auth/activate', {
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

  async me(): Promise<GitHubUserSummary> {
    const response = await fetch('/api/github/me', { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await jsonOrNull<GitHubUserSummary & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to fetch GitHub user');
    }
    return payload;
  },

  async prStatus(directory: string, branch: string, remote?: string): Promise<GitHubPullRequestStatus> {
    const params = new URLSearchParams({
      directory,
      branch,
      ...(remote ? { remote } : {}),
    });
    const response = await fetch(
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
    const response = await fetch('/api/github/pr/create', {
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
    const response = await fetch('/api/github/pr/update', {
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
    const response = await fetch('/api/github/pr/merge', {
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
    const response = await fetch('/api/github/pr/ready', {
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
    const response = await fetch(
      `/api/github/repo/upstream?directory=${encodeURIComponent(directory)}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const body = await jsonOrNull<GitHubRepoUpstreamResult & { error?: string }>(response);
    if (!response.ok || !body) {
      throw new Error(body?.error || response.statusText || 'Failed to detect upstream repo');
    }
    return body;
  },

  async prsList(directory: string, options?: { page?: number }): Promise<GitHubPullRequestsListResult> {
    const page = options?.page ?? 1;
    const response = await fetch(
      `/api/github/pulls/list?directory=${encodeURIComponent(directory)}&page=${encodeURIComponent(String(page))}`,
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
    options?: { includeDiff?: boolean; includeCheckDetails?: boolean }
  ): Promise<GitHubPullRequestContextResult> {
    const url = new URL('/api/github/pulls/context', window.location.origin);
    url.searchParams.set('directory', directory);
    url.searchParams.set('number', String(number));
    if (options?.includeDiff) {
      url.searchParams.set('diff', '1');
    }
    if (options?.includeCheckDetails) {
      url.searchParams.set('checkDetails', '1');
    }
    const response = await fetch(url.toString(), { method: 'GET', headers: { Accept: 'application/json' } });
    const body = await jsonOrNull<GitHubPullRequestContextResult & { error?: string }>(response);
    if (!response.ok || !body) {
      throw new Error(body?.error || response.statusText || 'Failed to load pull request context');
    }
    return body;
  },

  async issuesList(directory: string, options?: { page?: number }): Promise<GitHubIssuesListResult> {
    const page = options?.page ?? 1;
    const response = await fetch(
      `/api/github/issues/list?directory=${encodeURIComponent(directory)}&page=${encodeURIComponent(String(page))}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const payload = await jsonOrNull<GitHubIssuesListResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load issues');
    }
    return payload;
  },

  async issueGet(directory: string, number: number): Promise<GitHubIssueGetResult> {
    const response = await fetch(
      `/api/github/issues/get?directory=${encodeURIComponent(directory)}&number=${encodeURIComponent(String(number))}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const payload = await jsonOrNull<GitHubIssueGetResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load issue');
    }
    return payload;
  },

  async issueComments(directory: string, number: number): Promise<GitHubIssueCommentsResult> {
    const response = await fetch(
      `/api/github/issues/comments?directory=${encodeURIComponent(directory)}&number=${encodeURIComponent(String(number))}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const payload = await jsonOrNull<GitHubIssueCommentsResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load issue comments');
    }
    return payload;
  },
});
