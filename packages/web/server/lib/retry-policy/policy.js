/** The command the managed plugin registers for the retry chip's action. */
export const RETRY_NOW_COMMAND = 'openchamber-retry-now';

/** The longest wait the setting accepts, so a bad value cannot park a retry for hours. */
export const RETRY_WAIT_MAX_MS = 15 * 60 * 1000;

/**
 * Whether the managed OpenCode should load the retry-policy plugin. A cap
 * shortens the wait; the retry-now control holds it so the user can end it.
 * Either one needs the plugin.
 */
export const isRetryPolicyConfigured = (settings) => {
  const value = settings?.retryWaitMaxMs;
  return (Number.isFinite(value) && value > 0) || settings?.retryNowEnabled === true;
};
