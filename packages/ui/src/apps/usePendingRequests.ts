import React from 'react';

import { selectBlockingBadgeSessionScopes } from '@/components/session/sidebar/sessions/sessionNodeItemUtils';
import type { SessionNode } from '@/components/session/sidebar/types';
import { useSessionBlockingRequests } from '@/sync/sync-context';

export type PendingRequests = { hasPermission: boolean; hasForm: boolean };

export const usePendingRequests = (
  node: SessionNode,
  expanded: boolean,
  showSubagentSessions: boolean,
  sessionDirectory: string | null,
): PendingRequests => {
  const scopes = React.useMemo(
    () => selectBlockingBadgeSessionScopes(node, expanded, sessionDirectory, showSubagentSessions),
    [expanded, node, sessionDirectory, showSubagentSessions],
  );
  return useSessionBlockingRequests(scopes);
};
