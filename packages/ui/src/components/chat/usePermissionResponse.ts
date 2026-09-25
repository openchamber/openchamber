import React from 'react';
import type { PermissionReply, PermissionRequest } from '@/types/permission';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import * as sessionActions from '@/sync/session-actions';

// Newest pending card owns the keyboard; older cards wait their turn.
const activePermissionCardIds: string[] = [];

/** The request was raised by a child of the session the user is looking at. */
export const usePermissionFromSubagent = (permission: PermissionRequest): boolean => {
  const sessions = useSessions();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
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
    activePermissionCardIds.push(permission.id);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (activePermissionCardIds.at(-1) !== permission.id) return;
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
      const index = activePermissionCardIds.lastIndexOf(permission.id);
      if (index !== -1) activePermissionCardIds.splice(index, 1);
    };
  }, [hasResponded, permission.id]);

  return { isResponding, hasResponded, respond };
};
