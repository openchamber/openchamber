import React from 'react';
import type { SessionNode } from '../types';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { useBackgroundImagesStore } from '@/sync/background-images';
import { usePrWatchStore } from '@/sync/pr-watch';
import { useExtensionWaitsStore } from '@/sync/extension-waits';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { isSessionUnread } from '@/sync/session-unread';

export type CollapsedActivityState = 'permission' | 'form' | 'active' | 'unread' | null;

const mergeCollapsedActivityStates = (
  current: CollapsedActivityState,
  next: CollapsedActivityState,
): CollapsedActivityState => {
  if (current === 'active' || next === 'active') return 'active';
  if (current === 'unread' || next === 'unread') return 'unread';
  return null;
};

const getSessionNodeActivityState = (
  node: SessionNode,
  activeSessionIds: Set<string>,
  unreadSessionIds: Set<string>,
): CollapsedActivityState => {
  if (activeSessionIds.has(node.session.id)) return 'active';

  let state: CollapsedActivityState = null;
  if (unreadSessionIds.has(node.session.id) && !node.session.parentID) state = 'unread';

  for (const child of node.children) {
    state = mergeCollapsedActivityStates(
      state,
      getSessionNodeActivityState(child, activeSessionIds, unreadSessionIds),
    );
    if (state === 'active') return state;
  }

  return state;
};

export const getSessionNodesActivityState = (
  nodes: SessionNode[],
  activeSessionIds: Set<string>,
  unreadSessionIds: Set<string>,
): CollapsedActivityState => {
  let state: CollapsedActivityState = null;
  for (const node of nodes) {
    state = mergeCollapsedActivityStates(
      state,
      getSessionNodeActivityState(node, activeSessionIds, unreadSessionIds),
    );
    if (state === 'active') return state;
  }
  return state;
};

type SessionActivityProps = {
  nodes: readonly SessionNode[];
  blockingSessionIds?: readonly string[];
};

const collectActivityIds = (nodes: readonly SessionNode[]) => {
  const active = new Set<string>();
  const unread = new Set<string>();
  const visit = (node: SessionNode, isSubtask: boolean): void => {
    active.add(node.session.id);
    if (!isSubtask) unread.add(node.session.id);
    node.children.forEach((child) => visit(child, true));
  };
  nodes.forEach((node) => visit(node, false));
  return { active, unread };
};

export const useCollapsedSessionActivityState = ({
  nodes,
  blockingSessionIds,
  enabled = true,
}: SessionActivityProps & { enabled?: boolean }): CollapsedActivityState => {
  const ids = React.useMemo(() => collectActivityIds(enabled ? nodes : []), [enabled, nodes]);
  const blockingIds = React.useMemo(
    () => (blockingSessionIds && blockingSessionIds.length > 0 ? new Set([...ids.active, ...blockingSessionIds]) : ids.active),
    [blockingSessionIds, ids.active],
  );
  const active = useGlobalSessionStatusStore(React.useCallback((state): CollapsedActivityState => {
    if (!enabled) return null;
    for (const sessionId of ids.active) {
      const status = state.statusById.get(sessionId)?.status.type;
      if (status === 'busy' || status === 'retry') return 'active';
    }
    return null;
  }, [enabled, ids.active]));
  const waitingOnShell = useBackgroundShellsStore(React.useCallback((state): CollapsedActivityState => {
    if (!enabled) return null;
    for (const sessionId of ids.active) {
      if (state.sessionIds.has(sessionId)) return 'active';
    }
    return null;
  }, [enabled, ids.active]));
  const waitingOnImage = useBackgroundImagesStore(React.useCallback((state): CollapsedActivityState => {
    if (!enabled) return null;
    for (const sessionId of ids.active) {
      if (state.sessionIds.has(sessionId)) return 'active';
    }
    return null;
  }, [enabled, ids.active]));
  const waitingOnPullRequest = usePrWatchStore(React.useCallback((state): CollapsedActivityState => {
    if (!enabled) return null;
    for (const sessionId of ids.active) {
      if (state.bySession.has(sessionId)) return 'active';
    }
    return null;
  }, [enabled, ids.active]));
  const waitingOnExtension = useExtensionWaitsStore(React.useCallback((state): CollapsedActivityState => {
    if (!enabled) return null;
    for (const sessionId of ids.active) {
      if (state.bySession.has(sessionId)) return 'active';
    }
    return null;
  }, [enabled, ids.active]));
  const unread = useGlobalSessionsStore(React.useCallback((state): CollapsedActivityState => {
    if (!enabled) return null;
    for (const sessionId of ids.unread) {
      if (isSessionUnread(state.entityById.get(sessionId))) return 'unread';
    }
    return null;
  }, [enabled, ids.unread]));
  const blocked = useGlobalBlockingRequestsStore(React.useCallback((state): CollapsedActivityState => {
    if (!enabled) return null;
    let result: CollapsedActivityState = null;
    for (const sessionId of blockingIds) {
      const pending = state.bySession.get(sessionId);
      if (!pending) continue;
      if (pending.permissions.length > 0) return 'permission';
      if (pending.forms.length > 0 || pending.pages.length > 0) result = 'form';
    }
    return result;
  }, [enabled, blockingIds]));
  return blocked ?? active ?? waitingOnShell ?? waitingOnImage ?? waitingOnPullRequest ?? waitingOnExtension ?? unread;
};
