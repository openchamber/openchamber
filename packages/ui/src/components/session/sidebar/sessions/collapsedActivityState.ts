import type { Session } from '@opencode-ai/sdk/v2';
import React from 'react';
import type { SessionNode } from '../types';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useNotificationStore } from '@/sync/notification-store';

export type CollapsedActivityState = 'active' | 'unread' | null;

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
  nodes: SessionNode[];
  includeUnreadSubtasks: boolean;
};

const collectActivityIds = (nodes: SessionNode[], includeUnreadSubtasks: boolean) => {
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
  includeUnreadSubtasks,
  enabled = true,
}: SessionActivityProps & { enabled?: boolean }): CollapsedActivityState => {
  const ids = React.useMemo(() => collectActivityIds(nodes, includeUnreadSubtasks), [includeUnreadSubtasks, nodes]);
  const active = useGlobalSessionStatusStore(React.useCallback((state): CollapsedActivityState => {
    if (!enabled) return null;
    for (const sessionId of ids.active) {
      const status = state.statusById.get(sessionId)?.status.type;
      if (status === 'busy' || status === 'retry') return 'active';
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
  return active ?? unread;
};
