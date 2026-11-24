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

const same = (item: string) => item;

test('a fresh list is shown again without asking', async () => {
    const cache = createListCache<string>(same);
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
    const cache = createListCache<string>(same, 40, () => clock);
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
    const cache = createListCache<string>(same);
    cache.ensure('k', async () => page(['kept']));
    await flush();

    cache.ensure('k', async () => {
        throw new Error('GitHub rate limited');
    }, { force: true });
    await flush();

    expect(cache.read('k')).toMatchObject({ status: 'ready', items: ['kept'], error: 'GitHub rate limited', refreshing: false });
});

test('a failed first load is an error, never an empty success', async () => {
    const cache = createListCache<string>(same);
    cache.ensure('k', async () => {
        throw new Error('offline');
    });
    await flush();

    expect(cache.read('k')).toMatchObject({ status: 'error', items: [], error: 'offline' });
});

test('later pages append, and a refresh drops a page still in flight', async () => {
    const cache = createListCache<string>(same);
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
    const cache2 = createListCache<string>(same);
    cache2.ensure('k', async (cursor) => (cursor ? stalePage.promise : page(['x'], 'c1')));
    await flush();
    cache2.loadMore('k');
    cache2.ensure('k', async () => page(['fresh']), { force: true });
    await flush();
    stalePage.resolve(page(['stale']));
    await flush();
    expect(cache2.read('k')?.items).toEqual(['fresh']);
});

test('a background refresh renews page one and keeps the pages loaded after it', async () => {
    let clock = 0;
    const cache = createListCache<string>(same, 40, () => clock);
    const pages = new Map<string | null, ListPage<string>>([
        [null, { kind: 'page', items: ['a', 'b'], cursor: 'p2', hasMore: true }],
        ['p2', { kind: 'page', items: ['c', 'd'], cursor: 'p3', hasMore: true }],
    ]);
    const asked: (string | null)[] = [];
    const third = deferred<ListPage<string>>();
    const fetchPage = (cursor: string | null) => {
        asked.push(cursor);
        return cursor === 'p3' ? third.promise : Promise.resolve(pages.get(cursor)!);
    };
    cache.ensure('k', fetchPage);
    await flush();
    cache.loadMore('k');
    await flush();
    const loaded = cache.read('k')!.pageReads;

    // Page three is on its way when the refresh starts. Two new items are on top now, so `a` and
    // `b` slid off page one and page three repeats `d`.
    cache.loadMore('k');
    clock = 61_000;
    pages.set(null, { kind: 'page', items: ['n1', 'n2'], cursor: 'p2', hasMore: true });
    cache.ensure('k', fetchPage);
    expect(cache.read('k')).toMatchObject({ items: ['a', 'b', 'c', 'd'], refreshing: true, loadingMore: true });
    await flush();

    expect(cache.read('k')).toMatchObject({ items: ['n1', 'n2', 'a', 'b', 'c', 'd'], hasMore: true, refreshing: false });
    expect(cache.read('k')!.pageReads).toEqual([
        { start: 0, read: { at: 61_000, forced: false } },
        { start: 2, read: loaded[0].read },
        { start: 4, read: loaded[1].read },
    ]);

    third.resolve({ kind: 'page', items: ['d', 'e'], cursor: null, hasMore: false });
    await flush();
    expect(cache.read('k')).toMatchObject({ items: ['n1', 'n2', 'a', 'b', 'c', 'd', 'e'], hasMore: false, loadingMore: false });
    expect(asked).toEqual([null, 'p2', 'p3', null]);

    // An item page one now holds is shown once, at its new place.
    clock = 122_000;
    pages.set(null, { kind: 'page', items: ['e', 'n1'], cursor: 'p2', hasMore: true });
    cache.ensure('k', fetchPage);
    await flush();
    expect(cache.read('k')?.items).toEqual(['e', 'n1', 'n2', 'a', 'b', 'c', 'd']);

    // A forced read while a background one is out starts the list over, and the background answer is dropped.
    clock = 183_000;
    const background = deferred<ListPage<string>>();
    cache.ensure('k', () => background.promise);
    cache.ensure('k', async () => page(['f'], 'p2'), { force: true });
    await flush();
    background.resolve(page(['late'], 'p2'));
    await flush();
    expect(cache.read('k')).toMatchObject({ items: ['f'], hasMore: true, refreshing: false });
});

test('an unavailable source is its own state', async () => {
    const cache = createListCache<string>(same);
    cache.ensure('k', async () => ({ kind: 'unavailable', reason: 'disconnected' }));
    await flush();

    expect(cache.read('k')).toMatchObject({ status: 'unavailable', unavailable: 'disconnected', items: [] });
});

test('the list bound never evicts a key someone watches', async () => {
    const cache = createListCache<string>(same, 2);
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

test('a folder a list across repositories left out stays left out after the next page', async () => {
    const cache = createListCache<string>(same);
    const first: ListPage<string> = { kind: 'page', items: ['a'], cursor: 'next', hasMore: true, skipped: [{ directory: '/w/b', reason: 'error' }] };
    const next: ListPage<string> = { kind: 'page', items: ['c'], cursor: null, hasMore: false, skipped: [{ directory: '/w/c', reason: 'disconnected' }] };
    const fetchPage = async (cursor: string | null) => (cursor === 'next' ? next : first);

    cache.ensure('k', fetchPage);
    await flush();
    cache.loadMore('k');
    await flush();

    expect(cache.read('k')).toMatchObject({
        items: ['a', 'c'],
        skipped: [{ directory: '/w/b', reason: 'error' }, { directory: '/w/c', reason: 'disconnected' }],
    });
});
