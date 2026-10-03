// Results of sessions an agent dispatched and asked to hear back from.
//
// An agent that creates, sends to, or forks a session with `returnResult`
// gets its answer at once and goes on. When the dispatched session's turn is
// over, this runtime hands its final answer to the session that dispatched it
// as a synthetic message and wakes that session, so the agent continues on its
// own: background primary sessions, the way OpenCode 2 reports a background
// subagent to its parent (core `session/subagent-completion.ts`).
//
// Event-driven like the message queue: the shared upstream hub delivers
// `session.status`, and an idle transition of a watched session arms a short
// timer. The tick confirms the turn is over against OpenCode itself (not
// running, no running subagent, and the `idle` record OpenCode appends when a
// run ends) before anything is delivered. Pending deliveries are persisted,
// so a restart in between still delivers.

import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';

const FILE_NAME = 'dispatch-results.json';
const FILE_VERSION = 1;
const MAX_ENTRIES = 200;
// Idle events arrive in bursts around a turn boundary.
const QUIET_MS = 500;
// While a subagent of the dispatched session runs, the turn is not over yet.
const SUBAGENT_RECHECK_MS = 5_000;
// An idle session without the run's `idle` record yet: the record lands with
// the event, so a few short rechecks cover a projection that trails it.
const SETTLE_RECHECK_MS = 2_000;
const SETTLE_RECHECKS = 3;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_PAGE_LIMIT = 50;
// The answer travels into the parent's context; a session that wrote a book
// is cut, and the agent can read the rest with session.messages.
const ANSWER_CHAR_LIMIT = 50_000;

export const DISPATCH_RESULT_SOURCE = 'openchamber-session';

const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Boundary schemas: the only place raw JSON (the file, OpenCode answers, hub
// events) is inspected. Everything below branches on what they return.
const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,128}$/);
const messageIdSchema = z.string().regex(/^msg_[A-Za-z0-9]{8,64}$/);
const timeSchema = z.number().finite().nonnegative();

const afterIdleSchema = z.string().min(1).nullable();

