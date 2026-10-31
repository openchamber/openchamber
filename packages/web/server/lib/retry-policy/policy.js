/** The longest wait the setting accepts, so a bad value cannot park a retry for hours. */
export const RETRY_WAIT_MAX_MS = 15 * 60 * 1000;

/**
 * Whether the managed OpenCode should load the retry-policy plugin. An unset
 * or zero cap keeps OpenCode's own retry schedule.
 */
export const isRetryPolicyConfigured = (settings) => {
  const value = settings?.retryWaitMaxMs;
  return Number.isFinite(value) && value > 0;
};
