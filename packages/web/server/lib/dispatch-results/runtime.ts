import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';

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
const ANSWER_CHAR_LIMIT = 50_000;

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
const sessionRecordSchema = z.object({ title: z.string().optional() });
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
    title?: string;
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
}

type WatchedSession =
  | { kind: 'running' }
  | { kind: 'deleted' }
  | { kind: 'ended'; title: string; records: unknown[] };

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

const outcomeBody = ({ state, text, errorMessage }: DispatchOutcome, sessionId: string) => {
  const answer = text.length > ANSWER_CHAR_LIMIT
    ? `${text.slice(0, ANSWER_CHAR_LIMIT)}\n\n[Cut at ${ANSWER_CHAR_LIMIT} characters; read the rest with session.messages for ${sessionId}.]`
    : text;
  if (state === 'completed') return answer || 'The session finished without a text reply.';
  if (state === 'error') {
    const failure = errorMessage ? `The session failed: ${errorMessage}` : 'The session failed.';
    return answer ? `${failure}\n\nIts last reply:\n${answer}` : failure;
  }
  const stopped = 'The session was stopped before it finished.';
  return answer ? `${stopped}\n\nIts last reply:\n${answer}` : stopped;
};

export const buildDispatchResultMessage = ({ sessionId, title, outcome }: { sessionId: string; title: string; outcome: DispatchOutcome }): DispatchResultMessage => {
  const label = title || 'Dispatched session';
  const attributes = `sessionID="${escapeAttribute(sessionId)}" state="${outcome.state}" title="${escapeAttribute(label)}"`;
  const metadata: DispatchResultMessage['metadata'] = { source: DISPATCH_RESULT_SOURCE, sessionID: sessionId, state: outcome.state };
  if (title) metadata.title = title;
  return {
    text: `<openchamber-session ${attributes}>\n${outcomeBody(outcome, sessionId)}\n</openchamber-session>`,
    description: label,
    metadata,
  };
};

const DELETED_OUTCOME: DispatchOutcome = { state: 'cancelled', text: '', errorMessage: '' };

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
    if (statuses[sessionId]) return { kind: 'running' };
    const encoded = encodeURIComponent(sessionId);
    try {
      const session = await openCodeRequest(`/api/session/${encoded}`, sessionRecordSchema);
      const page = await openCodeRequest(`/api/session/${encoded}/message`, messagePageSchema, {
        query: { limit: String(MESSAGE_PAGE_LIMIT), order: 'desc' },
      });
      if (!page) return null;
      return { kind: 'ended', title: session?.title?.trim() ?? '', records: page.data };
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
      return true;
    } catch (error) {
      if (hasStatus(error) && error.status === 409) return true;
      if (hasStatus(error) && error.status === 404) {
        console.log(`[dispatch-results] dropping the result of ${entry.sessionId}: session ${entry.parentSessionId} no longer exists`);
        return true;
      }
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

  async function tick(sessionId: string): Promise<void> {
    if (stopped || pendingFor(sessionId).length === 0) return;
    if (ticking.has(sessionId)) return arm(sessionId);
    ticking.add(sessionId);
    try {
      const watched = await readWatchedSession(sessionId);
      if (watched === null) return retryLater(sessionId);
      if (watched.kind === 'running') return;

      let waiting = false;
      const ready: ReadyResult[] = [];
      for (const entry of pendingFor(sessionId)) {
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
        const message = buildDispatchResultMessage({
          sessionId,
          title: watched.kind === 'ended' ? watched.title : '',
          outcome,
        });
        await deliver(entry, message);
        for (const item of group) entries.delete(item.entry.id);
        await persist();
        console.log(`[dispatch-results] delivered the ${outcome.state} result of ${sessionId} to ${entry.parentSessionId}`);
      }
      failures.delete(sessionId);

      if (!waiting) {
        settleChecks.delete(sessionId);
        return;
      }
      const spent = settleChecks.get(sessionId) ?? 0;
      if (spent < SETTLE_RECHECKS) {
        settleChecks.set(sessionId, spent + 1);
        arm(sessionId, settleRecheckMs);
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
    const entry: DispatchEntry = { id: `dispatch-${now()}-${Math.random().toString(36).slice(2, 9)}`, parentSessionId: parent, sessionId: watched, dispatchedAt: at };
    const baseline = afterIdleSchema.safeParse(afterIdleId);
    if (afterIdleId !== undefined && baseline.success) entry.afterIdleId = baseline.data;
    entries.set(entry.id, entry);
    if (entries.size > MAX_ENTRIES) {
      const oldest = Array.from(entries.values())
        .filter((candidate) => candidate.id !== entry.id)
        .sort((left, right) => left.dispatchedAt - right.dispatchedAt)
        .slice(0, entries.size - MAX_ENTRIES);
      for (const stale of oldest) {
        entries.delete(stale.id);
        console.warn(`[dispatch-results] too many pending results; no longer waiting on ${stale.sessionId} for ${stale.parentSessionId}`);
      }
    }
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
