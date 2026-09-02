import React from 'react';
import { isDesktopShell } from '@/lib/desktop';
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

/**
 * Ceiling on how long the first unscoped snapshot may sit in idle time, so a
 * permanently busy main thread cannot strand global-cache consumers.
 */
export const GLOBAL_SESSIONS_IDLE_LOAD_TIMEOUT_MS = 5_000;

type ScheduleInterval = (callback: () => void, delay: number) => number;
type ClearScheduledInterval = (intervalId: number) => void;
type SubscribeToRecoverySignals = (onSignal: () => void) => () => void;
type WaitForInitialScopedLoad = (onSettled: () => void) => () => void;
/** Defers work to idle time and returns its canceller. */
type ScheduleIdleWork = (callback: () => void, timeoutMs: number) => () => void;

/**
 * Desktop covers the global cache on demand only. The complete snapshot walks
 * every project the OpenCode server knows, which on a local machine is real
 * sustained filesystem work — a 60s sample caught the managed process reading
 * three unrelated project trees, and the antivirus backlog cost more CPU than
 * OpenCode. Idle deferral moved when that ran without removing it. Web and
 * VS Code address a server they do not own, so they keep the eager load.
 */
export const shouldLoadInitialGlobalSnapshot = (): boolean => !isDesktopShell();

export type GlobalSessionsPollingRuntime = {
  /** Omitted, this surface has no automatic snapshot: nothing waits, nothing queues. */
  initialLoad?: () => void;
  /** Sequences the first unscoped load after scoped startup; omitted, it runs on start. */
  waitForInitialScopedLoad?: WaitForInitialScopedLoad;
  /** Defers the first unscoped load off the interactive path; omitted, it runs inline. */
  scheduleIdleWork?: ScheduleIdleWork;
  refresh: () => void;
  now: () => number;
  scheduleInterval: ScheduleInterval;
  clearScheduledInterval: ClearScheduledInterval;
  subscribeToRecoverySignals: SubscribeToRecoverySignals;
};

/**
 * Falls back to the next task, not a delay: a runtime without
 * `requestIdleCallback` should yield the current frame rather than wait out a
 * guessed interval.
 */
export const scheduleBrowserIdleWork: ScheduleIdleWork = (callback, timeoutMs) => {
  const requestIdle = window.requestIdleCallback;
  if (requestIdle) {
    const handle = requestIdle.call(window, callback, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(handle);
  }
  const timeoutId = window.setTimeout(callback, 0);
  return () => window.clearTimeout(timeoutId);
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
  let initialLoadScheduled = false;
  let initialLoadStarted = false;
  let cancelIdleLoad: () => void = () => {};

  const runInitialLoad = () => {
    if (disposed || initialLoadStarted) return;
    initialLoadStarted = true;
    lastRefreshAt = runtime.now();
    runtime.initialLoad?.();
  };

  // A settled scoped bootstrap only stops the snapshot competing with bootstrap
  // requests. It still enumerates every project the server knows, which pinned
  // the managed OpenCode process while the app became interactive.
  const scheduleInitialLoad = () => {
    if (disposed || initialLoadScheduled) return;
    initialLoadScheduled = true;
    if (!runtime.scheduleIdleWork) {
      runInitialLoad();
      return;
    }
    cancelIdleLoad = runtime.scheduleIdleWork(runInitialLoad, GLOBAL_SESSIONS_IDLE_LOAD_TIMEOUT_MS);
  };

  const startInitialLoadSequence = (): (() => void) => {
    if (!runtime.initialLoad) return () => {};
    if (runtime.waitForInitialScopedLoad) return runtime.waitForInitialScopedLoad(scheduleInitialLoad);
    scheduleInitialLoad();
    return () => {};
  };
  const cancelInitialLoadWait = startInitialLoadSequence();

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
    cancelIdleLoad();
    unsubscribe();
    runtime.clearScheduledInterval(backstopId);
  };
};

/** Owns the one global-session polling lifecycle for the main app runtime. */
export const useGlobalSessionsPolling = (enabled: boolean): void => {
  React.useEffect(() => {
    if (!enabled) return;

    return startGlobalSessionsPolling({
      initialLoad: shouldLoadInitialGlobalSnapshot()
        ? () => { void ensureGlobalSessionsLoaded(getAllSyncSessions()); }
        : undefined,
      waitForInitialScopedLoad: subscribeToInitialScopedDirectoryLoad,
      scheduleIdleWork: scheduleBrowserIdleWork,
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
