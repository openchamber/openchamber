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
  const showActivityDuration = (isStreaming || showUnreadStatus) && hasActivityDuration;
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
