import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitHubAPI, GitHubUserSummary } from '@openchamber/ui/lib/api/types';
import {
  createRuntimeUrlResolver,
  getRuntimeUrlResolver,
  setRuntimeUrlResolver,
} from '@openchamber/ui/lib/runtime-url';

type CommitDetailsMethod = (
  directory: string,
  hash: string,
  remote?: string,
) => Promise<{ connected: boolean; url?: string | null; author?: GitHubUserSummary | null }>;

const runtimeResolver = createRuntimeUrlResolver({ apiBaseUrl: 'http://runtime.test' });

const fetchMock = vi.fn<typeof fetch>();

const getCommitDetails = (api: GitHubAPI): CommitDetailsMethod => {
  const commitDetails = api.commitDetails;
  if (!commitDetails) {
    throw new TypeError('commitDetails is not a function');
  }
  return commitDetails.bind(api);
};

describe('createWebGitHubAPI commitDetails', () => {
  const originalResolver = getRuntimeUrlResolver();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    setRuntimeUrlResolver(runtimeResolver);
  });

  afterEach(() => {
    setRuntimeUrlResolver(originalResolver);
    vi.unstubAllGlobals();
  });

  it('encodes directory, hash, and remote in the runtimeFetch request URL', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls: runtimeResolver });
    fetchMock.mockResolvedValueOnce(Response.json({ connected: false }));

    await getCommitDetails(api)('/repo with spaces', 'abc1234', 'fork/origin');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      `http://runtime.test/api/github/commit/details?${new URLSearchParams({
        directory: '/repo with spaces',
        hash: 'abc1234',
        remote: 'fork/origin',
      }).toString()}`,
    );
    expect(init).toMatchObject({ method: 'GET' });
    expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
  });

  it('omits remote when none is provided', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls: runtimeResolver });
    fetchMock.mockResolvedValueOnce(Response.json({ connected: false }));

    await getCommitDetails(api)('/repo', 'def5678');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      `http://runtime.test/api/github/commit/details?${new URLSearchParams({
        directory: '/repo',
        hash: 'def5678',
      }).toString()}`,
    );
  });

  it('parses a successful commit details payload', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls: runtimeResolver });
    fetchMock.mockResolvedValueOnce(Response.json({
      connected: true,
      url: 'https://github.com/acme/app/commit/abc1234',
      author: {
        login: 'octocat',
        id: 1,
        avatarUrl: 'https://avatars.githubusercontent.com/u/1',
        name: 'Mona Lisa Octocat',
        email: 'mona@example.com',
      },
    }));

    await expect(getCommitDetails(api)('/repo', 'abc1234')).resolves.toEqual({
      connected: true,
      url: 'https://github.com/acme/app/commit/abc1234',
      author: {
        login: 'octocat',
        id: 1,
        avatarUrl: 'https://avatars.githubusercontent.com/u/1',
        name: 'Mona Lisa Octocat',
        email: 'mona@example.com',
      },
    });
  });

  it('throws when the response payload does not match the commit details contract', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls: runtimeResolver });
    fetchMock.mockResolvedValueOnce(Response.json({
      connected: true,
      url: 'https://github.com/acme/app/commit/abc1234',
      author: { login: 42 },
    }));

    await expect(getCommitDetails(api)('/repo', 'abc1234')).rejects.toThrow('Failed to load commit details');
  });

  it('throws when the response is not ok and no valid payload is available', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls: runtimeResolver });
    fetchMock.mockResolvedValueOnce(new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' }));

    await expect(getCommitDetails(api)('/repo', 'abc1234')).rejects.toThrow('Bad Gateway');
  });
});
