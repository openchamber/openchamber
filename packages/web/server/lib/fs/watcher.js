import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);
const callbackSchema = z.function();
const errorCodeSchema = z.object({ code: z.string() });

const asDirectory = (value, path) => {
  const parsed = nonEmptyStringSchema.safeParse(value);
  return parsed.success ? path.resolve(parsed.data) : '';
};

const watcherKey = (directory, platform) => (
  platform === 'win32' ? directory.toLowerCase() : directory
);

export const createFsWatcherRuntime = ({
  watch = nodeFs.watch,
  path = nodePath,
  platform = process.platform,
  debounceMs = 250,
  maxWaitMs = 1000,
  logger = console,
} = {}) => {
  const entries = new Map();
  let nextSubscriberId = 1;

  const closeEntry = (entry) => {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
    if (entry.maxWaitTimer) {
      clearTimeout(entry.maxWaitTimer);
      entry.maxWaitTimer = null;
    }
    entries.delete(entry.key);
    try {
      entry.watcher.close();
    } catch {
    }
  };

  const flush = (entry) => {
    if (entry.closed) return;
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
    if (entry.maxWaitTimer) {
      clearTimeout(entry.maxWaitTimer);
      entry.maxWaitTimer = null;
    }
    if (!entry.dirty) return;
    entry.dirty = false;

    for (const subscriber of entry.subscribers.values()) {
      try {
        subscriber.onChange({ directory: subscriber.requestedDirectory });
      } catch {
      }
    }
  };

  const scheduleFlush = (entry) => {
    if (entry.closed) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => flush(entry), debounceMs);
    entry.debounceTimer.unref?.();
    if (!entry.maxWaitTimer) {
      entry.maxWaitTimer = setTimeout(() => flush(entry), maxWaitMs);
      entry.maxWaitTimer.unref?.();
    }
  };

  const createEntry = (canonicalDirectory, key) => {
    const entry = {
      key,
      canonicalDirectory,
      watcher: null,
      subscribers: new Map(),
      dirty: false,
      debounceTimer: null,
      maxWaitTimer: null,
      closed: false,
    };

    entry.watcher = watch(canonicalDirectory, { persistent: false }, () => {
      entry.dirty = true;
      scheduleFlush(entry);
    });
    entry.watcher.on?.('error', (error) => {
      entry.dirty = true;
      flush(entry);
      for (const subscriber of entry.subscribers.values()) {
        try {
          subscriber.onError?.(error);
        } catch {
        }
      }
      const parsedError = errorCodeSchema.safeParse(error);
      const errorCode = parsedError.success ? parsedError.data.code : '';
      logger.warn?.(`[fs-watch] watcher stopped${errorCode ? ` (${errorCode})` : ''}`);
      closeEntry(entry);
    });

    entries.set(key, entry);
    return entry;
  };

  const subscribe = ({ canonicalDirectory, requestedDirectory, onChange, onError }) => {
    const canonical = asDirectory(canonicalDirectory, path);
    const requested = asDirectory(requestedDirectory, path);
    if (!canonical || !requested) {
      throw new Error('Filesystem watcher directories are required');
    }
    if (!callbackSchema.safeParse(onChange).success) {
      throw new Error('Filesystem watcher onChange callback is required');
    }

    const key = watcherKey(canonical, platform);
    const entry = entries.get(key) ?? createEntry(canonical, key);
    const subscriberId = nextSubscriberId;
    nextSubscriberId += 1;
    entry.subscribers.set(subscriberId, {
      requestedDirectory: requested,
      onChange,
      onError,
    });

    let closed = false;
    return {
      close() {
        if (closed) return;
        closed = true;
        entry.subscribers.delete(subscriberId);
        if (entry.subscribers.size === 0 && entries.get(key) === entry) {
          closeEntry(entry);
        }
      },
    };
  };

  return {
    subscribe,
    close() {
      for (const entry of Array.from(entries.values())) {
        closeEntry(entry);
      }
    },
  };
};
