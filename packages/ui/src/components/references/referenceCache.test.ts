import { expect, test } from 'bun:test';

import { createListCache, createValueCache, type ListPage } from './referenceCache';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };

const deferred = <T,>(): Deferred<T> => {
    let resolve: (value: T) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

const page = (items: string[], cursor: string | null = null): ListPage<string> => ({ kind: 'page', items, cursor, hasMore: cursor !== null });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a fresh list is shown again without asking', async () => {
    const cache = createListCache<string>();
    let calls = 0;
    const fetchPage = async () => {
        calls += 1;
        return page(['a', 'b']);
    };

    cache.ensure('k', fetchPage);
    await flush();
    cache.ensure('k', fetchPage);
    await flush();

    expect(calls).toBe(1);
    expect(cache.read('k')).toMatchObject({ status: 'ready', items: ['a', 'b'], refreshing: false });
});

test('a stale list stays visible while it refreshes, then is replaced', async () => {
    let clock = 0;
    const cache = createListCache<string>(40, () => clock);
    cache.ensure('k', async () => page(['old']));
    await flush();

    clock = 5 * 60_000;
    const next = deferred<ListPage<string>>();
    cache.ensure('k', () => next.promise);
    expect(cache.read('k')).toMatchObject({ status: 'ready', items: ['old'], refreshing: true });

    next.resolve(page(['new']));
    await flush();
    expect(cache.read('k')).toMatchObject({ status: 'ready', items: ['new'], refreshing: false });
});

test('a failed refresh keeps the shown list and reports the error', async () => {
    const cache = createListCache<string>();
    cache.ensure('k', async () => page(['kept']));
    await flush();

    cache.ensure('k', async () => {
        throw new Error('GitHub rate limited');
    }, { force: true });
    await flush();

    expect(cache.read('k')).toMatchObject({ status: 'ready', items: ['kept'], error: 'GitHub rate limited', refreshing: false });
});

test('a failed first load is an error, never an empty success', async () => {
    const cache = createListCache<string>();
    cache.ensure('k', async () => {
        throw new Error('offline');
    });
    await flush();

    expect(cache.read('k')).toMatchObject({ status: 'error', items: [], error: 'offline' });
});

test('an older answer cannot overwrite a newer one', async () => {
    const cache = createListCache<string>();
    const first = deferred<ListPage<string>>();
    cache.ensure('k', () => first.promise);
    const second = deferred<ListPage<string>>();
    // A forced retry while the first request is still out waits for it.
    cache.ensure('k', () => second.promise, { force: true });
    first.resolve(page(['first']));
    await flush();
    cache.ensure('k', () => second.promise, { force: true });
    second.resolve(page(['second']));
    await flush();

    expect(cache.read('k')?.items).toEqual(['second']);
});

test('later pages append, and a refresh drops a page still in flight', async () => {
    const cache = createListCache<string>();
    const more = deferred<ListPage<string>>();
    let calls = 0;
    const fetchPage = (cursor: string | null) => {
        calls += 1;
        if (cursor === 'c1') return more.promise;
        return Promise.resolve(page(['a'], 'c1'));
    };
    cache.ensure('k', fetchPage);
    await flush();

    cache.loadMore('k');
    cache.loadMore('k');
    expect(calls).toBe(2);
    more.resolve(page(['b']));
    await flush();
    expect(cache.read('k')).toMatchObject({ items: ['a', 'b'], hasMore: false, loadingMore: false });

    const stalePage = deferred<ListPage<string>>();
    const cache2 = createListCache<string>();
    cache2.ensure('k', async (cursor) => (cursor ? stalePage.promise : page(['x'], 'c1')));
    await flush();
    cache2.loadMore('k');
    cache2.ensure('k', async () => page(['fresh']), { force: true });
    await flush();
    stalePage.resolve(page(['stale']));
    await flush();
    expect(cache2.read('k')?.items).toEqual(['fresh']);
});

test('an unavailable source is its own state', async () => {
    const cache = createListCache<string>();
    cache.ensure('k', async () => ({ kind: 'unavailable', reason: 'disconnected' }));
    await flush();

    expect(cache.read('k')).toMatchObject({ status: 'unavailable', unavailable: 'disconnected', items: [] });
});

test('the list bound never evicts a key someone watches', async () => {
    const cache = createListCache<string>(2);
    const stop = cache.subscribe('watched', () => undefined);
    for (const key of ['watched', 'a', 'b', 'c']) {
        cache.ensure(key, async () => page([key]));
    }
    await flush();

    expect(cache.read('watched')?.items).toEqual(['watched']);
    expect(cache.read('a')).toBeNull();
    expect(cache.read('c')?.items).toEqual(['c']);
    stop();
});

test('a value is asked once while in flight and kept after an error', async () => {
    const cache = createValueCache<string>();
    let calls = 0;
    const request = deferred<string>();
    const fetch = () => {
        calls += 1;
        return request.promise;
    };

    const first = cache.ensure('v', fetch);
    const second = cache.ensure('v', fetch);
    expect(calls).toBe(1);
    request.resolve('detail');
    expect(await first).toBe('detail');
    expect(await second).toBe('detail');
    expect(cache.read('v')).toEqual({ status: 'ready', value: 'detail' });

    await cache.ensure('w', async () => {
        throw new Error('gone');
    }).catch(() => undefined);
    expect(cache.read('w')).toEqual({ status: 'error', error: 'gone' });
});

test('many values are asked in batches, skipping fresh and in-flight keys', async () => {
    let clock = 0;
    const cache = createValueCache<string | null>(40, () => clock);
    const batches: string[][] = [];
    const answer = (keys: string[]) => {
        batches.push(keys);
        // `c` is left out of the answer.
        return Promise.resolve(new Map(keys.filter((key) => key !== 'c').map((key) => [key, key === 'b' ? null : key.toUpperCase()])));
    };

    cache.ensureMany(['a', 'b', 'c'], answer, 2);
    cache.ensureMany(['a', 'b', 'c'], answer, 2);
    expect(batches).toEqual([['a', 'b'], ['c']]);
    await flush();
    expect(cache.read('a')).toEqual({ status: 'ready', value: 'A' });
    expect(cache.read('b')).toEqual({ status: 'ready', value: null });
    expect(cache.read('c')).toEqual({ status: 'error', error: 'Not in the answer' });

    // Only the failed key is asked again while the rest are fresh; all once stale.
    cache.ensureMany(['a', 'b', 'c'], answer, 2);
    clock = 60_000;
    await flush();
    cache.ensureMany(['a', 'b', 'c', 'd'], answer, 2);
    expect(batches.slice(2)).toEqual([['c'], ['a', 'b'], ['c', 'd']]);
    expect(cache.read('a')).toEqual({ status: 'ready', value: 'A' });
});

test('a failed batch fails each of its keys', async () => {
    const cache = createValueCache<string>();
    cache.ensureMany(['a', 'b'], async () => {
        throw new Error('rate limited');
    }, 30);
    await flush();
    expect(cache.read('a')).toEqual({ status: 'error', error: 'rate limited' });
    expect(cache.read('b')).toEqual({ status: 'error', error: 'rate limited' });
});
