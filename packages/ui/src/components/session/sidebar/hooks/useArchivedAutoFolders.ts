import React from 'react';
import {
  getArchivedScopeKey,
  resolveArchivedFolderName,
} from '../utils';
import type { SessionOwnershipIndex } from '../sessionOwnership';

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
  normalizedProjects: ProjectForArchivedFolders[];
  ownership: SessionOwnershipIndex;
  isSessionsLoading: boolean;
  hasAuthoritativeGlobalSessions: boolean;
  isWorktreeTopologyLoading: boolean;
  unresolvedWorktreeProjectPaths: ReadonlySet<string>;
  foldersMap: Record<string, FolderEntry[]>;
  createFolder: (scopeKey: string, name: string, parentId?: string | null) => FolderEntry;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  cleanupSessions: (scopeKey: string, existingSessionIds: Set<string>) => void;
};

export const useArchivedAutoFolders = (args: Args): void => {
  const {
    normalizedProjects,
    ownership,
    isSessionsLoading,
    hasAuthoritativeGlobalSessions,
    isWorktreeTopologyLoading,
    unresolvedWorktreeProjectPaths,
    foldersMap,
    createFolder,
    addSessionToFolder,
    cleanupSessions,
  } = args;

  React.useEffect(() => {
    if (isSessionsLoading || !hasAuthoritativeGlobalSessions || isWorktreeTopologyLoading) {
      return;
    }

    normalizedProjects.forEach((project) => {
      if (unresolvedWorktreeProjectPaths.has(project.normalizedPath)) {
        return;
      }
      const scopeKey = getArchivedScopeKey(project.normalizedPath);
      const projectArchivedSessions = ownership.archivedSessionsByProject.get(project.id) ?? [];
      const sessionIds = new Set(projectArchivedSessions.map((session) => session.id));

      const existingFolders = foldersMap[scopeKey] ?? [];
      const folderByName = new Map(existingFolders.map((folder) => [folder.name.toLowerCase(), folder]));

      projectArchivedSessions.forEach((session) => {
        const folderName = resolveArchivedFolderName(session, project.normalizedPath);
        const key = folderName.toLowerCase();
        let folder = folderByName.get(key);
        if (!folder) {
          folder = createFolder(scopeKey, folderName);
          folderByName.set(key, folder);
        }

        if (!folder.sessionIds.includes(session.id)) {
          addSessionToFolder(scopeKey, folder.id, session.id);
        }
      });

      cleanupSessions(scopeKey, sessionIds);
    });
  }, [
    normalizedProjects,
    ownership,
    isSessionsLoading,
    hasAuthoritativeGlobalSessions,
    isWorktreeTopologyLoading,
    unresolvedWorktreeProjectPaths,
    foldersMap,
    createFolder,
    addSessionToFolder,
    cleanupSessions,
  ]);
};
