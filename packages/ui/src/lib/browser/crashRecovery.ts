export const CRASH_RECOVERY_WINDOW_MS = 30_000;
export const CRASH_RECOVERY_MAX_ATTEMPTS = 3;
export const CRASH_RECOVERY_BASE_DELAY_MS = 250;

export type CrashRecoveryState = {
  readonly attempts: number;
  readonly windowStartedAt: number | null;
};

export const INITIAL_CRASH_RECOVERY_STATE: CrashRecoveryState = {
  attempts: 0,
  windowStartedAt: null,
};

type CrashRecoveryPlan = {
  readonly delayMs: number;
  readonly state: CrashRecoveryState;
};

export const planCrashRecovery = (
  state: CrashRecoveryState,
  now: number,
): CrashRecoveryPlan | null => {
  const startsNewWindow = state.windowStartedAt === null
    || now - state.windowStartedAt >= CRASH_RECOVERY_WINDOW_MS;
  const attempts = startsNewWindow ? 0 : state.attempts;
  if (attempts >= CRASH_RECOVERY_MAX_ATTEMPTS) return null;

  return {
    delayMs: CRASH_RECOVERY_BASE_DELAY_MS * 2 ** attempts,
    state: {
      attempts: attempts + 1,
      windowStartedAt: startsNewWindow ? now : state.windowStartedAt,
    },
  };
};
