let safeStorageInstance: Storage | null = null;
let safeSessionStorageInstance: Storage | null = null;

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

    // Write-behind buffer. Every zustand-persist store plus the direct
    // writers (projects, directory, session folders, ...) funnels through
    // setItem below. Each call re-serializes a whole store slice, and doing
    // that synchronously during a session switch blocked the main thread for
    // >1s (large JSON.stringify in the vendor chunk). Writes are deferred to a
    // later task so the click->paint path is not blocked, and coalesced so
    // repeated writes to the same key collapse into one flush. Pending values
    // are served from memory so read-after-write stays consistent within the
    // deferral window.
    const pendingWrites = new Map<string, string>();
    const pendingDeletes = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const doFlush = () => {
        flushTimer = undefined;
        if (pendingWrites.size === 0 && pendingDeletes.size === 0) return;

        const writes = Array.from(pendingWrites.entries());
        const deletes = Array.from(pendingDeletes);
        pendingWrites.clear();
        pendingDeletes.clear();

        for (const [key, value] of writes) {
            if (storageAvailable) {
                try {
                    baseStorage.setItem(key, value);
                    fallback.removeItem(key);
                    continue;
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
        }
        for (const key of deletes) {
            try {
                baseStorage.removeItem(key);
            } catch {
                disableStorage();
            }
            fallback.removeItem(key);
        }
    };

    const scheduleFlush = () => {
        if (flushTimer !== undefined) return;
        // setTimeout(0) moves the (potentially large) serialization writes out
        // of the current task, letting the browser paint the interaction first.
        flushTimer = setTimeout(doFlush, 0);
    };

    const safeGet = (key: string): string | null => {
        if (pendingWrites.has(key)) {
            return pendingWrites.get(key) ?? null;
        }
        if (pendingDeletes.has(key)) {
            return null;
        }
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
        pendingWrites.set(key, value);
        pendingDeletes.delete(key);
        scheduleFlush();
    };

    const safeRemove = (key: string) => {
        pendingDeletes.add(key);
        pendingWrites.delete(key);
        scheduleFlush();
    };

    const safeClear = () => {
        pendingWrites.clear();
        pendingDeletes.clear();
        if (flushTimer !== undefined) {
            clearTimeout(flushTimer);
            flushTimer = undefined;
        }
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

    // Flush pending writes before the page is hidden or unloaded so deferred
    // state is not lost on tab close, reload, or the mobile freeze lifecycle.
    if (typeof window !== 'undefined') {
        const flushNow = () => doFlush();
        try {
            window.addEventListener('pagehide', flushNow, { capture: true });
            window.addEventListener('beforeunload', flushNow, { capture: true });
            window.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') doFlush();
            });
            window.addEventListener('freeze', flushNow);
        } catch {
            // Adding listeners can fail in restricted environments; persistence
            // still flushes via the setTimeout scheduler in that case.
        }
    }

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
