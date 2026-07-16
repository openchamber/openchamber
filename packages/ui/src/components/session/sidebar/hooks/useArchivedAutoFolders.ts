import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
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

// Only tree roots get auto-folder assignments: a subagent whose parent is
// archived too renders nested under the parent's node, so a direct folder
// entry would render it a second time (#2266). The cleanup set uses the same
// filter so previously persisted subagent assignments are removed.
export const filterArchivedFolderSessions = (archivedSessions: Session[]): Session[] => {
  const archivedIds = new Set(archivedSessions.map((session) => session.id));
  return archivedSessions.filter((session) => {
    const parentID = (session as Session & { parentID?: string | null }).parentID;
    return !parentID || !archivedIds.has(parentID);
  });
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
      const folderSessions = filterArchivedFolderSessions(projectArchivedSessions);
      const folderSessionIds = new Set(folderSessions.map((session) => session.id));

      const existingFolders = foldersMap[scopeKey] ?? [];
      const folderByName = new Map(existingFolders.map((folder) => [folder.name.toLowerCase(), folder]));

      folderSessions.forEach((session) => {
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

      cleanupSessions(scopeKey, folderSessionIds);
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
