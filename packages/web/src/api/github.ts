import type {
  GitHubAPI,
  GitHubAuthStatus,
  GitHubCommitDetails,
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
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import type { RuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';

interface WebGitHubAPIOptions {
  urls: RuntimeUrlResolver;
}

type RawScalar = string | number | boolean | null;

type RawGitHubUserSummaryObject = {
  login?: RawScalar;
  id?: RawScalar;
  avatarUrl?: RawScalar;
  name?: RawScalar;
  email?: RawScalar;
};

type RawGitHubUserSummaryPayload = RawScalar | RawGitHubUserSummaryObject;

type RawGitHubCommitDetailsObject = {
  connected?: RawScalar;
  url?: RawScalar;
  author?: RawGitHubUserSummaryPayload;
  error?: RawScalar;
};

type RawGitHubCommitDetailsPayload = RawScalar | RawGitHubCommitDetailsObject;

type RawCommitDetailsFieldValue =
  | RawScalar
  | RawGitHubUserSummaryObject
  | RawGitHubCommitDetailsObject
  | undefined;

type ParsedField<T> =
  | { ok: true; value: T }
  | { ok: false };

const valueTag = (value: RawCommitDetailsFieldValue): string => {
  return Object.prototype.toString.call(value);
};

const isBooleanValue = (value: RawCommitDetailsFieldValue): value is boolean => {
  return valueTag(value) === '[object Boolean]';
};

const isNumberValue = (value: RawCommitDetailsFieldValue): value is number => {
  return valueTag(value) === '[object Number]';
};

const isStringValue = (value: RawCommitDetailsFieldValue): value is string => {
  return valueTag(value) === '[object String]';
};

const isGitHubUserSummaryPayloadObject = (value: RawGitHubUserSummaryPayload | undefined): value is Exclude<RawGitHubUserSummaryPayload, RawScalar> => {
  return valueTag(value) === '[object Object]';
};

const isGitHubCommitDetailsPayloadObject = (value: RawGitHubCommitDetailsPayload | null): value is Exclude<RawGitHubCommitDetailsPayload, RawScalar> => {
  return valueTag(value) === '[object Object]';
};

const parseRequiredBooleanField = (value: RawCommitDetailsFieldValue): ParsedField<boolean> => {
  if (!isBooleanValue(value)) {
    return { ok: false };
  }
  return { ok: true, value };
};

const parseOptionalNumberField = (value: RawCommitDetailsFieldValue): ParsedField<number | undefined> => {
  if (value == null) {
    return { ok: true, value: undefined };
  }
  if (!isNumberValue(value)) {
    return { ok: false };
  }
  return { ok: true, value };
};

const parseOptionalStringField = (value: RawCommitDetailsFieldValue): ParsedField<string | undefined> => {
  if (value == null) {
    return { ok: true, value: undefined };
  }
  if (!isStringValue(value)) {
    return { ok: false };
  }
  return { ok: true, value };
};

const parseOptionalNullableStringField = (value: RawCommitDetailsFieldValue): ParsedField<string | null | undefined> => {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === null) {
    return { ok: true, value: null };
  }
  if (!isStringValue(value)) {
    return { ok: false };
  }
  return { ok: true, value };
};

const parseGitHubUserSummaryField = (value: RawGitHubUserSummaryPayload | undefined): ParsedField<GitHubUserSummary | null | undefined> => {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === null) {
    return { ok: true, value: null };
  }
  if (!isGitHubUserSummaryPayloadObject(value)) {
    return { ok: false };
  }

  const loginField = parseOptionalStringField(value.login);
  if (!loginField.ok || !loginField.value) {
    return { ok: false };
  }

  const idField = parseOptionalNumberField(value.id);
  const avatarUrlField = parseOptionalStringField(value.avatarUrl);
  const nameField = parseOptionalStringField(value.name);
  const emailField = parseOptionalStringField(value.email);
  if (!idField.ok || !avatarUrlField.ok || !nameField.ok || !emailField.ok) {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      login: loginField.value,
      id: idField.value,
      avatarUrl: avatarUrlField.value,
      name: nameField.value,
      email: emailField.value,
    },
  };
};

const parseGitHubCommitDetailsPayload = (value: RawGitHubCommitDetailsPayload | null): GitHubCommitDetails | null => {
  if (!isGitHubCommitDetailsPayloadObject(value)) {
    return null;
  }

  const connectedField = parseRequiredBooleanField(value.connected);
  const urlField = parseOptionalNullableStringField(value.url);
  const authorField = parseGitHubUserSummaryField(value.author);
  if (!connectedField.ok || !urlField.ok || !authorField.ok) {
    return null;
  }

  const details: GitHubCommitDetails = {
    connected: connectedField.value,
  };
  if (urlField.value !== undefined) {
    details.url = urlField.value;
  }
  if (authorField.value !== undefined) {
    details.author = authorField.value;
  }
  return details;
};

const parseGitHubErrorMessage = (value: RawGitHubCommitDetailsPayload | null): string | null => {
  if (!isGitHubCommitDetailsPayloadObject(value) || !isStringValue(value.error)) {
    return null;
  }
  return value.error;
};

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

  async commitDetails(directory: string, hash: string, remote?: string): Promise<GitHubCommitDetails> {
    const params = new URLSearchParams({ directory, hash });
    if (remote) {
      params.set('remote', remote);
    }
    const response = await runtimeFetch(
      `/api/github/commit/details?${params.toString()}`,
      { method: 'GET', headers: { Accept: 'application/json' } },
    );
    const payload = await jsonOrNull<RawGitHubCommitDetailsPayload>(response);
    const details = parseGitHubCommitDetailsPayload(payload);
    if (!response.ok || !details) {
      const errorMessage = parseGitHubErrorMessage(payload);
      const message = errorMessage
        ? errorMessage
        : response.statusText || 'Failed to load commit details';
      throw new Error(message);
    }
    return details;
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

  async issuesList(directory: string, options?: { page?: number; query?: string }): Promise<GitHubIssuesListResult> {
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
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    const payload = await jsonOrNull<GitHubIssuesListResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load issues');
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
