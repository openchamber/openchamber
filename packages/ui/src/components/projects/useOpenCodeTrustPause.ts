import React from 'react';

import { isOpenCodeTrustPaused, requestOpenCodeTrust, subscribeOpenCodeTrust } from '@/lib/opencodeTrust';
import { useConfigStore } from '@/stores/useConfigStore';
import { useChildStoreManager } from '@/sync/sync-context';

/** Whether the user declined to trust `directory`, so agents cannot work there. */
export const useOpenCodeTrustPaused = (directory: string | null | undefined): boolean => React.useSyncExternalStore(
  subscribeOpenCodeTrust,
  () => isOpenCodeTrustPaused(directory),
  () => false,
);

/** The first of `directories` the user declined to trust, or null. */
export const useOpenCodeTrustPausedDirectory = (directories: readonly string[]): string | null => React.useSyncExternalStore(
  subscribeOpenCodeTrust,
  () => directories.find((directory) => isOpenCodeTrustPaused(directory)) ?? null,
  () => null,
);

/**
 * Shows the trust prompt for a paused folder again. Once trusted, the folder's
 * sessions and its agents and models load, which the decline left unloaded.
 */
export const useResumeOpenCodeFolder = (): ((directory: string) => Promise<void>) => {
  const childStores = useChildStoreManager();
  return React.useCallback(async (directory: string) => {
    if (!await requestOpenCodeTrust(directory, { deliberate: true })) return;
    childStores.requestBootstrap({ directory, priority: 'selected', reason: 'action-demand', force: true });
    const config = useConfigStore.getState();
    void config.loadProviders({ directory, source: 'trustResumed', fresh: true });
    void config.loadAgents({ directory, source: 'trustResumed', fresh: true });
  }, [childStores]);
};
