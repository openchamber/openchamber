/**
 * What the reference picker has already fetched, shared across opens.
 *
 * Switching the picker's tab or filter, or opening it again, shows the list
 * it showed last time at once; a list older than `FRESH_MS` is refreshed in
 * the background and replaced when the answer arrives. A failed refresh keeps
 * what was shown and reports the error next to it: a failure never reads as
 * an empty list.
 *
 * Keys carry everything that changes the answer (runtime, account, project,
 * kind, filter, search text), so nothing here is invalidated by hand.
 */

import * as React from 'react';

const FRESH_MS = 60_000;

export type ListPage<T> =
    | { kind: 'page'; items: T[]; cursor: string | null; hasMore: boolean }
    /** The source answered but cannot list: not connected, or no repo. */
    | { kind: 'unavailable'; reason: 'disconnected' | 'no-repo' };

export type CachedList<T> = {
    /** `loading` only until the first answer; a refresh keeps the last one. */
    status: 'loading' | 'ready' | 'unavailable' | 'error';
    unavailable: 'disconnected' | 'no-repo' | null;
    items: T[];
    hasMore: boolean;
    refreshing: boolean;
    loadingMore: boolean;
    /** The last failure, first page or a later one; cleared by the next success. */
    error: string | null;
};

export type CachedValue<T> =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; value: T }
    | { status: 'error'; error: string };

type PageFetcher<T> = (cursor: string | null) => Promise<ListPage<T>>;

type ListRecord<T> = CachedList<T> & {
    cursor: string | null;
    fetchedAt: number;
    /** Bumped when the first page is asked again; older answers are dropped. */
    generation: number;
    fetchPage: PageFetcher<T>;
};

type ValueRecord<T> = { state: CachedValue<T>; fetchedAt: number };

type Listener = () => void;

type Settled<R> = { ok: true; value: R } | { ok: false; message: string };

