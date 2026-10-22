import { describe, expect, it, vi } from 'vitest';
import { createProvider } from './provider.js';

const rateLimitModule = (limited = false) => ({
  isGitHubRateLimited: () => limited,
  isGitHubRateLimitError: (error) => error?.status === 429,
  noteGitHubRateLimit: vi.fn(),
});

const boundAccount = (octokit, providerUserId = 'github.com#7') => ({
  octokit, credentialRevision: 1, providerUserId, source: 'oauth', user: { id: 7, login: 'octo' },
});

/** The GitHub provider with fake libraries: Octokit lookups, PR summaries, the rate limit and patch reads. */
const providerWith = ({
  octokitFor = async () => ({}),
  octokitForAccount = async (accountId) => (accountId === 'bound' ? boundAccount({ bound: true }) : null),
  fetchPrSummaries = vi.fn(async () => ({ summaries: [{ number: 1 }], issueSummaries: [] })),
  rateLimit = rateLimitModule(),
  events = null,
  patch = {},
} = {}) => createProvider({
  events,
  modules: async () => ({
    octokit: { getOctokitOrNull: octokitFor, getOctokitForAccountId: octokitForAccount },
    summaries: { fetchPrSummaries, isGraphqlRateLimitError: () => false },
    rateLimit,
    patch,
  }),
});

const liveSummaries = async (provider, { instance = 'github.com', accountId = '' } = {}, refs = []) => {
  const session = await provider.auth.resolveAccount({ instance, accountId, orCurrent: true });
  return provider.resources.liveSummaries({ session, refs, issueRefs: [] });
};

describe('GitHub accounts behind a session', () => {
  it('resolves the exact account, refuses one that is gone, and falls back to the current one only when asked', async () => {
    const provider = providerWith({ octokitFor: async () => ({ current: true }) });
    await expect(provider.auth.resolveAccount({ instance: 'github.com', accountId: 'bound' })).resolves.toMatchObject({
      instance: 'github.com', accountId: 'bound', credentialRevision: 1, providerUserId: 'github.com#7', persisted: true,
    });
    await expect(provider.auth.resolveAccount({ instance: 'github.com', accountId: 'gone' })).rejects.toMatchObject({
      status: 401, sourceControlAccountUnavailable: true,
      sourceControlIdentity: { provider: 'github', instance: 'github.com', accountId: 'gone' },
    });
    await expect(provider.auth.resolveAccount({ instance: 'github.com', accountId: 'gone', orCurrent: true }))
      .resolves.toMatchObject({ instance: 'github.com', accountId: '' });
  });

  it('refuses an account whose credential lives on another host', async () => {
    const provider = providerWith({
      octokitForAccount: async () => boundAccount({ openChamberHost: 'github.com' }),
    });
    await expect(provider.auth.resolveAccount({ instance: 'ghe.example.com', accountId: 'github-com-account' }))
      .rejects.toMatchObject({ status: 401, sourceControlAccountUnavailable: true });
  });

  it('answers nothing for a host without a credential', async () => {
    const provider = providerWith({ octokitFor: async () => null });
    await expect(provider.auth.resolveAccount({ instance: 'untrusted.example.com' }))
      .rejects.toMatchObject({ sourceControlAccountUnavailable: true });
  });
});

describe('GitHub transport credentials', () => {
  const cliCredential = (credentialId, providerUserId) => ({
    credentialId, credentialRevision: 1, providerUserId, status: 'valid', source: 'cli',
    user: { id: 5, login: 'octo' }, accessToken: 'gh-token',
  });
  const providerWithCli = (getGitHubCliCredential) => createProvider({
    modules: async () => ({ octokit: { getGitHubCliCredential } }),
  });

  it('hands out a credential only for the instance it belongs to', async () => {
    const getGitHubCliCredential = vi.fn(async (id) => cliCredential(id, 'ghe.example.com#5'));
    const provider = providerWithCli(getGitHubCliCredential);
    // An enterprise host's gh login is never a github.com credential.
    await expect(provider.transport.readCredential({ instance: 'github.com', credentialId: 'ghe.example.com#cli:5' }))
      .resolves.toBeNull();
    expect(getGitHubCliCredential).not.toHaveBeenCalled();
    // Nor is an answer whose user lives on another host.
    await expect(provider.transport.readCredential({ instance: 'github.com', credentialId: 'github.com#cli:5' }))
      .resolves.toBeNull();
    await expect(provider.transport.readCredential({ instance: 'GHE.example.com', credentialId: 'ghe.example.com#cli:5' }))
      .resolves.toMatchObject({ providerUserId: 'ghe.example.com#5', secret: 'gh-token' });
  });
});

