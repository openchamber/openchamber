
import * as React from 'react';

import type { RepositoryReferencesAcrossSkip } from '@/lib/api/types';

const FRESH_MS = 60_000;

export type ListSkip = { directory: string; reason: RepositoryReferencesAcrossSkip };

const mergeSkipped = (shown: readonly ListSkip[], next: readonly ListSkip[]): ListSkip[] => {
    const known = new Set(shown.map((skip) => skip.directory));
    return [...shown, ...next.filter((skip) => !known.has(skip.directory))];
};

export type ListPage<T> =
    | { kind: 'page'; items: T[]; cursor: string | null; hasMore: boolean; skipped?: ListSkip[] }
    | { kind: 'unavailable'; reason: 'disconnected' | 'no-repo' };

export type CachedList<T> = {
    status: 'loading' | 'ready' | 'unavailable' | 'error';
    unavailable: 'disconnected' | 'no-repo' | null;
    items: T[];
    hasMore: boolean;
    refreshing: boolean;
    loadingMore: boolean;
    error: string | null;
    skipped: ListSkip[];
    pageReads: PageRead[];
};

export type ReadStamp = { at: number; forced: boolean };

export type PageRead = { start: number; read: ReadStamp };

export type CachedValue<T> =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; value: T }
    | { status: 'error'; error: string };

type PageFetcher<T> = (cursor: string | null) => Promise<ListPage<T>>;

type ListRecord<T> = CachedList<T> & {
    cursor: string | null;
    fetchedAt: number;
    generation: number;
    fetchPage: PageFetcher<T>;
};

type ValueRecord<T> = { state: CachedValue<T>; fetchedAt: number; forced: boolean };

type Listener = () => void;

type Settled<R> = { ok: true; value: R } | { ok: false; message: string };

