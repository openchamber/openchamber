import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { opencodeClient, type ProjectFileSearchHit } from '@/lib/opencode/client';

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 40;
const DEFAULT_SEARCH_LIMIT = 60;

interface FileSearchCacheEntry {
  files: ProjectFileSearchHit[];
  timestamp: number;
}

interface FileSearchStoreState {
  cache: Record<string, FileSearchCacheEntry>;
  cacheKeys: string[];
  inFlight: Record<string, Promise<ProjectFileSearchHit[]>>;
  searchFiles: (
    directory: string,
    query: string,
    limit?: number,
    options?: { includeHidden?: boolean; respectGitignore?: boolean; type?: 'file' | 'directory' }
  ) => Promise<ProjectFileSearchHit[]>;
  invalidateDirectory: (directory?: string | null) => void;
}

const buildCacheKey = (
  directory: string,
  query: string,
  limit: number,
  includeHidden: boolean,
  respectGitignore: boolean,
  type: 'file' | 'directory'
) => {
  const normalizedDirectory = directory.trim();
  const normalizedQuery = query.trim().toLowerCase();
  return `${normalizedDirectory}::${normalizedQuery}::${limit}::${includeHidden ? '1' : '0'}::${respectGitignore ? '1' : '0'}::${type}`;
};

export const useFileSearchStore = create<FileSearchStoreState>()(
  devtools(
    (set, get) => ({
      cache: {},
      cacheKeys: [],
      inFlight: {},
      async searchFiles(directory, query, limit = DEFAULT_SEARCH_LIMIT, options) {
        if (!directory || directory.trim().length === 0) {
          return [];
        }

        const normalizedDirectory = directory.trim();
        const normalizedQuery = typeof query === 'string' ? query.trim() : '';
        const includeHidden = Boolean(options?.includeHidden);
        const respectGitignore = options?.respectGitignore ?? true;
        const type = options?.type === 'directory' ? 'directory' : 'file';
        const key = buildCacheKey(normalizedDirectory, normalizedQuery, limit, includeHidden, respectGitignore, type);
        const now = Date.now();
        const cached = get().cache[key];

        if (cached && now - cached.timestamp < CACHE_TTL_MS) {
          return cached.files;
        }

        const inflight = get().inFlight[key];
        if (inflight) {
          return inflight;
        }

        const searchPromise = opencodeClient
          .searchFiles(normalizedQuery, {
            directory: normalizedDirectory,
            limit,
            includeHidden,
            respectGitignore,
            dirs: type !== 'file',
            type,
          })
          .then((files) => {
            set((state) => {
              const nextCache = { ...state.cache, [key]: { files, timestamp: Date.now() } };
              const nextKeys = state.cacheKeys.filter((cacheKey) => cacheKey !== key);
              nextKeys.push(key);

              while (nextKeys.length > MAX_CACHE_ENTRIES) {
                const oldestKey = nextKeys.shift();
                if (oldestKey) {
                  delete nextCache[oldestKey];
                }
              }

              return {
                cache: nextCache,
                cacheKeys: nextKeys,
              };
            });
            return files;
          })
          .finally(() => {
            set((state) => {
              const nextInFlight = { ...state.inFlight };
              delete nextInFlight[key];
              return { inFlight: nextInFlight };
            });
          });

        set((state) => ({
          inFlight: {
            ...state.inFlight,
            [key]: searchPromise,
          },
        }));

        return searchPromise;
      },
      invalidateDirectory(directory) {
        if (!directory || directory.trim().length === 0) {
          set({ cache: {}, cacheKeys: [], inFlight: {} });
          return;
        }

        const normalizedDirectory = directory.trim();
        const prefix = `${normalizedDirectory}::`;

        set((state) => {
          const nextCache = { ...state.cache };
          const nextKeys = state.cacheKeys.filter((cacheKey) => {
            if (cacheKey.startsWith(prefix)) {
              delete nextCache[cacheKey];
              return false;
            }
            return true;
          });

          const nextInFlightEntries = Object.entries(state.inFlight).filter(
            ([key]) => !key.startsWith(prefix)
          );
          const nextInFlight = Object.fromEntries(nextInFlightEntries);

          return {
            cache: nextCache,
            cacheKeys: nextKeys,
            inFlight: nextInFlight,
          };
        });
      },
    }),
    {
      name: 'file-search-store',
    }
  )
);
