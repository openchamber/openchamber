import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitHistoryItem, GitHistoryOptions, GitHistoryPage, GitHistoryRefsResponse, GitStatus } from '@/lib/api/types';
import { useGitStore } from './useGitStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

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
  history: {
    refs: null,
    refsError: null,
    isLoadingRefs: false,
    queries: new Map(),
  },
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

const createHistoryRefs = (): GitHistoryRefsResponse => ({
  refs: [
    { id: 'HEAD', name: 'HEAD', revision: 'head-sha', kind: 'head', category: 'branches' },
    { id: 'refs/heads/main', name: 'main', revision: 'head-sha', kind: 'local', category: 'branches' },
    { id: 'refs/remotes/origin/main', name: 'origin/main', revision: 'upstream-sha', kind: 'remote', category: 'remote-branches' },
    { id: 'refs/tags/v1', name: 'v1', revision: 'tag-sha', kind: 'tag', category: 'tags' },
  ],
  current: { id: 'refs/heads/main', name: 'main', revision: 'head-sha', kind: 'local', category: 'branches' },
  upstream: { id: 'refs/remotes/origin/main', name: 'origin/main', revision: 'upstream-sha', kind: 'remote', category: 'remote-branches' },
  base: null,
  snapshot: 'snapshot-a',
});

const createHistoryItem = (id: string): GitHistoryItem => ({
  id,
  parentIds: [],
  subject: id,
  message: id,
  author: 'Author',
  authorEmail: 'author@example.com',
  timestamp: '2026-01-01T00:00:00.000Z',
  statistics: { files: 1, insertions: 1, deletions: 0 },
  references: [],
});

const createHistoryPage = (items: string[], overrides?: Partial<GitHistoryPage>): GitHistoryPage => ({
  items: items.map(createHistoryItem),
  nextCursor: null,
  hasMore: false,
  refsSnapshot: 'snapshot-a',
  ...overrides,
});

