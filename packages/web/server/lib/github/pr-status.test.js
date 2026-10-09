import { afterEach, beforeEach, describe, expect, mock, test, vi } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { findBranchPrCandidates, invalidateRepoPullsCache, isHistoricalPrOfCheckout, resolveGitHubPrStatus } from './pr-status.js';
import { createOctokit, getOctokitCacheIdentity } from './octokit.js';

const listMock = mock(async () => ({ data: [] }));

const isAncestorMock = mock(async () => false);

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

  test('does not reuse a cached history miss for a different source owner', async () => {
    const target = { repo: { owner: 'upstream-cache-scope', repo: 'app' }, remoteName: 'origin' };
    const ownerA = { repo: { owner: 'fork-cache-a', repo: 'app' } };
    const ownerB = { repo: { owner: 'fork-cache-b', repo: 'app' } };
    const ownerBPr = {
      ...mergedPr,
      number: 16,
      head: { ...mergedPr.head, label: 'fork-cache-b:feature', user: { login: 'fork-cache-b' }, repo: { owner: { login: 'fork-cache-b' }, name: 'app' } },
    };
    listMock.mockImplementation(async ({ head }) => (
      head === 'fork-cache-b:feature' ? { data: [ownerBPr] } : { data: [] }
    ));
    const octokit = octokitFor('test-token', 'test-account');

    await findBranchPrCandidates({
      octokit,
      target,
      branch: 'feature',
      sourceCandidates: [ownerA],
      force: true,
      includeHistory: true,
    });
    const { historical } = await findBranchPrCandidates({
      octokit,
      target,
      branch: 'feature',
      sourceCandidates: [ownerB],
      includeHistory: true,
    });

    expect(historical?.number).toBe(16);
  });
});

describe('resolveGitHubPrStatus for a contributor fork checkout', () => {
  let directory;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-status-fork-'));
    const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
    git('init', '-q', '-b', 'fix/thing');
    git('remote', 'add', 'origin', 'https://github.com/acme/app.git');
    git('remote', 'add', 'pr-contrib', 'https://github.com/contrib/app.git');
    invalidateRepoPullsCache('acme', 'app');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const forkPr = {
    number: 44,
    state: 'open',
    head: { ref: 'fix/thing', label: 'contrib:fix/thing', user: { login: 'contrib' }, repo: { owner: { login: 'contrib' }, name: 'app' } },
  };
  const octokit = () => ({
    openChamberCacheIdentity: getOctokitCacheIdentity(createOctokit('fork-token', 'fork-account')),
    rest: {
      repos: {
        get: async ({ owner, repo }) => ({
          data: owner === 'contrib'
            ? { default_branch: 'main', parent: { owner: { login: 'acme' }, name: repo } }
            : { default_branch: 'main' },
        }),
      },
      pulls: { list: async ({ owner }) => ({ data: owner === 'acme' ? [forkPr] : [] }) },
    },
  });

  test('finds the fork PR when the caller names the fork remote as the branch source', async () => {
    const status = await resolveGitHubPrStatus({
      octokit: octokit(), directory, branch: 'fix/thing', remoteName: 'origin', sourceRemoteName: 'pr-contrib', force: true,
    });
    expect(status.pr?.number).toBe(44);
    expect(status.repo).toMatchObject({ owner: 'acme', repo: 'app' });
  });

  test('finds the merged fork PR in the primary remote once it is merged', async () => {
    git(directory, '-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'fix');
    const mergedForkPr = {
      ...forkPr,
      state: 'closed',
      merged_at: '2026-01-01T00:00:00Z',
      head: { ...forkPr.head, sha: git(directory, 'rev-parse', 'HEAD').trim() },
    };
    const client = octokit();
    client.rest.pulls.list = async ({ owner, state, head }) => ({
      data: owner === 'acme' && state === 'all' && head === 'contrib:fix/thing' ? [mergedForkPr] : [],
    });

    const status = await resolveGitHubPrStatus({
      octokit: client, directory, branch: 'fix/thing', remoteName: 'origin', sourceRemoteName: 'pr-contrib', force: true,
    });
    expect(status.pr?.number).toBe(44);
    expect(status.repo).toMatchObject({ owner: 'acme', repo: 'app' });
  });

  test('without a source remote a same-named fork branch is not this branch', async () => {
    const status = await resolveGitHubPrStatus({
      octokit: octokit(), directory, branch: 'fix/thing', remoteName: 'origin', force: true,
    });
    expect(status.pr).toBeNull();
  });
});

describe('isHistoricalPrOfCheckout', () => {
  beforeEach(() => {
    isAncestorMock.mockReset();
  });

  test('a merged PR whose head commit is in the checkout history belongs to it', async () => {
    isAncestorMock.mockImplementation(async () => true);
    const isPatchEquivalent = mock(async () => false);
    const pr = { ...mergedPr, head: { ...mergedPr.head, sha: 'abc1234' } };
    expect(await isHistoricalPrOfCheckout('/repo', pr, { isAncestor: isAncestorMock, isPatchEquivalent })).toBe(true);
    expect(isAncestorMock).toHaveBeenCalledWith('/repo', 'abc1234');
    expect(isPatchEquivalent).not.toHaveBeenCalled();
  });

  test('a PR with a patch-equivalent head commit belongs to the checkout', async () => {
    isAncestorMock.mockImplementation(async () => false);
    const isPatchEquivalent = mock(async () => true);
    const pr = { ...mergedPr, head: { ...mergedPr.head, sha: 'abc1234' } };

    const belongsToCheckout = await isHistoricalPrOfCheckout('/repo', pr, { isAncestor: isAncestorMock, isPatchEquivalent });

    expect(isPatchEquivalent).toHaveBeenCalledWith('/repo', 'abc1234');
    expect(belongsToCheckout).toBe(true);
  });

  test('a reused branch name without the merged commits does not inherit the PR', async () => {
    isAncestorMock.mockImplementation(async () => false);
    const isPatchEquivalent = mock(async () => false);
    const pr = { ...mergedPr, head: { ...mergedPr.head, sha: 'abc1234' } };
    expect(await isHistoricalPrOfCheckout('/repo', pr, { isAncestor: isAncestorMock, isPatchEquivalent })).toBe(false);
    expect(isPatchEquivalent).toHaveBeenCalledWith('/repo', 'abc1234');
  });

  test('a PR without a head sha is never attributed', async () => {
    expect(await isHistoricalPrOfCheckout('/repo', mergedPr, { isAncestor: isAncestorMock })).toBe(false);
    expect(isAncestorMock).not.toHaveBeenCalled();
  });
});

const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], {
  encoding: 'utf8',
});

