import { beforeEach, describe, expect, mock, test } from 'bun:test';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const searchRequests: Array<Deferred<Array<{ path: string }>>> = [];

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

const { useFileSearchStore } = await import('./useFileSearchStore');

describe('useFileSearchStore', () => {
  beforeEach(() => {
    searchRequests.length = 0;
    useFileSearchStore.setState({
      cache: {},
      cacheKeys: [],
      inFlight: {},
    });
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
});
