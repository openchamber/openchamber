import * as React from 'react';

import type { FilesAPI, FileWatchSubscription } from '@/lib/api/types';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import {
  getFileTreePathIdentity,
  isFileTreePathWithinRoot,
  normalizeFileTreePath,
} from '@/lib/fileTreePath';

const FALLBACK_REFRESH_INTERVAL_MS = 8_000;
const FILE_TREE_REFRESH_CONCURRENCY = 3;

export const collectFileTreeWatchDirectories = (root: string, expandedPaths: string[]): string[] => {
  const normalizedRoot = normalizeFileTreePath(root);
  if (!normalizedRoot) return [];

  const rootKey = getFileTreePathIdentity(normalizedRoot);
  const seen = new Set([rootKey]);
  const directories = [normalizedRoot];
  for (const value of expandedPaths) {
    const directory = normalizeFileTreePath(value);
    const key = getFileTreePathIdentity(directory);
    if (!directory || seen.has(key)) continue;
    if (!isFileTreePathWithinRoot(directory, normalizedRoot)) continue;
    seen.add(key);
    directories.push(directory);
  }
  return directories;
};

interface UseFileTreeAutoRefreshOptions {
  enabled: boolean;
  root: string;
  expandedPaths: string[];
  watchDirectories: FilesAPI['watchDirectories'];
  refreshDirectory: (directory: string) => Promise<void>;
}

export const useFileTreeAutoRefresh = ({
  enabled,
  root,
  expandedPaths,
  watchDirectories,
  refreshDirectory,
}: UseFileTreeAutoRefreshOptions): void => {
  const directories = React.useMemo(
    () => collectFileTreeWatchDirectories(root, expandedPaths),
    [expandedPaths, root],
  );
  const watchedDirectoryKeys = React.useMemo(
    () => new Set(directories.map(getFileTreePathIdentity)),
    [directories],
  );

  React.useEffect(() => {
    if (!enabled || directories.length === 0) return;

    let active = true;
    let interval: ReturnType<typeof setInterval> | null = null;
    let watcherReady = false;
    let activeRefreshes = 0;
    const refreshWaiters: Array<() => void> = [];
    const refreshStates = new Map<string, {
      pending: boolean;
      pendingLiveRefresh: boolean;
      running: Promise<void> | null;
    }>();
    const acquireRefreshSlot = (): Promise<void> => {
      if (activeRefreshes < FILE_TREE_REFRESH_CONCURRENCY) {
        activeRefreshes += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        refreshWaiters.push(resolve);
      });
    };
    const releaseRefreshSlot = () => {
      const next = refreshWaiters.shift();
      if (next) {
        next();
        return;
      }
      activeRefreshes = Math.max(0, activeRefreshes - 1);
    };
    const runRefresh = async (directory: string, live: boolean) => {
      const refresh = async () => {
        await acquireRefreshSlot();
        try {
          if (active) await refreshDirectory(directory);
        } finally {
          releaseRefreshSlot();
        }
      };
      if (live) await refresh();
      else await runBackgroundNetworkTask(refresh);
    };
    const queueRefresh = (directory: string, live = false): Promise<void> => {
      const key = getFileTreePathIdentity(directory);
      const state = refreshStates.get(key) ?? {
        pending: false,
        pendingLiveRefresh: false,
        running: null,
      };
      refreshStates.set(key, state);
      state.pending = true;
      if (live) state.pendingLiveRefresh = true;
      if (!state.running) {
        state.running = (async () => {
          let latestRefreshFailed = false;
          while (active && state.pending) {
            state.pending = false;
            const nextRefreshIsLive = state.pendingLiveRefresh;
            state.pendingLiveRefresh = false;
            try {
              await runRefresh(directory, nextRefreshIsLive);
              latestRefreshFailed = false;
            } catch {
              latestRefreshFailed = true;
            }
          }
          if (latestRefreshFailed) throw new Error('Failed to refresh the file-tree directory');
        })().finally(() => {
          state.running = null;
          if (!state.pending) refreshStates.delete(key);
        });
      }
      return state.running;
    };
    const refreshAll = async () => {
      let refreshFailed = false;
      for (let index = 0; index < directories.length && active; index += FILE_TREE_REFRESH_CONCURRENCY) {
        const results = await Promise.allSettled(
          directories
            .slice(index, index + FILE_TREE_REFRESH_CONCURRENCY)
            .map((directory) => queueRefresh(directory)),
        );
        if (results.some((result) => result.status === 'rejected')) refreshFailed = true;
      }
      if (refreshFailed) throw new Error('Failed to reconcile all file-tree directories');
    };
    const stopFallback = () => {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
    };
    const startFallback = () => {
      if (interval) return;
      interval = setInterval(() => {
        if (document.hidden) return;
        void refreshAll().then(
          () => {
            if (active && watcherReady) stopFallback();
          },
          () => undefined,
        );
      }, FALLBACK_REFRESH_INTERVAL_MS);
    };
    startFallback();

    const handleVisibilityChange = () => {
      if (document.hidden) return;
      void refreshAll().then(
        () => {
          if (active && watcherReady) stopFallback();
        },
        () => {
          if (active) startFallback();
        },
      );
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    if (watchDirectories) {
      let subscription: FileWatchSubscription | null = null;
      try {
        subscription = watchDirectories(root, directories, {
          onReady: () => {
            watcherReady = true;
            void refreshAll().then(
              () => {
                if (active) stopFallback();
              },
              () => {
                if (active) startFallback();
              },
            );
          },
          onError: () => {
            watcherReady = false;
            startFallback();
          },
          onChange: (event) => {
            if (document.hidden) return;
            const directory = normalizeFileTreePath(event.directory);
            if (!watchedDirectoryKeys.has(getFileTreePathIdentity(directory))) return;
            void queueRefresh(directory, true).catch(() => {
              if (active) startFallback();
            });
          },
        });
      } catch {
        subscription = null;
      }
      if (subscription) {
        return () => {
          active = false;
          stopFallback();
          document.removeEventListener('visibilitychange', handleVisibilityChange);
          subscription.close();
        };
      }
    }

    return () => {
      active = false;
      stopFallback();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [directories, enabled, refreshDirectory, root, watchDirectories, watchedDirectoryKeys]);
};
