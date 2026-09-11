import React from 'react';
import { sessionEvents } from '@/lib/sessionEvents';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { normalizePath } from '@/lib/pathNormalization';
import { useGitStore } from '@/stores/useGitStore';

type GitRefreshHint = { directory: string; paths?: string[] };

type CoordinatorDeps = {
  isHidden: () => boolean;
  applyHint: (hint: GitRefreshHint) => void;
};

type PendingEntry = {
  directory: string;
  paths: Set<string> | null;
};

export const createGitRefreshCoordinator = ({ isHidden, applyHint }: CoordinatorDeps) => {
  const pending = new Map<string, PendingEntry>();

  const onHint = (hint: GitRefreshHint) => {
    if (!isHidden()) {
      applyHint(hint);
      return;
    }

    const key = normalizePath(hint.directory) ?? hint.directory;
    const entry = pending.get(key) ?? { directory: hint.directory, paths: new Set<string>() };

    if (!hint.paths?.length) {
      entry.paths = null;
    } else if (entry.paths) {
      for (const path of hint.paths) {
        entry.paths.add(path);
      }
    }

    pending.set(key, entry);
  };

  const flush = () => {
    if (isHidden()) {
      return;
    }

    const entries = Array.from(pending.values());
    pending.clear();
    for (const entry of entries) {
      applyHint(entry.paths ? { directory: entry.directory, paths: Array.from(entry.paths) } : { directory: entry.directory });
    }
  };

  return { onHint, flush };
};

const getDocument = (): Document | undefined => globalThis.document;

const documentIsHidden = () => getDocument()?.visibilityState === 'hidden';

export const useGitRefreshCoordinator = (): void => {
  const { git } = useRuntimeAPIs();

  React.useEffect(() => {
    if (!git) {
      return;
    }

    const coordinator = createGitRefreshCoordinator({
      isHidden: documentIsHidden,
      applyHint: ({ directory, paths }) => {
        const { clearDiffCache, invalidateHistory, fetchStatus } = useGitStore.getState();
        if (paths?.length) {
          clearDiffCache(directory, paths);
        }
        invalidateHistory(directory);
        void fetchStatus(directory, git, { silent: true });
      },
    });

    const unsubscribe = sessionEvents.onGitRefreshHint(coordinator.onHint);
    const onVisibilityChange = () => {
      coordinator.flush();
    };

    const doc = getDocument();
    if (doc) {
      doc.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
      unsubscribe();
      if (doc) {
        doc.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [git]);
};
