import type { Session } from '@/lib/opencode/model';
import React from 'react';
import type { SessionNode } from '../types';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { useNotificationStore } from '@/sync/notification-store';

// Ordered by how much the user is needed: a blocked turn outranks a running
// one, which outranks something merely unread.
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
  includeUnreadSubtasks: boolean,
): CollapsedActivityState => {
  if (activeSessionIds.has(node.session.id)) return 'active';

  let state: CollapsedActivityState = null;
  // SAFETY: SessionNode sessions are SDK Session records; parentID is the optional hierarchy field.
  const isSubtask = Boolean((node.session as Session & { parentID?: string | null }).parentID);
  if (unreadSessionIds.has(node.session.id) && (includeUnreadSubtasks || !isSubtask)) state = 'unread';

  for (const child of node.children) {
    state = mergeCollapsedActivityStates(
      state,
      getSessionNodeActivityState(child, activeSessionIds, unreadSessionIds, includeUnreadSubtasks),
    );
    if (state === 'active') return state;
  }

  return state;
};

export const getSessionNodesActivityState = (
  nodes: SessionNode[],
  activeSessionIds: Set<string>,
  unreadSessionIds: Set<string>,
  includeUnreadSubtasks: boolean,
): CollapsedActivityState => {
  let state: CollapsedActivityState = null;
  for (const node of nodes) {
    state = mergeCollapsedActivityStates(
      state,
      getSessionNodeActivityState(node, activeSessionIds, unreadSessionIds, includeUnreadSubtasks),
    );
    if (state === 'active') return state;
  }
  return state;
};

type SessionActivityProps = {
  nodes: readonly SessionNode[];
  // Sessions not present as nodes whose pending requests still count, such as
  // the hidden subagents of timeline rows.
  blockingSessionIds?: readonly string[];
  includeUnreadSubtasks: boolean;
};

const collectActivityIds = (nodes: readonly SessionNode[], includeUnreadSubtasks: boolean) => {
  const active = new Set<string>();
  const unread = new Set<string>();
  const visit = (node: SessionNode, isSubtask: boolean): void => {
    active.add(node.session.id);
    if (!isSubtask || includeUnreadSubtasks) unread.add(node.session.id);
    node.children.forEach((child) => visit(child, true));
  };
  nodes.forEach((node) => visit(node, false));
  return { active, unread };
};

export const useCollapsedSessionActivityState = ({
  nodes,
  blockingSessionIds,
  includeUnreadSubtasks,
  enabled = true,
}: SessionActivityProps & { enabled?: boolean }): CollapsedActivityState => {
  const ids = React.useMemo(() => collectActivityIds(enabled ? nodes : [], includeUnreadSubtasks), [enabled, includeUnreadSubtasks, nodes]);
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
  // A session idling while its background command runs is still at work.
  const waitingOnShell = useBackgroundShellsStore(React.useCallback((state): CollapsedActivityState => {
    if (!enabled) return null;
    for (const sessionId of ids.active) {
      if (state.sessionIds.has(sessionId)) return 'active';
    }
    return null;
  }, [enabled, ids.active]));
  const unread = useNotificationStore(React.useCallback((state): CollapsedActivityState => {
    if (!enabled) return null;
    for (const sessionId of ids.unread) {
      if ((state.index.session.unseenCount[sessionId] ?? 0) > 0) return 'unread';
    }
    return null;
  }, [enabled, ids.unread]));
  // Pending requests come from the cross-directory index, which every
  // directory feeds live and the host seeds, so a collapsed group in a project
  // that was never opened still shows the request. Subtasks count too: a
  // permission asked by a subagent blocks the whole family.
  const blocked = useGlobalBlockingRequestsStore(React.useCallback((state): CollapsedActivityState => {
    if (!enabled) return null;
    let result: CollapsedActivityState = null;
    for (const sessionId of blockingIds) {
      const pending = state.bySession.get(sessionId);
      if (!pending) continue;
      if (pending.permissions.length > 0) return 'permission';
      if (pending.forms.length > 0) result = 'form';
    }
    return result;
  }, [enabled, blockingIds]));
  return blocked ?? active ?? waitingOnShell ?? unread;
};
