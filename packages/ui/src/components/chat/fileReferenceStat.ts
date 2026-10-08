import { z } from 'zod';

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

const fileNameLookupSchema = z.object({ paths: z.array(z.string()) });

const FILE_NAME_LOOKUP_CACHE = new Map<string, Promise<string | null>>();
const FILE_NAME_LOOKUP_CACHE_MAX = 200;

/**
 * The one workspace file called `name`, for a reference an agent wrote
 * without its folder (`Renderer.tsx:42`). Answered from git's index in one
 * call per name; null when no file or several files carry the name, so an
 * ambiguous reference stays plain text instead of opening a guess.
 */
export const findUniqueFileByName = (name: string, effectiveDirectory: string): Promise<string | null> => {
  if (!name || !effectiveDirectory || isVSCodeRuntime()) return Promise.resolve(null);
  const cacheKey = statCacheKey(effectiveDirectory, name);
  const cached = FILE_NAME_LOOKUP_CACHE.get(cacheKey);
  if (cached) return cached;

  const request = runtimeFetch(`/api/fs/find-by-name?name=${encodeURIComponent(name)}`, {
    method: 'GET',
    cache: 'no-store',
    headers: { 'x-opencode-directory': effectiveDirectory },
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const parsed = fileNameLookupSchema.safeParse(await response.json().catch(() => null));
      const paths = parsed.success ? parsed.data.paths : [];
      return paths.length === 1 ? paths[0] : null;
    })
    .catch(() => null);

  while (FILE_NAME_LOOKUP_CACHE.size >= FILE_NAME_LOOKUP_CACHE_MAX) {
    const oldest = FILE_NAME_LOOKUP_CACHE.keys().next();
    if (oldest.done) break;
    FILE_NAME_LOOKUP_CACHE.delete(oldest.value);
  }
  FILE_NAME_LOOKUP_CACHE.set(cacheKey, request);
  return request;
};
