import React from 'react';
import { getArchivedScopeKey, normalizePath } from '../utils';
import type { SessionOwnershipIndex } from '../sessionOwnership';

type WorktreeMeta = { path: string };

type NormalizedProject = {
  id: string;
  normalizedPath: string;
};

type Args = {
  enabled?: boolean;
  isSessionsLoading: boolean;
  hasAuthoritativeGlobalSessions: boolean;
  isWorktreeTopologyLoading: boolean;
  normalizedProjects: NormalizedProject[];
  ownership: SessionOwnershipIndex;
  availableWorktreesByProject: Map<string, WorktreeMeta[]>;
  unresolvedWorktreeProjectPaths: ReadonlySet<string>;
  cleanupSessions: (scopeKey: string, validSessionIds: Set<string>) => void;
};

export const useSessionFolderCleanup = (args: Args): void => {
  const {
    isSessionsLoading,
    enabled = true,
    hasAuthoritativeGlobalSessions,
    isWorktreeTopologyLoading,
    normalizedProjects,
    ownership,
    availableWorktreesByProject,
    unresolvedWorktreeProjectPaths,
    cleanupSessions,
  } = args;

  React.useEffect(() => {
    if (!enabled || isSessionsLoading || !hasAuthoritativeGlobalSessions || isWorktreeTopologyLoading) {
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
      if (unresolvedWorktreeProjectPaths.has(project.normalizedPath)) {
        return;
      }
      const scopeKey = getArchivedScopeKey(project.normalizedPath);
      const archivedSessions = ownership.archivedSessionsByProject.get(project.id) ?? [];
      idsByScope.set(scopeKey, new Set(archivedSessions.map((session) => session.id)));
      if (!idsByScope.has(project.normalizedPath)) {
        idsByScope.set(project.normalizedPath, new Set());
      }
      for (const worktree of availableWorktreesByProject.get(project.normalizedPath) ?? []) {
        const worktreePath = normalizePath(worktree.path);
        if (worktreePath && !idsByScope.has(worktreePath)) {
          idsByScope.set(worktreePath, new Set());
        }
      }
    });

    idsByScope.forEach((sessionIds, scopeKey) => {
      cleanupSessions(scopeKey, sessionIds);
    });
  }, [
    availableWorktreesByProject,
    cleanupSessions,
    enabled,
    hasAuthoritativeGlobalSessions,
    isWorktreeTopologyLoading,
    isSessionsLoading,
    normalizedProjects,
    ownership,
    unresolvedWorktreeProjectPaths,
  ]);
};
