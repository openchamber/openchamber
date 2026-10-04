import { describe, expect, it, vi } from 'vitest';
import { createTrackedItemReaders } from './readers.js';

const rateLimitModule = (limited = false) => ({
  isGitHubRateLimited: () => limited,
  isGitHubRateLimitError: (error) => error?.status === 429,
  noteGitHubRateLimit: vi.fn(),
});

const readersWith = ({ octokit = {}, fetchPrSummaries = vi.fn(async () => ({ summaries: [{ number: 1 }], issueSummaries: [] })), limited = false, gitlab, linear } = {}) => createTrackedItemReaders({
  loadGitHub: async () => ({ getOctokitOrNull: async () => octokit, getOctokitForAccountId: async (accountId) => (accountId === 'bound' ? { octokit: { bound: true } } : null) }),
  loadGitHubSummaries: async () => ({ fetchPrSummaries, isGraphqlRateLimitError: () => false }),
  loadGitHubRateLimit: async () => rateLimitModule(limited),
  loadLinear: async () => ({ getLinearIssueSummaries: linear ?? (async () => ({ connected: false })) }),
  readGitLabLiveSummaries: gitlab,
});

describe('tracked item readers', () => {
  it('reads GitHub with the current account and says why when it cannot', async () => {
    const fetchPrSummaries = vi.fn(async () => ({ summaries: [{ number: 1 }], issueSummaries: [{ number: 2 }] }));
    await expect(readersWith({ fetchPrSummaries }).github({ pulls: [{ owner: 'a', repo: 'b', number: 1 }], issues: [] }))
      .resolves.toEqual({ status: 'ok', pulls: [{ number: 1 }], issues: [{ number: 2 }] });
    await expect(readersWith({ octokit: null }).github({ pulls: [], issues: [] })).resolves.toEqual({ status: 'disconnected' });
    // A bound repository's account answers for its own pull requests.
    await readersWith({ fetchPrSummaries }).github({ accountId: 'bound', pulls: [], issues: [] });
    expect(fetchPrSummaries).toHaveBeenLastCalledWith({ octokit: { bound: true }, refs: [], issueRefs: [] });
    await expect(readersWith().github({ accountId: 'gone', pulls: [], issues: [] })).resolves.toEqual({ status: 'disconnected' });
    await expect(readersWith({ limited: true }).github({ pulls: [], issues: [] })).resolves.toEqual({ status: 'unavailable' });
    const limitedNow = vi.fn(async () => { throw Object.assign(new Error('limit'), { status: 429 }); });
    await expect(readersWith({ fetchPrSummaries: limitedNow }).github({ pulls: [], issues: [] })).resolves.toEqual({ status: 'unavailable' });
  });

  it('maps GitLab and Linear answers into the same terms', async () => {
    const gitlab = vi.fn(async () => ({ connected: true, summaries: [{ number: 3 }], issueSummaries: [] }));
    await expect(readersWith({ gitlab }).gitlab({ instance: 'https://gitlab.com', pulls: [{ owner: 'g', repo: 'r', number: 3 }], issues: [] }))
      .resolves.toEqual({ status: 'ok', pulls: [{ number: 3 }], issues: [] });
    expect(gitlab).toHaveBeenCalledWith({ instance: 'https://gitlab.com', accountId: null, refs: [{ owner: 'g', repo: 'r', number: 3 }], issueRefs: [] });
    await expect(readersWith({ gitlab: async () => ({ connected: false }) }).gitlab({ instance: 'https://gitlab.com', pulls: [], issues: [] }))
      .resolves.toEqual({ status: 'disconnected' });
    await expect(readersWith({ linear: async () => ({ connected: true, issues: [{ identifier: 'OPE-1' }] }) }).linear({ identifiers: ['OPE-1'] }))
      .resolves.toEqual({ status: 'ok', issues: [{ identifier: 'OPE-1' }] });
  });
});
