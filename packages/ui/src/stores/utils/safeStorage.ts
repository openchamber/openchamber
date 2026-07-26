import type { PersistStorage, StateStorage, StorageValue } from 'zustand/middleware';

let safeStorageInstance: Storage | null = null;
let safeSessionStorageInstance: Storage | null = null;
let deferredSafeStorageInstance: Storage | null = null;

const deferredFlushers = new Set<() => void>();
let deferredFlushListenersRegistered = false;

type JsonStorageOptions = {
    reviver?: (key: string, value: unknown) => unknown;
    replacer?: (key: string, value: unknown) => unknown;
};

const registerDeferredFlusher = (flush: () => void) => {
    deferredFlushers.add(flush);
    if (deferredFlushListenersRegistered || typeof window === 'undefined') return;

    deferredFlushListenersRegistered = true;
    const flushAll = () => {
        for (const flushDeferredStorage of deferredFlushers) {
            flushDeferredStorage();
        }
    };

    try {
        window.addEventListener('pagehide', flushAll, { capture: true });
        window.addEventListener('beforeunload', flushAll, { capture: true });
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') flushAll();
            });
            document.addEventListener('freeze', flushAll);
        }
    } catch {
        // Restricted environments can reject listeners; timers still flush.
    }
};

const createDeferredJSONStorage = <S>(
    getStorage: () => StateStorage,
    options?: JsonStorageOptions,
): PersistStorage<S> | undefined => {
    let storage: StateStorage;
    try {
        storage = getStorage();
    } catch {
        return undefined;
    }

    const pendingWrites = new Map<string, StorageValue<S>>();
    const pendingDeletes = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
        flushTimer = undefined;
        if (pendingWrites.size === 0 && pendingDeletes.size === 0) return;

        const writes = Array.from(pendingWrites.entries());
        const deletes = Array.from(pendingDeletes);
        pendingWrites.clear();
        pendingDeletes.clear();

        for (const [name, value] of writes) {
            try {
                storage.setItem(name, JSON.stringify(value, options?.replacer));
            } catch (error) {
                console.error('Failed to persist deferred storage value', error);
                if (!pendingWrites.has(name) && !pendingDeletes.has(name)) pendingWrites.set(name, value);
            }
        }
        for (const name of deletes) {
            try {
                storage.removeItem(name);
            } catch (error) {
                console.error('Failed to remove deferred storage value', error);
                if (!pendingWrites.has(name)) pendingDeletes.add(name);
            }
        }
    };

    const scheduleFlush = () => {
        if (flushTimer !== undefined) return;
        flushTimer = setTimeout(flush, 0);
    };

    registerDeferredFlusher(flush);

    return {
        getItem: (name) => {
            if (pendingWrites.has(name)) {
                return pendingWrites.get(name) ?? null;
            }
            if (pendingDeletes.has(name)) {
                return null;
            }

            const parse = (value: string | null): StorageValue<S> | null => {
                if (value === null) return null;
                try {
                    return JSON.parse(value, options?.reviver) as StorageValue<S>;
                } catch {
                    try {
                        storage.removeItem(name);
                    } catch {
                        // A later hydration can retry cleanup.
                    }
                    return null;
                }
            };
            const value = storage.getItem(name);
            if (value instanceof Promise) {
                return value.then(parse);
            }
            return parse(value);
        },
        setItem: (name, value) => {
            pendingWrites.set(name, value);
            pendingDeletes.delete(name);
            scheduleFlush();
        },
        removeItem: (name) => {
            pendingWrites.delete(name);
            pendingDeletes.add(name);
            scheduleFlush();
        },
    };
};

export const createDeferredSafeJSONStorage = <S>(options?: JsonStorageOptions) => (
    createDeferredJSONStorage<S>(() => getSafeStorage(), options)
);

const createDeferredStorage = (storage: Storage): Storage => {
    const pendingWrites = new Map<string, string>();
    const pendingDeletes = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
        flushTimer = undefined;
        if (pendingWrites.size === 0 && pendingDeletes.size === 0) return;

        const writes = Array.from(pendingWrites.entries());
        const deletes = Array.from(pendingDeletes);
        pendingWrites.clear();
        pendingDeletes.clear();

        for (const [key, value] of writes) {
            try {
                storage.setItem(key, value);
            } catch (error) {
                console.error('Failed to persist deferred storage value', error);
                if (!pendingWrites.has(key) && !pendingDeletes.has(key)) pendingWrites.set(key, value);
            }
        }
        for (const key of deletes) {
            try {
                storage.removeItem(key);
            } catch (error) {
                console.error('Failed to remove deferred storage value', error);
                if (!pendingWrites.has(key)) pendingDeletes.add(key);
            }
        }
    };

    const scheduleFlush = () => {
        if (flushTimer !== undefined) return;
        flushTimer = setTimeout(flush, 0);
    };

    registerDeferredFlusher(flush);

    return {
        getItem: (key) => {
            if (pendingWrites.has(key)) return pendingWrites.get(key) ?? null;
            if (pendingDeletes.has(key)) return null;
            return storage.getItem(key);
        },
        setItem: (key, value) => {
            pendingWrites.set(key, value);
            pendingDeletes.delete(key);
            scheduleFlush();
        },
        removeItem: (key) => {
            pendingWrites.delete(key);
            pendingDeletes.add(key);
            scheduleFlush();
        },
        clear: () => {
            pendingWrites.clear();
            pendingDeletes.clear();
            if (flushTimer !== undefined) {
                clearTimeout(flushTimer);
                flushTimer = undefined;
            }
            storage.clear();
        },
        key: (index) => storage.key(index),
        get length() {
            return storage.length;
        },
    } as Storage;
};

