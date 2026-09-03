const DEFAULT_INTERVAL_MS = 100;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Wait for an owner-scoped Guardian health result. The caller supplies the
 * GuardianClient-backed check so managed readiness cannot accidentally fall
 * through to a port-wide HTTP probe or a caller-owned Basic Auth header.
 */
export const waitForGuardianManagedOpenCodeReady = async ({
  check,
  timeoutMs = 10_000,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = Date.now,
  sleepFn = sleep,
} = {}) => {
  if (typeof check !== 'function') {
    throw new TypeError('Guardian readiness requires an owner-scoped health check');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('Guardian readiness timeout must be a non-negative number');
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new TypeError('Guardian readiness interval must be a non-negative number');
  }

  const deadline = now() + timeoutMs;
  let lastError = null;
  while (now() < deadline || timeoutMs === 0) {
    try {
      const result = await check();
      if (result?.healthy === true) return result;
      lastError = new Error(result?.reason || 'Guardian-managed OpenCode health check failed');
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (timeoutMs === 0 || now() >= deadline) break;
    await sleepFn(Math.min(intervalMs, Math.max(0, deadline - now())));
  }

  const error = lastError || new Error('Timed out waiting for Guardian-managed OpenCode to become ready');
  error.code = error.code || 'GUARDIAN_HEALTH_TIMEOUT';
  throw error;
};
