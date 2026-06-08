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
