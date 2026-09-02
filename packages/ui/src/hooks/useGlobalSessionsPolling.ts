import React from 'react';
import { ensureGlobalSessionsLoaded, refreshGlobalSessionsForDirectories } from '@/stores/useGlobalSessionsStore';
import { useKnownSessionDirectoriesStore } from '@/stores/useKnownSessionDirectoriesStore';
import { getAllSyncSessions, subscribeToInitialScopedDirectoryLoad } from '@/sync/sync-refs';

/** Minimum spacing between two unscoped global refreshes, however many signals arrive. */
export const GLOBAL_SESSIONS_REFRESH_COOLDOWN_MS = 30_000;

/**
 * Coarse backstop for a window that stays visible and focused for hours, so a
 * dropped live event is eventually backfilled without polling every minute.
 */
export const GLOBAL_SESSIONS_BACKSTOP_INTERVAL_MS = 600_000;

type ScheduleInterval = (callback: () => void, delay: number) => number;
type ClearScheduledInterval = (intervalId: number) => void;
type SubscribeToRecoverySignals = (onSignal: () => void) => () => void;
type WaitForInitialScopedLoad = (onSettled: () => void) => () => void;

export type GlobalSessionsPollingRuntime = {
  initialLoad?: () => void;
  /** Sequences the first unscoped load after scoped startup; omitted, it runs on start. */
  waitForInitialScopedLoad?: WaitForInitialScopedLoad;
  refresh: () => void;
  now: () => number;
  scheduleInterval: ScheduleInterval;
  clearScheduledInterval: ClearScheduledInterval;
  subscribeToRecoverySignals: SubscribeToRecoverySignals;
};

/**
 * Browser events that mean this window may have missed live session events:
 * it was hidden, unfocused, restored from bfcache, or the machine resumed.
 */
export const subscribeToBrowserRecoverySignals: SubscribeToRecoverySignals = (onSignal) => {
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') onSignal();
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onSignal);
  window.addEventListener('pageshow', onSignal);
  window.addEventListener('openchamber:system-resume', onSignal);

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onSignal);
    window.removeEventListener('pageshow', onSignal);
    window.removeEventListener('openchamber:system-resume', onSignal);
  };
};

export const startGlobalSessionsPolling = (
  runtime: GlobalSessionsPollingRuntime,
): (() => void) => {
  // The initial load is the first refresh, so signals it races with are redundant.
  let lastRefreshAt = runtime.now();
  let disposed = false;
  let initialLoadStarted = false;

  const runInitialLoad = () => {
    if (disposed || initialLoadStarted) return;
    initialLoadStarted = true;
    lastRefreshAt = runtime.now();
    runtime.initialLoad?.();
  };

  let cancelInitialLoadWait: () => void = () => {};
  if (runtime.waitForInitialScopedLoad) {
    cancelInitialLoadWait = runtime.waitForInitialScopedLoad(runInitialLoad);
  } else {
    runInitialLoad();
  }

  const requestRefresh = () => {
    const requestedAt = runtime.now();
    if (requestedAt - lastRefreshAt < GLOBAL_SESSIONS_REFRESH_COOLDOWN_MS) return;
    lastRefreshAt = requestedAt;
    runtime.refresh();
  };

  const unsubscribe = runtime.subscribeToRecoverySignals(requestRefresh);
  const backstopId = runtime.scheduleInterval(
    requestRefresh,
    GLOBAL_SESSIONS_BACKSTOP_INTERVAL_MS,
  );

  return () => {
    disposed = true;
    cancelInitialLoadWait();
    unsubscribe();
    runtime.clearScheduledInterval(backstopId);
  };
};

/** Owns the one global-session polling lifecycle for the main app runtime. */
export const useGlobalSessionsPolling = (enabled: boolean): void => {
  React.useEffect(() => {
    if (!enabled) return;

    return startGlobalSessionsPolling({
      initialLoad: () => { void ensureGlobalSessionsLoaded(getAllSyncSessions()); },
      waitForInitialScopedLoad: subscribeToInitialScopedDirectoryLoad,
      refresh: () => {
        const directories = [...useKnownSessionDirectoriesStore.getState().directories];
        if (directories.length === 0) return;
        void refreshGlobalSessionsForDirectories(directories, getAllSyncSessions());
      },
      now: Date.now,
      scheduleInterval: window.setInterval.bind(window),
      clearScheduledInterval: window.clearInterval.bind(window),
      subscribeToRecoverySignals: subscribeToBrowserRecoverySignals,
    });
  }, [enabled]);
};
