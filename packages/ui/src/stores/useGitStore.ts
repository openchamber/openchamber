import React from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type {
  GitStatus,
  GitBranch,
  GitLogResponse,
  GitIdentitySummary,
} from '@/lib/api/types';

const LOG_STALE_THRESHOLD = 10000;
const REPO_CHECK_STALE_THRESHOLD = 60_000;
const STATUS_STALE_THRESHOLD = 5_000;
const BRANCHES_STALE_THRESHOLD = 30_000;
const IDENTITY_STALE_THRESHOLD = 60_000;
const DIFF_PREFETCH_MAX_FILES = 25;
const DIFF_PREFETCH_FOCUS_MAX_FILES = 40;
const DIFF_PREFETCH_CONCURRENCY = 2;
const DIFF_PREFETCH_TIMEOUT_MS = 15000;
const DIFF_PREFETCH_LARGE_FILE_THRESHOLD = 500; // skip prefetch for files with >500 changed lines

// Diff cache limits to prevent memory bloat with many modified files
const DIFF_CACHE_MAX_ENTRIES = 30;
const DIFF_CACHE_MAX_TOTAL_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

interface DirectoryGitState {
  isGitRepo: boolean | null;
  status: GitStatus | null;
  branches: GitBranch | null;
  log: GitLogResponse | null;
  identity: GitIdentitySummary | null;
  diffCache: Map<string, { original: string; modified: string; fetchedAt: number; isBinary?: boolean }>;
  lastRepoCheckAt: number;
  lastStatusFetch: number;
  lastStatusChange: number;
  lastLogFetch: number;
  lastBranchesFetch: number;
  lastIdentityFetch: number;
  logMaxCount: number;
  isLoadingStatus: boolean;
  isLoadingLog: boolean;
  isLoadingBranches: boolean;
  isLoadingIdentity: boolean;
}

interface GitStore {

  directories: Map<string, DirectoryGitState>;

  activeDirectory: string | null;

  setActiveDirectory: (directory: string | null) => void;
  getDirectoryState: (directory: string) => DirectoryGitState | null;

  fetchStatus: (directory: string, git: GitAPI, options?: { silent?: boolean; mode?: 'light' }) => Promise<boolean>;
  fetchBranches: (directory: string, git: GitAPI) => Promise<void>;
  fetchLog: (directory: string, git: GitAPI, maxCount?: number) => Promise<void>;
  fetchIdentity: (directory: string, git: GitAPI) => Promise<void>;
  fetchAll: (directory: string, git: GitAPI, options?: { force?: boolean; silentIfCached?: boolean }) => Promise<void>;

  ensureStatus: (directory: string, git: GitAPI) => Promise<void>;
  ensureAll: (directory: string, git: GitAPI) => Promise<void>;

  getDiff: (directory: string, filePath: string) => { original: string; modified: string; fetchedAt: number; isBinary?: boolean } | null;
  setDiff: (directory: string, filePath: string, diff: { original: string; modified: string; isBinary?: boolean }) => void;
  clearDiffCache: (directory: string) => void;
  fetchAllDiffs: (directory: string, git: GitAPI) => Promise<void>;
  prefetchDiffs: (directory: string, git: GitAPI, filePaths: string[], options?: { maxFiles?: number }) => Promise<void>;

  setLogMaxCount: (directory: string, maxCount: number) => void;

  refresh: (git: GitAPI, options?: { force?: boolean }) => Promise<void>;
}

interface GitFileDiffResponse {
  original: string;
  modified: string;
  path: string;
  isBinary?: boolean;
}

interface GitAPI {
  checkIsGitRepository: (directory: string) => Promise<boolean>;
  getGitStatus: (directory: string, options?: { mode?: 'light' }) => Promise<GitStatus>;
  getGitBranches: (directory: string) => Promise<GitBranch>;
  getGitLog: (directory: string, options?: { maxCount?: number }) => Promise<GitLogResponse>;
  getCurrentGitIdentity: (directory: string) => Promise<GitIdentitySummary | null>;
  getGitFileDiff: (directory: string, options: { path: string }) => Promise<GitFileDiffResponse>;
}

const inFlightDiffFetchesByDirectory = new Map<string, Set<string>>();
const diffFetchGenerationByDirectory = new Map<string, number>();
const inFlightStatusFetchesByDirectory = new Map<string, Promise<boolean>>();
const inFlightEnsureAllByDirectory = new Map<string, Promise<void>>();

