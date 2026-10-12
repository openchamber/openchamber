import React from 'react';

import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';

export type PendingRequests = { hasPermission: boolean; hasForm: boolean };

/**
 * Whether a permission request or a form waits for a row. The answer comes
 * from the cross-directory request index, so a project the phone never opened
 * still shows them. `sessionIds` is the row's own session plus any subsessions
 * it hides: a subagent's request blocks the whole family.
 */
export const usePendingRequests = (sessionIds: readonly string[]): PendingRequests => {
  const hasPermission = useGlobalBlockingRequestsStore(React.useCallback(
    (state) => sessionIds.some((id) => Boolean(state.bySession.get(id)?.permissions.length)),
    [sessionIds],
  ));
  const hasForm = useGlobalBlockingRequestsStore(React.useCallback(
    (state) => sessionIds.some((id) => Boolean(state.bySession.get(id)?.forms.length)),
    [sessionIds],
  ));
  return { hasPermission, hasForm };
};
