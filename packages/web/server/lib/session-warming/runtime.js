/**
 * Per-session warming: keeps the provider's prompt cache of chosen sessions
 * alive while they sit idle, the way OpenCode's `warming` config does for every
 * session at once. See DOCUMENTATION.md.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';

/** Idle time between keep-alive requests; OpenCode's warming default. */
export const WARMING_INTERVAL_MS = 4 * 60 * 1000;
/** The warm durations Settings offers, in minutes; the same steps for OpenCode's global warming. */
const WARMING_DURATION_STEPS = [30, 60, 120, 180];
/** How long after a session's last turn it is kept warm, until Settings picks another step. */
export const DEFAULT_WARMING_MINUTES = 60;
const MINUTE_MS = 60 * 1000;
/**
 * How long to wait before asking OpenCode again when it could not tell whether
 * a session is running: right after a server start OpenCode is still coming up.
 */
const STATUS_RETRY_MS = 30 * 1000;
const PING_TIMEOUT_MS = 2 * 60 * 1000;
const STATUS_TIMEOUT_MS = 10 * 1000;
/**
 * OpenCode's own keep-alive prompt. With its global warming also on, OpenCode
 * recognises the request as a keep-alive and does not restart its window.
 */
const WARMING_PROMPT = 'This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK';

const FILE_NAME = 'session-warming.json';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

export const sessionIdSchema = z.string().regex(SESSION_ID_PATTERN);

export const warmingMinutesSchema = z.number().int().refine((minutes) => WARMING_DURATION_STEPS.includes(minutes));

const storedSchema = z.object({
  enabled: z.boolean().catch(false),
  minutes: warmingMinutesSchema.catch(DEFAULT_WARMING_MINUTES),
  sessions: z.record(z.string(), z.unknown()).catch({}),
});
const storedSessionSchema = z.object({
  directory: z.string().min(1),
  warmUntil: z.number().finite().nullable().catch(null),
});
/** `/api/session/active` lists only the sessions running now; an absent id is idle. */
const activeSessionsSchema = z.record(z.string(), z.unknown());

const statusPayloadSchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({
    sessionID: z.string().min(1),
    status: z.object({ type: z.enum(['busy', 'retry', 'idle']) }),
  }),
});
const deletedPayloadSchema = z.object({
  type: z.literal('session.deleted'),
  properties: z.object({ sessionID: z.string().min(1) }),
});

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {(path: string, directory: string) => string} options.buildOpenCodeUrl
 * @param {() => Record<string, string>} options.getOpenCodeAuthHeaders
 * @param {(event: object) => void} [options.broadcast] Sends an event to every connected client.
 */