const getDiffFetchGeneration = (directory: string): number =>
  diffFetchGenerationByDirectory.get(directory) ?? 0;

const bumpDiffFetchGeneration = (directory: string): number => {
  const next = getDiffFetchGeneration(directory) + 1;
  diffFetchGenerationByDirectory.set(directory, next);
  return next;
};

const getInFlightDiffs = (directory: string): Set<string> => {
  const existing = inFlightDiffFetchesByDirectory.get(directory);
  if (existing) {
    return existing;
  }
  const created = new Set<string>();
  inFlightDiffFetchesByDirectory.set(directory, created);
  return created;
};

const createEmptyDirectoryState = (): DirectoryGitState => ({
  isGitRepo: null,
  status: null,
  branches: null,
  log: null,
  identity: null,
  diffCache: new Map(),
  lastRepoCheckAt: 0,
  lastStatusFetch: 0,
  lastStatusChange: 0,
  lastLogFetch: 0,
  lastBranchesFetch: 0,
  lastIdentityFetch: 0,
  logMaxCount: 25,
  isLoadingStatus: false,
  isLoadingLog: false,
  isLoadingBranches: false,
  isLoadingIdentity: false,
});

// LRU eviction helper for diff cache
const evictDiffCacheIfNeeded = (
  diffCache: Map<string, { original: string; modified: string; fetchedAt: number; isBinary?: boolean }>,
  maxEntries: number = DIFF_CACHE_MAX_ENTRIES,
  maxTotalSize: number = DIFF_CACHE_MAX_TOTAL_SIZE_BYTES
): Map<string, { original: string; modified: string; fetchedAt: number; isBinary?: boolean }> => {
  // Calculate total size
  let totalSize = 0;
  for (const entry of diffCache.values()) {
    totalSize += (entry.original?.length ?? 0) + (entry.modified?.length ?? 0);
  }

  // If within limits, return as-is
  if (diffCache.size <= maxEntries && totalSize <= maxTotalSize) {
    return diffCache;
  }

  // Sort entries by fetchedAt (oldest first) for LRU eviction
  const entries = Array.from(diffCache.entries())
    .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);

  const newCache = new Map<string, { original: string; modified: string; fetchedAt: number; isBinary?: boolean }>();
  let newTotalSize = 0;

  // Keep entries from newest to oldest until limits are reached
  for (let i = entries.length - 1; i >= 0; i--) {
    const [path, entry] = entries[i];
    const entrySize = (entry.original?.length ?? 0) + (entry.modified?.length ?? 0);

    if (newCache.size >= maxEntries) break;
    if (newTotalSize + entrySize > maxTotalSize && newCache.size > 0) continue;

    newCache.set(path, entry);
    newTotalSize += entrySize;
  }

  return newCache;
};

const haveDiffStatsChanged = (
  previous?: GitStatus['diffStats'],
  next?: GitStatus['diffStats']
): boolean => {
  if (!previous && !next) return false;
  if (!previous || !next) return true;

  const paths = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const path of paths) {
    const prevEntry = previous[path];
    const nextEntry = next[path];

    if (!prevEntry && !nextEntry) continue;
    if (!prevEntry || !nextEntry) return true;
    if (
      prevEntry.insertions !== nextEntry.insertions ||
      prevEntry.deletions !== nextEntry.deletions
    ) {
      return true;
    }
  }

  return false;
};

const hasStatusChanged = (oldStatus: GitStatus | null, newStatus: GitStatus | null): boolean => {
  if (!oldStatus && !newStatus) return false;
  if (!oldStatus || !newStatus) return true;

  const oldFiles = oldStatus.files ?? [];
  const newFiles = newStatus.files ?? [];

  if (oldFiles.length !== newFiles.length) return true;
  if (oldStatus.ahead !== newStatus.ahead) return true;
  if (oldStatus.behind !== newStatus.behind) return true;
  if (oldStatus.current !== newStatus.current) return true;
  if (oldStatus.tracking !== newStatus.tracking) return true;
  if (oldStatus.isClean !== newStatus.isClean) return true;

  const oldPaths = new Set(oldFiles.map(f => `${f.path}:${f.index}:${f.working_dir}`));
  for (const file of newFiles) {
    if (!oldPaths.has(`${file.path}:${file.index}:${file.working_dir}`)) {
      return true;
    }
  }

  // Skip diffStats comparison when light mode omits them (undefined)
  if (newStatus.diffStats !== undefined && haveDiffStatsChanged(oldStatus.diffStats, newStatus.diffStats)) return true;

  return false;
};

