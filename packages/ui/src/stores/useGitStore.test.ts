import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitStatus } from '@/lib/api/types';
import { useGitStore } from './useGitStore';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type GitAPI = Parameters<ReturnType<typeof useGitStore.getState>['fetchStatus']>[1];

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const createStatus = (diffStats?: GitStatus['diffStats']): GitStatus => ({
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  diffStats,
});

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
});
