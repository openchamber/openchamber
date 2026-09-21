import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';

import { normalizeReferencePath } from './fileReferenceParser';

const FILE_REFERENCE_STAT_CONCURRENCY = 4;
const FILE_REFERENCE_STAT_CACHE_MAX = 1000;
const VSCODE_FILE_REFERENCE_STAT_CACHE_MAX = 200;

const FILE_REFERENCE_STAT_CACHE = new Map<string, Promise<boolean>>();
let activeFileReferenceStatCount = 0;
const pendingFileReferenceStats: Array<() => void> = [];

const getFileReferenceStatCacheMax = (): number => (
  isVSCodeRuntime() ? VSCODE_FILE_REFERENCE_STAT_CACHE_MAX : FILE_REFERENCE_STAT_CACHE_MAX
);

// NUL cannot occur in a real path, so a directory-qualified key cannot collide
// with a differently scoped entry.
const statCacheKey = (directory: string, normalizedPath: string): string => `${directory}\u0000${normalizedPath}`;

export const fileReferenceExists = (resolvedPath: string, effectiveDirectory: string): Promise<boolean> => {
  const normalizedPath = normalizeReferencePath(resolvedPath);
  if (!normalizedPath) {
    return Promise.resolve(false);
  }

  const cacheKey = statCacheKey(effectiveDirectory, normalizedPath);
  const cached = FILE_REFERENCE_STAT_CACHE.get(cacheKey);
  if (cached) {
    FILE_REFERENCE_STAT_CACHE.delete(cacheKey);
    FILE_REFERENCE_STAT_CACHE.set(cacheKey, cached);
    return cached;
  }

  const request = new Promise<boolean>((resolve) => {
    const run = () => {
      activeFileReferenceStatCount += 1;
      void runtimeFetch(`/api/fs/stat?path=${encodeURIComponent(normalizedPath)}&optional=true`, {
        method: 'GET',
        cache: 'no-store',
        // The stat route resolves the workspace from this header. Without it
        // the server falls back to the browsed lastDirectory, which rejects
        // session-local files with 400 whenever the two directories differ.
        headers: effectiveDirectory ? { 'x-opencode-directory': effectiveDirectory } : undefined,
      })
        .then(async (response) => {
          if (!response.ok) {
            resolve(false);
            return;
          }
          const payload = await response.json().catch(() => null) as { exists?: unknown } | null;
          resolve(payload?.exists !== false);
        })
        .catch(() => resolve(false))
        .finally(() => {
          activeFileReferenceStatCount = Math.max(0, activeFileReferenceStatCount - 1);
          pendingFileReferenceStats.shift()?.();
        });
    };

    if (activeFileReferenceStatCount < FILE_REFERENCE_STAT_CONCURRENCY) {
      run();
      return;
    }

    pendingFileReferenceStats.push(run);
  });

  const maxCacheEntries = getFileReferenceStatCacheMax();
  while (FILE_REFERENCE_STAT_CACHE.size >= maxCacheEntries) {
    const oldest = FILE_REFERENCE_STAT_CACHE.keys().next().value;
    if (typeof oldest !== 'string') {
      break;
    }
    FILE_REFERENCE_STAT_CACHE.delete(oldest);
  }
  FILE_REFERENCE_STAT_CACHE.set(cacheKey, request);
  return request;
};
