import React from 'react';
import { useSessionTurnActivity } from '@/sync/global-session-status';
import { useSessionBlockingRequests } from '@/sync/sync-context';
import { useSessionMarkedUnread, useSessionUnread } from '@/sync/session-unread';
import { useHasSessionTurnDuration } from '@/sync/session-turn-duration';
import { useIsSessionAiRenamePending } from '@/sync/use-session-ai-rename';
import { useViewportStore, viewportSessionKey } from '@/sync/viewport-store';
import { useIsSessionWorktreeMovePending } from '@/lib/worktrees/sessionWorktreeMove';
import type { SessionNode } from '../types';
import { selectBlockingBadgeSessionScopes, type BlockingBadgeSessionScope } from './sessionNodeItemUtils';

type SessionRowLiveStateInput = {
  node: SessionNode;
  sessionDirectory: string | null;
  isExpanded: boolean;
  isActive: boolean;
  timelineBadgeSessionScopes: readonly BlockingBadgeSessionScope[] | undefined;
};

/** What is happening to a session right now, as its row shows it: a running turn, a pending request, an unread result, a move or an AI rename. */
export function useSessionRowLiveState({
  node,
  sessionDirectory,
  isExpanded,
  isActive,
  timelineBadgeSessionScopes,
}: SessionRowLiveStateInput) {
  const session = node.session;
  const isZombie = useViewportStore(
    React.useCallback((state) => Boolean(state.sessionMemoryState.get(viewportSessionKey(session.id))?.isZombie), [session.id]),
  );
  const turnActivity = useSessionTurnActivity(session.id);
  const isStreaming = turnActivity !== null;
  // Read as a boolean, not as the value: the row must not re-render on every
  // tick of the counter it only decides to mount.
  const hasActivityDuration = useHasSessionTurnDuration(session.id, isStreaming);
  const isMovingToWorktree = useIsSessionWorktreeMovePending(session.id);
  const isAiRenaming = useIsSessionAiRenamePending(session.id, sessionDirectory);
  const isSessionActionPending = isMovingToWorktree || isAiRenaming;
  const blockingBadgeSessionScopes = React.useMemo(
    () => timelineBadgeSessionScopes ?? selectBlockingBadgeSessionScopes(node, isExpanded, sessionDirectory),
    [isExpanded, node, sessionDirectory, timelineBadgeSessionScopes],
  );
  const {
    hasPermission: hasPendingPermission,
    hasForm: hasPendingForm,
  } = useSessionBlockingRequests(blockingBadgeSessionScopes);
  const needsAttention = useSessionUnread(session.id);
  const markedUnread = useSessionMarkedUnread(session.id);
  const showUnreadStatus = !isSessionActionPending && !isStreaming && needsAttention && (!isActive || markedUnread);
  const showStatusMarker = isStreaming || showUnreadStatus;
  // The settled duration lives exactly as long as the unread marker does, so a
  // session read (or watched) while it finishes never keeps a stale total.
  const showActivityDuration = (isStreaming || showUnreadStatus) && hasActivityDuration;
  // A request waiting on the user stands for the turn: the session is stopped
  // on it, so the running mark and its timer step aside for the one warning
  // mark (the timer reads its start from the store and resumes where it is).
  const waitingOnUser = hasPendingPermission || hasPendingForm;
  return {
    isZombie,
    turnActivity,
    isStreaming,
    isAiRenaming,
    isSessionActionPending,
    hasPendingPermission,
    hasPendingForm,
    needsAttention,
    showUnreadStatus,
    showStatusMarker,
    showActivityDuration,
    waitingOnUser,
  };
}
