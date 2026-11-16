
export const HEALTH_WAIT_MAX_MS = 8_000;
const HEALTH_WAIT_INTERVAL_MS = 100;

export const parseHealthWaitMs = (value) => {
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) return 0;
  return Math.min(Number(value), HEALTH_WAIT_MAX_MS);
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const createSharedHealthProbe = ({ probe, intervalMs = HEALTH_WAIT_INTERVAL_MS, now = Date.now }) => {
  let latest = null;
  return () => {
    const startedAt = now();
    if (latest && startedAt - latest.startedAt < intervalMs) return latest.result;
    const result = probe();
    latest = { startedAt, result };
    result.catch(() => {
      if (latest?.result === result) latest = null;
    });
    return result;
  };
};

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
