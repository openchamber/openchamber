import { describe, expect, test } from 'bun:test';
import { usePrContextStore, getPrContextKey } from './usePrContextStore';
import type { GitHubAPI, GitHubPullRequestContextResult } from '@/lib/api/types';

const makeGithub = (result: GitHubPullRequestContextResult) => {
  let calls = 0;
  const prContext = async () => {
    calls += 1;
    return result;
  };
  return { github: { prContext } as unknown as GitHubAPI, callCount: () => calls };
};

const RESULT: GitHubPullRequestContextResult = {
  connected: true,
  pr: null,
  issueComments: [],
  reviewComments: [],
};

describe('usePrContextStore', () => {
  test('caches within TTL and dedupes plain requests after a detailed one', async () => {
    const { github, callCount } = makeGithub(RESULT);
    const { ensure } = usePrContextStore.getState();

    const first = await ensure(github, '/repo-a', 1, { includeCheckDetails: true });
    expect(first).toEqual(RESULT);
    expect(callCount()).toBe(1);

    // Fresh cache satisfies both detailed and plain requests.
    await ensure(github, '/repo-a', 1, { includeCheckDetails: true });
    await ensure(github, '/repo-a', 1);
    expect(callCount()).toBe(1);

    // force bypasses the cache.
    await ensure(github, '/repo-a', 1, { includeCheckDetails: true, force: true });
    expect(callCount()).toBe(2);
  });

  test('a plain cached result does not satisfy a detailed request', async () => {
    const { github, callCount } = makeGithub(RESULT);
    const { ensure } = usePrContextStore.getState();

    await ensure(github, '/repo-b', 2);
    await ensure(github, '/repo-b', 2, { includeCheckDetails: true });
    expect(callCount()).toBe(2);
  });

  test('concurrent callers share one in-flight request', async () => {
    const { github, callCount } = makeGithub(RESULT);
    const { ensure } = usePrContextStore.getState();

    const [a, b] = await Promise.all([
      ensure(github, '/repo-c', 3, { includeCheckDetails: true }),
      ensure(github, '/repo-c', 3, { includeCheckDetails: true }),
    ]);
    expect(a).toEqual(RESULT);
    expect(b).toEqual(RESULT);
    expect(callCount()).toBe(1);
  });

  test('invalidate clears the entry so the next ensure refetches', async () => {
    const { github, callCount } = makeGithub(RESULT);
    const { ensure, invalidate } = usePrContextStore.getState();

    await ensure(github, '/repo-d', 4);
    invalidate('/repo-d', 4);
    expect(usePrContextStore.getState().entries[getPrContextKey('/repo-d', 4)] ?? null).toBe(null);
    await ensure(github, '/repo-d', 4);
    expect(callCount()).toBe(2);
  });

  test('invalidate matches the directory exactly, not by prefix', async () => {
    const { github } = makeGithub(RESULT);
    const { ensure, invalidate } = usePrContextStore.getState();

    await ensure(github, '/repo', 1);
    await ensure(github, '/repo-beta', 1);
    invalidate('/repo');

    expect(usePrContextStore.getState().entries[getPrContextKey('/repo', 1)] ?? null).toBe(null);
    expect(usePrContextStore.getState().entries[getPrContextKey('/repo-beta', 1)]?.result).toEqual(RESULT);
  });

  test('failed fetch records the error and returns null', async () => {
    const github = { prContext: async () => { throw new Error('boom'); } } as unknown as GitHubAPI;
    const { ensure } = usePrContextStore.getState();

    const result = await ensure(github, '/repo-e', 5);
    expect(result).toBeNull();
    const entry = usePrContextStore.getState().entries[getPrContextKey('/repo-e', 5)];
    expect(entry?.error).toBe('boom');
    expect(entry?.isLoading).toBe(false);
  });
});
