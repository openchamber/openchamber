import React from 'react';
import { getAllSyncSessions } from '@/sync/sync-refs';
import {
  ensureGlobalSessionsLoaded,
  refreshGlobalSessions,
  useGlobalSessionsStore,
} from '@/stores/useGlobalSessionsStore';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { seedGlobalSessionStatusFromHost } from '@/sync/host-session-status-seed';
import { subscribeFirstServerConnect } from '@/sync/first-server-connect';

export const GLOBAL_SESSIONS_REFRESH_INTERVAL_MS = 45_000;
export const GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS = 10 * 60_000;
const STARTUP_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

type ScheduleTimeout = (callback: () => void, delay: number) => number;
type ClearTimeout = (timeoutId: number) => void;

/** Whether anyone can see the app, and a way to hear when they can again. */
type PollingVisibility = {
  isHidden: () => boolean;
  onVisible: (listener: () => void) => () => void;
};

const NEVER_HIDDEN: PollingVisibility = { isHidden: () => false, onVisible: () => () => undefined };

/** Hears when OpenCode first answers, the moment a failed startup load can succeed. */
type SubscribeServerReady = (listener: () => void) => () => void;

const NEVER_READY: SubscribeServerReady = () => () => undefined;

const documentVisibility = (): PollingVisibility => {
  if (typeof document === 'undefined') return NEVER_HIDDEN;
  return {
    isHidden: () => document.visibilityState === 'hidden',
    onVisible: (listener) => {
      let wasHidden = document.visibilityState === 'hidden';
      const handle = () => {
        const hidden = document.visibilityState === 'hidden';
        if (wasHidden && !hidden) listener();
        wasHidden = hidden;
      };
      const focus = () => { if (wasHidden && document.visibilityState !== 'hidden') handle(); };
      document.addEventListener('visibilitychange', handle);
      window.addEventListener('focus', focus);
      return () => {
        document.removeEventListener('visibilitychange', handle);
        window.removeEventListener('focus', focus);
      };
    },
  };
};

export const startGlobalSessionsPolling = (
  initialLoad: () => Promise<boolean>,
  refresh: () => Promise<boolean>,
  scheduleTimeout: ScheduleTimeout = window.setTimeout.bind(window),
  clearScheduledTimeout: ClearTimeout = window.clearTimeout.bind(window),
  visibility: PollingVisibility = NEVER_HIDDEN,
  subscribeServerReady: SubscribeServerReady = NEVER_READY,
  headCheck: () => Promise<boolean> = refresh,
  now: () => number = Date.now,
): (() => void) => {
  let disposed = false;
  let timeoutId: number | undefined;
  let startupRetries = 0;
  let hasSucceeded = false;
  let running = false;
  // OpenCode answered while a load that started before it was in flight.
  let readyDuringRun = false;
  let fullRefreshPending = false;
  let lastFullRefreshAt = Number.NEGATIVE_INFINITY;
  const run = async (load: () => Promise<boolean>, full = true) => {
    running = true;
    readyDuringRun = false;
    const succeeded = await load().catch(() => false);
    running = false;
    if (disposed) return;
    hasSucceeded ||= succeeded;
    if (full && succeeded) lastFullRefreshAt = now();
    if (fullRefreshPending) {
      fullRefreshPending = false;
      void run(refresh);
      return;
    }
    if (!hasSucceeded && readyDuringRun) {
      // That load may have failed only because OpenCode was still starting.
      void run(refresh);
      return;
    }
    const retryDelay = !hasSucceeded ? STARTUP_RETRY_DELAYS_MS[startupRetries] : undefined;
    if (retryDelay !== undefined) startupRetries += 1;
    const untilFullRefresh = GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS - (now() - lastFullRefreshAt);
    const delay = untilFullRefresh > 0
      ? Math.min(GLOBAL_SESSIONS_REFRESH_INTERVAL_MS, untilFullRefresh)
      : full ? GLOBAL_SESSIONS_REFRESH_INTERVAL_MS : 0;
    timeoutId = scheduleTimeout(() => {
      timeoutId = undefined;
      if (visibility.isHidden()) {
        return;
      }
      const fullDue = !hasSucceeded || now() - lastFullRefreshAt >= GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS;
      void run(fullDue ? refresh : headCheck, fullDue);
    }, retryDelay ?? delay);
  };
  const stopListening = visibility.onVisible(() => {
    if (disposed) return;
    if (timeoutId !== undefined) clearScheduledTimeout(timeoutId);
    timeoutId = undefined;
    if (running) { fullRefreshPending = true; return; }
    void run(refresh);
  });
  // Until a load succeeds, OpenCode answering ends the wait for the next
  // retry, which after the startup retries is the full refresh interval.
  const stopReadyListening = subscribeServerReady(() => {
    if (disposed || hasSucceeded) return;
    if (running) {
      readyDuringRun = true;
      return;
    }
    if (timeoutId !== undefined) clearScheduledTimeout(timeoutId);
    timeoutId = undefined;
    void run(refresh);
  });
  void run(initialLoad);
  return () => {
    disposed = true;
    stopListening();
    stopReadyListening();
    if (timeoutId !== undefined) clearScheduledTimeout(timeoutId);
  };
};

/**
 * Owns the one global-session polling lifecycle for the main app runtime.
 * The timed refresh pauses while the document is hidden: live events keep
 * the list current, and becoming visible runs a complete snapshot.
 *
 * Each complete load is followed by the host status seed: unopened directories are
 * never bootstrapped, so a turn already running there when this client
 * started is only known to the host's cross-project map. The seed resolves
 * directories from the list just loaded, which is why it runs after it.
 */
export const useGlobalSessionsPolling = (enabled: boolean): void => {
  React.useEffect(() => {
    if (!enabled) return;

    const start = () => {
      const runtimeKey = getRuntimeKey();
      let active = true;
      const load = async (initial: boolean): Promise<boolean> => {
        if (initial) await ensureGlobalSessionsLoaded(getAllSyncSessions());
        else await refreshGlobalSessions();
        if (!active || getRuntimeKey() !== runtimeKey) return false;
        void seedGlobalSessionStatusFromHost();
        // The store preserves cached sessions on failure instead of throwing.
        return useGlobalSessionsStore.getState().status === 'ready';
      };
      const stop = startGlobalSessionsPolling(
        () => load(true),
        () => load(false),
        window.setTimeout.bind(window),
        window.clearTimeout.bind(window),
        documentVisibility(),
        (listener) => subscribeFirstServerConnect((connectedRuntimeKey) => {
          if (connectedRuntimeKey === runtimeKey) listener();
        }),
        () => useGlobalSessionsStore.getState().refreshSessionHead(),
      );
      return () => { active = false; stop(); };
    };
    let stop = start();
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      stop();
      stop = start();
    });
    return () => {
      unsubscribe();
      stop();
    };
  }, [enabled]);
};
