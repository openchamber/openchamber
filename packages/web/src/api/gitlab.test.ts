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
