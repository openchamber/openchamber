import { describe, expect, test } from 'bun:test';

const importSafeStorage = async () => {
    return await import(`./safeStorage.ts?test=${Date.now()}-${Math.random()}`) as typeof import('./safeStorage');
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
});
