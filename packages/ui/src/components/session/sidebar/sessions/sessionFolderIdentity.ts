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

const WORK_FOLDER_OWNER_PREFIX = 'work:';

/**
 * A worktree or a space lists its own sessions and is filed whole, so its
 * sessions are not the project's to file: they own only the folders inside it.
 */
export const getWorkFolderOwnerKey = (directory: string): string => `${WORK_FOLDER_OWNER_PREFIX}${directory}`;

export const getGroupFolderOwnerKey = (
  projectId: string | null | undefined,
  group: Pick<SessionGroup, 'isMain' | 'isArchivedBucket' | 'directory' | 'worktree' | 'space'>,
): string | null => {
  const directory = normalizePath(group.directory ?? null);
  return !group.isMain && !group.isArchivedBucket && (group.worktree !== null || group.space) && directory
    ? getWorkFolderOwnerKey(directory)
    : getSessionFolderOwnerKey(projectId, group.directory);
};

/**
 * Whose folders a session files in: a worktree's or a space's own, else its
 * project's or Chats'. A multi-run lane lists under the project root wherever
 * it runs, so it files like the root's sessions.
 */
export const resolveSessionFolderOwnerKey = (
  session: Session,
  owner: DirectoryOwner | undefined,
  isRunLane: boolean,
): string | null => (
  owner && owner.kind !== 'project' && !isRunLane
    ? getWorkFolderOwnerKey(owner.scopeDirectory)
    : getAuthoritativeSessionFolderOwnerKey(session, owner)
);

/** The directory of the worktree or space whose folders an owner key names, or null. */
export const getWorkFolderScope = (ownerKey: string | null | undefined): string | null => (
  ownerKey?.startsWith(WORK_FOLDER_OWNER_PREFIX) ? ownerKey.slice(WORK_FOLDER_OWNER_PREFIX.length) : null
);

export const getSessionFolderScopes = (
  group: Pick<SessionGroup, 'folderScopes' | 'folderScopeKey' | 'directory'>,
): SessionGroupFolderScope[] => {
  if (group.folderScopes && group.folderScopes.length > 0) return group.folderScopes;
  const scopeKey = group.folderScopeKey ?? normalizePath(group.directory ?? null);
  return scopeKey ? [{ scopeKey, directory: group.directory }] : [];
};

export const isArchivedFolderScope = (scopeKey: string): boolean => scopeKey.startsWith('__archived__:');
