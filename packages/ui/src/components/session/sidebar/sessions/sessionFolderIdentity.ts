import type { SessionGroup, SessionGroupFolderScope } from '../types';
import { getChatsRootFromDirectory } from '@/lib/chatDirectories';
import { normalizePath } from '../utils';

export { getSessionFolderIdentityKey } from '@/lib/sessionFolderIdentity';

export const getSessionFolderOwnerKey = (
  projectId: string | null | undefined,
  managedChatDirectory: string | null | undefined,
): string | null => projectId ?? getChatsRootFromDirectory(managedChatDirectory) ?? normalizePath(managedChatDirectory ?? null);

/**
 * Selection groups are logical containers, not necessarily the directory that
 * owns a session's messages. Managed Chats therefore select by their shared
 * root while ordinary unowned rows retain their directory fallback.
 */
export const getSessionSelectionScopeKey = (
  projectId: string | null | undefined,
  sessionDirectory: string | null | undefined,
): string | null => projectId ?? getChatsRootFromDirectory(sessionDirectory) ?? normalizePath(sessionDirectory ?? null);

export const getSessionFolderScopes = (group: Pick<SessionGroup, 'folderScopes' | 'folderScopeKey' | 'directory'>): SessionGroupFolderScope[] => {
  if (group.folderScopes && group.folderScopes.length > 0) return group.folderScopes;
  const scopeKey = group.folderScopeKey ?? normalizePath(group.directory ?? null);
  return scopeKey ? [{ scopeKey, directory: group.directory }] : [];
};

type ProjectFolderScopeSection = {
  project: { id: string; normalizedPath: string };
  groups: readonly Pick<SessionGroup, 'folderScopes' | 'folderScopeKey' | 'directory' | 'isArchivedBucket'>[];
};

/** Resolve project-owned folder scopes from the complete, unfiltered topology. */
export const getProjectFolderScopesFromTopology = (
  projectSections: readonly ProjectFolderScopeSection[],
  projectId: string,
): SessionGroupFolderScope[] => {
  const section = projectSections.find((candidate) => candidate.project.id === projectId);
  if (!section) return [];

  const seen = new Set<string>();
  const scopes: SessionGroupFolderScope[] = [];
  for (const group of section.groups) {
    if (group.isArchivedBucket) continue;
    for (const scope of getSessionFolderScopes(group)) {
      if (!scope.scopeKey) continue;
      if (seen.has(scope.scopeKey)) continue;
      seen.add(scope.scopeKey);
      scopes.push(scope);
    }
  }
  if (scopes.length > 0) return scopes;

  const normalizedProjectPath = normalizePath(section.project.normalizedPath);
  return normalizedProjectPath
    ? [{ scopeKey: normalizedProjectPath, directory: normalizedProjectPath }]
    : [];
};
