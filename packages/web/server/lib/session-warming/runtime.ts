import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import type { TranslatedEvent } from '../event-stream/translate-v2.js';
import type { SessionWarmingSnapshot } from './contracts.js';

export interface SessionWarmingRuntimeOptions {
  dataDir: string;
  buildOpenCodeUrl: (route: string, directory: string) => string | URL;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  broadcast?: (event: { type: 'openchamber:session-warming'; properties: SessionWarmingSnapshot }) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

interface WarmingEntry {
  directory: string;
  warmUntil: number | null;
  intervalMs: number;
  lastAt: number | null;
  pendingEpoch: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  epoch: number;
}

interface SessionActivity {
  busy: boolean;
  idleAt: number | null;
}

const canReadFailure = (value: unknown): value is { message?: unknown; code?: unknown } =>
  value !== null && value !== undefined;

export const WARMING_INTERVAL_MS = 4 * 60 * 1000;
const CACHE_LIFETIME_SHARE = 0.9;
const CLAUDE_SUBSCRIPTION_CACHE_MS = 60 * 60 * 1000;
const CACHE_TTL_UNITS = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
const WARMING_DURATION_STEPS = [30, 60, 120, 180];
export const DEFAULT_WARMING_MINUTES = 60;
const MINUTE_MS = 60 * 1000;
const STATUS_RETRY_MS = 30 * 1000;
const PING_TIMEOUT_MS = 2 * 60 * 1000;
const STATUS_TIMEOUT_MS = 10 * 1000;
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
const activeSessionsSchema = z.record(z.string(), z.unknown());
const sessionModelSchema = z.object({ model: z.object({ id: z.string(), providerID: z.string() }) });
const modelListSchema = z.array(z.object({
  id: z.string(),
  providerID: z.string(),
  cost: z.array(z.unknown()).catch([]),
  settings: z.object({ cache: z.object({ ttl: z.string() }).partial().nullish() }).passthrough().nullish(),
}).passthrough());

const isCacheTtlUnit = (unit: string | undefined): unit is keyof typeof CACHE_TTL_UNITS =>
  unit !== undefined && Object.hasOwn(CACHE_TTL_UNITS, unit);

const parseCacheTtl = (ttl: string | undefined) => {
  const match = ttl !== undefined ? /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(ttl.trim()) : null;
  const unit = match?.[2];
  return match && isCacheTtlUnit(unit) ? Number(match[1]) * CACHE_TTL_UNITS[unit] : null;
};

const cacheLifetimeOf = (model: z.infer<typeof modelListSchema>[number] | null | undefined) => {
  const configured = parseCacheTtl(model?.settings?.cache?.ttl);
  if (configured) return configured;
  if (model?.providerID === 'claude-agent' && model.cost.length === 0) return CLAUDE_SUBSCRIPTION_CACHE_MS;
  return null;
};

type OpenCodeReader = Pick<SessionWarmingRuntimeOptions, 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders'> & { fetchImpl: typeof fetch };

const readOpenCodeJson = async ({ fetchImpl, buildOpenCodeUrl, getOpenCodeAuthHeaders }: OpenCodeReader, route: string, directory: string) => {
  const response = await fetchImpl(buildOpenCodeUrl(route, ''), {
    headers: {
      Accept: 'application/json',
      'x-opencode-directory': encodeURIComponent(directory),
      ...getOpenCodeAuthHeaders(),
    },
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`OpenCode answered ${response.status}`);
  }
  return unwrapOpenCodeResponse(await response.json());
};

export const readSessionCacheLifetime = async (reader: OpenCodeReader, sessionId: string, directory: string) => {
  const session = sessionModelSchema.safeParse(await readOpenCodeJson(reader, `/api/session/${encodeURIComponent(sessionId)}`, directory));
  if (!session.success) return null;
  const models = modelListSchema.safeParse(await readOpenCodeJson(reader, '/api/model', directory));
  const { id, providerID } = session.data.model;
  const model = models.success ? models.data.find((item) => item.id === id && item.providerID === providerID) : null;
  return cacheLifetimeOf(model);
};

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

export const createSessionWarmingRuntime = ({
  dataDir,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcast = () => {},
  fetchImpl = fetch,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: SessionWarmingRuntimeOptions) => {
  const filePath = path.join(dataDir, FILE_NAME);

  let enabled = false;
  let minutes = DEFAULT_WARMING_MINUTES;
  let revision = now();
  let stopped = false;
  let writeChain = Promise.resolve();
  const sessions = new Map<string, WarmingEntry>();
  const activity = new Map<string, SessionActivity>();

  const snapshot = (): SessionWarmingSnapshot => ({
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
      .catch((cause: unknown) => console.warn('[session-warming] failed to save:', (canReadFailure(cause) ? cause.message : undefined) ?? cause));
    return writeChain;
  };

  const commit = () => {
    revision += 1;
    void persist();
    broadcast({ type: 'openchamber:session-warming', properties: snapshot() });
  };

  const cancelTimer = (entry: WarmingEntry) => {
    if (entry.timer) clearTimer(entry.timer);
    entry.timer = null;
    entry.epoch += 1;
  };

  const armTimer = (sessionId: string, entry: WarmingEntry, at: number, run: (epoch: number) => Promise<void>) => {
    cancelTimer(entry);
    const epoch = entry.epoch;
    entry.timer = setTimer(() => {
      entry.timer = null;
      if (stopped || sessions.get(sessionId) !== entry || entry.epoch !== epoch) return;
      void run(epoch);
    }, Math.max(0, at - now()));
  };

  const isCurrent = (sessionId: string, entry: WarmingEntry, epoch: number) => !stopped && sessions.get(sessionId) === entry && entry.epoch === epoch;

  const forget = (sessionId: string, entry: WarmingEntry) => {
    cancelTimer(entry);
    sessions.delete(sessionId);
    commit();
  };

  const ping = async (sessionId: string, entry: WarmingEntry) => {
    const response = await fetchImpl(
      `${buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}/generate`, '')}?${new URLSearchParams({ directory: entry.directory })}`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...getOpenCodeAuthHeaders() },
        body: JSON.stringify({ prompt: WARMING_PROMPT }),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      },
    );
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) return 'gone';
    if (!response.ok) throw new Error(`OpenCode answered ${response.status}`);
    return 'sent';
  };

  const readBusy = async (sessionId: string) => {
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

  const readPingInterval = async (sessionId: string, directory: string) => {
    const lifetime = await readSessionCacheLifetime({ fetchImpl, buildOpenCodeUrl, getOpenCodeAuthHeaders }, sessionId, directory).catch(() => null);
    return lifetime ? lifetime * CACHE_LIFETIME_SHARE : WARMING_INTERVAL_MS;
  };


  const schedulePing = (sessionId: string, entry: WarmingEntry, at: number) => {
    if (entry.warmUntil === null || at >= entry.warmUntil) {
      cancelTimer(entry);
      return;
    }
    armTimer(sessionId, entry, at, async (epoch) => {
      if (entry.warmUntil === null || now() >= entry.warmUntil) {
        cancelTimer(entry);
        return;
      }
      let result;
      entry.pendingEpoch = epoch;
      try {
        result = await ping(sessionId, entry);
      } catch (error) {
        console.warn(`[session-warming] could not warm ${sessionId}:`, (canReadFailure(error) ? error.message : undefined) ?? error);
      }
      if (!isCurrent(sessionId, entry, epoch)) return;
      if (result === 'gone') {
        forget(sessionId, entry);
        return;
      }
      entry.lastAt = now();
      schedulePing(sessionId, entry, entry.lastAt + entry.intervalMs);
    });
  };

  const resumePings = (sessionId: string, entry: WarmingEntry, idleAt: number | null) => {
    cancelTimer(entry);
    const epoch = entry.epoch;
    entry.pendingEpoch = epoch;
    if (idleAt !== null) entry.lastAt = idleAt;
    void readPingInterval(sessionId, entry.directory).then((intervalMs) => {
      if (!isCurrent(sessionId, entry, epoch)) return;
      entry.pendingEpoch = null;
      entry.intervalMs = intervalMs;
      schedulePing(sessionId, entry, idleAt === null ? now() : Math.max(now(), idleAt + intervalMs));
    });
  };

  const isUnarmed = (entry: WarmingEntry) => !entry.timer && entry.pendingEpoch !== entry.epoch;

  const startWindow = (sessionId: string, entry: WarmingEntry, idleAt: number | null) => {
    entry.warmUntil = now() + minutes * MINUTE_MS;
    resumePings(sessionId, entry, idleAt);
  };

  const settle = async (sessionId: string, entry: WarmingEntry, epoch: number) => {
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
      startWindow(sessionId, entry, null);
      commit();
    } else if (isUnarmed(entry)) {
      resumePings(sessionId, entry, null);
    }
  };

  const settleSoon = (sessionId: string, entry: WarmingEntry, delayMs = 0) => {
    armTimer(sessionId, entry, now() + delayMs, (epoch) => settle(sessionId, entry, epoch));
  };

  const start = () => {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((canReadFailure(error) ? error.code : undefined) !== 'ENOENT') console.warn('[session-warming] could not read the saved state:', (canReadFailure(error) ? error.message : undefined) ?? error);
      return;
    }
    let parsed;
    try {
      parsed = storedSchema.parse(JSON.parse(raw));
    } catch (error) {
      const backup = `${filePath}.corrupt-${now()}`;
      try {
        fs.renameSync(filePath, backup);
      } catch {
        void 0;
      }
      console.warn(`[session-warming] state file was unreadable and moved to ${backup}: ${(canReadFailure(error) ? error.message : undefined) ?? error}`);
      return;
    }
    enabled = parsed.enabled;
    minutes = parsed.minutes;
    if (!enabled) return;
    for (const [sessionId, value] of Object.entries(parsed.sessions)) {
      const stored = storedSessionSchema.safeParse(value);
      if (!stored.success || !sessionIdSchema.safeParse(sessionId).success) continue;
      const entry: WarmingEntry = { directory: stored.data.directory, warmUntil: stored.data.warmUntil, intervalMs: WARMING_INTERVAL_MS, lastAt: null, pendingEpoch: null, timer: null, epoch: 0 };
      sessions.set(sessionId, entry);
      if (entry.warmUntil === null || entry.warmUntil > now()) settleSoon(sessionId, entry, STATUS_RETRY_MS);
    }
    if (sessions.size > 0) console.log(`[session-warming] resumed ${sessions.size} warmed session(s)`);
  };

  const processPayload = (payload: TranslatedEvent) => {
    if (stopped || !enabled) return;
    if (payload?.type === 'server.connected') {
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
      cancelTimer(entry);
      entry.warmUntil = null;
    } else {
      startWindow(sessionId, entry, now());
    }
    commit();
  };

  const setEnabled = (next: boolean) => {
    if (enabled === next) return snapshot();
    enabled = next;
    for (const entry of sessions.values()) cancelTimer(entry);
    sessions.clear();
    activity.clear();
    commit();
    return snapshot();
  };

  const setMinutes = (next: number) => {
    if (next === minutes) return snapshot();
    const shift = (next - minutes) * MINUTE_MS;
    minutes = next;
    for (const [sessionId, entry] of sessions) {
      if (entry.warmUntil === null) continue;
      const wasWarm = entry.warmUntil > now();
      entry.warmUntil += shift;
      if (entry.warmUntil <= now() || !isUnarmed(entry)) continue;
      if (wasWarm) {
        schedulePing(sessionId, entry, Math.max(now(), (entry.lastAt ?? now()) + entry.intervalMs));
      } else {
        resumePings(sessionId, entry, null);
      }
    }
    commit();
    return snapshot();
  };

  const setSessionWarm = (sessionId: string, directory: string, warm: boolean) => {
    if (!enabled) return { error: 'disabled' };
    const existing = sessions.get(sessionId);
    if (!warm) {
      if (existing) forget(sessionId, existing);
      return snapshot();
    }
    if (existing) return snapshot();
    const entry: WarmingEntry = { directory, warmUntil: null, intervalMs: WARMING_INTERVAL_MS, lastAt: null, pendingEpoch: null, timer: null, epoch: 0 };
    sessions.set(sessionId, entry);
    const state = activity.get(sessionId);
    if (!state) {
      settleSoon(sessionId, entry);
    } else if (!state.busy) {
      startWindow(sessionId, entry, state.idleAt);
    }
    commit();
    return snapshot();
  };

  const isSessionWarm = (sessionId: string, cacheLifetimeMs: number) => {
    const warmUntil = sessions.get(sessionId)?.warmUntil ?? null;
    return warmUntil !== null && now() < warmUntil + cacheLifetimeMs;
  };

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
