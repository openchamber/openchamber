import { useSyncExternalStore } from 'react';

const TICK_INTERVAL_MS = 60_000;

let tickAt: number = Date.now();
let cachedSnapshot = tickAt;
let intervalId: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<() => void>();

const notifySubscribers = (): void => {
  for (const fn of subscribers) {
    fn();
  }
};

const refreshTick = (): void => {
  tickAt = Date.now();
  cachedSnapshot = tickAt;
};

const startInterval = (): void => {
  if (intervalId !== null) return;
  // Refresh immediately: the interval may have been stopped for a while
  // (e.g. user was on a non-chat page), so tickAt could be stale.
  refreshTick();
  intervalId = setInterval(() => {
    refreshTick();
    notifySubscribers();
  }, TICK_INTERVAL_MS);
};

const stopInterval = (): void => {
  if (intervalId === null) return;
  clearInterval(intervalId);
  intervalId = null;
};

const subscribe = (callback: () => void): (() => void) => {
  subscribers.add(callback);
  if (subscribers.size === 1) {
    startInterval();
  }
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) {
      stopInterval();
    }
  };
};

const getSnapshot = (): number => {
  if (cachedSnapshot !== tickAt) {
    cachedSnapshot = tickAt;
  }
  return cachedSnapshot;
};

// Browsers throttle setInterval in background tabs. Refresh immediately
// when the page becomes visible again so timestamps aren't stale.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && subscribers.size > 0) {
      refreshTick();
      notifySubscribers();
    }
  });
}

export const useRelativeTick = (): number => {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

export const __resetRelativeTickForTests = (): void => {
  stopInterval();
  subscribers.clear();
  refreshTick();
};
