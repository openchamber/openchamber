import React from 'react';
import type { PermissionReply, PermissionRequest } from '@/types/permission';
import { useChatColumnActions, useChatSessionSelection } from './chatColumnSession';
import { useSessions } from '@/sync/sync-context';
import * as sessionActions from '@/sync/session-actions';

type ColumnKind = 'main' | 'pinned';

// Newest pending card of a chat owns that chat's keyboard; older cards wait
// their turn. With a chat pinned in the side panel, each chat answers only the
// keys pressed inside it (anywhere else counts as the main chat).
const activePermissionCards: Array<{ id: string; column: ColumnKind }> = [];

const columnOfEvent = (event: KeyboardEvent): ColumnKind => (
  event.target instanceof Element && event.target.closest('[data-chat-column="pinned"]') ? 'pinned' : 'main'
);

/** The request was raised by a child of the session the user is looking at. */
export const usePermissionFromSubagent = (permission: PermissionRequest): boolean => {
  const { sessionId: currentSessionId, directory: currentSessionDirectory } = useChatSessionSelection();
  const sessions = useSessions(currentSessionDirectory ?? undefined);
  return React.useMemo(() => {
    if (!currentSessionId || permission.sessionID === currentSessionId) return false;
    const sourceSession = sessions.find((session) => session.id === permission.sessionID);
    return Boolean(sourceSession?.parentID && sourceSession.parentID === currentSessionId);
  }, [permission.sessionID, currentSessionId, sessions]);
};

/**
 * Replies to one request and owns its keyboard shortcuts while it is the
 * newest pending one: Alt+Enter allows once, Alt+Shift+Enter always,
 * Alt+Backspace denies. Shared by the inline card and the dock.
 */
export const usePermissionResponse = (
  permission: PermissionRequest,
  onResponse?: (response: PermissionReply) => void,
) => {
  const column: ColumnKind = useChatColumnActions().pinned ? 'pinned' : 'main';
  const [isResponding, setIsResponding] = React.useState(false);
  const [hasResponded, setHasResponded] = React.useState(false);
  const respondToPermission = sessionActions.respondToPermission;

  const respond = React.useCallback(async (response: PermissionReply) => {
    setIsResponding(true);
    try {
      await respondToPermission(permission.sessionID, permission.id, response);
      setHasResponded(true);
      onResponse?.(response);
    } catch (error) {
      console.error('[PermissionCard] Failed to respond to permission:', error);
    } finally {
      setIsResponding(false);
    }
  }, [onResponse, permission.id, permission.sessionID, respondToPermission]);

  const respondRef = React.useRef(respond);
  respondRef.current = respond;

  React.useEffect(() => {
    if (hasResponded) return;
    const card = { id: permission.id, column };
    activePermissionCards.push(card);
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = columnOfEvent(event);
      let owner: typeof card | undefined;
      for (const entry of activePermissionCards) {
        if (entry.column === target) owner = entry;
      }
      if (owner !== card) return;
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      const response = event.key === 'Enter'
        ? (event.shiftKey ? 'always' as const : 'once' as const)
        : event.key === 'Backspace' && !event.shiftKey
          ? 'reject' as const
          : null;
      if (!response) return;
      event.preventDefault();
      event.stopPropagation();
      void respondRef.current(response);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      const index = activePermissionCards.lastIndexOf(card);
      if (index !== -1) activePermissionCards.splice(index, 1);
    };
  }, [column, hasResponded, permission.id]);

  return { isResponding, hasResponded, respond };
};
