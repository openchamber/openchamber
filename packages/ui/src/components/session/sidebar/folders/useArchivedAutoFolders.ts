import React from 'react';
import { resolveArchivedFolderName } from '../utils';
import { getArchivedScopeKey } from '@/lib/sessionFolderIdentity';
import type { SessionOwnershipIndex } from '../sessions/sessionOwnership';
import { useSessionFoldersStore, type ArchivedFolderAssignment } from '@/stores/useSessionFoldersStore';

type ProjectForArchivedFolders = {
  id: string;
  normalizedPath: string;
};

type FolderEntry = {
  id: string;
  name: string;
  sessionIds: string[];
};

type Args = {
  enabled?: boolean;
  normalizedProjects: ProjectForArchivedFolders[];
  ownership: SessionOwnershipIndex;
  isSessionsLoading: boolean;
  hasAuthoritativeGlobalSessions: boolean;
  isWorktreeTopologyLoading: boolean;
  unresolvedWorktreeProjectPaths: ReadonlySet<string>;
  foldersMap: Record<string, FolderEntry[]>;
  createFolder: (scopeKey: string, name: string, parentId?: string | null) => FolderEntry;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
};

export const useArchivedAutoFolders = (args: Args): void => {
  const {
    normalizedProjects,
    enabled = true,
    ownership,
    isSessionsLoading,
    hasAuthoritativeGlobalSessions,
    isWorktreeTopologyLoading,
    unresolvedWorktreeProjectPaths,
    foldersMap,
  } = args;

  React.useEffect(() => {
    if (!enabled || isSessionsLoading || !hasAuthoritativeGlobalSessions || isWorktreeTopologyLoading) {
      return;
    }

    normalizedProjects.forEach((project) => {
      if (unresolvedWorktreeProjectPaths.has(project.normalizedPath)) {
        return;
      }
      const scopeKey = getArchivedScopeKey(project.normalizedPath);
      const projectArchivedSessions = ownership.archivedSessionsByProject.get(project.id) ?? [];
      const knownSessionIds = new Set<string>();
      for (const session of [
        ...(ownership.sessionsByProject.get(project.id) ?? []),
        ...projectArchivedSessions,
      ]) {
        const sessionId = session.id.trim();
        if (sessionId) knownSessionIds.add(sessionId);
      }

      const assignmentsByName = new Map<string, ArchivedFolderAssignment & { sessionIds: string[] }>();
      const assignedSessionIds = new Set<string>();
      projectArchivedSessions.forEach((session) => {
        const sessionId = session.id.trim();
        if (!sessionId || assignedSessionIds.has(sessionId)) return;
        const folderName = resolveArchivedFolderName(session, project.normalizedPath);
        const normalizedFolderName = folderName.trim();
        if (!normalizedFolderName) return;
        const key = normalizedFolderName.toLowerCase();
        const assignment = assignmentsByName.get(key) ?? { name: normalizedFolderName, sessionIds: [] };
        assignment.sessionIds.push(sessionId);
        assignmentsByName.set(key, assignment);
        assignedSessionIds.add(sessionId);
      });

      useSessionFoldersStore.getState().reconcileArchivedFolders(
        scopeKey,
        [...assignmentsByName.values()],
        [...knownSessionIds],
      );
    });
  }, [
    normalizedProjects,
    enabled,
    ownership,
    isSessionsLoading,
    hasAuthoritativeGlobalSessions,
    isWorktreeTopologyLoading,
    unresolvedWorktreeProjectPaths,
    foldersMap,
  ]);
};
