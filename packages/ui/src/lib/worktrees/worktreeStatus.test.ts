import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Per-test controllable behaviour plus manual call tracking (the project's
// tsconfig does not load bun-test's mock matcher types, so existing tests track
// calls via plain arrays rather than `toHaveBeenCalled*`).
let resolveRootImpl: (directory: string) => string | Promise<string> = (directory) => directory;
let statusImpl: (directory: string) => { current: string } = () => ({ current: 'HEAD' });

const resolveRootCalls: string[] = [];
const statusCalls: string[] = [];

mock.module('@/lib/execCommands', () => ({
  execCommands: () => Promise.resolve({ success: false, results: [] }),
}));

mock.module('@/lib/gitApi', () => ({
  getGitStatus: (directory: string) => {
    statusCalls.push(directory);
    return Promise.resolve(statusImpl(directory));
  },
  resolveGitPrimaryRoot: (directory: string) => {
    resolveRootCalls.push(directory);
    return Promise.resolve(resolveRootImpl(directory));
  },
}));

const { getRootBranch, invalidateResolvedProjectRootCache } = await import('./worktreeStatus');

describe('worktreeStatus.getRootBranch', () => {
  beforeEach(() => {
    invalidateResolvedProjectRootCache();
    resolveRootCalls.length = 0;
    statusCalls.length = 0;
    resolveRootImpl = (directory) => directory;
    statusImpl = () => ({ current: 'HEAD' });
  });

  test('derives root from absolute-git-dir and returns its branch', async () => {
    resolveRootImpl = () => '/repo';
    statusImpl = () => ({ current: 'main' });

    expect(await getRootBranch('/repo')).toBe('main');
    expect(statusCalls).toEqual(['/repo']);
  });

  test('caches root resolution across repeated calls', async () => {
    resolveRootImpl = () => '/repo';
    statusImpl = () => ({ current: 'main' });

    await getRootBranch('/repo');
    await getRootBranch('/repo');
    await getRootBranch('/repo');

    expect(resolveRootCalls.length).toBe(1);
  });

  test('dedupes concurrent resolutions of the same directory', async () => {
    resolveRootImpl = () => '/repo';
    statusImpl = () => ({ current: 'main' });

    await Promise.all([getRootBranch('/repo'), getRootBranch('/repo'), getRootBranch('/repo')]);

    expect(resolveRootCalls.length).toBe(1);
  });

  test('invalidation forces re-resolution', async () => {
    resolveRootImpl = () => '/repo';
    statusImpl = () => ({ current: 'main' });

    await getRootBranch('/repo');
    invalidateResolvedProjectRootCache('/repo');
    await getRootBranch('/repo');

    expect(resolveRootCalls.length).toBe(2);
  });

  test('falls back to the directory itself in a non-git folder', async () => {
    resolveRootImpl = (directory) => directory;
    statusImpl = () => ({ current: 'HEAD' });

    expect(await getRootBranch('/plain')).toBe('HEAD');
    expect(statusCalls).toEqual(['/plain']);
  });

  test('resolves a linked worktree to its primary root and fetches that branch', async () => {
    resolveRootImpl = () => '/repo';
    statusImpl = () => ({ current: 'main' });

    // knownBranch is the *worktree* branch, which must NOT be returned for the root.
    expect(await getRootBranch('/repo-wt', { knownBranch: 'feature/x' })).toBe('main');
    expect(statusCalls).toEqual(['/repo']);
  });

  test('invalidation mid-flight does not let a stale resolve re-seed the cache', async () => {
    let releaseResolve: (result: string) => void = () => {};
    resolveRootImpl = () =>
      new Promise<string>((resolve) => {
        releaseResolve = resolve;
      });
    statusImpl = () => ({ current: 'main' });

    // Start a resolution and leave it in flight.
    const pending = getRootBranch('/repo');
    // A worktree topology change invalidates the cache while the resolve runs.
    invalidateResolvedProjectRootCache();
    // Now let the original resolve settle — it must NOT populate the cache.
    releaseResolve('/repo');
    await pending;

    resolveRootImpl = () => '/repo';
    await getRootBranch('/repo');

    // Second call recomputes because the stale in-flight result was discarded.
    expect(resolveRootCalls.length).toBe(2);
  });

  test('bounds the root cache by evicting the least-recently-used entry past the count cap', async () => {
    resolveRootImpl = (directory) => directory;
    statusImpl = () => ({ current: 'main' });

    for (let i = 0; i < 500; i += 1) {
      await getRootBranch(`/repo-${i}`);
    }
    const afterFill = resolveRootCalls.length;
    expect(afterFill).toBe(500);

    await getRootBranch('/repo-overflow');
    await getRootBranch('/repo-0');
    await getRootBranch('/repo-499');

    // /repo-overflow and evicted /repo-0 re-run; /repo-499 remains cached.
    expect(resolveRootCalls.length).toBe(afterFill + 2);
  });

  test('uses knownBranch fast-path when the directory is its own root', async () => {
    resolveRootImpl = () => '/repo';

    expect(await getRootBranch('/repo', { knownBranch: 'develop' })).toBe('develop');
    // No git status round-trip needed in the fast path.
    expect(statusCalls).toEqual([]);
  });
});