describe('useGitStore', () => {
  beforeEach(() => {
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

  test('dedupes in-flight history refs loads', async () => {
    const request = createDeferred<GitHistoryRefsResponse>();
    const git = {
      ...createGitApi(async () => createStatus()),
      getGitHistoryRefs: async () => request.promise,
    };

    const first = useGitStore.getState().ensureHistoryRefs('/repo', git);
    const second = useGitStore.getState().ensureHistoryRefs('/repo', git);

    request.resolve(createHistoryRefs());
    const [left, right] = await Promise.all([first, second]);

    expect(left).toEqual(right);
    expect(useGitStore.getState().getDirectoryState('/repo')?.history.refs?.snapshot).toBe('snapshot-a');
  });

  test('isolates history cache by filter and directory', async () => {
    const git = {
      ...createGitApi(async () => createStatus()),
      getGitHistoryRefs: async () => createHistoryRefs(),
      getGitHistory: async (directory: string, options: GitHistoryOptions) => createHistoryPage([
        `${directory}:${(options.refs ?? []).join(',')}`,
      ]),
    };

    await useGitStore.getState().fetchHistoryPage('/repo-a', git, { mode: 'auto' });
    await useGitStore.getState().fetchHistoryPage('/repo-a', git, { mode: 'manual', refIds: ['refs/tags/v1'] });
    await useGitStore.getState().fetchHistoryPage('/repo-b', git, { mode: 'auto' });

    expect(useGitStore.getState().getHistoryQueryState('/repo-a', { mode: 'auto' })?.items[0]?.id).toContain('/repo-a');
    expect(useGitStore.getState().getHistoryQueryState('/repo-a', { mode: 'manual', refIds: ['refs/tags/v1'] })?.items[0]?.id).toContain('refs/tags/v1');
    expect(useGitStore.getState().getHistoryQueryState('/repo-b', { mode: 'auto' })?.items[0]?.id).toContain('/repo-b');
  });

  test('appends history pages and preserves prior items on append failure', async () => {
    let call = 0;
    const git = {
      ...createGitApi(async () => createStatus()),
      getGitHistoryRefs: async () => createHistoryRefs(),
      getGitHistory: async (_directory: string, options: GitHistoryOptions) => {
        call += 1;
        if (call === 1) {
          expect(options.cursor ?? null).toBeNull();
          return createHistoryPage(['a', 'b'], { nextCursor: 'cursor-1', hasMore: true });
        }
        throw new Error('append failed');
      },
    };

    await useGitStore.getState().fetchHistoryPage('/repo', git, { mode: 'auto' });
    await useGitStore.getState().fetchHistoryPage('/repo', git, { mode: 'auto' }, { append: true });

    const query = useGitStore.getState().getHistoryQueryState('/repo', { mode: 'auto' });
    expect(query?.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(query?.error).toBe('append failed');
    expect(query?.outdated).toBe(true);
  });

  test('restarts from the first page after a stale cursor append failure', async () => {
    let call = 0;
    const git = {
      ...createGitApi(async () => createStatus()),
      getGitHistoryRefs: async () => createHistoryRefs(),
      getGitHistory: async () => {
        call += 1;
        if (call === 1) {
          return createHistoryPage(['first'], { nextCursor: 'cursor-1', hasMore: true });
        }
        if (call === 2) {
          throw new Error('stale cursor');
        }
        return createHistoryPage(['replacement']);
      },
    };

    await useGitStore.getState().fetchHistoryPage('/repo', git, { mode: 'auto' });
    await useGitStore.getState().fetchHistoryPage('/repo', git, { mode: 'auto' }, { append: true });

    expect(useGitStore.getState().getHistoryQueryState('/repo', { mode: 'auto' })?.items.map((item) => item.id)).toEqual(['replacement']);
  });

  test('keeps only the newest filter response', async () => {
    const autoRequest = createDeferred<GitHistoryPage>();
    const manualRequest = createDeferred<GitHistoryPage>();
    const git = {
      ...createGitApi(async () => createStatus()),
      getGitHistoryRefs: async () => createHistoryRefs(),
      getGitHistory: async (_directory: string, options: GitHistoryOptions) => (
        (options.refs ?? []).includes('refs/tags/v1') ? manualRequest.promise : autoRequest.promise
      ),
    };

    const auto = useGitStore.getState().fetchHistoryPage('/repo', git, { mode: 'auto' });
    const manual = useGitStore.getState().fetchHistoryPage('/repo', git, { mode: 'manual', refIds: ['refs/tags/v1'] });
    manualRequest.resolve(createHistoryPage(['manual']));
    await manual;
    autoRequest.resolve(createHistoryPage(['auto']));
    await auto;

    expect(useGitStore.getState().getHistoryQueryState('/repo', { mode: 'manual', refIds: ['refs/tags/v1'] })?.items[0]?.id).toBe('manual');
  });

  test('marks loaded history as outdated on invalidation without clearing rows', async () => {
    const git = {
      ...createGitApi(async () => createStatus()),
      getGitHistoryRefs: async () => createHistoryRefs(),
      getGitHistory: async () => createHistoryPage(['a']),
    };

    await useGitStore.getState().fetchHistoryPage('/repo', git, { mode: 'auto' });
    useGitStore.getState().invalidateHistory('/repo');

    const query = useGitStore.getState().getHistoryQueryState('/repo', { mode: 'auto' });
    expect(query?.items.map((item) => item.id)).toEqual(['a']);
    expect(query?.outdated).toBe(true);
  });

  test('rejects stale history completion after runtime reset', async () => {
    const historyRequest = createDeferred<GitHistoryPage>();
    const git = {
      ...createGitApi(async () => createStatus()),
      getGitHistoryRefs: async () => createHistoryRefs(),
      getGitHistory: async () => historyRequest.promise,
    };

    const loading = useGitStore.getState().fetchHistoryPage('/repo', git, { mode: 'auto' });
    useGitStore.getState().resetForRuntimeSwitch('runtime-b');
    historyRequest.resolve(createHistoryPage(['stale']));
    await loading;

    expect(useGitStore.getState().getHistoryQueryState('/repo', { mode: 'auto' })).toBe(null);
  });

  test('normalizes manual history query keys across ref ordering and duplicates', async () => {
    const git = {
      ...createGitApi(async () => createStatus()),
      getGitHistoryRefs: async () => createHistoryRefs(),
      getGitHistory: async () => createHistoryPage(['manual']),
    };

    await useGitStore.getState().fetchHistoryPage('/repo', git, {
      mode: 'manual',
      refIds: ['refs/tags/v1', 'refs/heads/main', 'refs/tags/v1'],
    });

    expect(useGitStore.getState().getHistoryQueryState('/repo', {
      mode: 'manual',
      refIds: ['refs/heads/main', 'refs/tags/v1'],
    })?.items.map((item) => item.id)).toEqual(['manual']);
  });

  test('uses the all selector instead of explicit refs for all-mode history', async () => {
    const manyRefs = Array.from({ length: 40 }, (_, index) => ({
      id: `refs/heads/branch-${index + 1}`,
      name: `branch-${index + 1}`,
      revision: `sha-${index + 1}`,
      kind: 'local' as const,
      category: 'branches' as const,
    }));
    const historyRequests: Array<{ all?: boolean; refs?: string[]; cursor?: string; limit?: number }> = [];
    const git = {
      ...createGitApi(async () => createStatus()),
      getGitHistoryRefs: async () => ({
        refs: manyRefs,
        current: manyRefs[0],
        upstream: null,
        base: null,
        snapshot: 'snapshot-many',
      }),
      getGitHistory: async (_directory: string, options: { all?: boolean; refs?: string[]; cursor?: string; limit?: number }) => {
        historyRequests.push(options);
        return createHistoryPage(['all']);
      },
    };

    await useGitStore.getState().fetchHistoryPage('/repo', git, { mode: 'all' });

    expect(historyRequests).toEqual([{ all: true, cursor: undefined, limit: 50 }]);
    expect(useGitStore.getState().getHistoryQueryState('/repo', { mode: 'all' })?.items.map((item) => item.id)).toEqual(['all']);
  });
});
