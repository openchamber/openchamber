import { afterEach, describe, expect, it, vi } from 'vitest';

import { getGitHubApiErrorCode } from '@openchamber/ui/lib/api/github-errors';
import type { RuntimeUrlQuery, RuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';

const runtimeFetchMock = vi.fn();

const captureError = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (thrown) {
    return thrown instanceof Error ? thrown : new Error(String(thrown));
  }
  throw new Error('Expected the call to reject');
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

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

describe('createWebGitHubAPI list calls', () => {
  it('passes the caller signal through to runtimeFetch for prsList', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls });
    const controller = new AbortController();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, prs: [] }));

    await api.prsList('/workspace', { page: 1, query: 'bug', signal: controller.signal });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    const [, init] = runtimeFetchMock.mock.calls[0];
    expect(init?.signal).toBe(controller.signal);
  });

  it('passes the caller signal through to runtimeFetch for issuesList', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls });
    const controller = new AbortController();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, issues: [] }));

    await api.issuesList('/workspace', { page: 1, query: 'bug', signal: controller.signal });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    const [, init] = runtimeFetchMock.mock.calls[0];
    expect(init?.signal).toBe(controller.signal);
  });

  it('carries the search_timeout code and message from a 504 prsList response', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls });
    runtimeFetchMock.mockResolvedValueOnce(
      Response.json({ error: 'Search timed out', code: 'search_timeout' }, { status: 504 }),
    );

    await expect(api.prsList('/workspace', { page: 1, query: 'bug' })).rejects.toMatchObject({
      message: 'Search timed out',
      code: 'search_timeout',
    });
  });

  it('carries the search_timeout code and message from a 504 issuesList response', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls });
    runtimeFetchMock.mockResolvedValueOnce(
      Response.json({ error: 'Search timed out', code: 'search_timeout' }, { status: 504 }),
    );

    await expect(api.issuesList('/workspace', { page: 1, query: 'bug' })).rejects.toMatchObject({
      message: 'Search timed out',
      code: 'search_timeout',
    });
  });

  it('carries the not_found code from a 404 issuesList response', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls });
    runtimeFetchMock.mockResolvedValueOnce(
      Response.json({ error: 'Issue not found', code: 'not_found' }, { status: 404 }),
    );

    await expect(api.issuesList('/workspace', { page: 1, query: '999' })).rejects.toMatchObject({
      message: 'Issue not found',
      code: 'not_found',
    });
  });

  it('carries the repo_unavailable code from a 422 prsList response', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls });
    runtimeFetchMock.mockResolvedValueOnce(
      Response.json({ error: 'Repository is not available for this project', code: 'repo_unavailable' }, { status: 422 }),
    );

    await expect(api.prsList('/workspace', { page: 1, query: 'https://github.com/other/fork/pull/9' })).rejects.toMatchObject({
      message: 'Repository is not available for this project',
      code: 'repo_unavailable',
    });
  });

  it('keeps an unrelated failure free of GitHub list codes', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ error: 'rate limited' }, { status: 500 }));

    const error = await captureError(api.issuesList('/workspace', { page: 1, query: 'bug' }));

    expect(error.message).toBe('rate limited');
    expect(getGitHubApiErrorCode(error)).toBeNull();
  });

  it('returns a successful list body unchanged', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, prs: [], hasMore: false }));

    await expect(api.prsList('/workspace')).resolves.toEqual({ connected: true, prs: [], hasMore: false });
  });
});
