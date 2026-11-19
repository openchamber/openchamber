import React from 'react';

import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';

export type PendingRequests = { hasPermission: boolean; hasForm: boolean };

export const usePendingRequests = (sessionIds: readonly string[]): PendingRequests => {
  const hasPermission = useGlobalBlockingRequestsStore(React.useCallback(
    (state) => sessionIds.some((id) => Boolean(state.bySession.get(id)?.permissions.length)),
    [sessionIds],
  ));
  const hasForm = useGlobalBlockingRequestsStore(React.useCallback(
    (state) => sessionIds.some((id) => {
      const pending = state.bySession.get(id);
      return Boolean(pending?.forms.length || pending?.pages.length);
    }),
    [sessionIds],
  ));
  return { hasPermission, hasForm };
};
