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

    test('defers persisted JSON serialization and serves pending reads', async () => {
        const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        const previousStringify = JSON.stringify;
        const stringifyCalls: unknown[] = [];
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
            JSON.stringify = ((value: unknown, replacer?: Parameters<typeof JSON.stringify>[1], space?: Parameters<typeof JSON.stringify>[2]) => {
                stringifyCalls.push(value);
                return previousStringify(value, replacer, space);
            }) as typeof JSON.stringify;

            const { createDeferredSafeJSONStorage } = await importSafeStorage();
            const storage = createDeferredSafeJSONStorage<{ value: string }>();

            expect(Boolean(storage)).toBe(true);
            if (!storage) throw new Error('storage unavailable');

            storage.setItem('k', { state: { value: 'v' } });

            // Neither serialization nor the backing write runs on the call site...
            expect(stringifyCalls).toHaveLength(0);
            expect(backingStorage.getItem('k')).toBeNull();
            // ...but read-after-write still returns the pending value.
            expect(storage.getItem('k')).toEqual({ state: { value: 'v' } });

            // Coalesce: a second write to the same key should not produce two
            // stringifications/backing writes, and the latest value wins.
            storage.setItem('k', { state: { value: 'v2' } });

            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(stringifyCalls).toEqual([{ state: { value: 'v2' } }]);
            expect(backingStorage.getItem('k')).toBe('{"state":{"value":"v2"}}');
            expect(storage.getItem('k')).toEqual({ state: { value: 'v2' } });
        } finally {
            JSON.stringify = previousStringify;
            if (previousWindow) {
                Object.defineProperty(globalThis, 'window', previousWindow);
            } else {
                delete (globalThis as { window?: unknown }).window;
            }
        }
    });

    test('defers direct storage writes and flushes on pagehide', async () => {
        const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        const backingStorage = createFakeStorage();
        const listeners = new Map<string, Array<() => void>>();
        const fakeWindow = {
            localStorage: backingStorage,
            sessionStorage: createFakeStorage(),
            addEventListener: (event: string, listener: () => void) => {
                listeners.set(event, [...(listeners.get(event) ?? []), listener]);
            },
        };

        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: fakeWindow,
        });

        try {
            const { getDeferredSafeStorage } = await importSafeStorage();
            const storage = getDeferredSafeStorage();

            storage.setItem('direct-k', 'direct-v');

            expect(backingStorage.getItem('direct-k')).toBeNull();
            expect(storage.getItem('direct-k')).toBe('direct-v');

            for (const listener of listeners.get('pagehide') ?? []) {
                listener();
            }

            expect(backingStorage.getItem('direct-k')).toBe('direct-v');
        } finally {
            if (previousWindow) {
                Object.defineProperty(globalThis, 'window', previousWindow);
            } else {
                delete (globalThis as { window?: unknown }).window;
            }
        }
    });

    test('isolates quota failures to one key and retries durable storage later', async () => {
        const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        const backingStorage = createFakeStorage();
        backingStorage.setItem('large', 'old');
        const originalSet = backingStorage.setItem.bind(backingStorage);
        let rejectLarge = true;
        backingStorage.setItem = (key, value) => {
            if (key === 'large' && rejectLarge) throw new DOMException('quota', 'QuotaExceededError');
            originalSet(key, value);
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { localStorage: backingStorage, sessionStorage: createFakeStorage(), addEventListener: () => {} },
        });

        try {
            const { getSafeStorage } = await importSafeStorage();
            const storage = getSafeStorage();
            storage.setItem('large', 'ephemeral-new');
            storage.setItem('unrelated', 'durable');

            expect(storage.getItem('large')).toBe('ephemeral-new');
            expect(backingStorage.getItem('large')).toBeNull();
            expect(backingStorage.getItem('unrelated')).toBe('durable');

            rejectLarge = false;
            storage.setItem('large', 'durable-new');
            expect(backingStorage.getItem('large')).toBe('durable-new');
            expect(storage.getItem('large')).toBe('durable-new');
        } finally {
            if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
            else delete (globalThis as { window?: unknown }).window;
        }
    });

    test('removes malformed persisted JSON and permits later recovery', async () => {
        const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        const backingStorage = createFakeStorage();
        backingStorage.setItem('broken', '{not-json');
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { localStorage: backingStorage, sessionStorage: createFakeStorage(), addEventListener: () => {} },
        });

        try {
            const { createDeferredSafeJSONStorage } = await importSafeStorage();
            const storage = createDeferredSafeJSONStorage<{ value: string }>();
            if (!storage) throw new Error('storage unavailable');

            expect(storage.getItem('broken')).toBeNull();
            expect(backingStorage.getItem('broken')).toBeNull();
            storage.setItem('broken', { state: { value: 'recovered' } });
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(storage.getItem('broken')).toEqual({ state: { value: 'recovered' } });
        } finally {
            if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
            else delete (globalThis as { window?: unknown }).window;
        }
    });
});
