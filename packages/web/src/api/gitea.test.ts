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
  const { createWebGiteaAPI } = await import('./gitea');
  return createWebGiteaAPI({ urls });
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  runtimeFetchMock.mockReset();
});

describe('createWebGiteaAPI', () => {
  it('parses auth status payloads', async () => {
    const status = {
      connected: true,
      user: { username: 'octocat', id: 1, name: 'Octo Cat' },
      accounts: [],
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(status));

    const api = await createAPI();
    await expect(api.authStatus()).resolves.toEqual(status);

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/gitea/auth/status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('sends the access token and base URL when connecting', async () => {
    const status = {
      connected: true,
      user: { username: 'octocat', id: 1 },
      accounts: [],
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(status));

    const api = await createAPI();
    await expect(api.authConnect({ accessToken: 'gitea-123', baseUrl: 'https://gitea.example' })).resolves.toEqual(status);

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/gitea/auth/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ accessToken: 'gitea-123', baseUrl: 'https://gitea.example' }),
    });
  });

  it('passes directory, number, owner and repo query params to issueGet', async () => {
    const result = {
      connected: true,
      repo: null,
      issue: { number: 42, title: 'Broken build', url: 'https://gitea.example/o/r/issues/42', state: 'open', author: { username: 'octocat', id: 1 }, labels: [] },
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.issueGet('/workspace', 42, { owner: 'group', repo: 'repo' })).resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', number: '42', owner: 'group', repo: 'repo' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/gitea/issues/get?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('passes includeDiff and repo params to prContext', async () => {
    const result = { connected: true, repo: null, pr: undefined };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.prContext('/workspace', 7, { includeDiff: true, owner: 'group', repo: 'repo' })).resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', number: '7', includeDiff: '1', owner: 'group', repo: 'repo' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/gitea/pr/context?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('passes sourceBranch query param to prsList', async () => {
    const result = {
      connected: true,
      repo: null,
      prs: [],
      page: 1,
      hasMore: false,
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.prsList('/workspace', { page: 1, query: 'search', sourceBranch: 'feat/api' })).resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', page: '1', query: 'search', sourceBranch: 'feat/api' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/gitea/prs/list?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('omits sourceBranch when not provided to prsList', async () => {
    const result = {
      connected: true,
      repo: null,
      prs: [],
      page: 1,
      hasMore: false,
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.prsList('/workspace', { page: 1 })).resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', page: '1' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/gitea/prs/list?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('posts to /api/gitea/pr/create with the input body and returns the created PR', async () => {
    const created = {
      connected: true,
      repo: null,
      pr: {
        number: 12,
        title: 'Add feature',
        url: 'https://gitea.example/owner/repo/pulls/12',
        state: 'open',
        draft: false,
        author: { username: 'octocat', id: 1 },
        labels: [],
        sourceBranch: 'feat/add',
        targetBranch: 'main',
      },
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(created));

    const api = await createAPI();
    await expect(api.prCreate({
      directory: '/workspace',
      title: 'Add feature',
      sourceBranch: 'feat/add',
      targetBranch: 'main',
    })).resolves.toEqual(created.pr);

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/gitea/pr/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        directory: '/workspace',
        title: 'Add feature',
        sourceBranch: 'feat/add',
        targetBranch: 'main',
      }),
    });
  });

  it('throws the server error when prCreate fails', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { error: 'Your Gitea token needs write:repository scope to create pull requests' },
      { status: 400 },
    ));

    const api = await createAPI();
    await expect(api.prCreate({
      directory: '/workspace',
      title: 'Add feature',
      sourceBranch: 'feat/add',
      targetBranch: 'main',
    })).rejects.toThrow('Your Gitea token needs write:repository scope to create pull requests');
  });

  it('PATCHes to /api/gitea/pr/update with the input body and returns the updated PR', async () => {
    const updated = {
      connected: true,
      repo: null,
      pr: { number: 12, title: 'Renamed', url: 'u', state: 'open', draft: false, author: { username: 'octocat', id: 1 }, labels: [], sourceBranch: 'feat/add', targetBranch: 'main' },
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(updated));

    const api = await createAPI();
    await expect(api.prUpdate({ directory: '/workspace', number: 12, title: 'Renamed', description: 'New body' })).resolves.toEqual(updated.pr);

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/gitea/pr/update', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ directory: '/workspace', number: 12, title: 'Renamed', description: 'New body' }),
    });
  });

  it('returns merged:false without throwing when the server rejects a merge', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { connected: true, merged: false, message: '409 Conflict: already merged' },
      { status: 409 },
    ));

    const api = await createAPI();
    await expect(api.prMerge({ directory: '/workspace', number: 12, method: 'merge' })).resolves.toEqual({
      connected: true,
      merged: false,
      message: '409 Conflict: already merged',
    });

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/gitea/pr/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ directory: '/workspace', number: 12, method: 'merge' }),
    });
  });

  it('resolves merged:true on a successful merge', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, merged: true }));

    const api = await createAPI();
    await expect(api.prMerge({ directory: '/workspace', number: 12 })).resolves.toEqual({ connected: true, merged: true });
  });

  it('throws the server error when prMerge hits a real error payload', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { error: 'Your Gitea token needs write:repository scope to merge pull requests' },
      { status: 400 },
    ));

    const api = await createAPI();
    await expect(api.prMerge({ directory: '/workspace', number: 12 })).rejects.toThrow(
      'Your Gitea token needs write:repository scope to merge pull requests',
    );
  });

  it('throws the response status text when prMerge has no parseable payload', async () => {
    runtimeFetchMock.mockResolvedValueOnce(new Response('upstream gone', { status: 502, statusText: 'Bad Gateway' }));

    const api = await createAPI();
    await expect(api.prMerge({ directory: '/workspace', number: 12 })).rejects.toThrow('Bad Gateway');
  });

  it('parses branches and the default branch from repoBranches', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ branches: ['main', 'feat/api'], defaultBranch: 'main' }));

    const api = await createAPI();
    await expect(api.repoBranches('group', 'sub')).resolves.toEqual({ branches: ['main', 'feat/api'], defaultBranch: 'main' });

    expect(runtimeFetchMock).toHaveBeenCalledWith('/api/gitea/repo/branches?owner=group&repo=sub', {
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
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ error: 'Gitea rate limited' }, { status: 503 }));

    const api = await createAPI();
    await expect(api.repoBranches('group', 'sub')).rejects.toThrow('Gitea rate limited');
  });

  it('throws the response status text when repoBranches has no parseable payload', async () => {
    runtimeFetchMock.mockResolvedValueOnce(new Response('upstream gone', { status: 502, statusText: 'Bad Gateway' }));

    const api = await createAPI();
    await expect(api.repoBranches('group', 'sub')).rejects.toThrow('Bad Gateway');
  });

  it('throws the server error message on {error} payloads', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ error: 'Not connected to Gitea' }, { status: 401 }));

    const api = await createAPI();
    await expect(api.authStatus()).rejects.toThrow('Not connected to Gitea');
  });

  it('throws the response status text when no error payload is present', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({}, { status: 500, statusText: 'Internal Server Error' }));

    const api = await createAPI();
    await expect(api.issuesList('/workspace')).rejects.toThrow('Internal Server Error');
  });

  it('passes directory/query/owner/repo to searchUsers and maps the response', async () => {
    const result = {
      connected: true,
      repo: null,
      users: [{ username: 'octocat', id: 1, name: 'Octo Cat', avatarUrl: 'https://gitea.example/octocat.png' }],
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.searchUsers!('/workspace', 'octo', { owner: 'group', repo: 'repo' })).resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', query: 'octo', owner: 'group', repo: 'repo' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/gitea/users/search?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('omits owner/repo from searchUsers when not provided', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, repo: null, users: [] }));

    const api = await createAPI();
    await expect(api.searchUsers!('/workspace', 'octo')).resolves.toEqual({ connected: true, repo: null, users: [] });

    const params = new URLSearchParams({ directory: '/workspace', query: 'octo' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/gitea/users/search?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('throws the server error message when searchUsers fails', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ error: 'Gitea rate limited' }, { status: 503 }));

    const api = await createAPI();
    await expect(api.searchUsers!('/workspace', 'octo')).rejects.toThrow('Gitea rate limited');
  });

  it('passes directory/query to searchLabels and maps the response', async () => {
    const result = { connected: true, repo: null, labels: [{ name: 'bug', color: 'd73a4a' }] };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.searchLabels!('/workspace', 'feat', { owner: 'group', repo: 'repo' })).resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', query: 'feat', owner: 'group', repo: 'repo' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/gitea/labels/search?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('passes directory/query to searchMilestones and maps the response', async () => {
    const result = { connected: true, repo: null, milestones: [{ title: 'v2.0', state: 'open' }] };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.searchMilestones!('/workspace', 'v2', { owner: 'group', repo: 'repo' })).resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', query: 'v2', owner: 'group', repo: 'repo' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/gitea/milestones/search?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('passes directory/query to searchBranches and maps the response', async () => {
    const result = { connected: true, repo: null, branches: ['main', 'feat/api'] };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.searchBranches!('/workspace', 'feat', { owner: 'group', repo: 'repo' })).resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', query: 'feat', owner: 'group', repo: 'repo' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/gitea/branches/search?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('passes directory/query to searchTags and maps the response', async () => {
    const result = { connected: true, repo: null, tags: ['v1.0', 'v1.1'] };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.searchTags!('/workspace', 'v1', { owner: 'group', repo: 'repo' })).resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', query: 'v1', owner: 'group', repo: 'repo' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/gitea/tags/search?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });
});
