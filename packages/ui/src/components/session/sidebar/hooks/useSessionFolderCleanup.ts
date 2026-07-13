import React from 'react';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import {
  getArchivedScopeKey,
} from '../utils';
import type { SessionOwnershipIndex } from '../sessionOwnership';

type NormalizedProject = {
  id: string;
  normalizedPath: string;
};

type Args = {
  isSessionsLoading: boolean;
  hasAuthoritativeGlobalSessions: boolean;
  isWorktreeTopologyLoading: boolean;
  normalizedProjects: NormalizedProject[];
  ownership: SessionOwnershipIndex;
  cleanupSessions: (scopeKey: string, validSessionIds: Set<string>) => void;
};

export const useSessionFolderCleanup = (args: Args): void => {
  const {
    isSessionsLoading,
    hasAuthoritativeGlobalSessions,
    isWorktreeTopologyLoading,
    normalizedProjects,
    ownership,
    cleanupSessions,
  } = args;

  React.useEffect(() => {
    if (isSessionsLoading || !hasAuthoritativeGlobalSessions || isWorktreeTopologyLoading) {
      return;
    }

    if (ownership.bySessionId.size === 0) {
      return;
    }

    const idsByScope = new Map<string, Set<string>>();
    ownership.sessionsByScope.forEach((sessionIds, scopeDirectory) => {
      idsByScope.set(scopeDirectory, new Set(sessionIds));
    });

    normalizedProjects.forEach((project) => {
      const scopeKey = getArchivedScopeKey(project.normalizedPath);
      const archivedIds = new Set([
        ...(ownership.archivedSessionsByProject.get(project.id) ?? []).map((session) => session.id),
      ]);
      idsByScope.set(scopeKey, archivedIds);
    });

    const currentFoldersMap = useSessionFoldersStore.getState().foldersMap;
    const allScopeKeys = new Set([...Object.keys(currentFoldersMap), ...idsByScope.keys()]);
    allScopeKeys.forEach((scopeKey) => {
      cleanupSessions(scopeKey, idsByScope.get(scopeKey) ?? new Set<string>());
    });
  }, [
    cleanupSessions,
    hasAuthoritativeGlobalSessions,
    isWorktreeTopologyLoading,
    isSessionsLoading,
    normalizedProjects,
    ownership,
  ]);
};
