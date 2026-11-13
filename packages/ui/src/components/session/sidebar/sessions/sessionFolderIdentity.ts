import { getChatsRootFromDirectory } from '@/lib/chatDirectories';
import type { SessionGroup, SessionGroupFolderScope } from '../types';
import { normalizePath } from '../utils';
import type { Session } from '@/lib/opencode/model';
import type { DirectoryOwner } from './sessionOwnership';

export const getSessionFolderIdentityKey = (scopeKey: string, folderId: string): string => (
  `${scopeKey}\u0000${folderId}`
);

export const getSessionDragId = (dragKey: string): string => `session-drag:${dragKey}`;

export const getSessionFolderDropId = (scopeKey: string, folderId: string): string => (
  `folder-drop:${getSessionFolderIdentityKey(scopeKey, folderId)}`
);

export const getSessionFolderOwnerKey = (
  projectId: string | null | undefined,
  directory: string | null | undefined,
): string | null => projectId ?? getChatsRootFromDirectory(directory) ?? normalizePath(directory ?? null);

export const getAuthoritativeSessionFolderOwnerKey = (
  session: Session,
  owner: DirectoryOwner | undefined,
): string | null => {
  if (owner) return getSessionFolderOwnerKey(owner.projectId, owner.scopeDirectory);
  const chatsRoot = getChatsRootFromDirectory(session.directory);
  return chatsRoot ? getSessionFolderOwnerKey(null, chatsRoot) : null;
};

export const getSessionFolderScopes = (
  group: Pick<SessionGroup, 'folderScopes' | 'folderScopeKey' | 'directory'>,
): SessionGroupFolderScope[] => {
  if (group.folderScopes && group.folderScopes.length > 0) return group.folderScopes;
  const scopeKey = group.folderScopeKey ?? normalizePath(group.directory ?? null);
  return scopeKey ? [{ scopeKey, directory: group.directory }] : [];
};

export const isArchivedFolderScope = (scopeKey: string): boolean => scopeKey.startsWith('__archived__:');
