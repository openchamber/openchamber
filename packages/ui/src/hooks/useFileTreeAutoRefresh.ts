import * as React from 'react';

import type { FilesAPI, FileWatchSubscription } from '@/lib/api/types';
import {
  getFileTreePathIdentity,
  isFileTreePathWithinRoot,
  normalizeFileTreePath,
} from '@/lib/fileTreePath';

const FALLBACK_REFRESH_INTERVAL_MS = 8_000;

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
    const refreshStates = new Map<string, {
      pending: boolean;
      running: Promise<void> | null;
    }>();
    const queueRefresh = (directory: string): Promise<void> => {
      const key = getFileTreePathIdentity(directory);
      const state = refreshStates.get(key) ?? { pending: false, running: null };
      refreshStates.set(key, state);
      state.pending = true;
      if (!state.running) {
        state.running = (async () => {
          while (active && state.pending) {
            state.pending = false;
            await refreshDirectory(directory);
          }
        })().finally(() => {
          state.running = null;
          if (!state.pending) refreshStates.delete(key);
        });
      }
      return state.running;
    };
    const refreshAll = async () => {
      for (let index = 0; index < directories.length && active; index += 3) {
        await Promise.all(directories.slice(index, index + 3).map(queueRefresh));
      }
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
        () => undefined,
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
            void queueRefresh(directory).catch(() => {
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
