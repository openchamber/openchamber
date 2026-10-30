import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const searchRequests: Array<Deferred<Array<{ path: string }>>> = [];
let runtimeKey = 'runtime-a';
let runtimeSearch: (() => Promise<Array<{ path: string; preview: string[] }>>) | undefined;
const runtimeSearchCalls: unknown[] = [];

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const searchFilesMock = mock(() => {
  const request = createDeferred<Array<{ path: string }>>();
  searchRequests.push(request);
  return request.promise;
});

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    searchFiles: searchFilesMock,
  },
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtimeKey }));
mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => {
    const search = runtimeSearch;
    return search ? { files: { search: (payload: unknown) => {
      runtimeSearchCalls.push(payload);
      return search();
    } } } : undefined;
  },
}));

const { useFileSearchStore } = await import('./useFileSearchStore');

describe('useFileSearchStore', () => {
  beforeEach(() => {
    searchRequests.length = 0;
    runtimeKey = 'runtime-a';
    runtimeSearch = undefined;
    runtimeSearchCalls.length = 0;
    useFileSearchStore.setState({
      cache: {},
      cacheKeys: [],
      inFlight: {},
    });
  });

  test('keeps indexed results and appends deduplicated toggle results', async () => {
    runtimeSearch = mock(async () => [
      { path: '/project/ordinary.ts', preview: ['ordinary.ts'] },
      { path: '/project/build/ignored.ts', preview: ['build/ignored.ts'] },
    ]);
    const pending = useFileSearchStore.getState().searchFiles('/project', 'ts', 3, { respectGitignore: false });
    const indexed = { path: '/project/ordinary.ts', name: 'ordinary.ts', relativePath: 'ordinary.ts' };
    searchRequests[0].resolve([indexed]);

    expect(await pending).toEqual([
      indexed,
      { path: '/project/build/ignored.ts', name: 'ignored.ts', relativePath: 'build/ignored.ts', extension: 'ts' },
    ]);
    expect(runtimeSearchCalls).toEqual([{
      directory: '/project', query: 'ts', maxResults: 3, includeHidden: false, respectGitignore: false,
    }]);
  });

  test('keeps toggle caches separate and leaves directory searches on OpenCode', async () => {
    runtimeSearch = mock(async () => [{ path: '/project/.hidden.ts', preview: ['.hidden.ts'] }]);
    const hidden = useFileSearchStore.getState().searchFiles('/project', 'hidden', 60, { includeHidden: true });
    searchRequests[0].resolve([]);
    expect(await hidden).toHaveLength(1);

    const ordinary = useFileSearchStore.getState().searchFiles('/project', 'hidden');
    searchRequests[1].resolve([]);
    expect(await ordinary).toEqual([]);
    const directories = useFileSearchStore.getState().searchFiles('/project', 'hidden', 60, { includeHidden: true, type: 'directory' });
    searchRequests[2].resolve([{ path: '/project/folder' }]);
    expect(await directories).toEqual([{ path: '/project/folder' }]);
    expect(runtimeSearchCalls).toHaveLength(1);
  });

  test('preserves indexed hits, reports supplemental failure and retries without caching partial results', async () => {
    const error = new Error('search failed');
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      runtimeSearch = mock(async () => { throw error; });
      const pending = useFileSearchStore.getState().searchFiles('/project', 'x', 60, { includeHidden: true });
      const indexed = [{ path: '/project/x.ts' }];
      searchRequests[0].resolve(indexed);
      expect(await pending).toEqual(indexed);
      expect(warning.mock.calls).toEqual([['Supplemental file search failed; keeping indexed results:', error]]);
      expect(useFileSearchStore.getState().cache).toEqual({});
      expect(useFileSearchStore.getState().inFlight).toEqual({});

      runtimeSearch = mock(async () => [{ path: '/project/.x.ts', preview: ['.x.ts'] }]);
      const retry = useFileSearchStore.getState().searchFiles('/project', 'x', 60, { includeHidden: true });
      searchRequests[1].resolve(indexed);
      expect(await retry).toHaveLength(2);
      expect(Object.values(useFileSearchStore.getState().cache)).toHaveLength(1);
    } finally {
      warning.mockRestore();
    }
  });

  test('still rejects indexed failures without caching supplemental hits', async () => {
    runtimeSearch = mock(async () => [{ path: '/project/.x.ts', preview: ['.x.ts'] }]);
    const pending = useFileSearchStore.getState().searchFiles('/project', 'x', 60, { includeHidden: true });
    searchRequests[0].reject(new Error('index failed'));
    await expect(pending).rejects.toThrow('index failed');
    expect(useFileSearchStore.getState().cache).toEqual({});
    expect(useFileSearchStore.getState().inFlight).toEqual({});
  });

  test('does not cache a stale in-flight search after invalidation', async () => {
    const searchPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    expect(Object.keys(useFileSearchStore.getState().inFlight)).toHaveLength(1);

    useFileSearchStore.getState().invalidateDirectory('/project');
    expect(Object.keys(useFileSearchStore.getState().inFlight)).toHaveLength(0);

    searchRequests[0].resolve([{ path: 'stale.ts' }]);
    await searchPromise;

    expect(useFileSearchStore.getState().cache).toEqual({});
    expect(useFileSearchStore.getState().cacheKeys).toEqual([]);
  });

  test('does not notify subscribers when stale search handlers make no state change', async () => {
    const searchPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    useFileSearchStore.getState().invalidateDirectory('/project');

    let updateCount = 0;
    const unsubscribe = useFileSearchStore.subscribe(() => {
      updateCount += 1;
    });

    searchRequests[0].resolve([{ path: 'stale.ts' }]);
    await searchPromise;
    unsubscribe();

    expect(updateCount).toBe(0);
  });

  test('does not let a stale request remove a newer in-flight search', async () => {
    const stalePromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    useFileSearchStore.getState().invalidateDirectory('/project');
    const freshPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');

    searchRequests[0].resolve([{ path: 'stale.ts' }]);
    await stalePromise;

    expect(Object.keys(useFileSearchStore.getState().inFlight)).toHaveLength(1);

    searchRequests[1].resolve([{ path: 'fresh.ts' }]);
    await freshPromise;

    const cacheEntries = Object.values(useFileSearchStore.getState().cache);
    expect(cacheEntries).toHaveLength(1);
    expect(cacheEntries[0]?.files).toEqual([{ path: 'fresh.ts' }]);
  });

  test('keeps directory and query separators from colliding in cache keys', async () => {
    const firstPromise = useFileSearchStore.getState().searchFiles('/project::nested', 'foo');
    searchRequests[0].resolve([{ path: 'first.ts' }]);
    await firstPromise;

    const secondPromise = useFileSearchStore.getState().searchFiles('/project', 'nested::foo');
    expect(searchRequests).toHaveLength(2);

    searchRequests[1].resolve([{ path: 'second.ts' }]);
    expect(await secondPromise).toEqual([{ path: 'second.ts' }]);
  });

  test('isolates cache and in-flight ownership by runtime', async () => {
    const firstPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    runtimeKey = 'runtime-b';
    const secondPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    expect(searchRequests).toHaveLength(2);

    searchRequests[1].resolve([{ path: 'runtime-b.ts' }]);
    expect(await secondPromise).toEqual([{ path: 'runtime-b.ts' }]);
    searchRequests[0].resolve([{ path: 'runtime-a.ts' }]);
    await firstPromise;

    runtimeKey = 'runtime-b';
    expect(await useFileSearchStore.getState().searchFiles('/project', 'foo')).toEqual([{ path: 'runtime-b.ts' }]);
    expect(searchRequests).toHaveLength(2);
  });
});
