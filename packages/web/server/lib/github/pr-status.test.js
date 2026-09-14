import { afterEach, beforeEach, describe, expect, mock, test, vi } from 'bun:test';

const listMock = mock(async () => ({ data: [] }));

mock.module('../git/index.js', () => ({
  getRemotes: async () => [],
  getStatus: async () => null,
}));

mock.module('./repo/index.js', () => ({
  resolveGitHubRepoFromDirectory: async () => null,
}));

mock.module('./rate-limit.js', () => ({
  noteIfGitHubRateLimit: () => {},
}));

const { findBranchPrCandidates, invalidateRepoPullsCache } = await import('./pr-status.js');
const { createOctokit, getOctokitCacheIdentity } = await import('./octokit.js');

const octokitFor = (token, accountId) => ({
  openChamberCacheIdentity: getOctokitCacheIdentity(createOctokit(token, accountId)),
  rest: { pulls: { list: listMock } },
});

const openPr = {
  number: 15,
  state: 'open',
  head: {
    ref: 'feature',
    label: 'acme:feature',
    user: { login: 'acme' },
    repo: { owner: { login: 'acme' }, name: 'app' },
  },
};

const mergedPr = {
  number: 12,
  state: 'closed',
  merged_at: '2026-01-01T00:00:00Z',
  head: {
    ref: 'feature',
    label: 'acme:feature',
    user: { login: 'acme' },
    repo: { owner: { login: 'acme' }, name: 'app' },
  },
};

const olderMergedPr = {
  ...mergedPr,
  number: 7,
  merged_at: '2025-11-01T00:00:00Z',
};

const call = (overrides = {}) => findBranchPrCandidates({
  octokit: octokitFor('test-token', 'test-account'),
  target: { repo: { owner: 'acme', repo: 'app' }, remoteName: 'origin' },
  branch: 'feature',
  sourceCandidates: [{ repo: { owner: 'acme', repo: 'app' } }],
  force: true,
  includeHistory: true,
  ...overrides,
});

