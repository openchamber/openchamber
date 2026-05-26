/**
 * Debounced localStorage wrapper to reduce I/O blocking.
 * Buffers writes and flushes asynchronously to prevent main thread blocking.
 */

const DEBOUNCE_MS = 500;

export interface DebouncedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  flush(): void;
  clearCache(): void;
}

export function createDebouncedStorage(): DebouncedStorage {
  const cache = new Map<string, string>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    getItem: (key: string): string | null => {
      // Check in-memory cache first for fastest reads
      if (cache.has(key)) {
        return cache.get(key)!;
      }
      // Fall back to localStorage
      return window.localStorage.getItem(key);
    },

    setItem: (key: string, value: string): void => {
      // Immediately update in-memory cache
      cache.set(key, value);
      // Cancel any pending write for this key
      const existingTimeout = pending.get(key);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }
      // Schedule actual localStorage write
      const timeout = window.setTimeout(() => {
        try {
          window.localStorage.setItem(key, value);
        } catch (error) {
          console.warn('[debounced-storage] Failed to write to localStorage:', error);
        }
        pending.delete(key);
      }, DEBOUNCE_MS);
      pending.set(key, timeout);
    },

    removeItem: (key: string): void => {
      // Immediately update in-memory cache
      cache.delete(key);
      // Cancel any pending write for this key
      const existingTimeout = pending.get(key);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
        pending.delete(key);
      }
      // Remove from localStorage
      try {
        window.localStorage.removeItem(key);
      } catch (error) {
        console.warn('[debounced-storage] Failed to remove from localStorage:', error);
      }
    },

    flush: (): void => {
      // Immediately write all pending items to localStorage
      for (const [key, timeout] of pending) {
        clearTimeout(timeout);
        const value = cache.get(key);
        if (value !== undefined) {
          try {
            window.localStorage.setItem(key, value);
          } catch (error) {
            console.warn('[debounced-storage] Failed to flush to localStorage:', error);
          }
        }
      }
      pending.clear();
    },

    clearCache: (): void => {
      cache.clear();
    },
  };
}

// Pre-configured instances for different use cases
export const configStorage = createDebouncedStorage();
export const appStorage = createDebouncedStorage();