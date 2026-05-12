import { createJSONStorage, type PersistStorage, type StorageValue } from 'zustand/middleware';
import { getSafeStorage, getSafeSessionStorage } from './safeStorage';

// ---------------------------------------------------------------------------
// Singleton beforeunload flush registry
// ---------------------------------------------------------------------------

const pendingFlushes = new Map<string, () => void>();
let listenerRegistered = false;

function ensureBeforeUnloadListener() {
    if (listenerRegistered || typeof window === 'undefined') return;
    window.addEventListener('beforeunload', () => {
        for (const flush of pendingFlushes.values()) flush();
        pendingFlushes.clear();
    });
    listenerRegistered = true;
}

function registerPendingFlush(key: string, flush: () => void) {
    ensureBeforeUnloadListener();
    pendingFlushes.set(key, flush);
}

function unregisterPendingFlush(key: string) {
    pendingFlushes.delete(key);
}

// ---------------------------------------------------------------------------
// Debounced JSON storage factory
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for `createJSONStorage(() => getSafeStorage())` that
 * debounces writes by {@link debounceMs} (default 300 ms).
 *
 * - `getItem` passes straight through (critical for hydration).
 * - `setItem` is debounced; only the latest value is written.
 * - All pending writes are flushed synchronously on `beforeunload`.
 * - Each invocation creates an independent closure with its own timer.
 */
export function createDebouncedJSONStorage<S>(
    getStorage: () => Storage = getSafeStorage,
    debounceMs = 300,
): PersistStorage<S> | undefined {
    const base = createJSONStorage<S>(getStorage);
    if (!base) return undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingName: string | null = null;
    let pendingValue: StorageValue<S> | null = null;

    const flushNow = () => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        if (pendingName !== null && pendingValue !== null) {
            const name = pendingName;
            const value = pendingValue;
            pendingName = null;
            pendingValue = null;
            unregisterPendingFlush(name);
            base.setItem(name, value);
        }
    };

    return {
        getItem: (name) => base.getItem(name),

        setItem: (name: string, value: StorageValue<S>) => {
            pendingName = name;
            pendingValue = value;

            if (timer !== undefined) clearTimeout(timer);
            registerPendingFlush(name, flushNow);
            timer = setTimeout(flushNow, debounceMs);
        },

        removeItem: (name: string) => {
            // Cancel any pending write for this key before removing.
            if (pendingName === name) {
                if (timer !== undefined) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                pendingName = null;
                pendingValue = null;
                unregisterPendingFlush(name);
            }
            base.removeItem(name);
        },
    };
}

/** Convenience shorthand for session-storage backed stores. */
export function createDebouncedSessionJSONStorage<S>(debounceMs = 300): PersistStorage<S> | undefined {
    return createDebouncedJSONStorage<S>(getSafeSessionStorage, debounceMs);
}