const getChangedFilePaths = (oldStatus: GitStatus | null, newStatus: GitStatus | null): Set<string> => {
  const changed = new Set<string>();
  if (!newStatus) return changed;

  const oldFiles = oldStatus?.files ?? [];
  const newFiles = newStatus.files ?? [];

  const oldFileMap = new Map(oldFiles.map((f) => [f.path, f] as const));
  const newFileMap = new Map(newFiles.map((f) => [f.path, f] as const));

  const allFilePaths = new Set<string>([...oldFileMap.keys(), ...newFileMap.keys()]);
  for (const filePath of allFilePaths) {
    const oldFile = oldFileMap.get(filePath);
    const newFile = newFileMap.get(filePath);

    // Added/removed/renamed
    if (!oldFile || !newFile) {
      changed.add(filePath);
      continue;
    }

    // Index/worktree state changed (indicates actual content/state changed)
    if (oldFile.index !== newFile.index || oldFile.working_dir !== newFile.working_dir) {
      changed.add(filePath);
      continue;
    }
  }

  // Only compare diffStats when light mode provides them (non-undefined)
  if (newStatus.diffStats !== undefined) {
    const oldStats = oldStatus?.diffStats ?? {};
    const newStats = newStatus.diffStats ?? {};
    const allStatPaths = new Set<string>([...Object.keys(oldStats), ...Object.keys(newStats)]);

    for (const filePath of allStatPaths) {
      const oldEntry = oldStats[filePath];
      const newEntry = newStats[filePath];

      if (!oldEntry || !newEntry) {
        changed.add(filePath);
        continue;
      }

      if (oldEntry.insertions !== newEntry.insertions || oldEntry.deletions !== newEntry.deletions) {
        changed.add(filePath);
      }
    }
  }

  return changed;
};