describe('GitHub live summaries', () => {
  it('reads with the bound account, else the current one, and says why when it cannot', async () => {
    const fetchPrSummaries = vi.fn(async () => ({ summaries: [{ number: 1 }], issueSummaries: [{ number: 2 }] }));
    await expect(liveSummaries(providerWith({ fetchPrSummaries }), {}, [{ owner: 'a', repo: 'b', number: 1 }]))
      .resolves.toEqual({ summaries: [{ number: 1 }], issueSummaries: [{ number: 2 }] });
    // A bound repository's account answers for its own pull requests.
    await liveSummaries(providerWith({ fetchPrSummaries }), { accountId: 'bound' });
    expect(fetchPrSummaries).toHaveBeenLastCalledWith({ octokit: { bound: true }, refs: [], issueRefs: [] });
    // A bound account that no longer resolves falls back to the host's current credential.
    await liveSummaries(providerWith({ fetchPrSummaries }), { accountId: 'gone' });
    expect(fetchPrSummaries).toHaveBeenLastCalledWith({ octokit: {}, refs: [], issueRefs: [] });
    await expect(liveSummaries(providerWith({ rateLimit: rateLimitModule(true) }))).resolves.toEqual({ status: 'unavailable' });
    const limitedNow = vi.fn(async () => { throw Object.assign(new Error('limit'), { status: 429 }); });
    await expect(liveSummaries(providerWith({ fetchPrSummaries: limitedNow }))).resolves.toEqual({ status: 'unavailable' });
  });

  it('reads each host on its own: its host-pinned octokit, per-host cooldown and a 401 that stays on the host', async () => {
    const seenHosts = [];
    const octokitFor = async (host) => { seenHosts.push(host); return { host }; };
    await liveSummaries(providerWith({ octokitFor }), { instance: 'github.acme.com' });
    await liveSummaries(providerWith({ octokitFor }), { instance: '' });
    expect(seenHosts).toEqual(['github.acme.com', '']);

    // A rate limit is noted against the host that hit it, never a shared slot.
    const rateLimit = rateLimitModule();
    const hostLimited = vi.fn(async () => { throw Object.assign(new Error('limit'), { status: 429 }); });
    await expect(liveSummaries(providerWith({ fetchPrSummaries: hostLimited, rateLimit }), { instance: 'github.acme.com' }))
      .resolves.toEqual({ status: 'unavailable' });
    expect(rateLimit.noteGitHubRateLimit).toHaveBeenCalledWith(expect.any(Object), 'github.acme.com');
    // A stale enterprise token 401s that host only: disconnected, and no other login is involved.
    const host401 = vi.fn(async () => { throw Object.assign(new Error('bad credentials'), { status: 401 }); });
    await expect(liveSummaries(providerWith({ fetchPrSummaries: host401 }), { instance: 'github.acme.com' }))
      .resolves.toEqual({ status: 'disconnected' });
  });

  it('reads a bound enterprise account with its own octokit, not the host\'s current credential', async () => {
    const fetchPrSummaries = vi.fn(async () => ({ summaries: [{ number: 7 }], issueSummaries: [] }));
    const octokitFor = vi.fn(async () => ({ host: 'github.acme.com' }));
    const octokitForAccount = vi.fn(async (accountId) => (accountId === 'github.acme.com#pat:7'
      ? boundAccount({ account: 'pat-user', openChamberHost: 'github.acme.com' }, 'github.acme.com#7')
      : null));
    await expect(liveSummaries(providerWith({ fetchPrSummaries, octokitFor, octokitForAccount }), { instance: 'github.acme.com', accountId: 'github.acme.com#pat:7' }))
      .resolves.toEqual({ summaries: [{ number: 7 }], issueSummaries: [] });
    expect(fetchPrSummaries).toHaveBeenLastCalledWith({
      octokit: { account: 'pat-user', openChamberHost: 'github.acme.com' }, refs: [], issueRefs: [],
    });
    expect(octokitFor).not.toHaveBeenCalled();
  });
});

describe('GitHub change request patch reads', () => {
  it('passes the shell\'s input to the patch module and reports an exact-account 401 as invalidated', async () => {
    const events = { invalidated: vi.fn() };
    const readGitHubChangeRequestPatch = vi.fn(async (_input, dependencies) => {
      await dependencies.onAccountUnavailable({ provider: 'github', instance: 'github.com', accountId: 'github.com#7' });
      return { patch: '', meta: null };
    });
    const provider = providerWith({ events, patch: { readGitHubChangeRequestPatch } });
    const input = { session: { instance: 'github.com', accountId: 'github.com#7' }, directory: '/repo', remote: 'origin', number: 3 };
    await provider.resources.readChangeRequestPatch(input);
    expect(readGitHubChangeRequestPatch).toHaveBeenCalledWith(input, expect.any(Object));
    expect(events.invalidated).toHaveBeenCalledWith({ provider: 'github', instance: 'github.com', accountId: 'github.com#7' });
  });
});
