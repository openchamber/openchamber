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

const errorCodeSchema = z.object({ code: z.string() });

const parse = (schema, value) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const retryDelay = (failures) => Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_DELAY_MS);

const httpError = (message, status) => Object.assign(new Error(message), { status });

export const createMessageId = (now) => {
  const time = (BigInt(now) * 0x1000n + BigInt(Math.floor(Math.random() * 0x1000))).toString(16).padStart(12, '0').slice(-12);
  let random = '';
  for (let index = 0; index < 14; index += 1) random += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return `msg_${time}${random}`;
};

export const escapeAttribute = (value) => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const assistantText = (assistant) => assistant.content
  .map((item) => parse(textContentSchema, item)?.text ?? '')
  .join('')
  .trim();

const OUTCOME_STATES = { succeeded: 'completed', failed: 'error', interrupted: 'cancelled' };

export const readDispatchOutcome = (records, dispatchedAt, afterIdleId, { withText = false } = {}) => {
  const idleIndex = records.findIndex((record) => parse(recordTypeSchema, record)?.type === 'idle');
  if (idleIndex === -1) return null;
  const idle = parse(idleRecordSchema, records[idleIndex]);
  if (!idle) return null;
  const byOrder = afterIdleId !== undefined;
  if (byOrder ? idle.id === afterIdleId : idle.time.created < dispatchedAt) return null;
  const baselineIndex = byOrder && afterIdleId !== null
    ? records.findIndex((record) => parse(recordIdSchema, record)?.id === afterIdleId)
    : -1;
  const turnRecords = records.slice(idleIndex + 1, baselineIndex === -1 ? undefined : baselineIndex);
  const replies = turnRecords
    .map((record) => parse(assistantRecordSchema, record))
    .filter((assistant) => assistant !== null && (byOrder || assistant.time.created >= dispatchedAt));
  const reply = replies[0];
  const textReply = withText ? replies.find((assistant) => assistantText(assistant)) : reply;
  return {
    state: OUTCOME_STATES[idle.outcome],
    text: textReply ? assistantText(textReply) : '',
    errorMessage: reply?.error?.message?.trim() ?? '',
  };
};

