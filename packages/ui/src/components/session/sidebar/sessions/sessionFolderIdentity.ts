import { getChatsRootFromDirectory } from '@/lib/chatDirectories';
import type { SessionGroup, SessionGroupFolderScope } from '../types';
import { normalizePath } from '../utils';

export const getSessionFolderIdentityKey = (scopeKey: string, folderId: string): string => (
  `${scopeKey}\u0000${folderId}`
);

export const getSessionFolderOwnerKey = (
  projectId: string | null | undefined,
  directory: string | null | undefined,
): string | null => projectId ?? getChatsRootFromDirectory(directory) ?? normalizePath(directory ?? null);

export const getSessionFolderScopes = (
  group: Pick<SessionGroup, 'folderScopes' | 'folderScopeKey' | 'directory'>,
): SessionGroupFolderScope[] => {
  if (group.folderScopes && group.folderScopes.length > 0) return group.folderScopes;
  const scopeKey = group.folderScopeKey ?? normalizePath(group.directory ?? null);
  return scopeKey ? [{ scopeKey, directory: group.directory }] : [];
};

export const isArchivedFolderScope = (scopeKey: string): boolean => scopeKey.startsWith('__archived__:');
