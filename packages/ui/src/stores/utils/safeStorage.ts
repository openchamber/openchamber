import type { PersistStorage, StateStorage, StorageValue } from 'zustand/middleware';

let safeStorageInstance: Storage | null = null;
let safeSessionStorageInstance: Storage | null = null;

type JsonStorageOptions = {
    reviver?: (key: string, value: unknown) => unknown;
    replacer?: (key: string, value: unknown) => unknown;
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
            storage.setItem(name, JSON.stringify(value, options?.replacer));
        }
        for (const name of deletes) {
            storage.removeItem(name);
        }
    };

    const scheduleFlush = () => {
        if (flushTimer !== undefined) return;
        flushTimer = setTimeout(flush, 0);
    };

    if (typeof window !== 'undefined') {
        const flushNow = () => flush();
        try {
            window.addEventListener('pagehide', flushNow, { capture: true });
            window.addEventListener('beforeunload', flushNow, { capture: true });
            window.addEventListener('visibilitychange', () => {
                if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush();
            });
            window.addEventListener('freeze', flushNow);
        } catch {
            // Restricted environments can reject listeners; the timer still flushes.
        }
    }

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
