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

/**
 * Services that run with nobody asking: `service.keepRunning` and
 * `service.schedule`. The catalog decides, at every `reconcile()` and again
 * before every run, so a pause or a withdrawn approval ends both.
 *
 * A kept service is started once and held, which suspends any role's idle
 * stop. A check every `CHECK_INTERVAL_MS` brings a stopped one back, and a
 * process that keeps dying waits longer each time, up to `RESTART_DELAY_MAX_MS`.
 *
 * A scheduled run is at most once: a run missed while the host was down, or
 * that the service failed to take, is gone. Each host arms its own timers.
 */

const CHECK_INTERVAL_MS = 15_000;
const RESTART_DELAY_MIN_MS = 5_000;
const RESTART_DELAY_MAX_MS = 5 * 60_000;
/** A timer past this is armed again rather than left to overflow `setTimeout`. */
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
  /** Per guest: the kept service's latest row, hold and restart state. */
  const kept = new Map();
  /** Per `<guestId>:<scheduleId>`: the armed timer and the cron it was armed from. */
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
        // A restart reads the catalog first: a grant withdrawn while the
        // process ran must not start it again.
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
    // The catalog decides at the moment of the run: a pause since arming ends it.
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

  /** The catalog changed, or the host started: bring the running set to what it says. */
  const reconcile = async () => {
    if (stopped) return;
    let guests;
    try {
      guests = await listGuests();
    } catch {
      // A catalog that cannot be read changes nothing: it is not an empty catalog.
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