describe('findBranchPrCandidates', () => {
  beforeEach(() => {
    listMock.mockReset();
    invalidateRepoPullsCache('acme', 'app');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('an open PR wins and no history lookup is spent', async () => {
    listMock.mockImplementation(async ({ state }) => (
      state === 'open' ? { data: [openPr] } : { data: [mergedPr] }
    ));

    const { open, historical } = await call();

    expect(open?.number).toBe(15);
    expect(historical).toBeNull();
    expect(listMock.mock.calls.every((entry) => entry[0]?.state === 'open')).toBe(true);
  });

  test('an open PR still wins when the shared open list missed it', async () => {
    // A repo with more than one page of open PRs: the shared list is incomplete,
    // so the per-head query is the one that must find the open PR.
    listMock.mockImplementation(async ({ head }) => (
      head ? { data: [mergedPr, openPr] } : { data: new Array(100).fill(null).map((_, index) => ({ number: index, state: 'open', head: { ref: 'other' } })) }
    ));

    const { open, historical } = await call();

    expect(open?.number).toBe(15);
    expect(historical).toBeNull();
  });

  test('returns the branch history when no open PR exists', async () => {
    listMock.mockImplementation(async ({ head }) => (
      head ? { data: [olderMergedPr, mergedPr] } : { data: [] }
    ));

    const { open, historical } = await call();

    expect(open).toBeNull();
    // The newest past PR for the head is the relevant record.
    expect(historical?.number).toBe(12);
  });

  test('returns no history for a branch that never had a PR', async () => {
    listMock.mockImplementation(async () => ({ data: [] }));

    const { open, historical } = await call();

    expect(open).toBeNull();
    expect(historical).toBeNull();
    expect(listMock.mock.calls.some((entry) => entry[0]?.state === 'all')).toBe(true);
  });

  test('spends no call on history for a secondary target', async () => {
    listMock.mockImplementation(async ({ head }) => (
      head ? { data: [mergedPr] } : { data: [] }
    ));

    const { open, historical } = await call({ includeHistory: false });

    expect(open).toBeNull();
    expect(historical).toBeNull();
    // The complete open list already answered the only question that matters
    // for a secondary repo in the fork network.
    expect(listMock.mock.calls).toHaveLength(1);
    expect(listMock.mock.calls[0]?.[0]?.state).toBe('open');
  });

  test('reuses the cached history instead of re-querying every poll', async () => {
    listMock.mockImplementation(async ({ head }) => (
      head ? { data: [mergedPr] } : { data: [] }
    ));

    await call();
    const callsAfterFirst = listMock.mock.calls.length;

    // A non-forced poll is answered entirely from the shared open list cache
    // plus the remembered history — no extra GitHub call.
    const { open, historical } = await call({ force: false });

    expect(open).toBeNull();
    expect(historical?.number).toBe(12);
    expect(listMock.mock.calls.length).toBe(callsAfterFirst);
  });

  test('does not share cached pull lists across accounts', async () => {
    listMock.mockResolvedValue({ data: [openPr] });
    const first = await call({
      octokit: octokitFor('first-token', 'first-account'),
      force: false,
    });
    expect(first.open?.number).toBe(15);

    listMock.mockResolvedValue({ data: [] });
    const second = await call({
      octokit: octokitFor('second-token', 'second-account'),
      force: false,
    });

    expect(second.open).toBeNull();
    expect(listMock).toHaveBeenCalledTimes(3);
  });

  test('does not share cached pull lists after an account credential changes', async () => {
    listMock.mockResolvedValue({ data: [openPr] });
    await call({ octokit: octokitFor('old-token', 'same-account'), force: false });

    listMock.mockResolvedValue({ data: [] });
    const result = await call({ octokit: octokitFor('new-token', 'same-account'), force: false });

    expect(result.open).toBeNull();
    expect(listMock).toHaveBeenCalledTimes(3);
  });

  test('invalidates pull caches for only the requested credential', async () => {
    const firstOctokit = octokitFor('first-token', 'first-account');
    const secondOctokit = octokitFor('second-token', 'second-account');
    listMock.mockResolvedValue({ data: [openPr] });
    await call({ octokit: firstOctokit, force: false });
    await call({ octokit: secondOctokit, force: false });

    invalidateRepoPullsCache('acme', 'app', firstOctokit);
    listMock.mockClear();
    listMock.mockResolvedValue({ data: [] });

    expect((await call({ octokit: firstOctokit, force: false })).open).toBeNull();
    expect((await call({ octokit: secondOctokit, force: false })).open?.number).toBe(15);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  test('does not let an invalidated pull-list promise refill its exact cache key', async () => {
    const firstOctokit = octokitFor('first-token', 'first-account');
    const secondOctokit = octokitFor('second-token', 'second-account');
    let releaseFirst;
    let markFirstStarted;
    const heldFirst = new Promise((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    listMock.mockImplementation(async () => {
      if (listMock.mock.calls.length === 1) {
        markFirstStarted();
        await heldFirst;
      }
      return { data: [openPr] };
    });

    const staleRead = call({ octokit: firstOctokit, force: false, includeHistory: false });
    await firstStarted;
    invalidateRepoPullsCache('acme', 'app', firstOctokit);
    releaseFirst();
    expect((await staleRead).open?.number).toBe(15);

    await call({ octokit: firstOctokit, force: false, includeHistory: false });
    await call({ octokit: secondOctokit, force: false, includeHistory: false });
    await call({ octokit: secondOctokit, force: false, includeHistory: false });
    expect(listMock).toHaveBeenCalledTimes(3);
  });

  test('does not remember history resolved after scoped invalidation', async () => {
    const octokit = octokitFor('first-token', 'first-account');
    let releaseHistory;
    let markHistoryStarted;
    const heldHistory = new Promise((resolve) => { releaseHistory = resolve; });
    const historyStarted = new Promise((resolve) => { markHistoryStarted = resolve; });
    let historyCalls = 0;
    listMock.mockImplementation(async ({ head }) => {
      if (head) {
        historyCalls += 1;
        if (historyCalls === 1) {
          markHistoryStarted();
          await heldHistory;
        }
      }
      return { data: [] };
    });

    const staleRead = call({ octokit, force: true });
    await historyStarted;
    invalidateRepoPullsCache('acme', 'app', octokit);
    releaseHistory();
    await staleRead;

    await call({ octokit, force: false });
    expect(historyCalls).toBe(2);
  });

  test('a found record outlives the shorter "no history" window', async () => {
    const startedAt = Date.now();
    listMock.mockImplementation(async ({ head }) => (
      head ? { data: [mergedPr] } : { data: [] }
    ));

    await call();
    const callsAfterFirst = listMock.mock.calls.length;

    // Past the "no history" expiry, but far short of the found-record one. The
    // shared open list is re-fetched; the history answer is not re-queried.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(startedAt + 30 * 60 * 1000));
    const { historical } = await call({ force: false });

    expect(historical?.number).toBe(12);
    expect(listMock.mock.calls.length).toBe(callsAfterFirst + 1);
    expect(listMock.mock.calls.at(-1)?.[0]?.state).toBe('open');
  });

  test('re-queries a branch with no history once its shorter window passes', async () => {
    const startedAt = Date.now();
    listMock.mockImplementation(async () => ({ data: [] }));

    await call();
    const callsAfterFirst = listMock.mock.calls.length;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(startedAt + 30 * 60 * 1000));
    await call({ force: false });

    expect(listMock.mock.calls.some((entry) => entry[0]?.state === 'all')).toBe(true);
    expect(listMock.mock.calls.length).toBeGreaterThan(callsAfterFirst + 1);
  });
});