const entrySchema = z.object({
  id: z.string().min(1),
  parentSessionId: sessionIdSchema,
  sessionId: sessionIdSchema,
  dispatchedAt: timeSchema,
  // The newest end-of-run record before the dispatch; null when there was
  // none. Entries written before this field compare clock times instead.
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

/**
 * A message id in OpenCode's own ascending format (`msg_` + time + random),
 * minted once per delivery and persisted before the first attempt. OpenCode
 * refuses a second admission of the same id, so a retry after a crash or a
 * lost response can never deliver the answer twice.
 */
const createMessageId = (now) => {
  const time = (BigInt(now) * 0x1000n + BigInt(Math.floor(Math.random() * 0x1000))).toString(16).padStart(12, '0').slice(-12);
  let random = '';
  for (let index = 0; index < 14; index += 1) random += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return `msg_${time}${random}`;
};

const escapeAttribute = (value) => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const assistantText = (assistant) => assistant.content
  .map((item) => parse(textContentSchema, item)?.text ?? '')
  .join('')
  .trim();

const OUTCOME_STATES = { succeeded: 'completed', failed: 'error', interrupted: 'cancelled' };

/**
 * How the dispatched turn ended, read from the newest page of the session's
 * records (newest first), or null while it has not ended since the dispatch.
 *
 * OpenCode appends an `idle` record with the run's outcome when a run ends,
 * so the outcome is authoritative and survives a restart of either server.
 * The answer is the newest assistant reply of that turn.
 *
 * "Since the dispatch" is decided by record order against `afterIdleId`, the
 * newest idle record before the prompt went out, so OpenChamber's clock never
 * meets OpenCode's: a remote OpenCode whose clock lags would otherwise make a
 * finished turn look older than its own dispatch. Only an entry stored
 * without that baseline (`afterIdleId` undefined) falls back to `dispatchedAt`.
 */
export const readDispatchOutcome = (records, dispatchedAt, afterIdleId) => {
  const idleIndex = records.findIndex((record) => parse(recordTypeSchema, record)?.type === 'idle');
  if (idleIndex === -1) return null;
  // A malformed idle record proves nothing about the turn: keep waiting.
  const idle = parse(idleRecordSchema, records[idleIndex]);
  if (!idle) return null;
  const byOrder = afterIdleId !== undefined;
  if (byOrder ? idle.id === afterIdleId : idle.time.created < dispatchedAt) return null;
  // The turn's records sit between its idle record and the baseline one.
  const baselineIndex = byOrder && afterIdleId !== null
    ? records.findIndex((record) => parse(recordIdSchema, record)?.id === afterIdleId)
    : -1;
  const turnRecords = records.slice(idleIndex + 1, baselineIndex === -1 ? undefined : baselineIndex);
  const reply = turnRecords
    .map((record) => parse(assistantRecordSchema, record))
    .find((assistant) => assistant !== null && (byOrder || assistant.time.created >= dispatchedAt));
  return {
    state: OUTCOME_STATES[idle.outcome],
    text: reply ? assistantText(reply) : '',
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

/** The synthetic message that carries a dispatched session's result to its parent. */
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
  // Archive is OpenChamber's: an archived parent records the answer but is not woken.
  isSessionArchived = async () => false,
  fetchImpl = fetch,
  now = Date.now,
  quietMs = QUIET_MS,
  retryDelayMs = retryDelay,
  subagentRecheckMs = SUBAGENT_RECHECK_MS,
  settleRecheckMs = SETTLE_RECHECK_MS,
}) {
  const filePath = path.join(dataDir, FILE_NAME);

  /** entry id → { id, parentSessionId, sessionId, dispatchedAt, messageId? } */
  const entries = new Map();
  let loadPromise = null;
  let writePromise = Promise.resolve();
  let stopped = false;

  // In memory only: a restart starts every watched session from a fresh tick.
  const timers = new Map(); // watched sessionId → timeout
  const failures = new Map(); // watched sessionId → consecutive failed ticks
  const settleChecks = new Map(); // watched sessionId → rechecks spent waiting for the idle record
  const ticking = new Set(); // watched sessionIds with a tick in flight

  // --- persistence ---------------------------------------------------------

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (parse(errorCodeSchema, error)?.code === 'ENOENT') return [];
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Malformed is a failure, not "nothing pending": keep the bytes and
      // start over rather than overwrite them on the next write.
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      console.warn(`[dispatch-results] file was unreadable and moved to ${backup}: ${error?.message ?? error}`);
      return [];
    }
    // One unreadable entry is dropped alone; the rest still deliver.
    return (parse(storedFileSchema, parsed)?.entries ?? []).map((entry) => parse(entrySchema, entry)).filter(Boolean);
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const entry of stored) if (!entries.has(entry.id)) entries.set(entry.id, entry);
        })
        .catch((error) => {
          // A failed read must not pass for "nothing pending": the next write
          // would clobber the file, so writes wait for a load that succeeds.
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const persist = () => {
    const payload = JSON.stringify({ version: FILE_VERSION, entries: Array.from(entries.values()) });
    writePromise = writePromise
      .then(async () => {
        await fs.promises.mkdir(dataDir, { recursive: true });
        const tmpPath = `${filePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
        await fs.promises.rename(tmpPath, filePath);
      })
      .catch((error) => {
        console.warn('[dispatch-results] failed to persist pending results:', error?.message ?? error);
      });
    return writePromise;
  };

  // --- OpenCode access -----------------------------------------------------

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

  /**
   * Where the watched session stands: `running`, `ended` with its record page
   * and title, `deleted`, or null when OpenCode could not be asked. Unknown is
   * never "ended": a failed read retries instead of reporting a guess.
   */
  const readWatchedSession = async (sessionId) => {
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!statuses) return null;
    if (statuses[sessionId]) return { kind: 'running' };
    // A turn is over only when its subagents are done too: the session idles
    // while a background subagent works and runs again on its result.
    const subagentsWorking = await activityProbe.hasWorkingChildren(sessionId, statuses);
    if (subagentsWorking === null) return null;
    if (subagentsWorking) return { kind: 'subagents' };
    const encoded = encodeURIComponent(sessionId);
    try {
      const session = parse(sessionRecordSchema, await openCodeRequest(`/api/session/${encoded}`));
      const page = parse(messagePageSchema, await openCodeRequest(`/api/session/${encoded}/message`, {
        query: { limit: String(MESSAGE_PAGE_LIMIT), order: 'desc' },
      }));
      // An answer that is not a page is unknown, never an empty history.
      if (!page) return null;
      return { kind: 'ended', title: session?.title?.trim() ?? '', records: page.data };
    } catch (error) {
      if (error?.status === 404) return { kind: 'deleted' };
      return null;
    }
  };

  /** Admits the result into the parent. Resolves true when it is there (now or before). */
  const deliver = async (entry, message) => {
    // The archive store answers asynchronously; reading its Promise as a
    // value made every parent look archived, so none was ever woken. A failed
    // lookup wakes: the agent asked for this result.
    const archived = await Promise.resolve(isSessionArchived(entry.parentSessionId)).catch(() => false);
    const resume = archived !== true;
    try {
      await openCodeRequest(`/api/session/${encodeURIComponent(entry.parentSessionId)}/synthetic`, {
        method: 'POST',
        body: { id: entry.messageId, ...message, delivery: 'steer', resume },
      });
      return true;
    } catch (error) {
      // The id is ours and was admitted before: an earlier attempt landed.
      if (error?.status === 409) return true;
      // The parent is gone; nobody is left to tell.
      if (error?.status === 404) {
        console.log(`[dispatch-results] dropping the result of ${entry.sessionId}: session ${entry.parentSessionId} no longer exists`);
        return true;
      }
      throw error;
    }
  };

  // --- delivery loop -------------------------------------------------------

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
    // An idle event that lands while a tick is still reading must not be
    // lost: that tick may have seen the session running a moment earlier.
    if (ticking.has(sessionId)) return arm(sessionId);
    ticking.add(sessionId);
    try {
      const watched = await readWatchedSession(sessionId);
      if (watched === null) return retryLater(sessionId);
      // Running: its next idle event re-arms the tick.
      if (watched.kind === 'running') return;
      if (watched.kind === 'subagents') return arm(sessionId, subagentRecheckMs);

      let waiting = false;
      for (const entry of pendingFor(sessionId)) {
        const outcome = watched.kind === 'deleted'
          ? DELETED_OUTCOME
          : readDispatchOutcome(watched.records, entry.dispatchedAt, entry.afterIdleId);
        if (!outcome) {
          waiting = true;
          continue;
        }
        if (!entry.messageId) {
          // Persisted before the first attempt, so a retry reuses it.
          entry.messageId = createMessageId(now());
          await persist();
        }
        const message = buildDispatchResultMessage({
          sessionId,
          title: watched.kind === 'ended' ? watched.title : '',
          outcome,
        });
        await deliver(entry, message);
        entries.delete(entry.id);
        await persist();
        console.log(`[dispatch-results] delivered the ${outcome.state} result of ${sessionId} to ${entry.parentSessionId}`);
      }
      failures.delete(sessionId);

      if (!waiting) {
        settleChecks.delete(sessionId);
        return;
      }
      // Idle, yet the run's idle record is not there: either the record trails
      // the event briefly, or the dispatched prompt has not started. A few
      // short rechecks cover the first; the next idle event covers the second.
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

  // --- public --------------------------------------------------------------

  /**
   * Watches `sessionId` for the end of the turn dispatched at `dispatchedAt`
   * and delivers its result to `parentSessionId`. Resolves once the entry is
   * on disk, so a restart right after the tool answers still delivers.
   */
  const register = async ({ parentSessionId, sessionId, dispatchedAt, afterIdleId }) => {
    const parent = parse(sessionIdSchema, parentSessionId);
    const watched = parse(sessionIdSchema, sessionId);
    if (!parent || !watched) throw new TypeError('parentSessionId and sessionId must be session ids');
    if (parent === watched) throw new TypeError('a session cannot return its result to itself');
    const at = parse(timeSchema, dispatchedAt);
    if (at === null) throw new TypeError('dispatchedAt must be a timestamp');
    await load();
    const entry = { id: `dispatch-${now()}-${Math.random().toString(36).slice(2, 9)}`, parentSessionId: parent, sessionId: watched, dispatchedAt: at };
    // Kept only when it is a real baseline (an id, or null for "none yet").
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
    await persist();
    // The session may already be done: a short turn can end before this
    // entry existed, and its idle event would then have found nothing to arm.
    arm(watched);
    return { id: entry.id };
  };

  const processPayload = (payload) => {
    if (stopped) return;

    const deleted = parse(deletedEventSchema, payload);
    if (deleted) {
      const deletedSessionId = deleted.properties.sessionID;
      // A deleted parent has nobody left to tell; a deleted dispatched session
      // still reports, as stopped, so the agent is not left waiting.
      let changed = false;
      for (const entry of entries.values()) {
        if (entry.parentSessionId === deletedSessionId) {
          entries.delete(entry.id);
          changed = true;
        }
      }
      if (changed) void persist();
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
    /** Pending entries, oldest first; tests and diagnostics read it. */
    pending: () => Array.from(entries.values()).sort((left, right) => left.dispatchedAt - right.dispatchedAt),
    /** Drains the pending write; tests and shutdown use it. */
    flush: () => writePromise,
  };
}
