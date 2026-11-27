import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { combinedOutcome, DELETED_OUTCOME, joinBodies, NOTHING_LEFT_NOTICE, NEXT_TURN_NOTICE, outcomeBody, stillRunningNotice, WAIT_LIMIT_MS } from './result-text.js';
import { createOwnWork } from './own-work.js';
import type { OwnWorkSources } from './own-work.js';

const FILE_NAME = 'dispatch-results.json';
const FILE_VERSION = 1;
const MAX_ENTRIES = 200;
const QUIET_MS = 500;
const SETTLE_RECHECK_MS = 2_000;
const SETTLE_RECHECKS = 3;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_PAGE_LIMIT = 50;
const MAX_FOLLOWED_DELIVERIES = 5;
const WAIT_CHECK_MS = 60_000;
const WAIT_GRACE_MS = 30_000;

const DISPATCH_RESULT_SOURCE = 'openchamber-session';

const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,128}$/);
const messageIdSchema = z.string().regex(/^msg_[A-Za-z0-9]{8,64}$/);
const timeSchema = z.number().finite().nonnegative();

const afterIdleSchema = z.string().min(1).nullable();

const entrySchema = z.object({
  id: z.string().min(1),
  parentSessionId: sessionIdSchema,
  sessionId: sessionIdSchema,
  dispatchedAt: timeSchema,
  afterIdleId: afterIdleSchema.optional(),
  messageId: messageIdSchema.optional(),
  follow: z.literal(true).optional(),
  targetIdleId: z.string().min(1).optional(),
  held: z.object({ since: timeSchema, bodies: z.array(z.string()).min(1) }).optional(),
  watching: z.literal(true).optional(),
  outgoing: z.object({
    text: z.string(),
    description: z.string(),
    metadata: z.object({ source: z.literal(DISPATCH_RESULT_SOURCE), sessionID: z.string(), state: z.enum(['completed', 'error', 'cancelled']), title: z.string().optional() }),
  }).optional(),
});

const storedFileSchema = z.object({ entries: z.array(z.unknown()) });

const idleRecordSchema = z.object({
  id: z.string().min(1),
  type: z.literal('idle'),
  outcome: z.enum(['succeeded', 'failed', 'interrupted']),
  time: z.object({ created: timeSchema }),
});

const assistantRecordSchema = z.object({
  type: z.literal('assistant'),
  content: z.array(z.unknown()).default([]),
  error: z.object({ message: z.string().optional() }).nullish(),
  time: z.object({ created: timeSchema }),
});

const textContentSchema = z.object({ type: z.literal('text'), text: z.string() });

const recordTypeSchema = z.object({ type: z.string() });
const recordIdSchema = z.object({ id: z.string() });
const sessionRecordSchema = z.object({
  title: z.string().optional(),
  time: z.object({ archived: z.number().nullish() }).optional(),
  metadata: z.unknown().optional(),
});
const ownerLinkSchema = z.object({ openchamber: z.object({ kind: z.literal('operator-child'), parentID: z.string().min(1) }) });
const messagePageSchema = z.object({ data: z.array(z.unknown()) });

const statusEventSchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({ sessionID: z.string().min(1), status: z.object({ type: z.string().min(1) }) }),
});

const deletedEventSchema = z.object({
  type: z.literal('session.deleted'),
  properties: z.object({ sessionID: z.string().min(1) }),
});

const dispatchEventSchema = z.union([deletedEventSchema, statusEventSchema]);
const errorCodeSchema = z.object({ code: z.string() });

export type DispatchEntry = z.infer<typeof entrySchema>;

export interface DispatchOutcome {
  state: 'completed' | 'error' | 'cancelled';
  text: string;
  errorMessage: string;
}

export interface DispatchResultMessage {
  text: string;
  description: string;
  metadata: {
    source: typeof DISPATCH_RESULT_SOURCE;
    sessionID: string;
    state: DispatchOutcome['state'];
    title?: string | undefined;
  };
}

