import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { GitLabMergeRequestSummary } from '@/lib/api/types';

const mrsListCalls: Array<{ directory: string; options?: { sourceBranch?: string } }> = [];
let mrsListResult: GitLabMergeRequestSummary[] = [];
let mrsListFailure: Error | null = null;
let registryHasGitlab = true;

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => {
    if (!registryHasGitlab) return null;
    return {
      gitlab: {
        mrsList: (directory: string, options?: { sourceBranch?: string }) => {
          mrsListCalls.push({ directory, options });
          if (mrsListFailure) {
            return Promise.reject(mrsListFailure);
          }
          const all = mrsListResult;
          const filtered = options?.sourceBranch
            ? all.filter((item) => item.sourceBranch === options.sourceBranch)
            : all;
          return Promise.resolve({ mrs: filtered });
        },
      },
    };
  },
}));

const { resolveGitLabMrForBranch } = await import('./gitlabMrStatus');

const mr = (number: number, state: string, sourceBranch: string): GitLabMergeRequestSummary => ({
  number,
  title: `MR ${number}`,
  url: `https://gitlab.example/${number}`,
  state,
  draft: false,
  author: { id: 1, username: 'user', name: 'User' },
  sourceBranch,
  targetBranch: 'main',
});

describe('resolveGitLabMrForBranch', () => {
  beforeEach(() => {
    mrsListCalls.length = 0;
    mrsListResult = [];
    mrsListFailure = null;
    registryHasGitlab = true;
  });

  afterEach(() => {
    mrsListCalls.length = 0;
    mrsListResult = [];
    mrsListFailure = null;
    registryHasGitlab = true;
  });

  test('prefers the opened MR over a merged one for the branch', async () => {
    mrsListResult = [mr(3, 'merged', 'feat/a'), mr(7, 'opened', 'feat/a')];

    const result = await resolveGitLabMrForBranch('/repo', 'feat/a');

    expect(result?.number).toBe(7);
    expect(mrsListCalls).toEqual([
      { directory: '/repo', options: { sourceBranch: 'feat/a' } },
    ]);
  });

  test('falls back to a merged MR when no opened one exists', async () => {
    mrsListResult = [mr(5, 'merged', 'feat/b'), mr(9, 'closed', 'feat/b')];

    const result = await resolveGitLabMrForBranch('/repo', 'feat/b');

    expect(result?.number).toBe(5);
  });

  test('returns null when no MR matches the branch', async () => {
    mrsListResult = [mr(5, 'merged', 'feat/a')];

    const result = await resolveGitLabMrForBranch('/repo', 'feat/c');

    expect(result).toBeNull();
    expect(mrsListCalls).toHaveLength(1);
  });

  test('returns null without calling the API when the runtime has no GitLab client', async () => {
    registryHasGitlab = false;

    const result = await resolveGitLabMrForBranch('/repo', 'feat/a');

    expect(result).toBeNull();
    expect(mrsListCalls).toHaveLength(0);
  });

  test('returns null and caches when the request fails', async () => {
    mrsListFailure = new Error('boom');

    const first = await resolveGitLabMrForBranch('/repo', 'fail-branch');
    expect(first).toBeNull();

    mrsListFailure = null;
    mrsListResult = [mr(1, 'opened', 'fail-branch')];
    // Same directory+branch within TTL must not re-request.
    const second = await resolveGitLabMrForBranch('/repo', 'fail-branch');
    expect(second).toBeNull();
    expect(mrsListCalls).toHaveLength(1);
  });

  test('serves the second call from cache within the TTL window', async () => {
    mrsListResult = [mr(7, 'opened', 'cache-branch')];

    const first = await resolveGitLabMrForBranch('/repo', 'cache-branch');
    const second = await resolveGitLabMrForBranch('/repo', 'cache-branch');

    expect(first?.number).toBe(7);
    expect(second?.number).toBe(7);
    expect(mrsListCalls).toHaveLength(1);
  });
});