const createRebasedCheckout = async (suffix, branch = 'feature') => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `oc-pr-history-${suffix}-`));
  git(directory, 'init', `--initial-branch=${branch}`);
  git(directory, 'config', 'user.name', 'Test User');
  git(directory, 'config', 'user.email', 'test@example.com');
  await fs.writeFile(path.join(directory, 'status.txt'), 'base\n');
  git(directory, 'add', 'status.txt');
  git(directory, 'commit', '-m', 'base');
  await fs.writeFile(path.join(directory, 'status.txt'), 'rebased change\n');
  git(directory, 'commit', '-am', 'original change');
  const originalSha = git(directory, 'rev-parse', 'HEAD').trim();
  git(directory, 'reset', '--hard', 'HEAD~1');
  await fs.writeFile(path.join(directory, 'status.txt'), 'rebased change\n');
  git(directory, 'commit', '-am', 'rebased change');
  const baseSha = git(directory, 'rev-parse', 'HEAD~1').trim();
  git(directory, 'remote', 'add', 'origin', `https://github.com/fork-${suffix}/app-${suffix}.git`);
  git(directory, 'remote', 'add', 'upstream', `https://github.com/upstream-${suffix}/app-${suffix}.git`);
  git(directory, 'remote', 'add', 'contributor', `https://github.com/contributor-${suffix}/app-${suffix}.git`);
  return { directory, originalSha, baseSha };
};

const createForkNetworkOctokit = ({ suffix, historicalPr, forkHistoricalPr = null, openParentPr = null, branch = 'feature' }) => {
  const calls = [];
  const fork = { owner: `fork-${suffix}`, repo: `app-${suffix}` };
  const parent = { owner: `upstream-${suffix}`, repo: `app-${suffix}` };
  const contributor = { owner: `contributor-${suffix}`, repo: `app-${suffix}` };
  const octokit = {
    openChamberCacheIdentity: getOctokitCacheIdentity(createOctokit(`token-${suffix}`, `account-${suffix}`)),
    rest: {
      repos: {
        get: async ({ owner, repo }) => {
          if (owner === fork.owner && repo === fork.repo) {
            return { data: { default_branch: 'main', parent: { owner: { login: parent.owner }, name: parent.repo } } };
          }
          return { data: { default_branch: 'main' } };
        },
      },
      pulls: {
        list: async (options) => {
          calls.push(options);
          if (!options.head && options.owner === parent.owner && openParentPr) {
            return { data: [openParentPr] };
          }
          if (options.owner === fork.owner && options.state === 'all' && options.head === `${fork.owner}:${branch}` && forkHistoricalPr) {
            return { data: [forkHistoricalPr] };
          }
          if (options.owner === parent.owner && options.state === 'all' && options.head === `${fork.owner}:${branch}`) {
            return { data: [historicalPr] };
          }
          return { data: [] };
        },
      },
    },
  };
  return { octokit, calls, fork, parent, contributor };
};