export interface DispatchRegistration {
  parentSessionId: string;
  sessionId: string;
  dispatchedAt: number;
  afterIdleId?: string | null;
}

export interface DispatchResultsOptions {
  globalEventHub: {
    subscribeEvent: (listener: (event: DispatchEventSource) => void) => () => void;
    subscribeStatus: (listener: (status: { type: string }) => void) => () => void;
  };
  buildOpenCodeUrl: (fetchPath: string, query: string) => string | URL;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  dataDir: string;
  isSessionArchived?: (sessionId: string) => boolean | Promise<boolean>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  quietMs?: number;
  retryDelayMs?: (failures: number) => number;
  settleRecheckMs?: number;
  waitCheckMs?: number;
  waitGraceMs?: number;
  ownWorkSources?: () => OwnWorkSources;
}

type WatchedSession =
  | { kind: 'running'; title: string; ownerId: string | null; active: ReadonlySet<string> }
  | { kind: 'deleted' }
  | { kind: 'ended'; title: string; records: unknown[]; ownerId: string | null; active: ReadonlySet<string> };

interface ReadyResult {
  entry: DispatchEntry;
  outcome: DispatchOutcome;
}

interface DispatchEventSource {
  translated?: () => unknown[];
}

const hasMessage = (value: unknown): value is { message: unknown } =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && 'message' in value;

const hasStatus = (value: unknown): value is { status: unknown } =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && 'status' in value;

const parsedData = <Data>(parsed: z.ZodSafeParseResult<Data>) => parsed.success ? parsed.data : null;

const isDispatchEvent = (value: unknown): value is z.infer<typeof dispatchEventSchema> =>
  dispatchEventSchema.safeParse(value).success;

const retryDelay = (failures: number) => Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_DELAY_MS);

const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });

export const createMessageId = (now: number) => {
  const time = (BigInt(now) * 0x1000n + BigInt(Math.floor(Math.random() * 0x1000))).toString(16).padStart(12, '0').slice(-12);
  let random = '';
  for (let index = 0; index < 14; index += 1) random += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return `msg_${time}${random}`;
};

export const escapeAttribute = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const assistantText = (assistant: z.infer<typeof assistantRecordSchema>) => assistant.content
  .map((item) => parsedData(textContentSchema.safeParse(item))?.text ?? '')
  .join('')
  .trim();

const OUTCOME_STATES = {
  succeeded: 'completed', failed: 'error', interrupted: 'cancelled',
} satisfies Record<z.infer<typeof idleRecordSchema>['outcome'], DispatchOutcome['state']>;

export const readDispatchOutcome = (records: unknown[], dispatchedAt: number, afterIdleId?: string | null, { withText = false }: { withText?: boolean } = {}): DispatchOutcome | null => {
  const idleIndex = records.findIndex((record) => parsedData(recordTypeSchema.safeParse(record))?.type === 'idle');
  if (idleIndex === -1) return null;
  const idle = parsedData(idleRecordSchema.safeParse(records[idleIndex]));
  if (!idle) return null;
  const byOrder = afterIdleId !== undefined;
  if (byOrder ? idle.id === afterIdleId : idle.time.created < dispatchedAt) return null;
  const baselineIndex = byOrder && afterIdleId !== null
    ? records.findIndex((record) => parsedData(recordIdSchema.safeParse(record))?.id === afterIdleId)
    : -1;
  const turnRecords = records.slice(idleIndex + 1, baselineIndex === -1 ? undefined : baselineIndex);
  const replies = turnRecords
    .map((record) => parsedData(assistantRecordSchema.safeParse(record)))
    .filter((assistant): assistant is z.infer<typeof assistantRecordSchema> => assistant !== null && (byOrder || assistant.time.created >= dispatchedAt));
  const reply = replies[0];
  const textReply = withText ? replies.find((assistant) => assistantText(assistant)) : reply;
  return {
    state: OUTCOME_STATES[idle.outcome],
    text: textReply ? assistantText(textReply) : '',
    errorMessage: reply?.error?.message?.trim() ?? '',
  };
};

