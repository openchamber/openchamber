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
  const { createWebGitHubAPI } = await import('./github');
  return createWebGitHubAPI({ urls });
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  runtimeFetchMock.mockReset();
});

describe('createWebGitHubAPI', () => {
  it('passes directory/query/owner/repo to searchUsers and maps the response', async () => {
    const result = {
      connected: true,
      repo: null,
      users: [{ login: 'octocat', id: 1, name: 'Octo Cat', avatarUrl: 'https://avatars.example/octocat.png' }],
    };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.searchUsers!('/workspace', 'octo', { sourceRepo: { owner: 'acme', repo: 'widget' } }))
      .resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', query: 'octo', owner: 'acme', repo: 'widget' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/github/users/search?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('omits owner/repo from searchUsers when no sourceRepo is provided', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, repo: null, users: [] }));

    const api = await createAPI();
    await expect(api.searchUsers!('/workspace', 'octo')).resolves.toEqual({ connected: true, repo: null, users: [] });

    const params = new URLSearchParams({ directory: '/workspace', query: 'octo' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/github/users/search?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it('defaults missing repo/users fields to null/empty when the response omits them', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true }));

    const api = await createAPI();
    await expect(api.searchUsers!('/workspace', 'octo')).resolves.toEqual({ connected: true, repo: null, users: [] });
  });

  it('throws the server error message when searchUsers fails', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ error: 'GitHub rate limited' }, { status: 503 }));

    const api = await createAPI();
    await expect(api.searchUsers!('/workspace', 'octo')).rejects.toThrow('GitHub rate limited');
  });

  it('passes directory/query to searchLabels and maps the response', async () => {
    const result = { connected: true, repo: null, labels: [{ name: 'bug', color: 'd73a4a' }] };
    runtimeFetchMock.mockResolvedValueOnce(Response.json(result));

    const api = await createAPI();
    await expect(api.searchLabels!('/workspace', 'feat', { sourceRepo: { owner: 'acme', repo: 'widget' } }))
      .resolves.toEqual(result);

    const params = new URLSearchParams({ directory: '/workspace', query: 'feat', owner: 'acme', repo: 'widget' });
    expect(runtimeFetchMock).toHaveBeenCalledWith(`/api/github/labels/search?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });
});
