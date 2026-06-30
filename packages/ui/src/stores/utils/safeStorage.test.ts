import { describe, expect, test } from 'bun:test';

const importSafeStorage = async () => {
    return await import(`./safeStorage.ts?test=${Date.now()}-${Math.random()}`) as typeof import('./safeStorage');
};

const createFakeStorage = (): Storage => {
    const store = new Map<string, string>();
    return {
        getItem: (k) => (store.has(k) ? store.get(k)! : null),
        setItem: (k, v) => {
            store.set(k, String(v));
        },
        removeItem: (k) => {
            store.delete(k);
        },
        clear: () => store.clear(),
        key: (i) => Array.from(store.keys())[i] ?? null,
        get length() {
            return store.size;
        },
    } as Storage;
};

describe('safeStorage', () => {
    test('falls back to memory when storage getters throw', async () => {
        const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        const throwingWindow = {};

        Object.defineProperties(throwingWindow, {
            localStorage: {
                get() {
                    throw new Error('localStorage blocked');
                },
            },
            sessionStorage: {
                get() {
                    throw new Error('sessionStorage blocked');
                },
            },
        });

        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: throwingWindow,
        });

        try {
            const { getSafeSessionStorage, getSafeStorage } = await importSafeStorage();
            const storage = getSafeStorage();
            const sessionStorage = getSafeSessionStorage();

            storage.setItem('local-key', 'local-value');
            sessionStorage.setItem('session-key', 'session-value');

            expect(storage.getItem('local-key')).toBe('local-value');
            expect(sessionStorage.getItem('session-key')).toBe('session-value');
        } finally {
            if (previousWindow) {
                Object.defineProperty(globalThis, 'window', previousWindow);
            } else {
                delete (globalThis as { window?: unknown }).window;
            }
        }
    });

    test('defers localStorage writes off the call site and serves pending reads', async () => {
        const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        const backingStorage = createFakeStorage();
        const fakeWindow = {
            localStorage: backingStorage,
            sessionStorage: createFakeStorage(),
            addEventListener: () => {},
        };

        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: fakeWindow,
        });

        try {
            const { getSafeStorage } = await importSafeStorage();
            const storage = getSafeStorage();

            storage.setItem('k', 'v');

            // Not yet written through to the backing store (write is deferred)...
            expect(backingStorage.getItem('k')).toBeNull();
            // ...but read-after-write still returns the pending value.
            expect(storage.getItem('k')).toBe('v');

            // Coalesce: a second write to the same key should not produce two
            // backing writes, and the latest value wins.
            storage.setItem('k', 'v2');

            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(backingStorage.getItem('k')).toBe('v2');
            expect(storage.getItem('k')).toBe('v2');
        } finally {
            if (previousWindow) {
                Object.defineProperty(globalThis, 'window', previousWindow);
            } else {
                delete (globalThis as { window?: unknown }).window;
            }
        }
    });
});
