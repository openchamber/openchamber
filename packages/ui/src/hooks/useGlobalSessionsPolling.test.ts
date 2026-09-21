import { describe, expect, test } from 'bun:test';
import {
  GLOBAL_SESSIONS_REFRESH_INTERVAL_MS,
  startGlobalSessionsPolling,
} from './useGlobalSessionsPolling';

describe('global sessions polling lifecycle', () => {
  test('loads immediately, owns one interval, and clears it on disposal', () => {
    let initialLoads = 0;
    let refreshes = 0;
    let scheduledCallback = () => {};
    let scheduledIntervals = 0;
    let scheduledDelay = 0;
    let clearedIntervalId: number | null = null;

    const dispose = startGlobalSessionsPolling(
      () => { initialLoads += 1; },
      () => { refreshes += 1; },
      (callback, delay) => {
        scheduledIntervals += 1;
        scheduledCallback = callback;
        scheduledDelay = delay;
        return 42;
      },
      (intervalId) => { clearedIntervalId = intervalId; },
    );

    expect(initialLoads).toBe(1);
    expect(refreshes).toBe(0);
    expect(scheduledIntervals).toBe(1);
    expect(scheduledDelay).toBe(GLOBAL_SESSIONS_REFRESH_INTERVAL_MS);

    scheduledCallback();
    expect(refreshes).toBe(1);

    dispose();
    expect(clearedIntervalId).toBe(42);
  });
});
