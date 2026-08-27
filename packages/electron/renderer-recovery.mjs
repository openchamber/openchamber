const RECOVERY_WINDOW_MS = 60_000;
const MAX_RECOVERY_ATTEMPTS = 3;

const RECOVERABLE_REASONS = new Set([
  'abnormal-exit',
  'crashed',
  'oom',
  'memory-eviction',
]);

export const createRendererRecoveryPolicy = (now = Date.now) => {
  let windowStartedAt = 0;
  let attempts = 0;

  return {
    shouldReload: (reason) => {
      if (!RECOVERABLE_REASONS.has(reason)) return false;

      const currentTime = now();
      if (currentTime - windowStartedAt >= RECOVERY_WINDOW_MS) {
        windowStartedAt = currentTime;
        attempts = 0;
      }
      if (attempts >= MAX_RECOVERY_ATTEMPTS) return false;

      attempts += 1;
      return true;
    },
  };
};
