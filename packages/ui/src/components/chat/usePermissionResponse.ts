import React from 'react';
import type { PermissionReply, PermissionRequest } from '@/types/permission';
import { useChatColumnActions, useChatSessionSelection } from './chatColumnSession';
import { useSubagentRequest } from '@/sync/sync-context';
import * as sessionActions from '@/sync/session-actions';
import { canSavePermission } from './permissionSummary';
import { eventMatchesShortcut, getEffectiveShortcutCombo, type ShortcutActionId } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';

type ColumnKind = 'main' | 'pinned';

const activePermissionCards: Array<{ id: string; column: ColumnKind }> = [];

const columnOfEvent = (event: KeyboardEvent): ColumnKind => (
  event.target instanceof Element && event.target.closest('[data-chat-column="pinned"]') ? 'pinned' : 'main'
);

export const permissionShortcutReply = (
  event: KeyboardEvent,
  canSave: boolean,
  overrides?: Record<string, string>,
): PermissionReply | null => {
  const pressed = (actionId: ShortcutActionId) => (
    eventMatchesShortcut(event, getEffectiveShortcutCombo(actionId, overrides))
  );
  if (pressed('permission_allow_once')) return 'once';
  if (pressed('permission_deny')) return 'reject';
  return canSave && pressed('permission_allow_always') ? 'always' : null;
};

/** The message a deny-with-feedback reply carries; blank text is no message. */
export const permissionFeedbackMessage = (text: string): string | undefined => {
  const trimmed = text.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * What a key press in the deny-feedback box means. Enter submits on desktop
 * and Shift+Enter inserts a newline; on mobile Enter inserts a newline and
 * only Cmd/Ctrl+Enter submits (the FormDock rule). Escape cancels back to the
 * buttons. IME composition never submits or cancels (mirrors
 * `isIMECompositionEvent` in lib/ime).
 */
export const permissionFeedbackKeyAction = (
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'isComposing' | 'keyCode'>,
  isMobile: boolean,
): 'submit' | 'cancel' | null => {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.key === 'Escape') return 'cancel';
  if (event.key !== 'Enter' || event.shiftKey) return null;
  if (event.ctrlKey || event.metaKey) return 'submit';
  return isMobile ? null : 'submit';
};

export const usePermissionFromSubagent = (permission: PermissionRequest): boolean => {
  const { sessionId: currentSessionId, directory: currentSessionDirectory } = useChatSessionSelection();
  return useSubagentRequest(permission.sessionID, currentSessionId, currentSessionDirectory ?? undefined);
};

export const usePermissionResponse = (
  permission: PermissionRequest,
  onResponse?: (response: PermissionReply) => void,
) => {
  const column: ColumnKind = useChatColumnActions().pinned ? 'pinned' : 'main';
  const [isResponding, setIsResponding] = React.useState(false);
  const [hasResponded, setHasResponded] = React.useState(false);
  const respondToPermission = sessionActions.respondToPermission;
  const canSave = canSavePermission(permission.save);

  const respond = React.useCallback(async (response: PermissionReply, message?: string) => {
    setIsResponding(true);
    try {
      await respondToPermission(permission.sessionID, permission.id, response, undefined, message);
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
      const response = permissionShortcutReply(event, canSave, useUIStore.getState().shortcutOverrides);
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
  }, [canSave, column, hasResponded, permission.id]);

  return { isResponding, hasResponded, respond };
};
