import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeUrlQuery, RuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';

const runtimeFetchMock = vi.fn();

vi.mock('@openchamber/ui/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

const toUrl = (path: string, query?: RuntimeUrlQuery): string => {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams();
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
};

const urls: RuntimeUrlResolver = {
  api: toUrl,
  authenticatedAsset: toUrl,
  auth: toUrl,
  health: (query?: RuntimeUrlQuery) => toUrl('/health', query),
  rawFile: (path: string) => toUrl('/api/fs/raw', new URLSearchParams({ path })),
  sse: toUrl,
  websocket: toUrl,
};

const createAPI = async () => {
  const { createWebGitLabAPI } = await import('./gitlab');
  return createWebGitLabAPI({ urls });
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  runtimeFetchMock.mockReset();
});

describe('createWebGitLabAPI', () => {
  it('parses auth status payloads', async () => {
    const status = {
      connected: true,
      user: { username: 'octocat', id: 1, name: 'Octo Cat' },
      accounts: [],
      defaultBaseUrl: 'https://gitlab.com',
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(status));

    const api = await createAPI();
    await expect(api.authStatus()).resolves.toEqual(status);

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/gitlab/auth/status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('sends the access token and base URL when connecting', async () => {
    const status = {
      connected: true,
      user: { username: 'octocat', id: 1 },
      accounts: [],
      defaultBaseUrl: 'https://gitlab.com',
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(status));

    const api = await createAPI();
    await expect(api.authConnect({ accessToken: 'glpat-123', baseUrl: 'https://gitlab.example' })).resolves.toEqual(status);

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/gitlab/auth/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ accessToken: 'glpat-123', baseUrl: 'https://gitlab.example' }),
    });
  });

  it('passes directory, number, namespace and project query params to issueGet', async () => {
    const result = {
      connected: true,
      repo: null,
      issue: { number: 42, title: 'Broken build', url: 'https://gitlab.com/g/repo/-/issues/42', state: 'opened', author: { username: 'octocat', id: 1 }, labels: [] },
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.issueGet('/workspace', 42, { namespace: 'group', project: 'repo' })).resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', number: '42', namespace: 'group', project: 'repo' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/gitlab/issues/get?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('passes diff=1 and repo params to mrContext', async () => {
    const result = { connected: true, repo: null, mr: undefined };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.mrContext('/workspace', 7, { includeDiff: true, namespace: 'group', project: 'repo' })).resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', number: '7', diff: '1', namespace: 'group', project: 'repo' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/gitlab/mrs/context?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('passes sourceBranch query param to mrsList', async () => {
    const result = {
      connected: true,
      repo: null,
      mrs: [],
      page: 1,
      hasMore: false,
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.mrsList('/workspace', { page: 1, query: 'search', sourceBranch: 'feat/api' })).resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', page: '1', query: 'search', sourceBranch: 'feat/api' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/gitlab/mrs/list?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('omits sourceBranch when not provided to mrsList', async () => {
    const result = {
      connected: true,
      repo: null,
      mrs: [],
      page: 1,
      hasMore: false,
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.mrsList('/workspace', { page: 1 })).resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', page: '1' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/gitlab/mrs/list?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('posts to /api/gitlab/mrs/create with the input body and returns the created MR', async () => {
    const created = {
      connected: true,
      repo: null,
      mr: {
        number: 12,
        title: 'Add feature',
        url: 'https://gitlab.com/group/sub/-/merge_requests/12',
        state: 'opened',
        draft: false,
        author: { username: 'octocat', id: 1 },
        sourceBranch: 'feat/add',
        targetBranch: 'main',
      },
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(created));

    const api = await createAPI();
    await expect(api.mrCreate({
      directory: '/workspace',
      title: 'Add feature',
      sourceBranch: 'feat/add',
      targetBranch: 'main',
      removeSourceBranch: true,
    })).resolves.toEqual(created.mr);

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/gitlab/mrs/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        directory: '/workspace',
        title: 'Add feature',
        sourceBranch: 'feat/add',
        targetBranch: 'main',
        removeSourceBranch: true,
      }),
    });
  });

  it('throws the server error when mrCreate fails', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { error: 'Your GitLab token needs the api scope to create merge requests' },
      { status: 400 },
    ));

    const api = await createAPI();
    await expect(api.mrCreate({
      directory: '/workspace',
      title: 'Add feature',
      sourceBranch: 'feat/add',
      targetBranch: 'main',
    })).rejects.toThrow('Your GitLab token needs the api scope to create merge requests');
  });

  it('PUTs to /api/gitlab/mrs/update with the input body and returns the updated MR', async () => {
    const updated = {
      connected: true,
      repo: null,
      mr: { number: 12, title: 'Renamed', url: 'u', state: 'opened', draft: false, author: { username: 'octocat', id: 1 }, sourceBranch: 'feat/add', targetBranch: 'main' },
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(updated));

    const api = await createAPI();
    await expect(api.mrUpdate({ directory: '/workspace', number: 12, title: 'Renamed', description: 'New body' })).resolves.toEqual(updated.mr);

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/gitlab/mrs/update', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ directory: '/workspace', number: 12, title: 'Renamed', description: 'New body' }),
    });
  });

  it('returns merged:false without throwing when the server rejects a merge', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { connected: true, merged: false, message: '405 Method Not Allowed: not open' },
      { status: 405 },
    ));

    const api = await createAPI();
    await expect(api.mrMerge({ directory: '/workspace', number: 12, squash: true })).resolves.toEqual({
      connected: true,
      merged: false,
      message: '405 Method Not Allowed: not open',
    });

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/gitlab/mrs/merge', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ directory: '/workspace', number: 12, squash: true }),
    });
  });

  it('resolves merged:true on a successful merge', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, merged: true }));

    const api = await createAPI();
    await expect(api.mrMerge({ directory: '/workspace', number: 12 })).resolves.toEqual({ connected: true, merged: true });
  });

  it('throws the server error when mrMerge hits a real error payload', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { error: 'Your GitLab token needs the api scope to create merge requests' },
      { status: 400 },
    ));

    const api = await createAPI();
    await expect(api.mrMerge({ directory: '/workspace', number: 12 })).rejects.toThrow(
      'Your GitLab token needs the api scope to create merge requests',
    );
  });

  it('throws the response status text when mrMerge has no parseable payload', async () => {
    runtimeFetchMock.mockResolvedValueOnce(new Response('upstream gone', { status: 502, statusText: 'Bad Gateway' }));

    const api = await createAPI();
    await expect(api.mrMerge({ directory: '/workspace', number: 12 })).rejects.toThrow('Bad Gateway');
  });

  it('parses branches and the default branch from repoBranches', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ branches: ['main', 'feat/api'], defaultBranch: 'main' }));

    const api = await createAPI();
    await expect(api.repoBranches('group', 'sub')).resolves.toEqual({ branches: ['main', 'feat/api'], defaultBranch: 'main' });

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/gitlab/repo/branches?namespace=group&project=sub', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('defaults defaultBranch to null when repoBranches omits it', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ branches: ['main'] }));

    const api = await createAPI();
    await expect(api.repoBranches('group', 'sub')).resolves.toEqual({ branches: ['main'], defaultBranch: null });
  });

  it('throws the server error message when repoBranches fails', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ error: 'GitLab rate limited' }, { status: 503 }));

    const api = await createAPI();
    await expect(api.repoBranches('group', 'sub')).rejects.toThrow('GitLab rate limited');
  });

  it('throws the response status text when repoBranches has no parseable payload', async () => {
    runtimeFetchMock.mockResolvedValueOnce(new Response('upstream gone', { status: 502, statusText: 'Bad Gateway' }));

    const api = await createAPI();
    await expect(api.repoBranches('group', 'sub')).rejects.toThrow('Bad Gateway');
  });

  it('throws the server error message on {error} payloads', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ error: 'Not connected to GitLab' }, { status: 401 }));

    const api = await createAPI();
    await expect(api.authStatus()).rejects.toThrow('Not connected to GitLab');
  });

  it('throws the response status text when no error payload is present', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({}, { status: 500, statusText: 'Internal Server Error' }));

    const api = await createAPI();
    await expect(api.issuesList('/workspace')).rejects.toThrow('Internal Server Error');
  });
});
