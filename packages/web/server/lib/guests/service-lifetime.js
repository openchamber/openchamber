import { randomUUID } from 'node:crypto';

import { CronExpressionParser } from 'cron-parser';

import {
  SERVICE_SCHEDULE_IDLE_MS,
  SERVICE_SCHEDULE_PATH,
  SERVICE_SCHEDULE_TIMEOUT_MS,
  SERVICE_SCHEDULE_WIRE_VERSION,
  isGuestApproved,
  requestedGuestCapabilities,
} from '@openchamber/sdk';


const CHECK_INTERVAL_MS = 15_000;
const RESTART_DELAY_MIN_MS = 5_000;
const RESTART_DELAY_MAX_MS = 5 * 60_000;
// external: https://nodejs.org/api/timers.html#settimeoutcallback-delay-args Delays above 2147483647 become 1 ms, so distant runs rearm the timer.
const TIMER_MAX_MS = 2 ** 31 - 1;
const RESULT_MAX = 4_096;
const HEALTH_PATH = '/health';

const eligible = (guest) => {
  const granted = Array.isArray(guest?.capabilityGrants) ? guest.capabilityGrants : [];
  return Boolean(guest?.service)
    && guest.enabled !== false
    && granted.includes('service')
    && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted });
};

const nextRunAt = (entry, from) => {
  try {
    const iterator = CronExpressionParser.parse(entry.cron, {
      currentDate: new Date(from),
      ...(entry.timezone ? { tz: entry.timezone } : {}),
    });
    return iterator.next().getTime();
  } catch {
    return null;
  }
};

/**
 * @param {{
 *   listGuests: () => Promise<object[]>,
 *   proxyServiceRequest: (params: object) => Promise<{ status: number, body: string }>,
 *   holdService: (guestId: string) => () => void,
 *   serviceStatus: (guestId: string) => string,
 *   persistPath: string,
 *   now?: () => number,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, setInterval: typeof setInterval, clearInterval: typeof clearInterval },
 *   createId?: () => string,
 *   warn?: (...args: unknown[]) => void,
 * }} deps
 */
