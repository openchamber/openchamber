import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { SessionNode } from '../types';
import { collectHiddenRowSessionIds } from './sessionNodeItemUtils';

export function useShowsOpenHiddenSession(
  node: SessionNode,
  isExpanded: boolean,
  showSubagentSessions: boolean,
  chatCovered: boolean,
): boolean {
  const hiddenSessionIds = React.useMemo(
    () => collectHiddenRowSessionIds(node, isExpanded, showSubagentSessions),
    [isExpanded, node, showSubagentSessions],
  );
  return useSessionUIStore((state) => (
    !chatCovered && state.currentSessionId !== null && hiddenSessionIds.has(state.currentSessionId)
  ));
}
