import React from 'react';

import { getWorktreeBootstrapState, subscribeWorktreeBootstrapState } from '@/lib/worktrees/worktreeBootstrap';

/**
 * Whether `directory` is a worktree whose creation has not finished yet: the
 * directory exists, but setup commands and the initial git reset are still
 * running. Until that completes the working tree transiently looks dirty, so
 * surfaces that report uncommitted changes consult this and show nothing
 * instead of presenting bootstrap noise as real changes on the branch.
 */
export const useWorktreeBootstrapPending = (directory: string | null): boolean => {
  const getSnapshot = React.useCallback(
    () => (directory ? getWorktreeBootstrapState(directory)?.status === 'pending' : false),
    [directory],
  );
  return React.useSyncExternalStore(subscribeWorktreeBootstrapState, getSnapshot, getSnapshot);
};