export const buildDispatchResultMessage = ({ sessionId, title, outcome, body = outcomeBody(outcome, sessionId) }: { sessionId: string; title: string; outcome: DispatchOutcome; body?: string }): DispatchResultMessage => {
  const label = title || 'Dispatched session';
  const attributes = `sessionID="${escapeAttribute(sessionId)}" state="${outcome.state}" title="${escapeAttribute(label)}"`;
  const metadata: DispatchResultMessage['metadata'] = { source: DISPATCH_RESULT_SOURCE, sessionID: sessionId, state: outcome.state };
  if (title) metadata.title = title;
  return {
    text: `<openchamber-session ${attributes}>\n${body}\n</openchamber-session>`,
    description: label,
    metadata,
  };
};


export interface FollowedTurn {
  idleId: string;
  outcome: DispatchOutcome;
}

const turnsAfter = (records: unknown[], entry: Pick<DispatchEntry, 'afterIdleId' | 'dispatchedAt'>, upTo?: string): FollowedTurn[] => {
  const idles = records.flatMap((record, index) => {
    const idle = parsedData(idleRecordSchema.safeParse(record));
    return idle ? [{ index, id: idle.id }] : [];
  });
  if (entry.afterIdleId === undefined) {
    const outcome = readDispatchOutcome(records, entry.dispatchedAt);
    const newest = idles[0];
    return outcome && newest ? [{ idleId: newest.id, outcome }] : [];
  }
  const baseline = entry.afterIdleId === null ? -1 : idles.findIndex((idle) => idle.id === entry.afterIdleId);
  let newer = (baseline === -1 ? idles : idles.slice(0, baseline)).reverse();
  if (upTo) {
    const last = newer.findIndex((idle) => idle.id === upTo);
    if (last !== -1) newer = newer.slice(0, last + 1);
  }
  return newer.flatMap((idle, position) => {
    const before = position === 0 ? entry.afterIdleId ?? null : newer[position - 1]?.id ?? null;
    const outcome = readDispatchOutcome(records.slice(idle.index), entry.dispatchedAt, before);
    return outcome ? [{ idleId: idle.id, outcome }] : [];
  });
};

