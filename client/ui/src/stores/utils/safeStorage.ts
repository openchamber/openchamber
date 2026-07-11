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
        window.addEventListener('visibilitychange', () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flushAll();
        });
        window.addEventListener('freeze', flushAll);
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
            }
        }
        for (const name of deletes) {
            try {
                storage.removeItem(name);
            } catch (error) {
                console.error('Failed to remove deferred storage value', error);
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
                return JSON.parse(value, options?.reviver) as StorageValue<S>;
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
            }
        }
        for (const key of deletes) {
            try {
                storage.removeItem(key);
            } catch (error) {
                console.error('Failed to remove deferred storage value', error);
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

const createSafeStorage = (): Storage => {
    const baseStorage = getWindowStorage('localStorage');

    if (!baseStorage) {
        return createInMemoryStorage();
    }

    const fallback = createInMemoryStorage();
    let storageAvailable = true;

    const disableStorage = () => {
        storageAvailable = false;
    };

    const safeGet = (key: string): string | null => {
        if (storageAvailable) {
            try {
                const value = baseStorage.getItem(key);
                if (value !== null) {
                    return value;
                }
            } catch {
                disableStorage();
            }
        }
        return fallback.getItem(key);
    };

    const safeSet = (key: string, value: string) => {
        if (storageAvailable) {
            try {
                baseStorage.setItem(key, value);
                fallback.removeItem(key);
                return;
            } catch {
                disableStorage();
                // Prevent stale previous value from surviving when writes fail (e.g. quota).
                try {
                    baseStorage.removeItem(key);
                } catch {
                    // noop
                }
            }
        }
        fallback.setItem(key, value);
    };

    const safeRemove = (key: string) => {
        try {
            baseStorage.removeItem(key);
        } catch {
            disableStorage();
        }
        fallback.removeItem(key);
    };

    const safeClear = () => {
        try {
            baseStorage.clear();
        } catch {
            disableStorage();
        }
        fallback.clear();
    };

    const safeKey = (index: number): string | null => {
        if (storageAvailable) {
            try {
                return baseStorage.key(index);
            } catch {
                disableStorage();
            }
        }
        return fallback.key(index);
    };

    return {
        getItem: safeGet,
        setItem: safeSet,
        removeItem: safeRemove,
        clear: safeClear,
        key: safeKey,
        get length() {
            if (storageAvailable) {
                try {
                    return baseStorage.length + fallback.length;
                } catch {
                    disableStorage();
                }
            }
            return fallback.length;
        },
    } as Storage;
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

    if (!baseStorage) {
        return createInMemoryStorage();
    }

    const fallback = createInMemoryStorage();
    let storageAvailable = true;

    const disableStorage = () => {
        storageAvailable = false;
    };

    const safeGet = (key: string): string | null => {
        if (storageAvailable) {
            try {
                const value = baseStorage.getItem(key);
                if (value !== null) {
                    return value;
                }
            } catch {
                disableStorage();
            }
        }
        return fallback.getItem(key);
    };

    const safeSet = (key: string, value: string) => {
        if (storageAvailable) {
            try {
                baseStorage.setItem(key, value);
                fallback.removeItem(key);
                return;
            } catch {
                disableStorage();
                // Prevent stale previous value from surviving when writes fail (e.g. quota).
                try {
                    baseStorage.removeItem(key);
                } catch {
                    // noop
                }
            }
        }
        fallback.setItem(key, value);
    };

    const safeRemove = (key: string) => {
        try {
            baseStorage.removeItem(key);
        } catch {
            disableStorage();
        }
        fallback.removeItem(key);
    };

    const safeClear = () => {
        try {
            baseStorage.clear();
        } catch {
            disableStorage();
        }
        fallback.clear();
    };

    const safeKey = (index: number): string | null => {
        if (storageAvailable) {
            try {
                return baseStorage.key(index);
            } catch {
                disableStorage();
            }
        }
        return fallback.key(index);
    };

    return {
        getItem: safeGet,
        setItem: safeSet,
        removeItem: safeRemove,
        clear: safeClear,
        key: safeKey,
        get length() {
            if (storageAvailable) {
                try {
                    return baseStorage.length + fallback.length;
                } catch {
                    disableStorage();
                }
            }
            return fallback.length;
        },
    } as Storage;
};

export const getSafeSessionStorage = (): Storage => {
    if (!safeSessionStorageInstance) {
        safeSessionStorageInstance = createSafeSessionStorage();
    }
    return safeSessionStorageInstance;
};
