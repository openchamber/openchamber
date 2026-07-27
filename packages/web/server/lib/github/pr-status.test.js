import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock side-effect-free dependencies so the module under test can load.
// safeListPulls is internal — we exercise it through real octokit objects.
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
}));

vi.mock('../git/index.js', () => ({
  getStatus: vi.fn(),
  getRemotes: vi.fn(),
}));

vi.mock('./repo/index.js', () => ({
  resolveGitHubRepoFromDirectory: vi.fn(),
}));

vi.mock('./rate-limit.js', () => ({
  noteIfGitHubRateLimit: vi.fn(),
}));

const { findFirstMatchingPr, resolveGitHubPrStatus } = await import('./pr-status.js');

const makeOctokit = (responses) => {
  const pullsList = vi.fn(async (options) => {
    const state = options.state;
    const headKey = options.head ?? '*';
    const key = `${state}|${headKey}`;
    const handler = responses[key];
    if (handler) {
      return { data: typeof handler === 'function' ? handler(options) : handler };
    }
    return { data: [] };
  });
  return {
    rest: {
      pulls: { list: pullsList },
      repos: {
        get: vi.fn(async () => ({ data: { default_branch: 'main' } })),
      },
    },
  };
};

const makePr = ({ number, owner, repo, branch, state, headLabel }) => ({
  number,
  state,
  head: {
    ref: branch,
    label: headLabel ?? `${owner}:${branch}`,
    repo: { owner: { login: owner }, name: repo },
    user: { login: owner },
  },
  base: {
    repo: { owner: { login: 'openchamber' }, name: 'openchamber' },
  },
});

describe('findFirstMatchingPr', () => {
  const branch = 'fix/git-tab-pr-priority';
  const upstreamTarget = { repo: { owner: 'openchamber', repo: 'openchamber' } };
  const forkTarget = { repo: { owner: 'bashrusakh', repo: 'openchamber' } };
  const sourceCandidates = [upstreamTarget, forkTarget];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the upstream open PR even when a merged fork PR exists (#1771)', async () => {
    const upstreamOpenPr = makePr({
      number: 1772,
      owner: 'bashrusakh',
      repo: 'openchamber',
      branch,
      state: 'open',
    });
    const mergedForkPr = makePr({
      number: 10,
      owner: 'bashrusakh',
      repo: 'openchamber',
      branch,
      state: 'closed',
      headLabel: 'bashrusakh:fix/git-tab-pr-priority',
    });

    // Target is the upstream repo. Source candidates cover both upstream + fork.
    const octokit = makeOctokit({
      'open|bashrusakh:fix/git-tab-pr-priority': [upstreamOpenPr],
      'open|openchamber:fix/git-tab-pr-priority': [],
      'open|*': [upstreamOpenPr],
      'closed|bashrusakh:fix/git-tab-pr-priority': [mergedForkPr],
      'closed|*': [mergedForkPr],
    });

    const pr = await findFirstMatchingPr({
      octokit,
      target: upstreamTarget,
      branch,
      sourceCandidates,
      state: 'open',
    });

    expect(pr).not.toBeNull();
    expect(pr.number).toBe(1772);
    expect(pr.state).toBe('open');
  });

  it('falls back to closed/merged when no open PR exists', async () => {
    const mergedForkPr = makePr({
      number: 10,
      owner: 'bashrusakh',
      repo: 'openchamber',
      branch,
      state: 'closed',
    });
    const octokit = makeOctokit({
      'open|bashrusakh:fix/git-tab-pr-priority': [],
      'open|openchamber:fix/git-tab-pr-priority': [],
      'open|*': [],
      'closed|bashrusakh:fix/git-tab-pr-priority': [mergedForkPr],
      'closed|*': [mergedForkPr],
    });

    const pr = await findFirstMatchingPr({
      octokit,
      target: upstreamTarget,
      branch,
      sourceCandidates,
      state: 'closed',
    });

    expect(pr).not.toBeNull();
    expect(pr.number).toBe(10);
  });

  it('returns null when no matching PR exists for any state', async () => {
    const octokit = makeOctokit({});
    const pr = await findFirstMatchingPr({
      octokit,
      target: upstreamTarget,
      branch,
      sourceCandidates,
      state: 'open',
    });
    expect(pr).toBeNull();
  });

  it('prefers upstream source when multiple open candidates match', async () => {
    const forkOpenPr = makePr({
      number: 5,
      owner: 'bashrusakh',
      repo: 'openchamber',
      branch,
      state: 'open',
      headLabel: 'bashrusakh:fix/git-tab-pr-priority',
    });
    const upstreamOpenPr = makePr({
      number: 6,
      owner: 'openchamber',
      repo: 'openchamber',
      branch,
      state: 'open',
      headLabel: 'openchamber:fix/git-tab-pr-priority',
    });

    const octokit = makeOctokit({
      'open|bashrusakh:fix/git-tab-pr-priority': [forkOpenPr],
      'open|openchamber:fix/git-tab-pr-priority': [upstreamOpenPr],
      'open|*': [forkOpenPr, upstreamOpenPr],
    });

    const pr = await findFirstMatchingPr({
      octokit,
      target: upstreamTarget,
      branch,
      sourceCandidates,
      state: 'open',
    });

    // Upstream PR is preferred because it ranks first in sourceCandidates.
    expect(pr).not.toBeNull();
    expect(pr.number).toBe(6);
  });
});

