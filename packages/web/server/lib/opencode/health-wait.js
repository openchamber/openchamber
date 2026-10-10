// Readiness long-poll for `GET /api/opencode/health?wait=<ms>`.
//
// A starting client asks once and the server answers the moment OpenCode is
// ready, instead of the client polling with growing gaps and noticing readiness
// seconds late. Only the server talks to OpenCode while waiting, over loopback,
// and only while a client is waiting.

export const HEALTH_WAIT_MAX_MS = 8_000;
const HEALTH_WAIT_INTERVAL_MS = 100;

/** Parses the `wait` query: a whole number of milliseconds, capped; anything else is no wait. */
export const parseHealthWaitMs = (value) => {
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) return 0;
  return Math.min(Number(value), HEALTH_WAIT_MAX_MS);
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shares probes among concurrent waiters: a probe started less than
 * `intervalMs` ago is answered from its result instead of asking OpenCode
 * again, so any number of waiting clients cost at most one probe per interval.
 */
export const createSharedHealthProbe = ({ probe, intervalMs = HEALTH_WAIT_INTERVAL_MS, now = Date.now }) => {
  let latest = null;
  return () => {
    const startedAt = now();
    if (latest && startedAt - latest.startedAt < intervalMs) return latest.result;
    const result = probe();
    latest = { startedAt, result };
    // A failed probe must not be reused; the next waiter asks again.
    result.catch(() => {
      if (latest?.result === result) latest = null;
    });
    return result;
  };
};

/**
 * Probes until a probe reports healthy, the wait runs out, or the client goes
 * away, and returns the last probe. `probe` resolves `{ healthy, status, body }`
 * and sets `final` when waiting cannot change the answer (an OpenCode version
 * OpenChamber does not support), which is returned at once.
 */
export const waitForOpenCodeHealth = async ({
  probe,
  waitMs,
  isAborted = () => false,
  intervalMs = HEALTH_WAIT_INTERVAL_MS,
  now = Date.now,
  sleep = defaultSleep,
}) => {
  const deadline = now() + waitMs;
  let result = await probe();
  while (!result.healthy && !result.final && !isAborted()) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
    if (isAborted()) break;
    result = await probe();
  }
  return result;
};
