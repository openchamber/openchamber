import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitStatus } from '@/lib/api/types';
import { useGitStore } from './useGitStore';

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
  lastRepoCheckAt: 0,
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
    useGitStore.setState({
      directories: new Map(),
      activeDirectory: null,
    });
  });

  test('does not reuse an in-flight light status request for full status', async () => {
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

    requests[0].resolve(createStatus());
    requests[1].resolve(createStatus({ 'src/index.ts': { insertions: 1, deletions: 0 } }));
    await Promise.all([lightPromise, fullPromise]);
  });

  test('reuses an in-flight full status request for light status', async () => {
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

  test('reports branch fetch failure and preserves cached branches', async () => {
    const previousBranches = { all: ['main'], current: 'main', branches: {} };
    const directoryState = {
      ...createDirectoryState(createStatus()),
      branches: previousBranches,
    };
    useGitStore.setState({
      directories: new Map([['/repo', directoryState]]),
      activeDirectory: '/repo',
    });
    const git = {
      ...createGitApi(async () => createStatus()),
      getGitBranches: async () => {
        throw new Error('remote unavailable');
      },
    };

    const result = await useGitStore.getState().fetchBranches('/repo', git);

    expect(result).toBe(false);
    expect(useGitStore.getState().getDirectoryState('/repo')?.branches).toBe(previousBranches);
    expect(useGitStore.getState().getDirectoryState('/repo')?.isLoadingBranches).toBe(false);
  });
});