describe('resolveGitHubPrStatus fork history', () => {
  test.each([
    ['closed', null],
    ['merged', '2026-01-01T00:00:00Z'],
  ])('restores a patch-equivalent %s PR from the primary fork parent', async (state, mergedAt) => {
    const suffix = `terminal-${state}`;
    const { directory, originalSha } = await createRebasedCheckout(suffix);
    const historicalPr = {
      number: state === 'closed' ? 301 : 302,
      state: 'closed',
      merged_at: mergedAt,
      head: {
        sha: originalSha,
        ref: 'feature',
        label: `fork-${suffix}:feature`,
        user: { login: `fork-${suffix}` },
        repo: { owner: { login: `fork-${suffix}` }, name: `app-${suffix}` },
      },
    };
    const { octokit, calls, fork, parent, contributor } = createForkNetworkOctokit({ suffix, historicalPr });

    try {
      const resolved = await resolveGitHubPrStatus({ octokit, directory, branch: 'feature', remoteName: 'origin', force: true });

      expect(resolved.pr?.number).toBe(historicalPr.number);
      expect(resolved.repo).toMatchObject(parent);
      const historyCalls = calls.filter((call) => call.state === 'all');
      expect(historyCalls).toEqual([
        expect.objectContaining({ owner: fork.owner, head: `${fork.owner}:feature` }),
        expect.objectContaining({ owner: fork.owner, head: `${parent.owner}:feature` }),
        expect.objectContaining({ owner: parent.owner, head: `${fork.owner}:feature` }),
        expect.objectContaining({ owner: parent.owner, head: `${parent.owner}:feature` }),
      ]);
      expect(historyCalls.some((call) => call.owner === contributor.owner)).toBe(false);

      const callsAfterFirst = calls.length;
      const repeated = await resolveGitHubPrStatus({ octokit, directory, branch: 'feature', remoteName: 'origin' });
      expect(repeated.pr?.number).toBe(historicalPr.number);
      expect(calls).toHaveLength(callsAfterFirst);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('returns an open parent PR before an earlier terminal fork PR', async () => {
    const suffix = 'open-priority';
    const { directory, originalSha } = await createRebasedCheckout(suffix);
    const terminalPr = {
      number: 303,
      state: 'closed',
      head: { sha: originalSha, ref: 'feature', label: `fork-${suffix}:feature`, user: { login: `fork-${suffix}` }, repo: { owner: { login: `fork-${suffix}` }, name: `app-${suffix}` } },
    };
    const openParentPr = { ...terminalPr, number: 304, state: 'open', merged_at: null };
    const { octokit } = createForkNetworkOctokit({ suffix, historicalPr: terminalPr, forkHistoricalPr: terminalPr, openParentPr });

    try {
      const resolved = await resolveGitHubPrStatus({ octokit, directory, branch: 'feature', remoteName: 'origin', force: true });
      expect(resolved.pr?.number).toBe(openParentPr.number);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('does not inherit terminal fork history on the default branch', async () => {
    const suffix = 'default-main-history';
    const { directory, baseSha } = await createRebasedCheckout(suffix, 'main');
    const terminalPr = {
      number: 305,
      state: 'closed',
      merged_at: '2026-01-01T00:00:00Z',
      head: { sha: baseSha, ref: 'main', label: `fork-${suffix}:main`, user: { login: `fork-${suffix}` }, repo: { owner: { login: `fork-${suffix}` }, name: `app-${suffix}` } },
    };
    const { octokit, calls } = createForkNetworkOctokit({ suffix, historicalPr: terminalPr, branch: 'main' });

    try {
      const resolved = await resolveGitHubPrStatus({ octokit, directory, branch: 'main', remoteName: 'origin', force: true });
      expect(resolved.pr).toBeNull();
      expect(calls.some((call) => call.state === 'all')).toBe(false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
