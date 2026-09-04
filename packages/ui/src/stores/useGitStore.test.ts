import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { GitStatus } from '@/lib/api/types';
import { useGitStore } from './useGitStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { notifyGitStatusInvalidated } from '@/lib/gitStatusInvalidation';
import { clearWorktreeBootstrapState, markWorktreeBootstrapPending } from '@/lib/worktrees/worktreeBootstrap';

// The real transport has no server in tests and fails as a generic error.
// Tests that exercise other failure modes swap this implementation; the
// default keeps every pre-existing expectation (generic failure → null).
const listGitDirectoriesControl: { impl: (root: string) => Promise<string[]> } = {
  impl: async () => {
    throw new Error('network unavailable');
  },
};
class TestGitDirectoriesUnsupportedError extends Error {}
mock.module('@/lib/gitApiHttp', () => ({
  GitDirectoriesUnsupportedError: TestGitDirectoriesUnsupportedError,
  listGitDirectories: (root: string) => listGitDirectoriesControl.impl(root),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type GitAPI = Parameters<ReturnType<typeof useGitStore.getState>['fetchStatus']>[1];
type DirectoryGitState = NonNullable<ReturnType<ReturnType<typeof useGitStore.getState>['getDirectoryState']>>;

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const createStatus = (diffStats?: GitStatus['diffStats'], files: GitStatus['files'] = []): GitStatus => ({
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files,
  isClean: files.length === 0,
  diffStats,
});

const createDirectoryState = (status: GitStatus): DirectoryGitState => ({
  isGitRepo: true,
  status,
  branches: null,
  log: null,
  identity: null,
  diffCache: new Map(),
  indexRevision: 0,
  lastRepoCheckAt: Date.now(),
  lastStatusFetch: 0,
  lastStatusChange: 0,
  lastLogFetch: 0,
  lastBranchesFetch: 0,
  lastIdentityFetch: 0,
  logMaxCount: 25,
  isLoadingStatus: false,
  isLoadingLog: false,
  isLoadingBranches: false,
  isLoadingIdentity: false,
});

const setDirectoryStatus = (status: GitStatus) => {
  useGitStore.setState({
    directories: new Map([['/repo', createDirectoryState(status)]]),
    activeDirectory: '/repo',
  });
};

const createGitApi = (getGitStatus: GitAPI['getGitStatus']): GitAPI => ({
  checkIsGitRepository: async () => true,
  getGitStatus,
  getGitBranches: async () => ({ all: [], current: 'main', branches: {} }),
  getGitLog: async () => ({ all: [], latest: null, total: 0 }),
  getCurrentGitIdentity: async () => null,
  getGitFileDiff: async (_directory, options) => ({ original: '', modified: '', path: options.path }),
});

describe('useGitStore', () => {
  beforeEach(() => {
    clearWorktreeBootstrapState('/repo');
    useGitStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  });

  test('does not reuse an in-flight light status request for full status', async () => {
    setDirectoryStatus(createStatus());
    const requests: Deferred<GitStatus>[] = [];
    const statusCalls: Array<{ directory: string; options?: { mode?: 'light' } }> = [];
    const git = createGitApi((directory, options) => {
      statusCalls.push({ directory, options });
      const request = createDeferred<GitStatus>();
      requests.push(request);
      return request.promise;
    });

    const lightPromise = useGitStore.getState().fetchStatus('/repo', git, { mode: 'light', silent: true });
    const fullPromise = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve();

    expect(statusCalls).toEqual([
      { directory: '/repo', options: { mode: 'light' } },
      { directory: '/repo', options: undefined },
    ]);

    requests[1].resolve(createStatus({ 'src/index.ts': { insertions: 1, deletions: 0 } }));
    await fullPromise;
    requests[0].resolve(createStatus());
    await lightPromise;

    expect(useGitStore.getState().getDirectoryState('/repo')?.status?.diffStats).toEqual({
      'src/index.ts': { insertions: 1, deletions: 0 },
    });
  });

  test('reuses an in-flight full status request for light status', async () => {
    setDirectoryStatus(createStatus());
    const requests: Deferred<GitStatus>[] = [];
    const statusCalls: Array<{ directory: string; options?: { mode?: 'light' } }> = [];
    const git = createGitApi((directory, options) => {
      statusCalls.push({ directory, options });
      const request = createDeferred<GitStatus>();
      requests.push(request);
      return request.promise;
    });

    const fullPromise = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    const lightPromise = useGitStore.getState().fetchStatus('/repo', git, { mode: 'light', silent: true });
    await Promise.resolve();

    expect(statusCalls).toEqual([{ directory: '/repo', options: undefined }]);

    requests[0].resolve(createStatus({ 'src/index.ts': { insertions: 1, deletions: 0 } }));
    const [fullResult, lightResult] = await Promise.all([fullPromise, lightPromise]);
    expect(lightResult).toBe(fullResult);
  });

  test('deduplicates concurrent status requests when no mutation occurs', async () => {
    setDirectoryStatus(createStatus());
    let statusCalls = 0;
    const request = createDeferred<GitStatus>();
    const git = createGitApi(() => {
      statusCalls += 1;
      return request.promise;
    });

    const first = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    const second = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve();

    expect(statusCalls).toBe(1);

    request.resolve(createStatus());
    await Promise.all([first, second]);
    expect(statusCalls).toBe(1);
  });

  test('a refresh after a mutation does not join the pre-mutation in-flight status request', async () => {
    setDirectoryStatus(createStatus());
    const requests: Deferred<GitStatus>[] = [];
    let statusCalls = 0;
    const git = createGitApi(() => {
      statusCalls += 1;
      const request = createDeferred<GitStatus>();
      requests.push(request);
      return request.promise;
    });

    const preMutation = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve();
    expect(statusCalls).toBe(1);

    // A successful git mutation invalidates the adapter status cache, which
    // notifies the store that the in-flight request predates the mutation.
    notifyGitStatusInvalidated('/repo');

    const postMutation = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve();
    expect(statusCalls).toBe(2);

    requests[1].resolve({ ...createStatus(), current: 'feature' });
    await postMutation;
    expect(useGitStore.getState().getDirectoryState('/repo')?.status?.current).toBe('feature');

    // The late pre-mutation response cannot overwrite the newer authoritative one.
    requests[0].resolve(createStatus());
    await preMutation;
    expect(useGitStore.getState().getDirectoryState('/repo')?.status?.current).toBe('feature');
  });

  test('fetchAll({ force: true }) forces a fresh status fetch past the in-flight dedup', async () => {
    setDirectoryStatus(createStatus());
    const requests: Deferred<GitStatus>[] = [];
    let statusCalls = 0;
    const statusOptions: Array<{ mode?: 'light'; fresh?: boolean } | undefined> = [];
    const git = createGitApi((_directory, options) => {
      statusCalls += 1;
      statusOptions.push(options);
      const request = createDeferred<GitStatus>();
      requests.push(request);
      return request.promise;
    });

    const inFlight = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve();
    expect(statusCalls).toBe(1);

    const all = useGitStore.getState().fetchAll('/repo', git, { force: true });
    await Promise.resolve();
    expect(statusCalls).toBe(2);
    expect(statusOptions).toEqual([undefined, { fresh: true }]);

    requests[1].resolve({ ...createStatus(), current: 'feature' });
    requests[0].resolve(createStatus());
    await Promise.allSettled([inFlight, all]);

    expect(useGitStore.getState().getDirectoryState('/repo')?.status?.current).toBe('feature');
  });

  test('does not request status while worktree bootstrap is pending', async () => {
    setDirectoryStatus(createStatus());
    let statusCalls = 0;
    const git = createGitApi(async () => {
      statusCalls += 1;
      return createStatus(undefined, [{ path: 'bootstrap.ts', index: 'D', working_dir: ' ' }]);
    });

    markWorktreeBootstrapPending('/repo');
    const changed = await useGitStore.getState().fetchStatus('/repo', git, { force: true });

    expect(changed).toBe(false);
    expect(statusCalls).toBe(0);
    expect(useGitStore.getState().getDirectoryState('/repo')?.status?.files).toEqual([]);
  });

  test('does not publish a status response after bootstrap becomes pending', async () => {
    setDirectoryStatus(createStatus());
    const request = createDeferred<GitStatus>();
    const git = createGitApi(() => request.promise);

    const loading = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve();
    markWorktreeBootstrapPending('/repo');
    request.resolve(createStatus(undefined, [{ path: 'bootstrap.ts', index: 'D', working_dir: ' ' }]));

    expect(await loading).toBe(false);
    expect(useGitStore.getState().getDirectoryState('/repo')?.status?.files).toEqual([]);
  });

  test('can propagate a forced status failure to a reconciliation owner', async () => {
    setDirectoryStatus(createStatus());
    const git = createGitApi(async () => {
      throw new Error('offline');
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;

    try {
      await expect(useGitStore.getState().fetchStatus('/repo', git, {
        force: true,
        silent: true,
        throwOnError: true,
      })).rejects.toThrow('offline');
      expect(useGitStore.getState().getDirectoryState('/repo')?.status?.files).toEqual([]);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test('does not let an older status fetch undo an optimistic mutation', async () => {
    const initial = createStatus(undefined, [{ path: 'src/index.ts', index: ' ', working_dir: 'M' }]);
    setDirectoryStatus(initial);
    const request = createDeferred<GitStatus>();
    const git = createGitApi(() => request.promise);

    const loading = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');
    request.resolve(initial);
    await loading;

    expect(useGitStore.getState().getDirectoryState('/repo')?.status?.files).toEqual([
      { path: 'src/index.ts', index: 'M', working_dir: ' ' },
    ]);
  });

  test('rejects an old runtime completion after reset', async () => {
    setDirectoryStatus(createStatus());
    const request = createDeferred<GitStatus>();
    const git = createGitApi(() => request.promise);
    const loading = useGitStore.getState().fetchStatus('/repo', git, { silent: true });

    useGitStore.getState().resetForRuntimeSwitch('runtime-b');
    request.resolve(createStatus(undefined, [{ path: 'stale.ts', index: 'M', working_dir: ' ' }]));
    await loading;

    expect(useGitStore.getState().runtimeKey).toBe('runtime-b');
    expect(useGitStore.getState().getDirectoryState('/repo')?.status ?? null).toBe(null);
  });

  test('rejects direct diff commits captured for another runtime', () => {
    useGitStore.getState().setDiff('/repo', 'stale.ts', { original: 'a', modified: 'b' }, 'runtime-a');
    expect(useGitStore.getState().getDiff('/repo', 'stale.ts')).toBe(null);
  });

  test('clears cached file contents when a git refresh hint invalidates diffs', () => {
    setDirectoryStatus(createStatus(
      { 'src/index.ts': { insertions: 1, deletions: 1 } },
      [{ path: 'src/index.ts', index: ' ', working_dir: 'M' }],
    ));
    useGitStore.getState().setDiff('/repo', 'src/index.ts', { original: 'old', modified: 'stale' });

    useGitStore.getState().clearDiffCache('/repo');

    expect(useGitStore.getState().getDiff('/repo', 'src/index.ts')).toBe(null);
  });

  test('invalidates only the requested cached file contents', () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'src/first.ts', index: ' ', working_dir: 'M' },
      { path: 'src/second.ts', index: ' ', working_dir: 'M' },
    ]));
    useGitStore.getState().setDiff('/repo', 'src/first.ts', { original: 'a', modified: 'b' });
    useGitStore.getState().setDiff('/repo', 'src/second.ts', { original: 'c', modified: 'd' });

    useGitStore.getState().clearDiffCache('/repo', ['src/first.ts']);

    expect(useGitStore.getState().getDiff('/repo', 'src/first.ts')).toBe(null);
    expect(useGitStore.getState().getDiff('/repo', 'src/second.ts')?.modified).toBe('d');
  });

  test('keeps the newest branch request when completions are reversed', async () => {
    const requests = [createDeferred<Awaited<ReturnType<GitAPI['getGitBranches']>>>(), createDeferred<Awaited<ReturnType<GitAPI['getGitBranches']>>>()];
    let index = 0;
    const git = {
      ...createGitApi(async () => createStatus()),
      getGitBranches: () => requests[index++].promise,
    };
    const first = useGitStore.getState().fetchBranches('/repo', git);
    const second = useGitStore.getState().fetchBranches('/repo', git);

    requests[1].resolve({ all: ['new'], current: 'new', branches: {} });
    await second;
    requests[0].resolve({ all: ['old'], current: 'old', branches: {} });
    await first;

    expect(useGitStore.getState().getDirectoryState('/repo')?.branches?.current).toBe('new');
  });

  test('optimistically stages modified files and preserves untouched file references', () => {
    const target = { path: 'src/index.ts', index: ' ', working_dir: 'M' };
    const untouched = { path: 'README.md', index: ' ', working_dir: 'M' };
    const initialStatus = createStatus(undefined, [target, untouched]);
    setDirectoryStatus(initialStatus);

    const previousStatus = useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;
    const state = useGitStore.getState().getDirectoryState('/repo');

    expect(previousStatus).toBe(initialStatus);
    expect(status?.files).toEqual([
      { path: 'src/index.ts', index: 'M', working_dir: ' ' },
      untouched,
    ]);
    expect(status?.files[1]).toBe(untouched);
    expect(state?.indexRevision).toBe(1);
  });

  test('optimistically stages untracked files as added files', () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'new-file.ts', index: '?', working_dir: '?' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['new-file.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([
      { path: 'new-file.ts', index: 'A', working_dir: ' ' },
    ]);
  });

  test('optimistically unstages staged files', () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'src/index.ts', index: 'M', working_dir: ' ' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'unstage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([
      { path: 'src/index.ts', index: ' ', working_dir: 'M' },
    ]);
  });

  test('optimistically unstages staged added files back to untracked files', () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'new-file.ts', index: 'A', working_dir: ' ' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['new-file.ts'], 'unstage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([
      { path: 'new-file.ts', index: ' ', working_dir: '?' },
    ]);
  });

  test('keeps conflicted files unchanged during optimistic moves', () => {
    const conflicted = { path: 'conflict.ts', index: 'U', working_dir: 'U' };
    setDirectoryStatus(createStatus(undefined, [conflicted]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['conflict.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([conflicted]);
    expect(status?.files[0]).toBe(conflicted);
  });

  test('preserves diff stats during optimistic moves', () => {
    const diffStats = { 'src/index.ts': { insertions: 2, deletions: 1 } };
    setDirectoryStatus(createStatus(diffStats, [
      { path: 'src/index.ts', index: ' ', working_dir: 'M' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.diffStats).toBe(diffStats);
  });

  test('does nothing when optimistic move has no matching path', () => {
    const initialStatus = createStatus(undefined, [
      { path: 'src/index.ts', index: ' ', working_dir: 'M' },
    ]);
    setDirectoryStatus(initialStatus);

    const previousStatus = useGitStore.getState().moveStatusPathsOptimistically('/repo', ['missing.ts'], 'stage');

    expect(previousStatus).toBe(initialStatus);
    expect(useGitStore.getState().getDirectoryState('/repo')?.status).toBe(initialStatus);
    expect(useGitStore.getState().getDirectoryState('/repo')?.indexRevision).toBe(0);
  });

  test('does nothing without status for optimistic moves', () => {
    useGitStore.setState({
      directories: new Map([['/repo', { ...createDirectoryState(createStatus()), status: null }]]),
      activeDirectory: '/repo',
    });

    const previousStatus = useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');

    expect(previousStatus).toBeNull();
    expect(useGitStore.getState().getDirectoryState('/repo')?.status).toBeNull();
  });

  test('removes entries that become clean during optimistic moves', () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'clean.ts', index: ' ', working_dir: ' ' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['clean.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([]);
    expect(status?.isClean).toBe(true);
  });

  test('restores previous status for optimistic rollback', () => {
    const initialStatus = createStatus(undefined, [
      { path: 'src/index.ts', index: ' ', working_dir: 'M' },
    ]);
    setDirectoryStatus(initialStatus);

    const previousStatus = useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');
    useGitStore.getState().restoreStatus('/repo', previousStatus);

    expect(useGitStore.getState().getDirectoryState('/repo')?.status).toBe(initialStatus);
  });
});

describe('useGitStore nested repository discovery', () => {
  beforeEach(() => {
    listGitDirectoriesControl.impl = async () => {
      throw new Error('network unavailable');
    };
    useGitStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  });

  test('selects a nested repo per root and persists the selection', () => {
    useGitStore.getState().selectNestedRepo('/root-a', '/root-a/repo-one');

    expect(useGitStore.getState().nestedRepoSelection.get('/root-a')).toBe('/root-a/repo-one');

    // Re-seeding from storage (as a page refresh would) restores the pick.
    useGitStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    expect(useGitStore.getState().nestedRepoSelection.get('/root-a')).toBe('/root-a/repo-one');
  });

  test('keeps selections isolated per root', () => {
    useGitStore.getState().selectNestedRepo('/root-a', '/root-a/one');
    useGitStore.getState().selectNestedRepo('/root-b', '/root-b/two');

    expect(useGitStore.getState().nestedRepoSelection.get('/root-a')).toBe('/root-a/one');
    expect(useGitStore.getState().nestedRepoSelection.get('/root-b')).toBe('/root-b/two');
  });

  test('clears only the given root selection', () => {
    useGitStore.getState().selectNestedRepo('/root-a', '/root-a/one');
    useGitStore.getState().selectNestedRepo('/root-b', '/root-b/two');

    useGitStore.getState().clearNestedRepoSelection('/root-a');

    expect(useGitStore.getState().nestedRepoSelection.has('/root-a')).toBe(false);
    expect(useGitStore.getState().nestedRepoSelection.get('/root-b')).toBe('/root-b/two');
  });

  test('remembers a stale-cleared repository so auto-select can skip it', () => {
    useGitStore.getState().selectNestedRepo('/root-a', '/root-a/one');
    useGitStore.getState().selectNestedRepo('/root-b', '/root-b/two');

    useGitStore.getState().clearNestedRepoSelection('/root-a');
    useGitStore.getState().clearNestedRepoSelection('/root-b');
    useGitStore.getState().clearNestedRepoSelection('/root-b');

    const clearedA = useGitStore.getState().staleClearedSelections.get('/root-a');
    const clearedB = useGitStore.getState().staleClearedSelections.get('/root-b');
    expect(clearedA).toEqual(new Set(['/root-a/one']));
    // Repeated clears of the same path stay a set, not an ever-growing list.
    expect(clearedB).toEqual(new Set(['/root-b/two']));
  });

  test('runtime switch clears stale-cleared memory with the rest', () => {
    useGitStore.getState().selectNestedRepo('/root-a', '/root-a/one');
    useGitStore.getState().clearNestedRepoSelection('/root-a');

    useGitStore.getState().resetForRuntimeSwitch('runtime-b');

    expect(useGitStore.getState().staleClearedSelections.size).toBe(0);
  });

  test('runtime switch does not leak selections or discovery across runtimes', () => {
    useGitStore.getState().selectNestedRepo('/root-a', '/root-a/one');
    useGitStore.setState({ nestedReposByRoot: new Map([['/root-a', ['/root-a/one']]]) });

    useGitStore.getState().resetForRuntimeSwitch('runtime-b');

    expect(useGitStore.getState().nestedRepoSelection.size).toBe(0);
    expect(useGitStore.getState().nestedReposByRoot.size).toBe(0);
  });

  test('discards an in-flight discovery result when the runtime switches', async () => {
    const stale = useGitStore.getState().ensureNestedRepos('/root-a');
    useGitStore.getState().resetForRuntimeSwitch('runtime-b');
    await stale;

    // The old runtime's late completion must not repopulate the cleared map.
    expect(useGitStore.getState().nestedReposByRoot.has('/root-a')).toBe(false);

    // Discovery started under the new runtime still commits normally.
    await useGitStore.getState().ensureNestedRepos('/root-a');
    expect(useGitStore.getState().nestedReposByRoot.get('/root-a')).toBeNull();
  });

  test('marks discovery failure as a failed marker, not an empty success', async () => {
    await useGitStore.getState().ensureNestedRepos('/root-a');

    expect(useGitStore.getState().nestedReposByRoot.get('/root-a')).toBeNull();
  });

  test('marks a 501 runtime as unsupported instead of failed', async () => {
    listGitDirectoriesControl.impl = async () => {
      throw new TestGitDirectoriesUnsupportedError();
    };

    await useGitStore.getState().ensureNestedRepos('/root-a');

    expect(useGitStore.getState().nestedReposByRoot.get('/root-a')).toBe('unsupported');
  });

  test('unsupported does not clobber a previous successful discovery', async () => {
    listGitDirectoriesControl.impl = async () => ['/root-a/one'];
    await useGitStore.getState().ensureNestedRepos('/root-a');

    listGitDirectoriesControl.impl = async () => {
      throw new TestGitDirectoriesUnsupportedError();
    };
    await useGitStore.getState().ensureNestedRepos('/root-a', { force: true });

    expect(useGitStore.getState().nestedReposByRoot.get('/root-a')).toEqual(['/root-a/one']);
  });

  test('dedupes concurrent discovery runs for the same root', async () => {
    const first = useGitStore.getState().ensureNestedRepos('/root-a');
    const second = useGitStore.getState().ensureNestedRepos('/root-a');
    await Promise.all([first, second]);

    expect(useGitStore.getState().nestedReposByRoot.get('/root-a')).toBeNull();
  });
});