export function createDispatchResultsRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  dataDir,
  isSessionArchived = async () => false,
  fetchImpl = fetch,
  now = Date.now,
  quietMs = QUIET_MS,
  retryDelayMs = retryDelay,
  settleRecheckMs = SETTLE_RECHECK_MS,
  waitCheckMs = WAIT_CHECK_MS,
  waitGraceMs = WAIT_GRACE_MS,
  ownWorkSources,
}: DispatchResultsOptions) {
  const filePath = path.join(dataDir, FILE_NAME);

  const entries = new Map<string, DispatchEntry>();
  let loadPromise: Promise<void> | null = null;
  let writePromise = Promise.resolve();
  let stopped = false;

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const failures = new Map<string, number>();
  const settleChecks = new Map<string, number>();
  const ticking = new Set<string>();

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (parsedData(errorCodeSchema.safeParse(error))?.code === 'ENOENT') return [];
      throw error;
    }
    let stored: z.infer<typeof storedFileSchema> | null = null;
    let reason: unknown;
    try {
      stored = parsedData(storedFileSchema.safeParse(JSON.parse(raw)));
    } catch (error) {
      reason = (hasMessage(error) ? error.message : undefined) ?? String(error);
    }
    if (!stored) {
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      console.warn(`[dispatch-results] file was unreadable and moved to ${backup}: ${reason === undefined ? 'not a dispatch results file' : reason}`);
      return [];
    }
    return stored.entries.map((entry) => parsedData(entrySchema.safeParse(entry))).filter((entry) => entry !== null);
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const entry of stored) if (!entries.has(entry.id)) entries.set(entry.id, entry);
        })
        .catch((error) => {
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const persist = () => {
    const payload = JSON.stringify({ version: FILE_VERSION, entries: Array.from(entries.values()) });
    const write = writePromise.then(async () => {
      await fs.promises.mkdir(dataDir, { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmpPath, filePath);
    });
    writePromise = write.catch((cause: unknown) => {
      console.warn('[dispatch-results] failed to persist pending results:', (hasMessage(cause) ? cause.message : undefined) ?? cause);
    });
    return write;
  };

  const openCodeRequest = async <Schema extends z.ZodType>(fetchPath: string, schema: Schema, { method = 'GET', body, query }: {
    method?: string;
    body?: { id: DispatchEntry['messageId']; delivery: 'steer'; resume: boolean } & DispatchResultMessage;
    query?: Record<string, string>;
  } = {}) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const search = new URLSearchParams(query || {}).toString();
    const headers = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    if (body) {
      Object.assign(headers, { 'Content-Type': 'application/json' });
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(search ? `${base}?${search}` : base, init);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw httpError(`OpenCode ${method} ${fetchPath} failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, response.status);
    }
    return parsedData(schema.safeParse(unwrapOpenCodeResponse(await response.json().catch(() => null))));
  };

  const activityProbe = createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs: FETCH_TIMEOUT_MS, fetchImpl, signal: undefined });

  const readWatchedSession = async (sessionId: string): Promise<WatchedSession | null> => {
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!statuses) return null;
    const encoded = encodeURIComponent(sessionId);
    try {
      const session = await openCodeRequest(`/api/session/${encoded}`, sessionRecordSchema);
      if (!session) return null;
      const ownerId = session.time?.archived ? null : ownerLinkSchema.safeParse(session.metadata).data?.openchamber.parentID ?? null;
      const title = session.title?.trim() ?? '';
      const active = new Set(Object.keys(statuses));
      if (statuses[sessionId]) return { kind: 'running', title, ownerId, active };
      const page = await openCodeRequest(`/api/session/${encoded}/message`, messagePageSchema, {
        query: { limit: String(MESSAGE_PAGE_LIMIT), order: 'desc' },
      });
      if (!page) return null;
      return { kind: 'ended', title, records: page.data, ownerId, active };
    } catch (error) {
      if (hasStatus(error) && error.status === 404) return { kind: 'deleted' };
      return null;
    }
  };

  const deliver = async (entry: DispatchEntry, message: DispatchResultMessage) => {
    const archived = await Promise.resolve(isSessionArchived(entry.parentSessionId)).catch(() => false);
    const resume = archived !== true;
    try {
      await openCodeRequest(`/api/session/${encodeURIComponent(entry.parentSessionId)}/synthetic`, z.unknown().transform(() => undefined), {
        method: 'POST',
        body: { id: entry.messageId, ...message, delivery: 'steer', resume },
      });
      return 'delivered';
    } catch (error) {
      if (hasStatus(error) && error.status === 409) return 'delivered';
      if (hasStatus(error) && error.status === 404) {
        console.log(`[dispatch-results] dropping the result of ${entry.sessionId}: session ${entry.parentSessionId} no longer exists`);
        return 'parent-gone';
      }
      throw error;
    }
  };

  const nothingRunsSince = new Map<string, number>();
  const ownWork = createOwnWork({
    jobs: activityProbe,
    sources: ownWorkSources,
    dispatched: (sessionId, active) => Array.from(entries.values())
      .filter((entry) => entry.follow && entry.parentSessionId === sessionId && (active.has(entry.sessionId) || entry.held || entry.watching))
      .map((entry) => entry.sessionId),
  });

  const holdOrNotice = async (entry: DispatchEntry, hasNewTurn: boolean, active: ReadonlySet<string>): Promise<{ hold: number } | { notice: string; watch?: true }> => {
    const work = await ownWork.read(entry.sessionId, active);
    const onlyWatching = !hasNewTurn && !entry.held;
    if (onlyWatching && (work === null || work.running.length > 0)) {
      nothingRunsSince.delete(entry.id);
      return { hold: waitCheckMs };
    }
    if (work === null || (work.waitsOnAnswer && !onlyWatching)) return { notice: '' };
    if (work.running.length === 0) {
      if (hasNewTurn) return { notice: '' };
      const since = nothingRunsSince.get(entry.id) ?? now();
      nothingRunsSince.set(entry.id, since);
      const left = since + waitGraceMs - now();
      return left > 0 ? { hold: left } : { notice: NOTHING_LEFT_NOTICE };
    }
    nothingRunsSince.delete(entry.id);
    const left = (entry.held?.since ?? now()) + WAIT_LIMIT_MS - now();
    if (left > 0) return { hold: Math.min(left, waitCheckMs) };
    return { notice: stillRunningNotice(work.running), watch: true };
  };

  const holdTurns = async (entry: DispatchEntry, turns: FollowedTurn[], cursor: string) => {
    const before = { ...entry };
    entry.held = {
      since: entry.held?.since ?? now(),
      bodies: [...(entry.held?.bodies ?? []), ...turns.map((turn) => outcomeBody(turn.outcome, entry.sessionId))],
    };
    entry.afterIdleId = cursor;
    delete entry.watching;
    try {
      await persist();
    } catch (error) {
      delete entry.held;
      delete entry.afterIdleId;
      Object.assign(entry, before);
      throw error;
    }
  };

  const mint = async (entry: DispatchEntry, title: string, turns: FollowedTurn[], notice: string, watch = false) => {
    const before = entry.watching;
    const target = turns.at(-1)?.idleId ?? entry.afterIdleId;
    entry.messageId = createMessageId(now());
    if (target) entry.targetIdleId = target;
    delete entry.watching;
    if (watch) entry.watching = true;
    entry.outgoing = buildDispatchResultMessage({ sessionId: entry.sessionId, title, ...combinedOutcome(turns, entry, notice) });
    try {
      await persist();
    } catch (error) {
      delete entry.messageId;
      delete entry.targetIdleId;
      delete entry.outgoing;
      delete entry.watching;
      if (before) entry.watching = before;
      throw error;
    }
  };

  const pendingFor = (sessionId: string) => Array.from(entries.values()).filter((entry) => entry.sessionId === sessionId);

  const clearTimer = (sessionId: string) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      timers.delete(sessionId);
    }
  };

  const arm = (sessionId: string, delayMs = quietMs) => {
    if (stopped || pendingFor(sessionId).length === 0) return;
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      tick(sessionId).catch((cause: unknown) => {
        console.warn('[dispatch-results] tick failed:', (hasMessage(cause) ? cause.message : undefined) ?? cause);
      });
    }, Math.max(0, delayMs));
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  const retryLater = (sessionId: string) => {
    const count = (failures.get(sessionId) ?? 0) + 1;
    failures.set(sessionId, count);
    arm(sessionId, retryDelayMs(count));
  };

  const reconcileFollowers = (sessionId: string, ownerId: string | null) => {
    let changed = false;
    const kept = new Map<string, DispatchEntry>();
    const ordered = pendingFor(sessionId).sort((left, right) => Number(Boolean(right.messageId)) - Number(Boolean(left.messageId)) || left.dispatchedAt - right.dispatchedAt);
    for (const entry of ordered) {
      const owned = ownerId === entry.parentSessionId;
      if (!owned) {
        if (!entry.follow) continue;
        entries.delete(entry.id);
        changed = true;
        console.log(`[dispatch-results] ${sessionId} no longer reports to ${entry.parentSessionId}`);
        continue;
      }
      const follower = kept.get(entry.parentSessionId);
      if (follower) {
        entries.delete(entry.id);
        changed = true;
        continue;
      }
      if (!entry.follow) {
        entry.follow = true;
        changed = true;
      }
      kept.set(entry.parentSessionId, entry);
    }
    return changed;
  };

  const sendFollowed = async (entry: DispatchEntry, title: string, records: unknown[]) => {
    const message = entry.outgoing
      ?? buildDispatchResultMessage({ sessionId: entry.sessionId, title, ...combinedOutcome(turnsAfter(records, entry, entry.targetIdleId), entry, '') });
    const result = await deliver(entry, message);
    nothingRunsSince.delete(entry.id);
    const cursor = entry.targetIdleId ?? turnsAfter(records, entry).at(-1)?.idleId;
    if (result === 'parent-gone' || !cursor) {
      entries.delete(entry.id);
    } else {
      entry.afterIdleId = cursor;
      delete entry.messageId;
      delete entry.targetIdleId;
      delete entry.held;
      delete entry.outgoing;
    }
    await persist();
    console.log(`[dispatch-results] delivered the ${message.metadata.state} result of ${entry.sessionId} to ${entry.parentSessionId}`);
    return 'sent' as const;
  };

  const deliverFollowedTurns = async (entry: DispatchEntry, watched: Extract<WatchedSession, { kind: 'ended' }>): Promise<'sent' | 'nothing' | { hold: number; newTurn: boolean }> => {
    if (!entry.messageId) {
      const turns = turnsAfter(watched.records, entry);
      const target = turns.at(-1);
      if (!target && !entry.held && !entry.watching) return 'nothing';
      const verdict = turns.every(({ outcome }) => outcome.state === 'completed')
        ? await holdOrNotice(entry, target !== undefined, watched.active)
        : { notice: '' };
      if ('hold' in verdict) {
        if (target) await holdTurns(entry, turns, target.idleId);
        return { ...verdict, newTurn: target !== undefined };
      }
      await mint(entry, watched.title, turns, verdict.notice, 'watch' in verdict);
    }
    return sendFollowed(entry, watched.title, watched.records);
  };

  const releaseWhileRunning = async (entry: DispatchEntry, { title, active }: Extract<WatchedSession, { kind: 'running' }>) => {
    if (!entry.held) return undefined;
    if (!entry.messageId) {
      const left = entry.held.since + WAIT_LIMIT_MS - now();
      const asks = (await ownWork.read(entry.sessionId, active))?.waitsOnAnswer === true;
      if (left > 0 && !asks) return Math.min(left, waitCheckMs);
      await mint(entry, title, [], left > 0 ? '' : NEXT_TURN_NOTICE);
    }
    if (entry.outgoing) await sendFollowed(entry, title, []);
    return undefined;
  };

  const releaseBeforeDropping = async (sessionId: string, { ownerId, title }: Extract<WatchedSession, { kind: 'running' | 'ended' }>) => {
    for (const entry of pendingFor(sessionId)) {
      if (!entry.held || entry.parentSessionId === ownerId) continue;
      if (!entry.messageId) await mint(entry, title, [], '');
      if (entry.outgoing) await sendFollowed(entry, title, []);
    }
  };

  async function tick(sessionId: string): Promise<void> {
    if (stopped || pendingFor(sessionId).length === 0) return;
    if (ticking.has(sessionId)) return arm(sessionId);
    ticking.add(sessionId);
    try {
      for (const entry of pendingFor(sessionId)) if (entry.outgoing) await sendFollowed(entry, '', []);
      const watched = await readWatchedSession(sessionId);
      if (watched === null) return retryLater(sessionId);
      if (watched.kind !== 'deleted') await releaseBeforeDropping(sessionId, watched);
      if (watched.kind !== 'deleted' && reconcileFollowers(sessionId, watched.ownerId)) await persist();
      let holdMs: number | undefined;
      if (watched.kind === 'running') {
        for (const entry of pendingFor(sessionId)) {
          const left = await releaseWhileRunning(entry, watched);
          if (left !== undefined) holdMs = Math.min(holdMs ?? left, left);
        }
        if (holdMs !== undefined) arm(sessionId, holdMs);
        return;
      }

      let waiting = false;
      if (watched.kind === 'ended') {
        for (const entry of pendingFor(sessionId).filter((candidate) => candidate.follow)) {
          let deliveries = 0;
          while (deliveries < MAX_FOLLOWED_DELIVERIES && entries.has(entry.id)) {
            const result = await deliverFollowedTurns(entry, watched);
            if (result === 'sent') {
              deliveries += 1;
              continue;
            }
            if (result === 'nothing') waiting ||= deliveries === 0;
            else {
              holdMs = Math.min(holdMs ?? result.hold, result.hold);
              waiting ||= !result.newTurn;
            }
            break;
          }
        }
      }

      const ready: ReadyResult[] = [];
      for (const entry of pendingFor(sessionId).filter((candidate) => watched.kind === 'deleted' || !candidate.follow)) {
        const outcome = watched.kind === 'deleted'
          ? DELETED_OUTCOME
          : readDispatchOutcome(watched.records, entry.dispatchedAt, entry.afterIdleId);
        if (outcome) ready.push({ entry, outcome });
        else waiting = true;
      }

      const unsent = ready.filter(({ entry }) => !entry.messageId);
      if (unsent.length > 0) {
        const minted = new Map<string, string>();
        for (const { entry } of unsent) {
          let messageId = minted.get(entry.parentSessionId);
          if (messageId === undefined) {
            messageId = createMessageId(now());
            minted.set(entry.parentSessionId, messageId);
          }
          entry.messageId = messageId;
        }
        try {
          await persist();
        } catch (error) {
          for (const { entry } of unsent) delete entry.messageId;
          throw error;
        }
      }

      const deliveries = new Map<string | undefined, [ReadyResult, ...ReadyResult[]]>();
      for (const item of ready) deliveries.set(item.entry.messageId, [...(deliveries.get(item.entry.messageId) ?? []), item]);
      for (const group of deliveries.values()) {
        const { entry, outcome } = group.find((item) => item.outcome.text) ?? group[0];
        const held = group.flatMap((item) => item.entry.held?.bodies ?? []);
        const message = buildDispatchResultMessage({
          sessionId,
          title: watched.kind === 'ended' ? watched.title : '',
          outcome,
          body: held.length > 0 ? joinBodies([...held, outcomeBody(outcome, sessionId)], sessionId) : outcomeBody(outcome, sessionId),
        });
        await deliver(entry, message);
        for (const item of group) entries.delete(item.entry.id);
        await persist();
        console.log(`[dispatch-results] delivered the ${outcome.state} result of ${sessionId} to ${entry.parentSessionId}`);
      }
      failures.delete(sessionId);

      if (holdMs !== undefined) arm(sessionId, holdMs);
      if (!waiting) {
        settleChecks.delete(sessionId);
        return;
      }
      const spent = settleChecks.get(sessionId) ?? 0;
      if (spent < SETTLE_RECHECKS) {
        settleChecks.set(sessionId, spent + 1);
        arm(sessionId, Math.min(settleRecheckMs, holdMs ?? settleRecheckMs));
      }
    } catch (error) {
      console.warn(`[dispatch-results] delivering the result of ${sessionId} failed:`, (hasMessage(error) ? error.message : undefined) ?? error);
      retryLater(sessionId);
    } finally {
      ticking.delete(sessionId);
    }
  }

  const reconcileAll = () => {
    for (const sessionId of new Set(Array.from(entries.values(), (entry) => entry.sessionId))) {
      if (!timers.has(sessionId)) arm(sessionId);
    }
  };

  const register = async ({ parentSessionId, sessionId, dispatchedAt, afterIdleId }: DispatchRegistration) => {
    const parent = parsedData(sessionIdSchema.safeParse(parentSessionId));
    const watched = parsedData(sessionIdSchema.safeParse(sessionId));
    if (!parent || !watched) throw new TypeError('parentSessionId and sessionId must be session ids');
    if (parent === watched) throw new TypeError('a session cannot return its result to itself');
    const at = parsedData(timeSchema.safeParse(dispatchedAt));
    if (at === null) throw new TypeError('dispatchedAt must be a timestamp');
    await load();
    const following = Array.from(entries.values()).find((candidate) => candidate.follow && candidate.parentSessionId === parent && candidate.sessionId === watched);
    if (following) {
      arm(watched);
      return { id: following.id };
    }
    const entry: DispatchEntry = { id: `dispatch-${now()}-${Math.random().toString(36).slice(2, 9)}`, parentSessionId: parent, sessionId: watched, dispatchedAt: at };
    const baseline = afterIdleSchema.safeParse(afterIdleId);
    if (afterIdleId !== undefined && baseline.success) entry.afterIdleId = baseline.data;
    entries.set(entry.id, entry);
    if (entries.size > MAX_ENTRIES) {
      const oldest = Array.from(entries.values())
        .sort((left, right) => Number(Boolean(left.follow)) - Number(Boolean(right.follow)) || left.dispatchedAt - right.dispatchedAt)
        .slice(0, entries.size - MAX_ENTRIES);
      for (const stale of oldest) {
        entries.delete(stale.id);
        console.warn(`[dispatch-results] too many pending results; no longer waiting on ${stale.sessionId} for ${stale.parentSessionId}`);
      }
    }
    if (!entries.has(entry.id)) throw new Error('too many sessions are reporting back already');
    try {
      await persist();
    } catch (error) {
      entries.delete(entry.id);
      throw error;
    }
    arm(watched);
    return { id: entry.id };
  };

  const processPayload = (payload: z.infer<typeof dispatchEventSchema>) => {
    if (stopped) return;

    const deleted = parsedData(deletedEventSchema.safeParse(payload));
    if (deleted) {
      const deletedSessionId = deleted.properties.sessionID;
      let changed = false;
      for (const entry of entries.values()) {
        if (entry.parentSessionId === deletedSessionId) {
          entries.delete(entry.id);
          changed = true;
        }
      }
      if (changed) persist().catch(() => undefined);
      arm(deletedSessionId);
      return;
    }

    const status = parsedData(statusEventSchema.safeParse(payload));
    if (!status) return;
    const sessionId = status.properties.sessionID;
    if (pendingFor(sessionId).length === 0) return;
    if (status.properties.status.type === 'idle') {
      settleChecks.delete(sessionId);
      arm(sessionId);
    } else {
      clearTimer(sessionId);
      const pending = pendingFor(sessionId);
      for (const entry of pending) nothingRunsSince.delete(entry.id);
      const deadlines = pending.flatMap((entry) => (entry.held ? [entry.held.since + WAIT_LIMIT_MS - now()] : []));
      if (deadlines.length > 0) arm(sessionId, Math.min(waitCheckMs, ...deadlines));
    }
  };

  const processEvent = (event: DispatchEventSource) => {
    for (const payload of event?.translated?.() ?? []) {
      if (isDispatchEvent(payload)) processPayload(payload);
    }
  };

  const start = () => {
    const unsubscribeEvent = globalEventHub.subscribeEvent(processEvent);
    const unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
      if (status?.type === 'connect') reconcileAll();
    });
    void load()
      .then(() => {
        if (entries.size > 0) console.log(`[dispatch-results] restored ${entries.size} pending result(s)`);
        reconcileAll();
      })
      .catch((cause: unknown) => {
        console.warn('[dispatch-results] failed to load pending results:', (hasMessage(cause) ? cause.message : undefined) ?? cause);
      });
    return () => {
      unsubscribeEvent();
      unsubscribeStatus();
    };
  };

  const stop = () => {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  return {
    load,
    register,
    processPayload,
    start,
    stop,
    pending: () => Array.from(entries.values()).sort((left, right) => left.dispatchedAt - right.dispatchedAt),
    flush: () => writePromise,
  };
}
