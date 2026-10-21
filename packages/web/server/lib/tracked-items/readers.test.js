import { describe, expect, it, vi } from 'vitest';
import { createTrackedItemReaders } from './readers.js';

const rateLimitModule = (limited = false) => ({
  isGitHubRateLimited: () => limited,
  isGitHubRateLimitError: (error) => error?.status === 429,
  noteGitHubRateLimit: vi.fn(),
});

const readersWith = ({ octokit = {}, octokitFor = async () => octokit, fetchPrSummaries = vi.fn(async () => ({ summaries: [{ number: 1 }], issueSummaries: [] })), limited = false, gitlab, linear } = {}) => createTrackedItemReaders({
  loadGitHub: async () => ({ getOctokitOrNull: octokitFor, getOctokitForAccountId: async (accountId) => (accountId === 'bound' ? { octokit: { bound: true } } : null) }),
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
    // A bound account that no longer resolves falls back to the host's current
    // credential — which is itself null for an untrusted host, so that host still
    // reads nothing.
    await readersWith({ fetchPrSummaries }).github({ accountId: 'gone', pulls: [], issues: [] });
    expect(fetchPrSummaries).toHaveBeenLastCalledWith({ octokit: {}, refs: [], issueRefs: [] });
    await expect(readersWith({ octokit: null }).github({ instance: 'untrusted.example.com', accountId: 'untrusted.example.com#cli:1', pulls: [], issues: [] }))
      .resolves.toEqual({ status: 'disconnected' });
    await expect(readersWith({ limited: true }).github({ pulls: [], issues: [] })).resolves.toEqual({ status: 'unavailable' });
    const limitedNow = vi.fn(async () => { throw Object.assign(new Error('limit'), { status: 429 }); });
    await expect(readersWith({ fetchPrSummaries: limitedNow }).github({ pulls: [], issues: [] })).resolves.toEqual({ status: 'unavailable' });
  });

  it('reads each GitHub host on its own: its host-pinned octokit, per-host cooldown and a 401 that stays on the host', async () => {
    const fetchPrSummaries = vi.fn(async () => ({ summaries: [{ number: 5 }], issueSummaries: [] }));
    const seenHosts = [];
    const octokitFor = async (host) => { seenHosts.push(host); return { host }; };
    await expect(readersWith({ fetchPrSummaries, octokitFor }).github({ instance: 'github.acme.com', pulls: [], issues: [] }))
      .resolves.toEqual({ status: 'ok', pulls: [{ number: 5 }], issues: [] });
    expect(seenHosts).toEqual(['github.acme.com']);
    await expect(readersWith({ fetchPrSummaries, octokitFor }).github({ instance: '', pulls: [], issues: [] }))
      .resolves.toEqual({ status: 'ok', pulls: [{ number: 5 }], issues: [] });
    expect(seenHosts).toEqual(['github.acme.com', 'github.com']);

    // A rate limit is noted against the host that hit it, never a shared slot.
    const hostLimited = vi.fn(async () => { throw Object.assign(new Error('limit'), { status: 429 }); });
    const rateLimit = rateLimitModule();
    await expect(createTrackedItemReaders({
      loadGitHub: async () => ({ getOctokitOrNull: async () => ({}), getOctokitForAccountId: async () => null }),
      loadGitHubSummaries: async () => ({ fetchPrSummaries: hostLimited, isGraphqlRateLimitError: () => false }),
      loadGitHubRateLimit: async () => rateLimit,
      readGitLabLiveSummaries: undefined,
    }).github({ instance: 'github.acme.com', pulls: [], issues: [] })).resolves.toEqual({ status: 'unavailable' });
    expect(rateLimit.noteGitHubRateLimit).toHaveBeenCalledWith(expect.any(Object), 'github.acme.com');
    // A stale enterprise token 401s that host only; the answer is its
    // disconnected, and no github.com login is involved.
    const host401 = vi.fn(async () => { throw Object.assign(new Error('bad credentials'), { status: 401 }); });
    await expect(createTrackedItemReaders({
      loadGitHub: async () => ({ getOctokitOrNull: async () => ({}), getOctokitForAccountId: async () => null }),
      loadGitHubSummaries: async () => ({ fetchPrSummaries: host401, isGraphqlRateLimitError: () => false }),
      loadGitHubRateLimit: async () => rateLimitModule(),
      readGitLabLiveSummaries: undefined,
    }).github({ instance: 'github.acme.com', pulls: [], issues: [] })).resolves.toEqual({ status: 'disconnected' });
  });

  it('reads a bound enterprise account with its own octokit, not the host\'s current credential', async () => {
    const fetchPrSummaries = vi.fn(async () => ({ summaries: [{ number: 7 }], issueSummaries: [] }));
    const hostOctokit = vi.fn(async () => ({ host: 'github.acme.com' }));
    const octokitForAccount = vi.fn(async (accountId) => (accountId === 'github.acme.com#pat:7' ? { octokit: { account: 'pat-user' } } : null));
    await expect(createTrackedItemReaders({
      loadGitHub: async () => ({ getOctokitOrNull: hostOctokit, getOctokitForAccountId: octokitForAccount }),
      loadGitHubSummaries: async () => ({ fetchPrSummaries, isGraphqlRateLimitError: () => false }),
      loadGitHubRateLimit: async () => rateLimitModule(),
      readGitLabLiveSummaries: undefined,
    }).github({ instance: 'github.acme.com', accountId: 'github.acme.com#pat:7', pulls: [], issues: [] }))
      .resolves.toEqual({ status: 'ok', pulls: [{ number: 7 }], issues: [] });
    expect(fetchPrSummaries).toHaveBeenLastCalledWith({ octokit: { account: 'pat-user' }, refs: [], issueRefs: [] });
    // The host's single current credential was never consulted: the bound account
    // owns the read.
    expect(hostOctokit).not.toHaveBeenCalled();
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
