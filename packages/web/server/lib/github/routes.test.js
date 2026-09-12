import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Octokit } from '@octokit/rest';

import { resolveRepoNetwork } from './repo/fork-detection.js';

// A real Octokit whose transport is stubbed. This routes the thrown fetch
// errors through @octokit/request's real fetch-wrapper, so the tests exercise
// the exact wrapped shape production sees (a TimeoutError from
// AbortSignal.timeout becomes an "HttpError" RequestError with `cause` set to
// the original error).
const requestFetchMock = vi.fn();
const octokit = new Octokit({
  auth: 'test-token',
  request: { fetch: requestFetchMock },
});

vi.mock('./index.js', () => ({
  getOctokitOrNull: () => octokit,
  resolveGitHubRepoFromDirectory: async () => ({
    repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app' },
  }),
}));

vi.mock('./repo/fork-detection.js', () => ({
  resolveRepoNetwork: vi.fn(async () => null),
}));

const { registerGitHubRoutes } = await import('./routes.js');

const createApp = () => {
  const app = express();
  registerGitHubRoutes(app);
  return app;
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const namedError = (name, message) => {
  const error = new Error(message);
  error.name = name;
  return error;
};

const issuePayload = (number = 42, title = 'Fix the bug') => ({
  number,
  title,
  html_url: `https://github.com/acme/app/issues/${number}`,
  state: 'open',
  user: { login: 'alice', id: 7, avatar_url: 'https://avatars.githubusercontent.com/u/7' },
  labels: [{ name: 'bug', color: 'ff0000' }],
});

const pullPayload = (number = 42, title = 'Add feature') => ({
  number,
  title,
  html_url: `https://github.com/acme/app/pull/${number}`,
  state: 'open',
  draft: false,
  merged_at: null,
  base: { ref: 'main' },
  head: {
    ref: 'feature',
    sha: 'abc123',
    label: 'acme:feature',
    repo: {
      owner: { login: 'acme' },
      name: 'app',
      html_url: 'https://github.com/acme/app',
      clone_url: 'https://github.com/acme/app.git',
      ssh_url: 'git@github.com:acme/app.git',
    },
  },
  user: { login: 'alice', id: 7, avatar_url: 'https://avatars.githubusercontent.com/u/7' },
});

const fetchUrl = (callIndex = 0) => String(requestFetchMock.mock.calls[callIndex][0]);

afterEach(() => {
  vi.clearAllMocks();
});

describe('GitHub list search failures', () => {
  it('returns 504 with search_timeout for a timed-out issue search', async () => {
    const app = createApp();
    requestFetchMock.mockRejectedValueOnce(namedError('TimeoutError', 'The operation was aborted due to timeout'));

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', page: '1', query: 'bug' })
      .expect(504);

    expect(response.body).toEqual({ error: 'Search timed out', code: 'search_timeout' });
  });

  it('returns 504 with search_timeout for a timed-out PR search', async () => {
    const app = createApp();
    requestFetchMock.mockRejectedValueOnce(namedError('TimeoutError', 'The operation was aborted due to timeout'));

    const response = await request(app)
      .get('/api/github/pulls/list')
      .query({ directory: '/workspace', page: '1', query: 'bug' })
      .expect(504);

    expect(response.body).toEqual({ error: 'Search timed out', code: 'search_timeout' });
  });

  it('fails a non-timeout issue search with 500 instead of an empty list', async () => {
    const app = createApp();
    requestFetchMock.mockRejectedValueOnce(new Error('rate limited'));

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', page: '1', query: 'bug' })
      .expect(500);

    expect(response.body.error).toBe('rate limited');
  });

  it('fails a non-timeout PR search with 500', async () => {
    const app = createApp();
    requestFetchMock.mockRejectedValueOnce(new Error('rate limited'));

    const response = await request(app)
      .get('/api/github/pulls/list')
      .query({ directory: '/workspace', page: '1', query: 'bug' })
      .expect(500);

    expect(response.body.error).toBe('rate limited');
  });
});

describe('GitHub issues/list exact references', () => {
  it('resolves a bare issue number with a single issues.get call', async () => {
    const app = createApp();
    requestFetchMock.mockResolvedValueOnce(jsonResponse(issuePayload()));

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', page: '1', query: '#42' })
      .expect(200);

    expect(requestFetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrl()).toContain('/repos/acme/app/issues/42');
    expect(fetchUrl()).not.toContain('/search/');
    expect(response.body).toMatchObject({
      connected: true,
      repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app', source: 'origin' },
      page: 1,
      hasMore: false,
      issues: [{
        number: 42,
        title: 'Fix the bug',
        state: 'open',
        sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
      }],
    });
  });

  it('keeps a closed issue when resolving an exact number', async () => {
    const app = createApp();
    requestFetchMock.mockResolvedValueOnce(jsonResponse({ ...issuePayload(), state: 'closed' }));

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', page: '1', query: '42' })
      .expect(200);

    expect(requestFetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrl()).toContain('/repos/acme/app/issues/42');
    expect(response.body.issues).toMatchObject([
      { number: 42, state: 'closed', sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' } },
    ]);
  });

  it('resolves a same-repo URL without the fork network', async () => {
    const app = createApp();
    requestFetchMock.mockResolvedValueOnce(jsonResponse(issuePayload()));

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', query: 'https://github.com/acme/app/issues/42' })
      .expect(200);

    expect(requestFetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrl()).toContain('/repos/acme/app/issues/42');
    expect(resolveRepoNetwork).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      connected: true,
      repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app', source: 'origin' },
      issues: [{ number: 42, sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' } }],
    });
  });

  it('matches a differently-cased same-repo URL locally', async () => {
    const app = createApp();
    requestFetchMock.mockResolvedValueOnce(jsonResponse(issuePayload()));

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', query: 'https://github.com/ACME/App/issues/42' })
      .expect(200);

    expect(requestFetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrl()).toContain('/repos/acme/app/issues/42');
    expect(resolveRepoNetwork).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      connected: true,
      repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app', source: 'origin' },
      issues: [{ number: 42, sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' } }],
    });
  });

  it('resolves a fork-network repo URL against that network repo', async () => {
    const app = createApp();
    resolveRepoNetwork.mockResolvedValueOnce([
      { owner: 'other', repo: 'fork', url: 'https://github.com/other/fork', source: 'upstream' },
    ]);
    requestFetchMock.mockResolvedValueOnce(jsonResponse(issuePayload(9, 'Fork issue')));

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', query: 'https://github.com/other/fork/issues/9' })
      .expect(200);

    expect(requestFetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrl()).toContain('/repos/other/fork/issues/9');
    expect(response.body.repo).toEqual({
      owner: 'other',
      repo: 'fork',
      url: 'https://github.com/other/fork',
      source: 'upstream',
    });
    expect(response.body.issues).toMatchObject([
      { number: 9, sourceRepo: { owner: 'other', repo: 'fork', source: 'upstream' } },
    ]);
  });

  it('rejects a URL outside the project repo network with repo_unavailable', async () => {
    const app = createApp();

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', query: 'https://github.com/other/fork/issues/9' })
      .expect(422);

    expect(response.body).toEqual({
      error: 'Repository is not available for this project',
      code: 'repo_unavailable',
    });
    expect(requestFetchMock).not.toHaveBeenCalled();
  });

  it('rejects a PR URL on the issues route with not_found', async () => {
    const app = createApp();

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', query: 'https://github.com/acme/app/pull/42' })
      .expect(404);

    expect(response.body).toEqual({ error: 'Issue not found', code: 'not_found' });
    expect(requestFetchMock).not.toHaveBeenCalled();
  });

  it('reports a GitHub 404 for an exact issue as not_found', async () => {
    const app = createApp();
    requestFetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Not Found' }, 404));

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', query: '999' })
      .expect(404);

    expect(response.body).toEqual({ error: 'Issue not found', code: 'not_found' });
    expect(requestFetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a number that belongs to a PR as not_found', async () => {
    const app = createApp();
    requestFetchMock.mockResolvedValueOnce(jsonResponse({
      ...issuePayload(42, 'A pull request'),
      pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/42' },
    }));

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', query: '42' })
      .expect(404);

    expect(response.body).toEqual({ error: 'Issue not found', code: 'not_found' });
  });

  it('does not take the exact path for pages after the first', async () => {
    const app = createApp();
    requestFetchMock.mockResolvedValueOnce(jsonResponse({ total_count: 0, items: [] }));

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', page: '2', query: '42' })
      .expect(200);

    expect(fetchUrl()).toContain('/search/issues');
    expect(response.body).toMatchObject({ connected: true, page: 2, issues: [], hasMore: false });
  });
});

describe('GitHub pulls/list exact references', () => {
  it('resolves a bare pull number with a single pulls.get call', async () => {
    const app = createApp();
    requestFetchMock.mockResolvedValueOnce(jsonResponse(pullPayload()));

    const response = await request(app)
      .get('/api/github/pulls/list')
      .query({ directory: '/workspace', page: '1', query: '42' })
      .expect(200);

    expect(requestFetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrl()).toContain('/repos/acme/app/pulls/42');
    expect(fetchUrl()).not.toContain('/comments');
    expect(fetchUrl()).not.toContain('/files');
    expect(fetchUrl()).not.toContain('/check-runs');
    expect(response.body).toMatchObject({
      connected: true,
      repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app', source: 'origin' },
      page: 1,
      hasMore: false,
      prs: [{
        number: 42,
        title: 'Add feature',
        state: 'open',
        draft: false,
        base: 'main',
        head: 'feature',
        headSha: 'abc123',
        sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
      }],
    });
  });

  it('resolves a #-prefixed pull number with a single pulls.get call', async () => {
    const app = createApp();
    requestFetchMock.mockResolvedValueOnce(jsonResponse(pullPayload()));

    const response = await request(app)
      .get('/api/github/pulls/list')
      .query({ directory: '/workspace', page: '1', query: '#42' })
      .expect(200);

    expect(requestFetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrl()).toContain('/repos/acme/app/pulls/42');
    expect(fetchUrl()).not.toContain('/search/');
    expect(response.body).toMatchObject({
      connected: true,
      repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app', source: 'origin' },
      page: 1,
      hasMore: false,
      prs: [{
        number: 42,
        title: 'Add feature',
        state: 'open',
        sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
      }],
    });
  });

  it('keeps a merged pull request when resolving an exact number', async () => {
    const app = createApp();
    requestFetchMock.mockResolvedValueOnce(jsonResponse({
      ...pullPayload(),
      state: 'closed',
      merged_at: '2026-01-01T00:00:00Z',
    }));

    const response = await request(app)
      .get('/api/github/pulls/list')
      .query({ directory: '/workspace', page: '1', query: '42' })
      .expect(200);

    expect(requestFetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrl()).toContain('/repos/acme/app/pulls/42');
    expect(response.body.prs).toMatchObject([{ number: 42, state: 'merged' }]);
  });

  it('rejects an issue URL on the pulls route with not_found', async () => {
    const app = createApp();

    const response = await request(app)
      .get('/api/github/pulls/list')
      .query({ directory: '/workspace', query: 'https://github.com/acme/app/issues/42' })
      .expect(404);

    expect(response.body).toEqual({ error: 'Pull request not found', code: 'not_found' });
    expect(requestFetchMock).not.toHaveBeenCalled();
  });

  it('reports a GitHub 404 for an exact pull request as not_found', async () => {
    const app = createApp();
    requestFetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Not Found' }, 404));

    const response = await request(app)
      .get('/api/github/pulls/list')
      .query({ directory: '/workspace', query: '999' })
      .expect(404);

    expect(response.body).toEqual({ error: 'Pull request not found', code: 'not_found' });
    expect(requestFetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a URL outside the project repo network with repo_unavailable', async () => {
    const app = createApp();

    const response = await request(app)
      .get('/api/github/pulls/list')
      .query({ directory: '/workspace', query: 'https://github.com/other/fork/pull/9' })
      .expect(422);

    expect(response.body).toEqual({
      error: 'Repository is not available for this project',
      code: 'repo_unavailable',
    });
    expect(requestFetchMock).not.toHaveBeenCalled();
  });
});

describe('GitHub list text search', () => {
  it('searches and maps issue results for free text', async () => {
    const app = createApp();
    requestFetchMock.mockResolvedValueOnce(jsonResponse({
      total_count: 1,
      items: [{ ...issuePayload(), repository_url: 'https://api.github.com/repos/acme/app' }],
    }));

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', page: '1', query: 'bug' })
      .expect(200);

    expect(requestFetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrl()).toContain('/search/issues');
    expect(response.body).toMatchObject({
      connected: true,
      hasMore: false,
      issues: [{
        number: 42,
        title: 'Fix the bug',
        sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
      }],
    });
  });

  it('searches and maps pull request results for free text', async () => {
    const app = createApp();
    requestFetchMock
      .mockResolvedValueOnce(jsonResponse({
        total_count: 1,
        items: [{ number: 42, repository_url: 'https://api.github.com/repos/acme/app' }],
      }))
      .mockResolvedValueOnce(jsonResponse(pullPayload()));

    const response = await request(app)
      .get('/api/github/pulls/list')
      .query({ directory: '/workspace', page: '1', query: 'bug' })
      .expect(200);

    expect(requestFetchMock).toHaveBeenCalledTimes(2);
    expect(fetchUrl(0)).toContain('/search/issues');
    expect(fetchUrl(1)).toContain('/repos/acme/app/pulls/42');
    expect(response.body).toMatchObject({
      connected: true,
      hasMore: false,
      prs: [{
        number: 42,
        title: 'Add feature',
        sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
      }],
    });
  });

  it('keeps mixed text and number on the search path', async () => {
    const app = createApp();
    requestFetchMock.mockResolvedValueOnce(jsonResponse({ total_count: 0, items: [] }));

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', page: '1', query: '123 bug' })
      .expect(200);

    expect(fetchUrl()).toContain('/search/issues');
    expect(fetchUrl()).not.toContain('/repos/acme/app/issues/123');
    expect(response.body).toMatchObject({ connected: true, issues: [], hasMore: false });
  });
});