describe('resolveGitHubPrStatus — #1771 cross-target priority', () => {
  const branch = 'fix/git-tab-pr-priority';
  const dir = '/tmp/some-worktree';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the open upstream PR even when the fork target is queried first', async () => {
    const { stat } = await import('node:fs/promises');
    const { getStatus, getRemotes } = await import('../git/index.js');
    const { resolveGitHubRepoFromDirectory } = await import('./repo/index.js');

    stat.mockResolvedValue({});
    getStatus.mockResolvedValue({ tracking: 'origin/fix/git-tab-pr-priority' });
    getRemotes.mockResolvedValue([
      { name: 'origin', url: 'https://github.com/bashrusakh/openchamber' },
      { name: 'upstream', url: 'https://github.com/openchamber/openchamber' },
    ]);

    // First remote in the resolved list is the fork (origin), then upstream.
    resolveGitHubRepoFromDirectory
      .mockResolvedValueOnce({
        repo: { owner: 'bashrusakh', repo: 'openchamber' },
      })
      .mockResolvedValueOnce({
        repo: { owner: 'openchamber', repo: 'openchamber' },
      });

    const upstreamOpenPr = makePr({
      number: 1772,
      owner: 'bashrusakh',
      repo: 'openchamber',
      branch,
      state: 'open',
    });
    const mergedForkPr = makePr({
      number: 10,
      owner: 'bashrusakh',
      repo: 'openchamber',
      branch,
      state: 'closed',
    });

    // respond by (target_owner, head_owner, state) so both targets get the
    // right payload. We need the fork target's "open" to be empty (so the
    // outer loop advances to the upstream target) and the upstream's "open"
    // to surface the upstream PR.
    const calls = [];
    const pullsList = vi.fn(async (options) => {
      calls.push(options);
      const isForkTarget = options.owner === 'bashrusakh';
      const headOwner = options.head?.split(':')[0];
      const state = options.state;

      if (state === 'open') {
        if (isForkTarget) {
          return { data: [] };
        }
        if (headOwner === 'bashrusakh') {
          return { data: [upstreamOpenPr] };
        }
        if (headOwner === 'openchamber') {
          return { data: [] };
        }
        return { data: [upstreamOpenPr] };
      }

      // closed — only fork has a merged PR
      if (headOwner === 'bashrusakh') {
        return { data: [mergedForkPr] };
      }
      return { data: [mergedForkPr] };
    });

    const octokit = {
      rest: {
        pulls: { list: pullsList },
        repos: {
          get: vi.fn(async ({ owner, repo }) => ({
            data: {
              default_branch: 'main',
              parent: { owner: { login: 'openchamber' }, name: 'openchamber' },
            },
          })),
        },
      },
    };

    const result = await resolveGitHubPrStatus({
      octokit,
      directory: dir,
      branch,
      remoteName: 'origin',
    });

    expect(result.pr).not.toBeNull();
    expect(result.pr.number).toBe(1772);
    expect(result.pr.state).toBe('open');
    // Critical: we must have queried an "open" state for the upstream target,
    // proving the two-phase loop did not stop at the fork target's merged PR.
    const queriedUpstreamOpen = calls.some(
      (c) => c.state === 'open' && c.owner === 'openchamber',
    );
    expect(queriedUpstreamOpen).toBe(true);
  });
});
