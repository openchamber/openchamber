import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { GiteaPullRequestSummary } from '@/lib/api/types';

const prsListCalls: Array<{ directory: string; options?: { sourceBranch?: string } }> = [];
let prsListResult: GiteaPullRequestSummary[] = [];
let prsListFailure: Error | null = null;
let registryHasGitea = true;

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => {
    if (!registryHasGitea) return null;
    return {
      gitea: {
        prsList: (directory: string, options?: { sourceBranch?: string }) => {
          prsListCalls.push({ directory, options });
          if (prsListFailure) {
            return Promise.reject(prsListFailure);
          }
          const all = prsListResult;
          const filtered = options?.sourceBranch
            ? all.filter((item) => item.sourceBranch === options.sourceBranch)
            : all;
          return Promise.resolve({ prs: filtered });
        },
      },
    };
  },
}));

const { resolveGiteaPrForBranch } = await import('./giteaPrStatus');

const pr = (number: number, state: 'open' | 'closed' | 'merged', sourceBranch: string): GiteaPullRequestSummary => ({
  number,
  title: `PR ${number}`,
  url: `https://gitea.example/${number}`,
  state,
  draft: false,
  author: { id: 1, username: 'user' },
  labels: [],
  sourceBranch,
  targetBranch: 'main',
});

describe('resolveGiteaPrForBranch', () => {
  beforeEach(() => {
    prsListCalls.length = 0;
    prsListResult = [];
    prsListFailure = null;
    registryHasGitea = true;
  });

  afterEach(() => {
    prsListCalls.length = 0;
    prsListResult = [];
    prsListFailure = null;
    registryHasGitea = true;
  });

  test('prefers the open PR over a merged one for the branch', async () => {
    prsListResult = [pr(3, 'merged', 'feat/a'), pr(7, 'open', 'feat/a')];

    const result = await resolveGiteaPrForBranch('/repo', 'feat/a');

    expect(result?.number).toBe(7);
    expect(prsListCalls).toEqual([
      { directory: '/repo', options: { sourceBranch: 'feat/a' } },
    ]);
  });

  test('falls back to a merged PR when no open one exists', async () => {
    prsListResult = [pr(5, 'merged', 'feat/b'), pr(9, 'closed', 'feat/b')];

    const result = await resolveGiteaPrForBranch('/repo', 'feat/b');

    expect(result?.number).toBe(5);
  });

  test('returns null when no PR matches the branch', async () => {
    prsListResult = [pr(5, 'merged', 'feat/a')];

    const result = await resolveGiteaPrForBranch('/repo', 'feat/c');

    expect(result).toBeNull();
    expect(prsListCalls).toHaveLength(1);
  });

  test('returns null without calling the API when the runtime has no Gitea client', async () => {
    registryHasGitea = false;

    const result = await resolveGiteaPrForBranch('/repo', 'feat/a');

    expect(result).toBeNull();
    expect(prsListCalls).toHaveLength(0);
  });

  test('returns null and caches when the request fails', async () => {
    prsListFailure = new Error('boom');

    const first = await resolveGiteaPrForBranch('/repo', 'fail-branch');
    expect(first).toBeNull();

    prsListFailure = null;
    prsListResult = [pr(1, 'open', 'fail-branch')];
    // Same directory+branch within TTL must not re-request.
    const second = await resolveGiteaPrForBranch('/repo', 'fail-branch');
    expect(second).toBeNull();
    expect(prsListCalls).toHaveLength(1);
  });

  test('serves the second call from cache within the TTL window', async () => {
    prsListResult = [pr(7, 'open', 'cache-branch')];

    const first = await resolveGiteaPrForBranch('/repo', 'cache-branch');
    const second = await resolveGiteaPrForBranch('/repo', 'cache-branch');

    expect(first?.number).toBe(7);
    expect(second?.number).toBe(7);
    expect(prsListCalls).toHaveLength(1);
  });
});
