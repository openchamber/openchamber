
import { isString } from '../shared/guards.js';
import type { QueryValue } from '../shared/http-contracts.js';

export const HEALTH_WAIT_MAX_MS = 8_000;
const HEALTH_WAIT_INTERVAL_MS = 100;

export const parseHealthWaitMs = (value: QueryValue | undefined) => {
  if (!isString(value) || !/^\d{1,6}$/.test(value)) return 0;
  return Math.min(Number(value), HEALTH_WAIT_MAX_MS);
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface SharedHealthProbeOptions<Result> {
  probe: () => Promise<Result>;
  intervalMs?: number;
  now?: () => number;
}

export const createSharedHealthProbe = <Result>({ probe, intervalMs = HEALTH_WAIT_INTERVAL_MS, now = Date.now }: SharedHealthProbeOptions<Result>) => {
  let latest: { startedAt: number; result: Promise<Result> } | null = null;
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

export interface HealthWaitOptions<Result> extends SharedHealthProbeOptions<Result> {
  waitMs: number;
  isAborted?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export const waitForOpenCodeHealth = async <Result extends { healthy: boolean; final?: boolean }>({
  probe,
  waitMs,
  isAborted = () => false,
  intervalMs = HEALTH_WAIT_INTERVAL_MS,
  now = Date.now,
  sleep = defaultSleep,
}: HealthWaitOptions<Result>) => {
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
