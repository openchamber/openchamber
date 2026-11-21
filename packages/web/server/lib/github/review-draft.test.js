import { describe, expect, it, vi } from 'vitest';
import { fetchReviewState } from './review-draft.js';

const person = { login: 'ann', avatarUrl: 'https://a/ann.png' };
const thread = (overrides = {}) => ({
  id: 'T1', path: 'a.ts', line: 5, startLine: null, diffSide: 'RIGHT', subjectType: 'LINE',
  isOutdated: false, isResolved: false, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: false,
  comments: { nodes: [{ id: 'C1', state: 'SUBMITTED', body: 'Hm', createdAt: '2026-11-01T00:00:00Z', url: 'https://x/1', author: person }] },
  ...overrides,
});
const pull = (overrides = {}) => ({
  viewerDidAuthor: false,
  headRefOid: 'abc',
  reviews: { nodes: [] },
  reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [thread()] },
  ...overrides,
});
const octokitAnswering = (...pulls) => {
  const graphql = vi.fn();
  for (const value of pulls) graphql.mockResolvedValueOnce({ repository: { pullRequest: value } });
  return { graphql };
};
const read = (octokit) => fetchReviewState({ octokit, owner: 'acme', repo: 'app', number: 7 });

describe('fetchReviewState', () => {
  it('reads threads with their lines and leaves outdated ones to the board', async () => {
    const state = await read(octokitAnswering(pull({
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [thread(), thread({ id: 'T2', isOutdated: true, line: null })] },
    })));

    expect(state.threads).toEqual([{
      id: 'T1', path: 'a.ts', side: 'new', line: 5, startLine: null, resolved: false, canReply: true, canResolve: true,
      comments: [{ id: 'C1', body: 'Hm', createdAt: '2026-11-01T00:00:00Z', url: 'https://x/1', author: person }],
    }]);
    expect(state.draft).toBeNull();
  });

  it('takes a draft comment out of its thread and gives it the thread\'s side', async () => {
    const state = await read(octokitAnswering(pull({
      reviews: { nodes: [{ id: 'R1', viewerDidAuthor: true, body: '', comments: { nodes: [
        { id: 'D1', body: 'Mine', path: 'a.ts', line: 2, startLine: 1, subjectType: 'LINE', author: person },
      ] } }] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [thread({
        id: 'T3', diffSide: 'LEFT', comments: { nodes: [{ id: 'D1', state: 'PENDING', body: 'Mine', createdAt: 'x', url: 'y', author: person }] },
      })] },
    })));

    expect(state.threads).toEqual([]);
    expect(state.draft.comments).toEqual([{ id: 'D1', path: 'a.ts', side: 'old', line: 2, startLine: 1, body: 'Mine', author: person }]);
  });

  it('reads every page of threads, and says when it stopped short', async () => {
    const more = { hasNextPage: true, endCursor: 'next' };
    const octokit = octokitAnswering(
      pull({ reviewThreads: { pageInfo: more, nodes: [thread()] } }),
      pull({ reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [thread({ id: 'T2' })] } }),
    );

    const state = await read(octokit);

    expect(state.threads.map((entry) => entry.id)).toEqual(['T1', 'T2']);
    expect(octokit.graphql.mock.calls[1][1].after).toBe('next');
    expect(state.truncated).toBe(false);

    const endless = await read(octokitAnswering(...Array.from({ length: 10 }, () => pull({ reviewThreads: { pageInfo: more, nodes: [] } }))));
    expect(endless.truncated).toBe(true);
  });

  it('fails on a pull request it cannot read, never as an empty review', async () => {
    await expect(read(octokitAnswering(null))).rejects.toMatchObject({ status: 404 });
  });
});