export const useGitStore = create<GitStore>()(
  devtools(
    (set, get) => ({
      directories: new Map(),
      activeDirectory: null,

      setActiveDirectory: (directory) => {
        const { activeDirectory, directories } = get();
        if (activeDirectory === directory) return;

        if (activeDirectory) {
          bumpDiffFetchGeneration(activeDirectory);
        }
        if (directory) {
          bumpDiffFetchGeneration(directory);
        }

        if (directory && !directories.has(directory)) {
          const newDirectories = new Map(directories);
          newDirectories.set(directory, createEmptyDirectoryState());
          set({ activeDirectory: directory, directories: newDirectories });
        } else {
          set({ activeDirectory: directory });
        }
      },

      getDirectoryState: (directory) => {
        return get().directories.get(directory) ?? null;
      },

      fetchStatus: async (directory, git, options = {}) => {
        const existing = inFlightStatusFetchesByDirectory.get(directory);
        if (existing) {
          return existing;
        }

        const fetchPromise = (async () => {
          const { silent = false } = options;
          const { directories } = get();
          let dirState = directories.get(directory);

          if (!dirState) {
            dirState = createEmptyDirectoryState();
          }

          if (!silent) {
            const newDirectories = new Map(get().directories);
            const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
            newDirectories.set(directory, { ...d, isLoadingStatus: true });
            set({ directories: newDirectories });
          }

          let statusChanged = false;

          try {
            const now = Date.now();
            const shouldProbeRepository =
              dirState.isGitRepo !== true ||
              now - (dirState.lastRepoCheckAt || 0) > REPO_CHECK_STALE_THRESHOLD;

            let isRepo = dirState.isGitRepo === true;
            if (shouldProbeRepository) {
              isRepo = await git.checkIsGitRepository(directory);
            }

            if (!isRepo) {
              const newDirectories = new Map(get().directories);
              const currentDirState = newDirectories.get(directory) ?? dirState;
              newDirectories.set(directory, {
                ...currentDirState,
                isGitRepo: false,
                status: null,
                isLoadingStatus: false,
                lastRepoCheckAt: now,
                lastStatusFetch: now,
              });
              set({ directories: newDirectories });
              return false;
            }

            const newStatus = await git.getGitStatus(directory, options.mode ? { mode: options.mode } : undefined);

            if (hasStatusChanged(dirState.status, newStatus)) {
              statusChanged = true;
              const newDirectories = new Map(get().directories);
              const currentDirState = newDirectories.get(directory) ?? createEmptyDirectoryState();

              const changedPaths = getChangedFilePaths(currentDirState.status, newStatus);

              const oldPaths = new Set((currentDirState.status?.files ?? []).map((f) => f.path));
              const newPaths = new Set((newStatus.files ?? []).map((f) => f.path));

              const nextDiffCache = new Map(currentDirState.diffCache);

              // Drop cache for removed files
              for (const oldPath of oldPaths) {
                if (!newPaths.has(oldPath)) {
                  nextDiffCache.delete(oldPath);
                }
              }

              // Drop cache for files whose state/content changed
              for (const filePath of changedPaths) {
                nextDiffCache.delete(filePath);
              }

              const hasFileContentChange = changedPaths.size > 0;
              if (hasFileContentChange) {
                bumpDiffFetchGeneration(directory);
              }

              // Preserve diffStats from previous status when light mode returns none
              const mergedStatus = newStatus.diffStats === undefined && currentDirState.status?.diffStats
                ? { ...newStatus, diffStats: currentDirState.status.diffStats }
                : newStatus;

              newDirectories.set(directory, {
                ...currentDirState,
                isGitRepo: true,
                status: mergedStatus,
                diffCache: nextDiffCache,
                lastRepoCheckAt: shouldProbeRepository ? now : currentDirState.lastRepoCheckAt,
                lastStatusFetch: Date.now(),
                lastStatusChange: hasFileContentChange ? Date.now() : currentDirState.lastStatusChange,
              });
              set({ directories: newDirectories });
            } else {

              const newDirectories = new Map(get().directories);
              const currentDirState = newDirectories.get(directory) ?? createEmptyDirectoryState();
              newDirectories.set(directory, {
                ...currentDirState,
                isGitRepo: true,
                lastRepoCheckAt: shouldProbeRepository ? now : currentDirState.lastRepoCheckAt,
                lastStatusFetch: Date.now(),
                lastStatusChange: currentDirState.lastStatusChange,
              });
              set({ directories: newDirectories });
            }
          } catch (error) {
            console.error('Failed to fetch git status:', error);
          } finally {
            if (!silent) {
              const newDirectories = new Map(get().directories);
              const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
              newDirectories.set(directory, { ...d, isLoadingStatus: false });
              set({ directories: newDirectories });
            }
          }

          return statusChanged;
        })();

        inFlightStatusFetchesByDirectory.set(directory, fetchPromise);

        try {
          return await fetchPromise;
        } finally {
          if (inFlightStatusFetchesByDirectory.get(directory) === fetchPromise) {
            inFlightStatusFetchesByDirectory.delete(directory);
          }
        }
      },

      fetchBranches: async (directory, git) => {
        {
          const newDirectories = new Map(get().directories);
          const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, { ...d, isLoadingBranches: true });
          set({ directories: newDirectories });
        }

        try {
          const branches = await git.getGitBranches(directory);
          const newDirectories = new Map(get().directories);
          const dirState = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, { ...dirState, branches, isLoadingBranches: false, lastBranchesFetch: Date.now() });
          set({ directories: newDirectories });
        } catch (error) {
          console.error('Failed to fetch git branches:', error);
          const newDirectories = new Map(get().directories);
          const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, { ...d, isLoadingBranches: false });
          set({ directories: newDirectories });
        }
      },

      fetchLog: async (directory, git, maxCount) => {
        const { directories } = get();
        const dirState = directories.get(directory);
        const effectiveMaxCount = maxCount ?? dirState?.logMaxCount ?? 25;

        {
          const newDirectories = new Map(get().directories);
          const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, { ...d, isLoadingLog: true });
          set({ directories: newDirectories });
        }

        try {
          const log = await git.getGitLog(directory, { maxCount: effectiveMaxCount });
          const newDirectories = new Map(get().directories);
          const currentDirState = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, {
            ...currentDirState,
            log,
            isLoadingLog: false,
            lastLogFetch: Date.now(),
            logMaxCount: effectiveMaxCount,
          });
          set({ directories: newDirectories });
        } catch (error) {
          console.error('Failed to fetch git log:', error);
          const newDirectories = new Map(get().directories);
          const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, { ...d, isLoadingLog: false });
          set({ directories: newDirectories });
        }
      },

      fetchIdentity: async (directory, git) => {
        {
          const newDirectories = new Map(get().directories);
          const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, { ...d, isLoadingIdentity: true });
          set({ directories: newDirectories });
        }

        try {
          const identity = await git.getCurrentGitIdentity(directory);
          const newDirectories = new Map(get().directories);
          const dirState = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, { ...dirState, identity, isLoadingIdentity: false, lastIdentityFetch: Date.now() });
          set({ directories: newDirectories });
        } catch (error) {
          console.error('Failed to fetch git identity:', error);
          const newDirectories = new Map(get().directories);
          const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, { ...d, isLoadingIdentity: false });
          set({ directories: newDirectories });
        }
      },

      fetchAll: async (directory, git, options = {}) => {
        const { directories } = get();
        let dirState = directories.get(directory);

        if (!dirState) {
          dirState = createEmptyDirectoryState();
          const newDirectories = new Map(directories);
          newDirectories.set(directory, dirState);
          set({ directories: newDirectories });
        }

        const { force = false, silentIfCached = false } = options;
        const now = Date.now();

        await get().fetchStatus(directory, git, {
          silent: silentIfCached && Boolean(dirState?.status),
        });

        const updatedDirState = get().directories.get(directory);
        if (!updatedDirState?.isGitRepo) return;

        await get().fetchBranches(directory, git);

        const logAge = now - (updatedDirState.lastLogFetch || 0);
        if (force || logAge > LOG_STALE_THRESHOLD || !updatedDirState.log) {
          await get().fetchLog(directory, git);
        }

        await get().fetchIdentity(directory, git);

        // Diff prefetch deferred — triggered on-demand when Git tab opens (GitView reactive prefetch)

      },

      getDiff: (directory, filePath) => {
        const dirState = get().directories.get(directory);
        return dirState?.diffCache.get(filePath) ?? null;
      },

      setDiff: (directory, filePath, diff) => {
        const newDirectories = new Map(get().directories);
        const dirState = newDirectories.get(directory) ?? createEmptyDirectoryState();
        const newDiffCache = new Map(dirState.diffCache);
        newDiffCache.set(filePath, { ...diff, fetchedAt: Date.now() });
        // Apply LRU eviction to prevent memory bloat
        const evictedCache = evictDiffCacheIfNeeded(newDiffCache);
        newDirectories.set(directory, { ...dirState, diffCache: evictedCache });
        set({ directories: newDirectories });
      },

      clearDiffCache: (directory) => {
        bumpDiffFetchGeneration(directory);
        const newDirectories = new Map(get().directories);
        const dirState = newDirectories.get(directory);
        if (dirState) {
          newDirectories.set(directory, { ...dirState, diffCache: new Map() });
          set({ directories: newDirectories });
        }
      },

      fetchAllDiffs: async (directory, git) => {
        const dirState = get().directories.get(directory);
        if (!dirState?.status?.files || dirState.status.files.length === 0) return;

        const limitedFilesToFetch = dirState.status.files
          .map((file) => file.path)
          .slice(0, DIFF_PREFETCH_MAX_FILES);
        await get().prefetchDiffs(directory, git, limitedFilesToFetch, { maxFiles: DIFF_PREFETCH_MAX_FILES });
      },

      prefetchDiffs: async (directory, git, filePaths, options = {}) => {
        const dirState = get().directories.get(directory);
        if (!dirState?.status?.files || dirState.status.files.length === 0 || filePaths.length === 0) return;

        const { maxFiles = DIFF_PREFETCH_FOCUS_MAX_FILES } = options;
        const availablePaths = new Set(dirState.status.files.map((file) => file.path));
        const diffStats = dirState.status.diffStats;
        const inFlight = getInFlightDiffs(directory);

        const dedupedPaths: string[] = [];
        const seen = new Set<string>();
        for (const filePath of filePaths) {
          if (!filePath || seen.has(filePath)) {
            continue;
          }
          seen.add(filePath);
          if (!availablePaths.has(filePath)) {
            continue;
          }
          if (dirState.diffCache.has(filePath)) {
            continue;
          }
          if (inFlight.has(filePath)) {
            continue;
          }
          // Skip large files during prefetch — they'll be fetched on-demand when user clicks
          const stats = diffStats?.[filePath];
          if (stats && (stats.insertions + stats.deletions) > DIFF_PREFETCH_LARGE_FILE_THRESHOLD) {
            continue;
          }
          dedupedPaths.push(filePath);
        }

        const limitedFilePaths = dedupedPaths.slice(0, Math.max(1, maxFiles));
        if (limitedFilePaths.length === 0) return;

        const generation = getDiffFetchGeneration(directory);

        if (typeof document !== 'undefined' && document.hidden) {
          return;
        }

        limitedFilePaths.forEach((path) => inFlight.add(path));

        let nextIndex = 0;
        const results: Array<{ path: string; diff: { original: string; modified: string; isBinary?: boolean } }> = [];

        const takeNext = () => {
          const current = nextIndex;
          nextIndex += 1;
          return current < limitedFilePaths.length ? limitedFilePaths[current] : null;
        };

        const fetchWithTimeout = async (filePath: string) => {
          const fetchPromise = git.getGitFileDiff(directory, { path: filePath });
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Timed out after ${DIFF_PREFETCH_TIMEOUT_MS}ms`)), DIFF_PREFETCH_TIMEOUT_MS);
          });
          const response = await Promise.race([fetchPromise, timeoutPromise]);
          return {
            path: filePath,
            diff: { original: response.original ?? '', modified: response.modified ?? '', isBinary: response.isBinary },
          };
        };

        const worker = async () => {
          for (;;) {
            if (generation !== getDiffFetchGeneration(directory)) {
              return;
            }
            const next = takeNext();
            if (!next) return;
            try {
              results.push(await fetchWithTimeout(next));
            } catch {
              // Ignore individual failures/timeouts during prefetch.
            } finally {
              inFlight.delete(next);
            }
          }
        };

        const workerCount = Math.min(DIFF_PREFETCH_CONCURRENCY, limitedFilePaths.length);
        await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));

        limitedFilePaths.forEach((path) => inFlight.delete(path));

        if (generation !== getDiffFetchGeneration(directory)) {
          return;
        }

        // Update diff cache with results
        const newDirectories = new Map(get().directories);
        const currentDirState = newDirectories.get(directory);
        if (!currentDirState) return;

        const newDiffCache = new Map(currentDirState.diffCache);
        const now = Date.now();

        results.forEach((result) => {
          newDiffCache.set(result.path, {
            ...result.diff,
            fetchedAt: now
          });
        });

        // Apply LRU eviction to prevent memory bloat
        const evictedCache = evictDiffCacheIfNeeded(newDiffCache);
        newDirectories.set(directory, { ...currentDirState, diffCache: evictedCache });
        set({ directories: newDirectories });
      },

      setLogMaxCount: (directory, maxCount) => {
        const newDirectories = new Map(get().directories);
        const dirState = newDirectories.get(directory) ?? createEmptyDirectoryState();
        newDirectories.set(directory, { ...dirState, logMaxCount: maxCount });
        set({ directories: newDirectories });
      },

      ensureStatus: async (directory, git) => {
        const dirState = get().directories.get(directory);
        const now = Date.now();
        if (dirState?.status && now - dirState.lastStatusFetch < STATUS_STALE_THRESHOLD) {
          return;
        }
        await get().fetchStatus(directory, git, { silent: Boolean(dirState?.status) });
      },

      ensureAll: (directory, git) => {
        const existing = inFlightEnsureAllByDirectory.get(directory);
        if (existing) return existing;

        const promise = (async () => {
          const dirState = get().directories.get(directory);
          const now = Date.now();
          const needsFullStatus = !dirState?.status || dirState.status.diffStats === undefined;

          if (needsFullStatus || now - (dirState?.lastStatusFetch ?? 0) >= STATUS_STALE_THRESHOLD) {
            await get().fetchStatus(directory, git, { silent: Boolean(dirState?.status) });
          }

          const updatedState = get().directories.get(directory);
          if (!updatedState?.isGitRepo) return;

          const fetches: Promise<void>[] = [];

          if (!updatedState.branches || now - updatedState.lastBranchesFetch >= BRANCHES_STALE_THRESHOLD) {
            fetches.push(get().fetchBranches(directory, git));
          }
          if (!updatedState.log || now - updatedState.lastLogFetch >= LOG_STALE_THRESHOLD) {
            fetches.push(get().fetchLog(directory, git));
          }
          if (!updatedState.identity || now - updatedState.lastIdentityFetch >= IDENTITY_STALE_THRESHOLD) {
            fetches.push(get().fetchIdentity(directory, git));
          }

          if (fetches.length > 0) await Promise.all(fetches);
        })();

        inFlightEnsureAllByDirectory.set(directory, promise);
        promise.finally(() => {
          if (inFlightEnsureAllByDirectory.get(directory) === promise) {
            inFlightEnsureAllByDirectory.delete(directory);
          }
        });

        return promise;
      },

      refresh: async (git, options = {}) => {
        const { activeDirectory } = get();
        if (!activeDirectory) return;
        await get().fetchAll(activeDirectory, git, options);
      },
    }),
    { name: 'git-store' }
  )
);

export const useGitStatus = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return null;
    return state.directories.get(directory)?.status ?? null;
  });
};

export const useGitBranches = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return null;
    return state.directories.get(directory)?.branches ?? null;
  });
};

export const useGitLog = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return null;
    return state.directories.get(directory)?.log ?? null;
  });
};

export const useGitIdentity = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return null;
    return state.directories.get(directory)?.identity ?? null;
  });
};

export const useIsGitRepo = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return null;
    return state.directories.get(directory)?.isGitRepo ?? null;
  });
};

export const useGitFileCount = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return 0;
    return state.directories.get(directory)?.status?.files?.length ?? 0;
  });
};

export const useGitBranchLabel = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return null;
    return state.directories.get(directory)?.status?.current?.trim() ?? null;
  });
};

const allBranchesCacheRef = { current: new Map<string, string | null>() };

export const useGitAllBranches = () => {
  return useGitStore((state) => {
    const prev = allBranchesCacheRef.current;
    let same = prev.size === state.directories.size;
    if (same) {
      for (const [dir, dirState] of state.directories) {
        if (prev.get(dir) !== (dirState.status?.current ?? null)) { same = false; break; }
      }
    }
    if (same) return prev;
    const result = new Map<string, string | null>();
    for (const [dir, dirState] of state.directories) {
      result.set(dir, dirState.status?.current ?? null);
    }
    allBranchesCacheRef.current = result;
    return result;
  });
};

export const useGitBranchMap = (directories: string[]) => {
  const cacheRef = React.useRef<Map<string, string | null>>(new Map());
  return useGitStore((state) => {
    const prev = cacheRef.current;
    let same = prev.size === directories.length;
    if (same) {
      for (const dir of directories) {
        if (prev.get(dir) !== (state.directories.get(dir)?.status?.current ?? null)) { same = false; break; }
      }
    }
    if (same) return prev;
    const result = new Map<string, string | null>();
    for (const dir of directories) {
      result.set(dir, state.directories.get(dir)?.status?.current ?? null);
    }
    cacheRef.current = result;
    return result;
  });
};

export const useGitRepoStatusMap = (directories: string[]) => {
  const cacheRef = React.useRef<Map<string, { isGitRepo: boolean | null; branch: string | null }>>(new Map());
  return useGitStore((state) => {
    const prev = cacheRef.current;
    let same = prev.size === directories.length;
    if (same) {
      for (const dir of directories) {
        const d = state.directories.get(dir);
        const pv = prev.get(dir);
        if (!pv || (d?.isGitRepo ?? null) !== pv.isGitRepo || (d?.status?.current ?? null) !== pv.branch) { same = false; break; }
      }
    }
    if (same) return prev;
    const result = new Map<string, { isGitRepo: boolean | null; branch: string | null }>();
    for (const dir of directories) {
      const d = state.directories.get(dir);
      result.set(dir, { isGitRepo: d?.isGitRepo ?? null, branch: d?.status?.current ?? null });
    }
    cacheRef.current = result;
    return result;
  });
};

export const useGitLoadingStatus = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return false;
    return state.directories.get(directory)?.isLoadingStatus ?? false;
  });
};

export const useGitLoadingLog = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return false;
    return state.directories.get(directory)?.isLoadingLog ?? false;
  });
};

export const useGitLoadingBranches = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return false;
    return state.directories.get(directory)?.isLoadingBranches ?? false;
  });
};

export const useGitLoadingIdentity = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return false;
    return state.directories.get(directory)?.isLoadingIdentity ?? false;
  });
};
