import React from 'react';
import { getAllSyncSessions } from '@/sync/sync-refs';
import {
  ensureGlobalSessionsLoaded,
  refreshGlobalSessions,
  useGlobalSessionsStore,
} from '@/stores/useGlobalSessionsStore';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { seedGlobalSessionStatusFromHost } from '@/sync/host-session-status-seed';

export const GLOBAL_SESSIONS_REFRESH_INTERVAL_MS = 45_000;
const STARTUP_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

type ScheduleTimeout = (callback: () => void, delay: number) => number;
type ClearTimeout = (timeoutId: number) => void;

export const startGlobalSessionsPolling = (
  initialLoad: () => Promise<boolean>,
  refresh: () => Promise<boolean>,
  scheduleTimeout: ScheduleTimeout = window.setTimeout.bind(window),
  clearScheduledTimeout: ClearTimeout = window.clearTimeout.bind(window),
): (() => void) => {
  let disposed = false;
  let timeoutId: number | undefined;
  let startupRetries = 0;
  let hasSucceeded = false;
  const run = async (load: () => Promise<boolean>) => {
    const succeeded = await load().catch(() => false);
    if (disposed) return;
    hasSucceeded ||= succeeded;
    const retryDelay = !hasSucceeded ? STARTUP_RETRY_DELAYS_MS[startupRetries] : undefined;
    if (retryDelay !== undefined) startupRetries += 1;
    timeoutId = scheduleTimeout(() => {
      timeoutId = undefined;
      void run(refresh);
    }, retryDelay ?? GLOBAL_SESSIONS_REFRESH_INTERVAL_MS);
  };
  void run(initialLoad);
  return () => {
    disposed = true;
    if (timeoutId !== undefined) clearScheduledTimeout(timeoutId);
  };
};

/**
 * Owns the one global-session polling lifecycle for the main app runtime.
 *
 * Each load is followed by the host status seed: unopened directories are
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
      const stop = startGlobalSessionsPolling(() => load(true), () => load(false));
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
