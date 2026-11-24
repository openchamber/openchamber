import React from 'react';
import { normalizePath } from '@/lib/pathNormalization';
import { sessionEvents } from '@/lib/sessionEvents';
import type { GitAPI } from '@/lib/api/types';
import type { useGitStore } from '@/stores/useGitStore';

type Deferred = { directory: string | null; paths: Set<string>; dirty: boolean; unscoped: boolean };

export function useWorkingDiffFreshness(options: {
  visible: boolean;
  directory: string | null | undefined;
  git: GitAPI;
  clearDiffCache: ReturnType<typeof useGitStore.getState>['clearDiffCache'];
  fetchStatus: ReturnType<typeof useGitStore.getState>['fetchStatus'];
}) {
  const { visible, directory, git, clearDiffCache, fetchStatus } = options;
  const [workingTreeRevision, setWorkingTreeRevision] = React.useState(0);
  const [fileRefreshNonce, setFileRefreshNonce] = React.useState<Map<string, number>>(() => new Map());
  const deferredRef = React.useRef<Deferred>({ directory: null, paths: new Set(), dirty: false, unscoped: false });
  const wasVisibleRef = React.useRef(visible);

  React.useEffect(() => {
    const resumed = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (resumed && directory) void fetchStatus(directory, git, { silent: true, force: true });
  }, [directory, fetchStatus, git, visible]);

  React.useEffect(() => {
    if (!directory) return;
    if (deferredRef.current.directory !== directory) {
      deferredRef.current = { directory, paths: new Set(), dirty: false, unscoped: false };
    }
    const deferred = deferredRef.current;
    const refresh = (paths: string[], unscoped: boolean) => {
      if (paths.length) {
        clearDiffCache(directory, paths);
        setFileRefreshNonce((previous) => {
          const next = new Map(previous);
          for (const path of paths) next.set(path, (next.get(path) ?? 0) + 1);
          return next;
        });
      }
      if (unscoped) setWorkingTreeRevision((previous) => previous + 1);
      void fetchStatus(directory, git, { silent: true });
    };
    if (visible && deferred.dirty) {
      refresh([...deferred.paths], deferred.unscoped);
      deferred.paths.clear();
      deferred.dirty = false;
      deferred.unscoped = false;
    }
    return sessionEvents.onGitRefreshHint((hint) => {
      if (normalizePath(hint.directory) !== normalizePath(directory)) return;
      const paths = hint.paths ?? [];
      const unscoped = paths.length === 0;
      if (!visible) {
        deferred.dirty = true;
        deferred.unscoped ||= unscoped;
        for (const path of paths) deferred.paths.add(path);
        return;
      }
      refresh(paths, unscoped);
    });
  }, [clearDiffCache, directory, fetchStatus, git, visible]);

  return { workingTreeRevision, fileRefreshNonce };
}