export const createServiceLifetime = ({
  listGuests,
  proxyServiceRequest,
  holdService,
  serviceStatus,
  persistPath,
  now = Date.now,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  createId = () => randomUUID(),
  warn = (...args) => console.warn(...args),
}) => {
  const kept = new Map();
  const armed = new Map();
  let checkTimer = null;
  let stopped = false;

  const request = (guest, params) => proxyServiceRequest({
    guestId: guest.id,
    guestName: guest.name,
    packageRoot: guest.packageRoot,
    service: guest.service,
    granted: guest.capabilityGrants,
    persistPath,
    ...params,
  });

  const startKept = async (entry) => {
    entry.starting = true;
    try {
      await request(entry.guest, { method: 'GET', path: HEALTH_PATH, responseMax: RESULT_MAX });
      entry.failures = 0;
      entry.nextAttemptAt = 0;
    } catch (error) {
      if (error?.code === 'DISABLED' || stopped) return;
      entry.failures += 1;
      const delay = Math.min(RESTART_DELAY_MAX_MS, RESTART_DELAY_MIN_MS * 2 ** (entry.failures - 1));
      entry.nextAttemptAt = now() + delay;
      if (entry.failures === 1) warn(`[service-lifetime] ${entry.guest.id}: its service could not be started (${error?.code ?? 'error'}); trying again`);
    } finally {
      entry.starting = false;
    }
  };

  const needsStart = (entry) => !entry.starting && now() >= entry.nextAttemptAt && serviceStatus(entry.guest.id) !== 'ready';

  const checkKept = () => {
    for (const entry of kept.values()) if (needsStart(entry)) void startKept(entry);
  };

  const releaseKept = (guestId) => {
    const entry = kept.get(guestId);
    if (!entry) return;
    entry.release();
    kept.delete(guestId);
  };

  const reconcileKept = (guests) => {
    const wanted = new Map(guests.filter((guest) => eligible(guest) && guest.service.keepRunning).map((guest) => [guest.id, guest]));
    for (const id of [...kept.keys()]) if (!wanted.has(id)) releaseKept(id);
    for (const [id, guest] of wanted) {
      const entry = kept.get(id);
      if (entry) {
        entry.guest = guest;
        continue;
      }
      kept.set(id, { guest, release: holdService(id), starting: false, failures: 0, nextAttemptAt: 0 });
    }
    if (kept.size > 0 && checkTimer === null) {
      checkTimer = timers.setInterval(() => {
        if ([...kept.values()].some(needsStart)) void reconcile();
      }, CHECK_INTERVAL_MS);
      checkTimer.unref?.();
    }
    if (kept.size === 0 && checkTimer !== null) {
      timers.clearInterval(checkTimer);
      checkTimer = null;
    }
    checkKept();
  };

  const disarm = (key) => {
    const slot = armed.get(key);
    if (!slot) return;
    timers.clearTimeout(slot.timer);
    armed.delete(key);
  };

  const runEntry = async (guestId, entry, at) => {
    let guests;
    try {
      guests = await listGuests();
    } catch {
      return;
    }
    const guest = guests.find((row) => row.id === guestId);
    if (!eligible(guest)) return;
    try {
      const answer = await request(guest, {
        method: 'POST',
        path: SERVICE_SCHEDULE_PATH,
        body: JSON.stringify({ v: SERVICE_SCHEDULE_WIRE_VERSION, requestId: createId(), id: entry.id, at }),
        timeoutMs: SERVICE_SCHEDULE_TIMEOUT_MS,
        idleStopMs: guest.service.keepRunning ? undefined : SERVICE_SCHEDULE_IDLE_MS,
        responseMax: RESULT_MAX,
      });
      if (answer.status < 200 || answer.status >= 300) {
        warn(`[service-lifetime] ${guestId}: the scheduled run "${entry.id}" was answered with HTTP ${answer.status}`);
      }
    } catch (error) {
      warn(`[service-lifetime] ${guestId}: the scheduled run "${entry.id}" failed (${error?.code ?? 'error'})`);
    }
  };

  const arm = (guestId, entry) => {
    const key = `${guestId}:${entry.id}`;
    const at = nextRunAt(entry, now());
    if (at === null) {
      warn(`[service-lifetime] ${guestId}: the schedule "${entry.id}" has a cron expression or timezone that does not parse; it never runs`);
      return;
    }
    const wait = Math.max(0, at - now());
    const timer = timers.setTimeout(() => {
      armed.delete(key);
      if (stopped) return;
      if (wait <= TIMER_MAX_MS) void runEntry(guestId, entry, at);
      arm(guestId, entry);
    }, Math.min(wait, TIMER_MAX_MS));
    timer.unref?.();
    armed.set(key, { timer, cron: entry.cron, timezone: entry.timezone ?? null });
  };

  const reconcileSchedules = (guests) => {
    const wanted = new Map();
    for (const guest of guests) {
      if (!eligible(guest)) continue;
      for (const entry of guest.service.schedule ?? []) wanted.set(`${guest.id}:${entry.id}`, { guestId: guest.id, entry });
    }
    for (const [key, slot] of armed) {
      const next = wanted.get(key);
      if (!next || next.entry.cron !== slot.cron || (next.entry.timezone ?? null) !== slot.timezone) disarm(key);
    }
    for (const [key, { guestId, entry }] of wanted) if (!armed.has(key)) arm(guestId, entry);
  };

  const reconcile = async () => {
    if (stopped) return;
    let guests;
    try {
      guests = await listGuests();
    } catch {
      return;
    }
    if (stopped || !Array.isArray(guests)) return;
    reconcileKept(guests);
    reconcileSchedules(guests);
  };

  const stop = () => {
    stopped = true;
    if (checkTimer !== null) timers.clearInterval(checkTimer);
    checkTimer = null;
    for (const id of [...kept.keys()]) releaseKept(id);
    for (const key of [...armed.keys()]) disarm(key);
  };

  return { reconcile, stop };
};
