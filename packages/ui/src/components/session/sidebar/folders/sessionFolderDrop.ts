import type { SessionSidebarFolderTarget, SessionSidebarOwnerAuthority, SessionSidebarRow } from '../sessionSidebarRowModel';
import { getSessionDragId, getSessionFolderDropId } from '../sessions/sessionFolderIdentity';

type ApplySessionFolderDropArgs = {
  sessionId: string;
  sessionOwnerKey: string | null;
  target: SessionSidebarFolderTarget | undefined;
  authority: SessionSidebarOwnerAuthority | undefined;
  removeSessionFromFolder: (scopeKey: string, sessionId: string) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
};

export const resolveCurrentSessionFolderDropSource = (
  rows: readonly SessionSidebarRow[],
  dragId: string,
  claimedSessionId: string,
): { sessionId: string; ownerKey: string } | null => {
  const row = rows.find((candidate) => candidate.kind === 'session' && getSessionDragId(candidate.key) === dragId);
  if (row?.kind !== 'session' || row.node.session.id !== claimedSessionId || row.archived || !row.ownerKey) return null;
  return { sessionId: claimedSessionId, ownerKey: row.ownerKey };
};

export const resolveCurrentSessionFolderDropTarget = (
  targets: readonly SessionSidebarFolderTarget[],
  dropId: string,
  claimedScopeKey: string,
  claimedFolderId: string,
): SessionSidebarFolderTarget | undefined => targets.find((target) => (
  getSessionFolderDropId(target.scopeKey, target.folderId) === dropId
  && target.scopeKey === claimedScopeKey
  && target.folderId === claimedFolderId
));

export const applySessionFolderDrop = ({
  sessionId,
  sessionOwnerKey,
  target,
  authority,
  removeSessionFromFolder,
  addSessionToFolder,
}: ApplySessionFolderDropArgs): boolean => {
  if (!sessionOwnerKey || target?.ownerKey !== sessionOwnerKey || !target.enabled || authority?.complete !== true) {
    return false;
  }
  for (const scopeKey of authority.scopeKeys) {
    if (scopeKey !== target.scopeKey) removeSessionFromFolder(scopeKey, sessionId);
  }
  addSessionToFolder(target.scopeKey, target.folderId, sessionId);
  return true;
};
