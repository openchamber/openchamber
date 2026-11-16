import React from 'react';

import { getWorktreeBootstrapState, subscribeWorktreeBootstrapState } from '@/lib/worktrees/worktreeBootstrap';

export const useWorktreeBootstrapPending = (directory: string | null): boolean => {
  const getSnapshot = React.useCallback(
    () => (directory ? getWorktreeBootstrapState(directory)?.status === 'pending' : false),
    [directory],
  );
  return React.useSyncExternalStore(subscribeWorktreeBootstrapState, getSnapshot, getSnapshot);
};
