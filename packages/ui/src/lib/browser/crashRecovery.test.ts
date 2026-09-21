import { describe, expect, test } from 'bun:test';

import {
  CRASH_RECOVERY_BASE_DELAY_MS,
  CRASH_RECOVERY_MAX_ATTEMPTS,
  CRASH_RECOVERY_WINDOW_MS,
  INITIAL_CRASH_RECOVERY_STATE,
  planCrashRecovery,
} from './crashRecovery';

describe('crash recovery', () => {
  test('recovers from the first crash immediately enough to feel automatic', () => {
    const plan = planCrashRecovery(INITIAL_CRASH_RECOVERY_STATE, 1_000);
    expect(plan?.delayMs).toBe(CRASH_RECOVERY_BASE_DELAY_MS);
    expect(plan?.state).toEqual({ attempts: 1, windowStartedAt: 1_000 });
  });

  test('waits longer after each attempt instead of reloading in a tight loop', () => {
    let state = INITIAL_CRASH_RECOVERY_STATE;
    const delays: number[] = [];
    for (let index = 0; index < CRASH_RECOVERY_MAX_ATTEMPTS; index += 1) {
      const plan = planCrashRecovery(state, 1_000 + index);
      expect(plan === null).toBe(false);
      delays.push(plan!.delayMs);
      state = plan!.state;
    }
    expect(delays).toEqual([250, 500, 1000]);
  });

  test('gives up once the attempts in this window are spent', () => {
    let state = INITIAL_CRASH_RECOVERY_STATE;
    for (let index = 0; index < CRASH_RECOVERY_MAX_ATTEMPTS; index += 1) {
      state = planCrashRecovery(state, 1_000)!.state;
    }
    expect(planCrashRecovery(state, 1_000)).toBeNull();
  });

  test('a crash long after the last one starts over rather than staying given up', () => {
    let state = INITIAL_CRASH_RECOVERY_STATE;
    for (let index = 0; index < CRASH_RECOVERY_MAX_ATTEMPTS; index += 1) {
      state = planCrashRecovery(state, 1_000)!.state;
    }
    const later = 1_000 + CRASH_RECOVERY_WINDOW_MS;
    const plan = planCrashRecovery(state, later);
    expect(plan?.delayMs).toBe(CRASH_RECOVERY_BASE_DELAY_MS);
    expect(plan?.state).toEqual({ attempts: 1, windowStartedAt: later });
  });

  test('crashes inside the window keep counting against the same window', () => {
    const first = planCrashRecovery(INITIAL_CRASH_RECOVERY_STATE, 1_000)!;
    const second = planCrashRecovery(first.state, 1_000 + CRASH_RECOVERY_WINDOW_MS - 1)!;
    expect(second.state.windowStartedAt).toBe(1_000);
    expect(second.state.attempts).toBe(2);
  });
});
