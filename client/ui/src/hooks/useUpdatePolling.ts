import React from 'react';

import { useUpdateStore } from '@/stores/useUpdateStore';

export function useUpdatePolling() {
  const checkForUpdates = useUpdateStore((state) => state.checkForUpdates);
  const checkForUpdatesRef = React.useRef(checkForUpdates);

  React.useEffect(() => {
    checkForUpdatesRef.current = checkForUpdates;
  }, [checkForUpdates]);

  React.useEffect(() => {
    const initialDelayMs = 3000;
    const defaultIntervalMs = 60 * 60 * 1000;
    const minIntervalMs = 5 * 60 * 1000;
    const maxIntervalMs = 24 * 60 * 60 * 1000;
    let disposed = false;
    let timer: number | null = null;

    const clampIntervalMs = (seconds: number): number => {
      const ms = Math.round(seconds * 1000);
      return Math.max(minIntervalMs, Math.min(maxIntervalMs, ms));
    };

    const scheduleNext = (delayMs: number) => {
      if (disposed) return;
      timer = window.setTimeout(async () => {
        const suggestedSec = await checkForUpdatesRef.current();
        const nextDelay = typeof suggestedSec === 'number' && Number.isFinite(suggestedSec)
          ? clampIntervalMs(suggestedSec)
          : defaultIntervalMs;
        scheduleNext(nextDelay);
      }, delayMs);
    };

    scheduleNext(initialDelayMs);

    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, []);
}