const outcomeBody = ({ state, text, errorMessage }, sessionId) => {
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

export const buildDispatchResultMessage = ({ sessionId, title, outcome }) => {
  const label = title || 'Dispatched session';
  const attributes = `sessionID="${escapeAttribute(sessionId)}" state="${outcome.state}" title="${escapeAttribute(label)}"`;
  const metadata = { source: DISPATCH_RESULT_SOURCE, sessionID: sessionId, state: outcome.state };
  if (title) metadata.title = title;
  return {
    text: `<openchamber-session ${attributes}>\n${outcomeBody(outcome, sessionId)}\n</openchamber-session>`,
    description: label,
    metadata,
  };
};

const DELETED_OUTCOME = { state: 'cancelled', text: '', errorMessage: '' };

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
}) {
  const filePath = path.join(dataDir, FILE_NAME);

  const entries = new Map();
  let loadPromise = null;
  let writePromise = Promise.resolve();
  let stopped = false;

  const timers = new Map();
  const failures = new Map();
  const settleChecks = new Map();
  const ticking = new Set();

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (parse(errorCodeSchema, error)?.code === 'ENOENT') return [];
      throw error;
    }
    let stored = null;
    let reason = 'not a dispatch results file';
    try {
      stored = parse(storedFileSchema, JSON.parse(raw));
    } catch (error) {
      reason = error?.message ?? String(error);
    }
    if (!stored) {
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      console.warn(`[dispatch-results] file was unreadable and moved to ${backup}: ${reason}`);
      return [];
    }
    return stored.entries.map((entry) => parse(entrySchema, entry)).filter(Boolean);
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
    writePromise = write.catch((error) => {
      console.warn('[dispatch-results] failed to persist pending results:', error?.message ?? error);
    });
    return write;
  };

  const openCodeRequest = async (fetchPath, { method = 'GET', body, query } = {}) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const search = new URLSearchParams(query || {}).toString();
    const headers = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
    const init = { method, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(search ? `${base}?${search}` : base, init);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw httpError(`OpenCode ${method} ${fetchPath} failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, response.status);
    }
    return unwrapOpenCodeResponse(await response.json().catch(() => null));
  };

  const activityProbe = createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs: FETCH_TIMEOUT_MS, fetchImpl });

  const readWatchedSession = async (sessionId) => {
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!statuses) return null;
    if (statuses[sessionId]) return { kind: 'running' };
    const encoded = encodeURIComponent(sessionId);
    try {
      const session = parse(sessionRecordSchema, await openCodeRequest(`/api/session/${encoded}`));
      const page = parse(messagePageSchema, await openCodeRequest(`/api/session/${encoded}/message`, {
        query: { limit: String(MESSAGE_PAGE_LIMIT), order: 'desc' },
      }));
      if (!page) return null;
      return { kind: 'ended', title: session?.title?.trim() ?? '', records: page.data };
    } catch (error) {
      if (error?.status === 404) return { kind: 'deleted' };
      return null;
    }
  };

  const deliver = async (entry, message) => {
    const archived = await Promise.resolve(isSessionArchived(entry.parentSessionId)).catch(() => false);
    const resume = archived !== true;
    try {
      await openCodeRequest(`/api/session/${encodeURIComponent(entry.parentSessionId)}/synthetic`, {
        method: 'POST',
        body: { id: entry.messageId, ...message, delivery: 'steer', resume },
      });
      return true;
    } catch (error) {
      if (error?.status === 409) return true;
      if (error?.status === 404) {
        console.log(`[dispatch-results] dropping the result of ${entry.sessionId}: session ${entry.parentSessionId} no longer exists`);
        return true;
      }
      throw error;
    }
  };

  const pendingFor = (sessionId) => Array.from(entries.values()).filter((entry) => entry.sessionId === sessionId);

  const clearTimer = (sessionId) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      timers.delete(sessionId);
    }
  };

  const arm = (sessionId, delayMs = quietMs) => {
    if (stopped || pendingFor(sessionId).length === 0) return;
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      tick(sessionId).catch((error) => {
        console.warn('[dispatch-results] tick failed:', error?.message ?? error);
      });
    }, Math.max(0, delayMs));
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  const retryLater = (sessionId) => {
    const count = (failures.get(sessionId) ?? 0) + 1;
    failures.set(sessionId, count);
    arm(sessionId, retryDelayMs(count));
  };

  async function tick(sessionId) {
    if (stopped || pendingFor(sessionId).length === 0) return;
    if (ticking.has(sessionId)) return arm(sessionId);
    ticking.add(sessionId);
    try {
      const watched = await readWatchedSession(sessionId);
      if (watched === null) return retryLater(sessionId);
      if (watched.kind === 'running') return;

      let waiting = false;
      const ready = [];
      for (const entry of pendingFor(sessionId)) {
        const outcome = watched.kind === 'deleted'
          ? DELETED_OUTCOME
          : readDispatchOutcome(watched.records, entry.dispatchedAt, entry.afterIdleId);
        if (outcome) ready.push({ entry, outcome });
        else waiting = true;
      }

      const unsent = ready.filter(({ entry }) => !entry.messageId);
      if (unsent.length > 0) {
        const minted = new Map();
        for (const { entry } of unsent) {
          if (!minted.has(entry.parentSessionId)) minted.set(entry.parentSessionId, createMessageId(now()));
          entry.messageId = minted.get(entry.parentSessionId);
        }
        try {
          await persist();
        } catch (error) {
          for (const { entry } of unsent) delete entry.messageId;
          throw error;
        }
      }

      const deliveries = new Map();
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
      console.warn(`[dispatch-results] delivering the result of ${sessionId} failed:`, error?.message ?? error);
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

  const register = async ({ parentSessionId, sessionId, dispatchedAt, afterIdleId }) => {
    const parent = parse(sessionIdSchema, parentSessionId);
    const watched = parse(sessionIdSchema, sessionId);
    if (!parent || !watched) throw new TypeError('parentSessionId and sessionId must be session ids');
    if (parent === watched) throw new TypeError('a session cannot return its result to itself');
    const at = parse(timeSchema, dispatchedAt);
    if (at === null) throw new TypeError('dispatchedAt must be a timestamp');
    await load();
    const entry = { id: `dispatch-${now()}-${Math.random().toString(36).slice(2, 9)}`, parentSessionId: parent, sessionId: watched, dispatchedAt: at };
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

  const processPayload = (payload) => {
    if (stopped) return;

    const deleted = parse(deletedEventSchema, payload);
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

    const status = parse(statusEventSchema, payload);
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

  const processEvent = (event) => {
    for (const payload of event?.translated?.() ?? []) processPayload(payload);
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
      .catch((error) => {
        console.warn('[dispatch-results] failed to load pending results:', error?.message ?? error);
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