export const createSessionWarmingRuntime = ({
  dataDir,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcast = () => {},
  fetchImpl = fetch,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) => {
  const filePath = path.join(dataDir, FILE_NAME);

  let enabled = false;
  let minutes = DEFAULT_WARMING_MINUTES;
  // Starts from the clock so a snapshot after a restart still reads as newer.
  let revision = now();
  let stopped = false;
  let writeChain = Promise.resolve();
  /**
   * Warmed sessions. `warmUntil` is null while a turn runs and while no turn
   * has ended since the toggle; a time in the past means the window ran out and
   * the next turn starts a new one. `epoch` changes with every state change, so
   * a ping or a status read that was in flight across one does not act on it.
   */
  const sessions = new Map(); // sessionId → { directory, warmUntil, timer, epoch }
  /**
   * What the event stream said last about each session, so a toggle knows when
   * its turn ended. Cleared when the stream reconnects: a gap may hide changes.
   */
  const activity = new Map(); // sessionId → { busy, idleAt }

  const snapshot = () => ({
    revision,
    enabled,
    minutes,
    sessions: Array.from(sessions, ([sessionId, entry]) => ({ sessionId, warmUntil: entry.warmUntil })),
  });

  const persist = () => {
    const payload = JSON.stringify({
      enabled,
      minutes,
      sessions: Object.fromEntries(Array.from(sessions, ([sessionId, entry]) => [
        sessionId,
        { directory: entry.directory, warmUntil: entry.warmUntil },
      ])),
    });
    writeChain = writeChain
      .then(async () => {
        await fs.promises.mkdir(dataDir, { recursive: true });
        const tmpPath = `${filePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmpPath, payload, 'utf8');
        await fs.promises.rename(tmpPath, filePath);
      })
      .catch((error) => console.warn('[session-warming] failed to save:', error?.message ?? error));
    return writeChain;
  };

  /** Every change goes through here: persist, then tell the clients. */
  const commit = () => {
    revision += 1;
    void persist();
    broadcast({ type: 'openchamber:session-warming', properties: snapshot() });
  };

  const cancelTimer = (entry) => {
    if (entry.timer) clearTimer(entry.timer);
    entry.timer = null;
    entry.epoch += 1;
  };

  /** Arms `run` at `at` for this entry, dropped if the entry changes first. */
  const armTimer = (sessionId, entry, at, run) => {
    cancelTimer(entry);
    const epoch = entry.epoch;
    entry.timer = setTimer(() => {
      entry.timer = null;
      if (stopped || sessions.get(sessionId) !== entry || entry.epoch !== epoch) return;
      void run(epoch);
    }, Math.max(0, at - now()));
  };

  const isCurrent = (sessionId, entry, epoch) => !stopped && sessions.get(sessionId) === entry && entry.epoch === epoch;

  const forget = (sessionId, entry) => {
    cancelTimer(entry);
    sessions.delete(sessionId);
    commit();
  };

  const ping = async (sessionId, entry) => {
    const response = await fetchImpl(
      `${buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}/generate`, '')}?${new URLSearchParams({ directory: entry.directory })}`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...getOpenCodeAuthHeaders() },
        body: JSON.stringify({ prompt: WARMING_PROMPT }),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      },
    );
    // The reply is the model's "OK"; nobody reads it.
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) return 'gone';
    if (!response.ok) throw new Error(`OpenCode answered ${response.status}`);
    return 'sent';
  };

  /** Whether OpenCode is running a turn in the session right now; null when it could not be asked. */
  const readBusy = async (sessionId) => {
    try {
      const response = await fetchImpl(buildOpenCodeUrl('/api/session/active', ''), {
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const active = activeSessionsSchema.safeParse(unwrapOpenCodeResponse(await response.json()));
      return active.success ? Boolean(active.data[sessionId]) : null;
    } catch {
      return null;
    }
  };

  /** Arms the next ping at `at`, or lets the session go cold when its window is over by then. */
  const schedulePing = (sessionId, entry, at) => {
    if (entry.warmUntil === null || at >= entry.warmUntil) {
      cancelTimer(entry);
      return;
    }
    armTimer(sessionId, entry, at, async (epoch) => {
      // The window may have been shortened since this ping was armed.
      if (entry.warmUntil === null || now() >= entry.warmUntil) {
        cancelTimer(entry);
        return;
      }
      let result;
      try {
        result = await ping(sessionId, entry);
      } catch (error) {
        // Like OpenCode: a failed ping waits for the next interval, and the
        // window keeps counting down.
        console.warn(`[session-warming] could not warm ${sessionId}:`, error?.message ?? error);
      }
      if (!isCurrent(sessionId, entry, epoch)) return;
      if (result === 'gone') {
        forget(sessionId, entry);
        return;
      }
      schedulePing(sessionId, entry, now() + WARMING_INTERVAL_MS);
    });
  };

  /** A turn ended: the session is warm for the chosen duration. */
  const startWindow = (sessionId, entry, firstPingAt) => {
    entry.warmUntil = now() + minutes * MINUTE_MS;
    schedulePing(sessionId, entry, firstPingAt);
  };

  /**
   * Asks OpenCode whether the session is running, for a session whose state
   * the event stream did not tell: a toggle the server has seen no event for,
   * a restart, a gap in the stream. A ping never goes out during a turn, and a
   * session whose turn ended unseen starts its window now.
   */
  const settle = async (sessionId, entry, epoch) => {
    const busy = await readBusy(sessionId);
    if (!isCurrent(sessionId, entry, epoch)) return;
    if (busy === null) {
      armTimer(sessionId, entry, now() + STATUS_RETRY_MS, (next) => settle(sessionId, entry, next));
      return;
    }
    activity.set(sessionId, { busy, idleAt: null });
    if (busy) {
      cancelTimer(entry);
      if (entry.warmUntil !== null) {
        entry.warmUntil = null;
        commit();
      }
      return;
    }
    if (entry.warmUntil === null) {
      startWindow(sessionId, entry, now());
      commit();
    } else if (!entry.timer) {
      // Back from a restart in the middle of the window.
      schedulePing(sessionId, entry, now());
    }
  };

  const settleSoon = (sessionId, entry, delayMs = 0) => {
    armTimer(sessionId, entry, now() + delayMs, (epoch) => settle(sessionId, entry, epoch));
  };

  /** Reads the saved state; synchronous, so no request or event can land before it. */
  const start = () => {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[session-warming] could not read the saved state:', error?.message ?? error);
      return;
    }
    let parsed;
    try {
      parsed = storedSchema.parse(JSON.parse(raw));
    } catch (error) {
      // Kept for the user rather than overwritten by the next save.
      const backup = `${filePath}.corrupt-${now()}`;
      try {
        fs.renameSync(filePath, backup);
      } catch {
        // The next save replaces it.
      }
      console.warn(`[session-warming] state file was unreadable and moved to ${backup}: ${error?.message ?? error}`);
      return;
    }
    enabled = parsed.enabled;
    minutes = parsed.minutes;
    if (!enabled) return;
    for (const [sessionId, value] of Object.entries(parsed.sessions)) {
      const stored = storedSessionSchema.safeParse(value);
      if (!stored.success || !sessionIdSchema.safeParse(sessionId).success) continue;
      const entry = { directory: stored.data.directory, warmUntil: stored.data.warmUntil, timer: null, epoch: 0 };
      sessions.set(sessionId, entry);
      // OpenCode starts with the server; ask once it has had a moment.
      if (entry.warmUntil === null || entry.warmUntil > now()) settleSoon(sessionId, entry, STATUS_RETRY_MS);
    }
    if (sessions.size > 0) console.log(`[session-warming] resumed ${sessions.size} warmed session(s)`);
  };

  const processPayload = (payload) => {
    // Off, or OpenCode warming every session: nothing here to keep up to date.
    if (stopped || !enabled) return;
    if (payload?.type === 'server.connected') {
      // Turns may have started or ended while the stream was down.
      activity.clear();
      for (const [sessionId, entry] of sessions) {
        const epoch = entry.epoch;
        void settle(sessionId, entry, epoch);
      }
      return;
    }
    const deleted = deletedPayloadSchema.safeParse(payload);
    if (deleted.success) {
      const sessionId = deleted.data.properties.sessionID;
      activity.delete(sessionId);
      const entry = sessions.get(sessionId);
      if (entry) forget(sessionId, entry);
      return;
    }
    const parsed = statusPayloadSchema.safeParse(payload);
    if (!parsed.success) return;
    const sessionId = parsed.data.properties.sessionID;
    const busy = parsed.data.properties.status.type !== 'idle';
    const previous = activity.get(sessionId);
    if (previous?.busy === busy) return;
    activity.set(sessionId, { busy, idleAt: busy ? previous?.idleAt ?? null : now() });

    const entry = sessions.get(sessionId);
    if (!entry) return;
    if (busy) {
      // The turn itself keeps the cache in use; the window restarts when it ends.
      cancelTimer(entry);
      entry.warmUntil = null;
    } else {
      startWindow(sessionId, entry, now() + WARMING_INTERVAL_MS);
    }
    commit();
  };

  const setEnabled = (next) => {
    if (enabled === next) return snapshot();
    enabled = next;
    // Turning per-session warming off forgets the chosen sessions; turning it
    // on starts with no history, so a toggle asks OpenCode first.
    for (const entry of sessions.values()) cancelTimer(entry);
    sessions.clear();
    activity.clear();
    commit();
    return snapshot();
  };

  /**
   * Picks how long a session stays warm after its turn. A window already
   * running moves by the difference, so the countdown shows the new length.
   */
  const setMinutes = (next) => {
    if (next === minutes) return snapshot();
    const shift = (next - minutes) * MINUTE_MS;
    minutes = next;
    for (const [sessionId, entry] of sessions) {
      if (entry.warmUntil === null) continue;
      const wasWarm = entry.warmUntil > now();
      entry.warmUntil += shift;
      // A window that ran out but fits the longer step resumes its pings.
      if (!wasWarm && entry.warmUntil > now()) schedulePing(sessionId, entry, now());
    }
    commit();
    return snapshot();
  };

  /** Resolves the snapshot, or `{ error: 'disabled' }` while per-session warming is off. */
  const setSessionWarm = (sessionId, directory, warm) => {
    if (!enabled) return { error: 'disabled' };
    const existing = sessions.get(sessionId);
    if (!warm) {
      if (existing) forget(sessionId, existing);
      return snapshot();
    }
    if (existing) return snapshot();
    const entry = { directory, warmUntil: null, timer: null, epoch: 0 };
    sessions.set(sessionId, entry);
    const state = activity.get(sessionId);
    if (!state) {
      settleSoon(sessionId, entry);
    } else if (!state.busy) {
      // A turn that ended under an interval ago gets its ping on the usual
      // beat; otherwise the cache may be about to lapse, so the ping goes now.
      const idleAt = state.idleAt;
      const firstPingAt = idleAt !== null && idleAt + WARMING_INTERVAL_MS > now() ? idleAt + WARMING_INTERVAL_MS : now();
      startWindow(sessionId, entry, firstPingAt);
    }
    commit();
    return snapshot();
  };

  /** Whether the session is in its warm window; the last ping keeps the cache for one more lifetime after it. */
  const isSessionWarm = (sessionId, cacheLifetimeMs) => {
    const warmUntil = sessions.get(sessionId)?.warmUntil ?? null;
    return warmUntil !== null && now() < warmUntil + cacheLifetimeMs;
  };

  /** Stops the timers; resolves once the last change is on disk. */
  const stop = () => {
    stopped = true;
    for (const entry of sessions.values()) cancelTimer(entry);
    return writeChain;
  };

  return {
    start,
    processPayload,
    snapshot,
    setEnabled,
    setMinutes,
    setSessionWarm,
    isSessionWarm,
    stop,
  };
};