const getWindowStorage = (key: 'localStorage' | 'sessionStorage'): Storage | null => {
    if (typeof window === 'undefined') {
        return null;
    }

    try {
        return window[key] ?? null;
    } catch {
        return null;
    }
};

const createInMemoryStorage = (): Storage => {
    const store = new Map<string, string>();
    return {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            store.set(key, value);
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        clear: () => {
            store.clear();
        },
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() {
            return store.size;
        },
    } as Storage;
};

const createSafeStorageAdapter = (baseStorage: Storage): Storage => {
    const fallback = createInMemoryStorage();
    const fallbackKeys = new Set<string>();
    const deletedKeys = new Set<string>();

    const safeGet = (key: string): string | null => {
        if (deletedKeys.has(key)) return null;
        if (fallbackKeys.has(key)) return fallback.getItem(key);
        try {
            return baseStorage.getItem(key);
        } catch {
            return null;
        }
    };

    const safeSet = (key: string, value: string) => {
        try {
            baseStorage.setItem(key, value);
            fallback.removeItem(key);
            fallbackKeys.delete(key);
            deletedKeys.delete(key);
            return;
        } catch {
            // Hide an older durable value even when quota or storage policy blocks replacement.
            try {
                baseStorage.removeItem(key);
            } catch {
                // The ephemeral override remains authoritative for this adapter.
            }
        }
        fallback.setItem(key, value);
        fallbackKeys.add(key);
        deletedKeys.delete(key);
    };

    const safeRemove = (key: string) => {
        try {
            baseStorage.removeItem(key);
            deletedKeys.delete(key);
        } catch {
            deletedKeys.add(key);
        }
        fallback.removeItem(key);
        fallbackKeys.delete(key);
    };

    const safeClear = () => {
        const knownKeys: string[] = [];
        try {
            for (let index = 0; index < baseStorage.length; index += 1) {
                const key = baseStorage.key(index);
                if (key) knownKeys.push(key);
            }
        } catch {
            // Best-effort tombstones cover keys that could be enumerated.
        }
        try {
            baseStorage.clear();
            deletedKeys.clear();
        } catch {
            for (const key of knownKeys) deletedKeys.add(key);
        }
        fallback.clear();
        fallbackKeys.clear();
    };

    const visibleKeys = (): string[] => {
        const keys = new Set<string>();
        try {
            for (let index = 0; index < baseStorage.length; index += 1) {
                const key = baseStorage.key(index);
                if (key && !deletedKeys.has(key) && !fallbackKeys.has(key)) keys.add(key);
            }
        } catch {
            // Ephemeral keys remain available when durable enumeration fails.
        }
        for (const key of fallbackKeys) keys.add(key);
        return [...keys];
    };

    return {
        getItem: safeGet,
        setItem: safeSet,
        removeItem: safeRemove,
        clear: safeClear,
        key: (index) => visibleKeys()[index] ?? null,
        get length() {
            return visibleKeys().length;
        },
    } as Storage;
};

const createSafeStorage = (): Storage => {
    const baseStorage = getWindowStorage('localStorage');
    return baseStorage ? createSafeStorageAdapter(baseStorage) : createInMemoryStorage();
};

export const getSafeStorage = (): Storage => {
    if (!safeStorageInstance) {
        safeStorageInstance = createSafeStorage();
    }
    return safeStorageInstance;
};

export const getDeferredSafeStorage = (): Storage => {
    if (!deferredSafeStorageInstance) {
        deferredSafeStorageInstance = createDeferredStorage(getSafeStorage());
    }
    return deferredSafeStorageInstance;
};

const createSafeSessionStorage = (): Storage => {
    const baseStorage = getWindowStorage('sessionStorage');
    return baseStorage ? createSafeStorageAdapter(baseStorage) : createInMemoryStorage();
};

export const getSafeSessionStorage = (): Storage => {
    if (!safeSessionStorageInstance) {
        safeSessionStorageInstance = createSafeSessionStorage();
    }
    return safeSessionStorageInstance;
};
