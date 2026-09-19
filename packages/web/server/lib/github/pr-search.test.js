import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  mapPullRequestSummary,
  mapSearchHitPullRequestSummary,
  summarizeSearchPullRequests,
} from './pr-search.js';

const origin = { owner: 'acme', repo: 'app', source: 'origin' };

const searchHit = (number, title) => ({
  number,
  title,
  html_url: `https://github.com/acme/app/pull/${number}`,
  state: 'open',
  draft: false,
  user: { login: 'ada', id: 1, avatar_url: 'https://example.com/ada.png' },
  repository_url: 'https://api.github.com/repos/acme/app',
});

const pullPayload = (number, title) => ({
  number,
  title,
  html_url: `https://github.com/acme/app/pull/${number}`,
  state: 'open',
  draft: false,
  merged_at: null,
  mergeable: true,
  mergeable_state: 'clean',
  user: { login: 'ada', id: 1, avatar_url: 'https://example.com/ada.png' },
  base: { ref: 'main' },
  head: {
    ref: `feature-${number}`,
    sha: `sha-${number}`,
    label: `acme:feature-${number}`,
    repo: {
      owner: { login: 'acme' },
      name: 'app',
      html_url: 'https://github.com/acme/app',
      clone_url: 'https://github.com/acme/app.git',
      ssh_url: 'git@github.com:acme/app.git',
    },
  },
});

describe('summarizeSearchPullRequests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a lightweight search row when per-item enrichment fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn(async ({ pull_number }) => {
            if (pull_number === 11) {
              const error = new Error('rate limited');
              error.status = 403;
              throw error;
            }
            return { data: pullPayload(pull_number, `Enriched ${pull_number}`) };
          }),
        },
      },
    };

    const { prs, incomplete } = await summarizeSearchPullRequests({
      octokit,
      items: [searchHit(10, 'Keep me'), searchHit(11, 'Do not drop me')],
      reposToQuery: [origin],
    });

    expect(incomplete).toBe(true);
    expect(prs).toHaveLength(2);
    expect(prs[0]).toMatchObject({
      number: 10,
      title: 'Enriched 10',
      head: 'feature-10',
      base: 'main',
    });
    expect(prs[1]).toEqual(mapSearchHitPullRequestSummary(searchHit(11, 'Do not drop me'), origin));
    expect(prs[1].head).toBe('');
    expect(prs[1].base).toBe('');
    expect(warn).toHaveBeenCalled();
  });

  it('does not mark a fully enriched page incomplete', async () => {
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn(async ({ pull_number }) => ({ data: pullPayload(pull_number, `PR ${pull_number}`) })),
        },
      },
    };

    const { prs, incomplete } = await summarizeSearchPullRequests({
      octokit,
      items: [searchHit(10, 'A'), searchHit(12, 'B')],
      reposToQuery: [origin],
    });

    expect(incomplete).toBe(false);
    expect(prs.map((pr) => pr.number)).toEqual([10, 12]);
    expect(prs[0]).toEqual(mapPullRequestSummary(pullPayload(10, 'PR 10'), origin));
  });

  it('treats GitHub incomplete_results as incomplete even when enrichment succeeds', async () => {
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn(async ({ pull_number }) => ({ data: pullPayload(pull_number, `PR ${pull_number}`) })),
        },
      },
    };

    const { prs, incomplete } = await summarizeSearchPullRequests({
      octokit,
      items: [searchHit(10, 'A')],
      reposToQuery: [origin],
      incompleteResults: true,
    });

    expect(prs).toHaveLength(1);
    expect(incomplete).toBe(true);
  });

  it('marks the page incomplete when a search hit cannot be mapped', async () => {
    const octokit = { rest: { pulls: { get: vi.fn() } } };

    const { prs, incomplete } = await summarizeSearchPullRequests({
      octokit,
      items: [{ title: 'no number', repository_url: 'https://api.github.com/repos/acme/app' }],
      reposToQuery: [origin],
    });

    expect(prs).toEqual([]);
    expect(incomplete).toBe(true);
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
  });
});
