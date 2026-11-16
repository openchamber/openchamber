import React from 'react';

import type { SessionNode } from '@/components/session/sidebar/types';
import { selectBlockingBadgeSessionScopes } from '@/components/session/sidebar/sessions/sessionNodeItemUtils';
import { useSessionBlockingRequests } from '@/sync/sync-context';
import type { BlockingRequestKinds } from '@/sync/global-blocking-requests';

export type PendingRequests = BlockingRequestKinds;

export const usePendingRequests = (
  node: SessionNode,
  isExpanded: boolean,
  fallbackDirectory: string | null,
): PendingRequests => {
  const scopes = React.useMemo(
    () => selectBlockingBadgeSessionScopes(node, isExpanded, fallbackDirectory),
    [fallbackDirectory, isExpanded, node],
  );
  return useSessionBlockingRequests(scopes);
};
