import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getOctokitOrNull = vi.fn();
const resolveGitHubRepoFromDirectory = vi.fn();
const resolveRepoNetwork = vi.fn();
const clearGitHubAuth = vi.fn();

vi.mock('./index.js', () => ({
  getOctokitOrNull,
  resolveGitHubRepoFromDirectory,
  clearGitHubAuth,
}));

vi.mock('./repo/fork-detection.js', () => ({
  resolveRepoNetwork,
}));

const { registerGitHubRoutes } = await import('./routes.js');

const repo = { owner: 'acme', repo: 'app' };

const searchHit = (number, title) => ({
  number,
  title,
  html_url: `https://github.com/acme/app/pull/${number}`,
  state: 'open',
  draft: false,
  user: { login: 'ada', id: 1, avatar_url: 'https://example.com/ada.png' },
  repository_url: 'https://api.github.com/repos/acme/app',
});

const pullPayload = (number) => ({
  number,
  title: `Enriched ${number}`,
  html_url: `https://github.com/acme/app/pull/${number}`,
  state: 'open',
  draft: false,
  merged_at: null,
  mergeable: true,
  mergeable_state: 'clean',
  user: { login: 'ada', id: 1, avatar_url: 'https://example.com/ada.png' },
  base: { ref: 'main' },
  head: { ref: `feature-${number}`, sha: `sha-${number}`, label: `acme:feature-${number}` },
});

const createApp = () => {
  const app = express();
  registerGitHubRoutes(app);
  return app;
};

describe('GET /api/github/pulls/list search', () => {
  beforeEach(() => {
    getOctokitOrNull.mockReset();
    resolveGitHubRepoFromDirectory.mockReset();
    resolveRepoNetwork.mockReset();
    clearGitHubAuth.mockReset();
    resolveGitHubRepoFromDirectory.mockResolvedValue({ repo, remoteUrl: 'https://github.com/acme/app.git' });
    resolveRepoNetwork.mockResolvedValue(null);
  });

  it('returns every search hit and incomplete when enrichment fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const octokit = {
      rest: {
        search: {
          issuesAndPullRequests: vi.fn(async () => ({
            data: {
              total_count: 2,
              incomplete_results: false,
              items: [searchHit(10, 'Keep me'), searchHit(11, 'Do not drop me')],
            },
          })),
        },
        pulls: {
          get: vi.fn(async ({ pull_number }) => {
            if (pull_number === 11) throw new Error('octokit timeout');
            return { data: pullPayload(pull_number) };
          }),
        },
      },
    };
    getOctokitOrNull.mockReturnValue(octokit);

    const response = await request(createApp())
      .get('/api/github/pulls/list')
      .query({ directory: '/repo', query: 'fix' })
      .expect(200);

    expect(response.body.connected).toBe(true);
    expect(response.body.incomplete).toBe(true);
    expect(response.body.prs.map((pr) => pr.number)).toEqual([10, 11]);
    expect(response.body.prs[0].head).toBe('feature-10');
    expect(response.body.prs[1]).toMatchObject({
      number: 11,
      title: 'Do not drop me',
      url: 'https://github.com/acme/app/pull/11',
      head: '',
      base: '',
    });
    expect(octokit.rest.search.issuesAndPullRequests).toHaveBeenCalledTimes(1);
  });

  it('omits incomplete when every search hit is enriched', async () => {
    const octokit = {
      rest: {
        search: {
          issuesAndPullRequests: vi.fn(async () => ({
            data: {
              total_count: 1,
              incomplete_results: false,
              items: [searchHit(10, 'Ready')],
            },
          })),
        },
        pulls: {
          get: vi.fn(async ({ pull_number }) => ({ data: pullPayload(pull_number) })),
        },
      },
    };
    getOctokitOrNull.mockReturnValue(octokit);

    const response = await request(createApp())
      .get('/api/github/pulls/list')
      .query({ directory: '/repo', query: 'ready' })
      .expect(200);

    expect(response.body.prs).toHaveLength(1);
    expect(response.body.incomplete).toBeUndefined();
  });

  it('does not mask a search-level failure as an empty complete list', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const octokit = {
      rest: {
        search: {
          issuesAndPullRequests: vi.fn(async () => {
            throw new Error('search exploded');
          }),
        },
        pulls: {
          get: vi.fn(),
        },
      },
    };
    getOctokitOrNull.mockReturnValue(octokit);

    const response = await request(createApp())
      .get('/api/github/pulls/list')
      .query({ directory: '/repo', query: 'fix' })
      .expect(500);

    expect(response.body).toEqual({ error: 'search exploded' });
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
  });
});
