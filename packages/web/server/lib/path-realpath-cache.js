export const createRealpathCache = ({
  realpath,
  successTtlMs = 600_000,
  failureTtlMs = 60_000,
  maxEntries = 256,
  fallbackOnError = false,
  now = () => Date.now(),
} = {}) => {
  const cache = new Map();
  const resolveRealpath = typeof realpath === 'function' ? realpath : null;

  const prune = () => {
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      cache.delete(oldestKey);
    }
  };

  const remember = (key, entry, ttlMs) => {
    if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
      return;
    }
    cache.delete(key);
    cache.set(key, { ...entry, expiresAt: now() + Math.max(0, ttlMs) });
    prune();
  };

  const resolve = async (value) => {
    if (typeof value !== 'string' || value.length === 0 || !resolveRealpath) {
      return value;
    }

    const cached = cache.get(value);
    const currentTime = now();
    if (cached?.promise) {
      return cached.promise;
    }
    if (cached && cached.expiresAt > currentTime) {
      cache.delete(value);
      cache.set(value, cached);
      if (cached.error) {
        if (fallbackOnError) {
          return value;
        }
        throw cached.error;
      }
      return cached.value;
    }
    if (cached) {
      cache.delete(value);
    }

    const promise = Promise.resolve()
      .then(() => resolveRealpath(value))
      .then((resolved) => {
        const next = typeof resolved === 'string' && resolved.length > 0 ? resolved : value;
        remember(value, { value: next }, successTtlMs);
        return next;
      })
      .catch((error) => {
        remember(value, { value, error }, failureTtlMs);
        if (!fallbackOnError) {
          throw error;
        }
        return value;
      });

    if (Number.isFinite(maxEntries) && maxEntries > 0) {
      cache.delete(value);
      cache.set(value, { value, expiresAt: 0, promise });
      prune();
    }

    return promise;
  };

  return {
    resolve,
    clear: () => cache.clear(),
    size: () => cache.size,
  };
};
