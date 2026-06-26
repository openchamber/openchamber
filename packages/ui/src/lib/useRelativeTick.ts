import { useSyncExternalStore } from 'react';

const TICK_INTERVAL_MS = 60_000;

let tickAt: number = Date.now();
let intervalId: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<() => void>();

const startInterval = (): void => {
  if (intervalId !== null) return;
  intervalId = setInterval(() => {
    tickAt = Date.now();
    for (const fn of subscribers) {
      fn();
    }
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

let cachedSnapshot = tickAt;
const getSnapshot = (): number => {
  if (cachedSnapshot !== tickAt) {
    cachedSnapshot = tickAt;
  }
  return cachedSnapshot;
};

export const useRelativeTick = (): number => {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

export const __resetRelativeTickForTests = (): void => {
  stopInterval();
  subscribers.clear();
  tickAt = Date.now();
  cachedSnapshot = tickAt;
};
