import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  getArchivedScopeKey,
  resolveArchivedFolderName,
} from '../utils';
import type { SessionOwnershipIndex } from '../sessions/sessionOwnership';
import { isSessionTreeRoot } from '../sessions/sessionNodeItemUtils';

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
  removeSessionsFromFolders: (scopeKey: string, sessionIds: string[]) => void;
};

export const filterArchivedFolderSessions = (archivedSessions: Session[]): Session[] => {
  const sessionsById = new Map(archivedSessions.map((session) => [session.id, session]));
  const childrenByParent = new Map<string, Session[]>();
  const rootCandidates: Session[] = [];
  for (const session of archivedSessions) {
    if (isSessionTreeRoot(session, sessionsById)) {
      rootCandidates.push(session);
      continue;
    }
    if (!session.parentID) continue;
    const children = childrenByParent.get(session.parentID) ?? [];
    children.push(session);
    childrenByParent.set(session.parentID, children);
  }

  const claimed = new Set<string>();
  const roots: Session[] = [];
  const addRoot = (session: Session) => {
    if (claimed.has(session.id)) return;
    roots.push(session);
    const pending = [session];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || claimed.has(current.id)) continue;
      claimed.add(current.id);
      pending.push(...(childrenByParent.get(current.id) ?? []));
    }
  };
  rootCandidates.forEach(addRoot);
  archivedSessions.forEach(addRoot);
  return roots;
};

export const getStaleArchivedFolderSessionIds = (
  folderSessions: Session[],
  folders: FolderEntry[],
): string[] => {
  const folderSessionIds = new Set(folderSessions.map((session) => session.id));
  return [...new Set(folders.flatMap((folder) => folder.sessionIds))]
    .filter((sessionId) => !folderSessionIds.has(sessionId));
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
    createFolder,
    addSessionToFolder,
    removeSessionsFromFolders,
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
      const folderSessions = filterArchivedFolderSessions(projectArchivedSessions);
      const existingFolders = foldersMap[scopeKey] ?? [];
      const staleSessionIds = getStaleArchivedFolderSessionIds(folderSessions, existingFolders);
      removeSessionsFromFolders(scopeKey, staleSessionIds);
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
    createFolder,
    addSessionToFolder,
    removeSessionsFromFolders,
  ]);
};