const settle = async <R,>(request: Promise<R>): Promise<Settled<R>> => {
    try {
        return { ok: true, value: await request };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
};

class KeyedStore<R> {
    private readonly records = new Map<string, R>();
    private readonly listeners = new Map<string, Set<Listener>>();
    version = 0;

    constructor(private readonly limit: number) {}

    get(key: string): R | undefined {
        return this.records.get(key);
    }

    set(key: string, record: R): void {
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
        this.forget(() => true);
    }

    forget(picked: (key: string) => boolean): void {
        const keys = [...this.records.keys()].filter(picked);
        if (keys.length === 0) return;
        for (const key of keys) this.records.delete(key);
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
    ensure: (key: string, fetchPage: PageFetcher<T>, options?: { force?: boolean }) => Promise<void>;
    loadMore: (key: string) => void;
    read: (key: string) => CachedList<T> | null;
    subscribe: (key: string, listener: Listener) => () => void;
    clear: () => void;
};

type ItemKey<T> = (item: T) => string;

const mergeFirstPage = <T,>(
    shown: Pick<CachedList<T>, 'items' | 'pageReads'>,
    fresh: T[],
    read: ReadStamp,
    keyOf: ItemKey<T>,
): Pick<CachedList<T>, 'items' | 'pageReads'> => {
    const freshKeys = new Set(fresh.map(keyOf));
    const items = [...fresh];
    const pageReads: PageRead[] = [{ start: 0, read }];
    let page = -1;
    shown.items.forEach((item, index) => {
        while (page + 1 < shown.pageReads.length && shown.pageReads[page + 1].start <= index) page += 1;
        if (freshKeys.has(keyOf(item))) return;
        const stamp = shown.pageReads[page]?.read ?? read;
        if (pageReads[pageReads.length - 1].read !== stamp) pageReads.push({ start: items.length, read: stamp });
        items.push(item);
    });
    return { items, pageReads };
};

export function createListCache<T>(keyOf: ItemKey<T>, limit = 40, now: () => number = Date.now): ListCache<T> {
    const store = new KeyedStore<ListRecord<T>>(limit);

    const update = (key: string, record: ListRecord<T>, patch: Partial<ListRecord<T>>) => {
        store.set(key, { ...record, ...patch });
    };

    const ensure: ListCache<T>['ensure'] = (key, fetchPage, options) => {
        const existing = store.get(key);
        if (existing && !options?.force && (existing.refreshing || now() - existing.fetchedAt < FRESH_MS)) {
            if (existing.fetchPage !== fetchPage) update(key, existing, { fetchPage });
            return Promise.resolve();
        }
        const keepsPages = !options?.force && existing?.status === 'ready' && existing.pageReads.length > 1;
        const generation = (existing?.generation ?? 0) + (keepsPages ? 0 : 1);
        store.set(key, existing
            ? { ...existing, refreshing: true, loadingMore: keepsPages && existing.loadingMore, generation, fetchPage }
            : {
                status: 'loading',
                unavailable: null,
                items: [],
                hasMore: false,
                refreshing: true,
                loadingMore: false,
                error: null,
                skipped: [],
                pageReads: [],
                cursor: null,
                fetchedAt: 0,
                generation,
                fetchPage,
            });
        return settle(fetchPage(null)).then((outcome) => {
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
                    skipped: [],
                    pageReads: [],
                    fetchedAt: now(),
                });
                return;
            }
            const at = now();
            if (keepsPages && current.status === 'ready') {
                update(key, current, {
                    ...mergeFirstPage(current, page.items, { at, forced: false }, keyOf),
                    skipped: page.skipped ?? [],
                    refreshing: false,
                    error: null,
                    fetchedAt: at,
                });
                return;
            }
            update(key, current, {
                status: 'ready',
                skipped: page.skipped ?? [],
                unavailable: null,
                items: page.items,
                cursor: page.cursor,
                hasMore: page.hasMore,
                refreshing: false,
                error: null,
                pageReads: [{ start: 0, read: { at, forced: Boolean(options?.force) } }],
                fetchedAt: at,
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
            const shownKeys = new Set(current.items.map(keyOf));
            update(key, current, {
                items: [...current.items, ...page.items.filter((item) => !shownKeys.has(keyOf(item)))],
                pageReads: [...current.pageReads, { start: current.items.length, read: { at: now(), forced: false } }],
                cursor: page.cursor,
                hasMore: page.hasMore,
                loadingMore: false,
                error: null,
                skipped: mergeSkipped(current.skipped, page.skipped ?? []),
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
    ensure: (key: string, fetch: () => Promise<T>, options?: { force?: boolean }) => Promise<T>;
    ensureMany: (keys: string[], fetch: (keys: string[]) => Promise<ReadonlyMap<string, T>>, batchSize: number) => void;
    read: (key: string) => CachedValue<T> | null;
    readOf: (key: string) => ReadStamp | null;
    subscribe: (key: string, listener: Listener) => () => void;
    version: () => number;
    forget: (picked: (key: string) => boolean) => void;
    clear: () => void;
};

export function createValueCache<T>(limit = 40, now: () => number = Date.now): ValueCache<T> {
    const store = new KeyedStore<ValueRecord<T>>(limit);
    const inflight = new Map<string, Promise<T>>();

    const isFresh = (key: string) => {
        const existing = store.get(key);
        return existing?.state.status === 'ready' && now() - existing.fetchedAt < FRESH_MS;
    };

    const track = (key: string, request: Promise<Settled<T>>, forced = false): Promise<T> => {
        if (store.get(key)?.state.status !== 'ready') {
            store.set(key, { state: { status: 'loading' }, fetchedAt: 0, forced: false });
        }
        const promise = request.then((outcome) => {
            inflight.delete(key);
            if (!outcome.ok) {
                store.set(key, { state: { status: 'error', error: outcome.message }, fetchedAt: 0, forced: false });
                throw new Error(outcome.message);
            }
            store.set(key, { state: { status: 'ready', value: outcome.value }, fetchedAt: now(), forced });
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
            return track(key, settle(after.then(fetch)), true);
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
                track(key, one).catch(() => undefined);
            }
        }
    };

    return {
        ensure,
        ensureMany,
        read: (key) => store.get(key)?.state ?? null,
        readOf: (key) => {
            const record = store.get(key);
            return record?.state.status === 'ready' ? { at: record.fetchedAt, forced: record.forced } : null;
        },
        subscribe: (key, listener) => store.subscribe(key, listener),
        version: () => store.version,
        forget: (picked) => {
            for (const key of inflight.keys()) if (picked(key)) inflight.delete(key);
            store.forget(picked);
        },
        clear: () => {
            inflight.clear();
            store.clear();
        },
    };
}

const noSubscription = () => () => undefined;

let revalidation = 0;
const revalidationListeners = new Set<Listener>();

const subscribeRevalidation = (listener: Listener) => {
    revalidationListeners.add(listener);
    return () => {
        revalidationListeners.delete(listener);
    };
};

export function revalidateReferences(): void {
    revalidation += 1;
    for (const listener of revalidationListeners) listener();
}

export function useReferenceRevalidation(): number {
    return React.useSyncExternalStore(subscribeRevalidation, () => revalidation, () => revalidation);
}

export function useCachedList<T>(
    cache: ListCache<T>,
    key: string | null,
    fetchPage: PageFetcher<T>,
): CachedList<T> & { loadMore: () => void; retry: () => Promise<void> } {
    const subscribe = React.useCallback(
        (listener: Listener) => (key ? cache.subscribe(key, listener) : noSubscription()),
        [cache, key],
    );
    const snapshot = React.useSyncExternalStore(subscribe, () => (key ? cache.read(key) : null));
    const revalidation = useReferenceRevalidation();

    React.useEffect(() => {
        if (key) void cache.ensure(key, fetchPage);
    }, [cache, fetchPage, key, revalidation]);

    const loadMore = React.useCallback(() => {
        if (key) cache.loadMore(key);
    }, [cache, key]);
    const retry = React.useCallback(
        () => (key ? cache.ensure(key, fetchPage, { force: true }) : Promise.resolve()),
        [cache, fetchPage, key],
    );

    return {
        ...(snapshot ?? { status: 'loading', unavailable: null, items: [], hasMore: false, refreshing: false, loadingMore: false, error: null, skipped: [], pageReads: [] }),
        loadMore,
        retry,
    };
}

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
    const revalidation = useReferenceRevalidation();

    React.useEffect(() => {
        if (key && fetchNow) cache.ensure(key, fetch).catch(() => undefined);
    }, [cache, fetch, fetchNow, key, revalidation]);

    return snapshot ?? { status: 'idle' };
}