/** A request's outcome as data, so every caller handles failure the same way. */
const settle = async <R,>(request: Promise<R>): Promise<Settled<R>> => {
    try {
        return { ok: true, value: await request };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
};

/**
 * A bounded map of keyed records with per-key listeners. A key someone is
 * subscribed to is never evicted, so the bound is a soft target.
 */
class KeyedStore<R> {
    private readonly records = new Map<string, R>();
    private readonly listeners = new Map<string, Set<Listener>>();
    /** Counts every write, so a reader can tell whether anything changed since it last looked. */
    version = 0;

    constructor(private readonly limit: number) {}

    get(key: string): R | undefined {
        return this.records.get(key);
    }

    set(key: string, record: R): void {
        // Re-inserting keeps the map in least-recently-written order.
        this.records.delete(key);
        this.records.set(key, record);
        this.version += 1;
        for (const listener of this.listeners.get(key) ?? []) listener();
        this.evict();
    }

    subscribe(key: string, listener: Listener): () => void {
        let set = this.listeners.get(key);
        if (!set) {
            set = new Set();
            this.listeners.set(key, set);
        }
        set.add(listener);
        return () => {
            set.delete(listener);
            if (set.size === 0) this.listeners.delete(key);
        };
    }

    clear(): void {
        const keys = [...this.records.keys()];
        this.records.clear();
        this.version += 1;
        for (const key of keys) {
            for (const listener of this.listeners.get(key) ?? []) listener();
        }
    }

    private evict(): void {
        for (const key of this.records.keys()) {
            if (this.records.size <= this.limit) return;
            if (this.listeners.has(key)) continue;
            this.records.delete(key);
        }
    }
}

export type ListCache<T> = {
    /** Show what `key` has and fetch it when missing or stale. */
    ensure: (key: string, fetchPage: PageFetcher<T>, options?: { force?: boolean }) => void;
    loadMore: (key: string) => void;
    read: (key: string) => CachedList<T> | null;
    subscribe: (key: string, listener: Listener) => () => void;
    clear: () => void;
};

/** `now` is the clock freshness is measured on; tests pass their own. */
export function createListCache<T>(limit = 40, now: () => number = Date.now): ListCache<T> {
    const store = new KeyedStore<ListRecord<T>>(limit);

    const update = (key: string, record: ListRecord<T>, patch: Partial<ListRecord<T>>) => {
        store.set(key, { ...record, ...patch });
    };

    const ensure: ListCache<T>['ensure'] = (key, fetchPage, options) => {
        const existing = store.get(key);
        if (existing && (existing.refreshing || (!options?.force && now() - existing.fetchedAt < FRESH_MS))) {
            if (existing.fetchPage !== fetchPage) update(key, existing, { fetchPage });
            return;
        }
        const generation = (existing?.generation ?? 0) + 1;
        store.set(key, existing
            ? { ...existing, refreshing: true, loadingMore: false, generation, fetchPage }
            : {
                status: 'loading',
                unavailable: null,
                items: [],
                hasMore: false,
                refreshing: true,
                loadingMore: false,
                error: null,
                cursor: null,
                fetchedAt: 0,
                generation,
                fetchPage,
            });
        void settle(fetchPage(null)).then((outcome) => {
            const current = store.get(key);
            if (!current || current.generation !== generation) return;
            if (!outcome.ok) {
                update(key, current, {
                    status: current.status === 'loading' ? 'error' : current.status,
                    refreshing: false,
                    error: outcome.message,
                });
                return;
            }
            const page = outcome.value;
            if (page.kind === 'unavailable') {
                update(key, current, {
                    status: 'unavailable',
                    unavailable: page.reason,
                    items: [],
                    cursor: null,
                    hasMore: false,
                    refreshing: false,
                    error: null,
                    fetchedAt: now(),
                });
                return;
            }
            update(key, current, {
                status: 'ready',
                unavailable: null,
                items: page.items,
                cursor: page.cursor,
                hasMore: page.hasMore,
                refreshing: false,
                error: null,
                fetchedAt: now(),
            });
        });
    };

    const loadMore: ListCache<T>['loadMore'] = (key) => {
        const record = store.get(key);
        if (!record || !record.hasMore || record.loadingMore || record.refreshing || record.status !== 'ready') return;
        const { generation, cursor } = record;
        update(key, record, { loadingMore: true });
        void settle(record.fetchPage(cursor)).then((outcome) => {
            const current = store.get(key);
            if (!current || current.generation !== generation) return;
            if (!outcome.ok) {
                update(key, current, { loadingMore: false, error: outcome.message });
                return;
            }
            const page = outcome.value;
            if (page.kind === 'unavailable') {
                update(key, current, { loadingMore: false, hasMore: false });
                return;
            }
            update(key, current, {
                items: [...current.items, ...page.items],
                cursor: page.cursor,
                hasMore: page.hasMore,
                loadingMore: false,
                error: null,
            });
        });
    };

    return {
        ensure,
        loadMore,
        read: (key) => store.get(key) ?? null,
        subscribe: (key, listener) => store.subscribe(key, listener),
        clear: () => store.clear(),
    };
}

export type ValueCache<T> = {
    /**
     * The value for `key`, fetched once and again when stale; one request at
     * a time. `force` asks again even when fresh, after any request already
     * running, so an answer from before a change never wins over one after it.
     */
    ensure: (key: string, fetch: () => Promise<T>, options?: { force?: boolean }) => Promise<T>;
    /**
     * Every key of `keys` that is missing or stale, asked together: one
     * `fetch` per `batchSize` of them. `fetch` answers each key it was given;
     * a key it leaves out ends as an error, like a failed request.
     */
    ensureMany: (keys: string[], fetch: (keys: string[]) => Promise<ReadonlyMap<string, T>>, batchSize: number) => void;
    read: (key: string) => CachedValue<T> | null;
    subscribe: (key: string, listener: Listener) => () => void;
    /** Changes on every write; a snapshot for readers of several keys at once. */
    version: () => number;
    clear: () => void;
};

export function createValueCache<T>(limit = 40, now: () => number = Date.now): ValueCache<T> {
    const store = new KeyedStore<ValueRecord<T>>(limit);
    const inflight = new Map<string, Promise<T>>();

    const isFresh = (key: string) => {
        const existing = store.get(key);
        return existing?.state.status === 'ready' && now() - existing.fetchedAt < FRESH_MS;
    };

    /** Track `key` as asked by `request`, keeping a stale value visible meanwhile. */
    const track = (key: string, request: Promise<Settled<T>>): Promise<T> => {
        if (store.get(key)?.state.status !== 'ready') {
            store.set(key, { state: { status: 'loading' }, fetchedAt: 0 });
        }
        const promise = request.then((outcome) => {
            inflight.delete(key);
            if (!outcome.ok) {
                store.set(key, { state: { status: 'error', error: outcome.message }, fetchedAt: 0 });
                throw new Error(outcome.message);
            }
            store.set(key, { state: { status: 'ready', value: outcome.value }, fetchedAt: now() });
            return outcome.value;
        });
        inflight.set(key, promise);
        return promise;
    };

    const ensure: ValueCache<T>['ensure'] = (key, fetch, options) => {
        const existing = store.get(key);
        const running = inflight.get(key);
        if (options?.force) {
            const after = running ? running.then(() => undefined, () => undefined) : Promise.resolve();
            return track(key, settle(after.then(fetch)));
        }
        if (existing?.state.status === 'ready' && isFresh(key)) {
            return Promise.resolve(existing.state.value);
        }
        return running ?? track(key, settle(fetch()));
    };

    const ensureMany: ValueCache<T>['ensureMany'] = (keys, fetch, batchSize) => {
        const wanted = [...new Set(keys)].filter((key) => !isFresh(key) && !inflight.has(key));
        for (let start = 0; start < wanted.length; start += batchSize) {
            const batch = wanted.slice(start, start + batchSize);
            const answer = settle(fetch(batch));
            for (const key of batch) {
                const one = answer.then((outcome): Settled<T> => {
                    if (!outcome.ok) return outcome;
                    for (const [answered, value] of outcome.value) {
                        if (answered === key) return { ok: true, value };
                    }
                    return { ok: false, message: 'Not in the answer' };
                });
                // Nobody awaits a batch key; its failure lives in the store.
                track(key, one).catch(() => undefined);
            }
        }
    };

    return {
        ensure,
        ensureMany,
        read: (key) => store.get(key)?.state ?? null,
        subscribe: (key, listener) => store.subscribe(key, listener),
        version: () => store.version,
        clear: () => {
            inflight.clear();
            store.clear();
        },
    };
}

const noSubscription = () => () => undefined;

/**
 * The cached list for `key`, refreshed when stale. A null key shows nothing
 * and fetches nothing.
 */
export function useCachedList<T>(
    cache: ListCache<T>,
    key: string | null,
    fetchPage: PageFetcher<T>,
): CachedList<T> & { loadMore: () => void; retry: () => void } {
    const subscribe = React.useCallback(
        (listener: Listener) => (key ? cache.subscribe(key, listener) : noSubscription()),
        [cache, key],
    );
    const snapshot = React.useSyncExternalStore(subscribe, () => (key ? cache.read(key) : null));

    React.useEffect(() => {
        if (key) cache.ensure(key, fetchPage);
    }, [cache, fetchPage, key]);

    const loadMore = React.useCallback(() => {
        if (key) cache.loadMore(key);
    }, [cache, key]);
    const retry = React.useCallback(() => {
        if (key) cache.ensure(key, fetchPage, { force: true });
    }, [cache, fetchPage, key]);

    return {
        ...(snapshot ?? { status: 'loading', unavailable: null, items: [], hasMore: false, refreshing: false, loadingMore: false, error: null }),
        loadMore,
        retry,
    };
}

/**
 * The cached value for `key`, fetched on first use. A null key stays idle.
 * With `fetchNow` false it shows what the cache already has and asks nothing,
 * so a caller can wait before asking without hiding a known answer.
 */
export function useCachedValue<T>(
    cache: ValueCache<T>,
    key: string | null,
    fetch: () => Promise<T>,
    fetchNow = true,
): CachedValue<T> {
    const subscribe = React.useCallback(
        (listener: Listener) => (key ? cache.subscribe(key, listener) : noSubscription()),
        [cache, key],
    );
    const snapshot = React.useSyncExternalStore(subscribe, () => (key ? cache.read(key) : null));

    React.useEffect(() => {
        if (key && fetchNow) cache.ensure(key, fetch).catch(() => undefined);
    }, [cache, fetch, fetchNow, key]);

    return snapshot ?? { status: 'idle' };
}
