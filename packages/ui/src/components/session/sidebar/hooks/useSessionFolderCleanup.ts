import React from 'react';
import { getArchivedScopeKey, normalizePath } from '../utils';
import type { SessionOwnershipIndex } from '../sessionOwnership';
import { captureSidebarRuntimeContext, isSidebarRuntimeContextCurrent } from './sidebarRuntimeContext';

type WorktreeMeta = { path: string };

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
  availableWorktreesByProject: Map<string, WorktreeMeta[]>;
  unresolvedWorktreeProjectPaths: ReadonlySet<string>;
  cleanupSessions: (scopeKey: string, validSessionIds: Set<string>) => void;
};

export const useSessionFolderCleanup = (args: Args): void => {
  const {
    isSessionsLoading,
    hasAuthoritativeGlobalSessions,
    isWorktreeTopologyLoading,
    normalizedProjects,
    ownership,
    availableWorktreesByProject,
    unresolvedWorktreeProjectPaths,
    cleanupSessions,
  } = args;
  const runtimeContextAtRender = captureSidebarRuntimeContext();
  const runtimeKeyAtRender = runtimeContextAtRender.runtimeKey;
  const runtimeGenerationAtRender = runtimeContextAtRender.generation;

  React.useEffect(() => {
    const isRuntimeContextCurrent = () => isSidebarRuntimeContextCurrent({
      runtimeKey: runtimeKeyAtRender,
      generation: runtimeGenerationAtRender,
    });
    if (!isRuntimeContextCurrent()) {
      return;
    }
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
      if (!isRuntimeContextCurrent()) {
        return;
      }
      cleanupSessions(scopeKey, sessionIds);
    });
  }, [
    availableWorktreesByProject,
    cleanupSessions,
    hasAuthoritativeGlobalSessions,
    isWorktreeTopologyLoading,
    isSessionsLoading,
    normalizedProjects,
    ownership,
    runtimeGenerationAtRender,
    runtimeKeyAtRender,
    unresolvedWorktreeProjectPaths,
  ]);
};
