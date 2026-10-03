/**
 * Keeps the message search index in step with OpenCode.
 *
 * Live: a session's turn ending (or one of its steps settling) queues that
 * session; a sync reads only what came after the stored cursors. Background:
 * once OpenCode is reachable, the session list is walked and every session
 * changed since it was last read is queued behind the live ones, one at a
 * time. Nothing here blocks a request or a turn.
 *
 * What goes in: the text of user messages and of settled agent replies, and,
 * when asked for (`includeReasoning`), the agent's reasoning as rows of their
 * own. Tool calls, their output and attached context records stay out.
 * Subagent sessions stay out, as they do in the command palette.
 */

import { z } from 'zod';

const PAGE_SIZE = 100;
const SESSION_PAGE_SIZE = 200;
const LIVE_DEBOUNCE_MS = 1_500;
const BACKFILL_PAUSE_MS = 25;
const ROLES = ['user', 'assistant'];

const isTag = (error, tag) => error?._tag === tag;

// OpenCode's records and events, read once here. Only the fields the index
// uses are parsed; anything else on them is ignored.
const sessionSchema = z.object({
  id: z.string().min(1),
  parentID: z.string().nullish(),
  title: z.string().nullish(),
  location: z.object({ directory: z.string() }).partial().nullish(),
  time: z.object({ created: z.number(), updated: z.number() }).partial().nullish(),
  revert: z.object({ messageID: z.string().nullish() }).nullish(),
});
const sessionPageSchema = z.object({
  data: z.array(z.unknown()),
  cursor: z.object({ next: z.string().nullish() }).nullish(),
});
const messagePageSchema = sessionPageSchema;
const createdSchema = z.object({ time: z.object({ created: z.number() }) });
const textPartSchema = z.object({ type: z.literal('text'), text: z.string() });
const reasoningPartSchema = z.object({ type: z.literal('reasoning'), text: z.string() });
const messageSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string().min(1), type: z.literal('user'), text: z.string().nullish(), time: z.object({ created: z.number() }) }),
  z.object({
    id: z.string().min(1),
    type: z.literal('assistant'),
    content: z.array(z.unknown()).nullish(),
    time: z.object({ created: z.number(), completed: z.number().nullish() }),
  }),
]);
const eventSchema = z.object({
  type: z.string(),
  properties: z.object({
    sessionID: z.string().min(1),
    info: z.object({
      title: z.string(),
      directory: z.string(),
      time: z.object({ completed: z.number() }).partial(),
    }).partial().nullish(),
  }),
});

// Terminal selections appended by older builds are source material, not what
// the user wrote (session-assist/context.js strips them the same way).
const stripTerminalContext = (text) => text.replace(/\n*<terminal_context>\n[\s\S]*?\n<\/terminal_context>\s*$/, '');

/** An agent record's parts of one kind, joined; null when it has none. */
const joinParts = (message, schema) => {
  const blocks = [];
  for (const part of message.content ?? []) {
    const parsed = schema.safeParse(part);
    if (parsed.success && parsed.data.text.trim()) blocks.push(parsed.data.text.trim());
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null;
};

/** The searchable text of a parsed message record, or null when it has none. */
const readSearchableText = (message) => {
  if (message.type === 'user') return stripTerminalContext(message.text ?? '').trim() || null;
  return joinParts(message, textPartSchema);
};

// An assistant record is still being written until OpenCode stamps it
// completed; its text is not final and it must not move the cursor past it.
const isSettled = (message) => message.type !== 'assistant' || Number.isFinite(message.time.completed);

export const createMessageSearchIndexer = ({
  store,
  // (directory) => OpenCode client, built at call time so a restarted or
  // re-pointed OpenCode is used as soon as it exists.
  createClient,
  pageSize = PAGE_SIZE,
  liveDebounceMs = LIVE_DEBOUNCE_MS,
  backfillPauseMs = BACKFILL_PAUSE_MS,
  // Read per record, so switching it takes effect from the next one.
  includeReasoning = () => false,
  logger = console,
}) => {
  const liveTimers = new Map();
  const liveQueue = new Map();
  const backfillQueue = new Map();
  let draining = null;
  let backfill = { state: 'idle', total: 0, done: 0 };
  let backfillRun = 0;
  let stopped = false;

  const syncSession = async (sessionId, directoryHint, { retried = false } = {}) => {
    const client = createClient(directoryHint);
    let session;
    try {
      session = sessionSchema.parse(await client.session.get({ sessionID: sessionId }));
    } catch (error) {
      if (isTag(error, 'SessionNotFoundError')) {
        store.deleteSession(sessionId);
        return;
      }
      throw error;
    }
    if (session.parentID) {
      store.deleteSession(sessionId);
      return;
    }
    const directory = session.location?.directory || directoryHint || '';
    store.upsertSession({ id: sessionId, directory, title: session.title ?? '', createdAt: session.time?.created });

    // A revert hides the tail of the conversation, and the next prompt
    // deletes it: what was read past the boundary is no longer the session.
    const revertId = session.revert?.messageID ?? null;
    const known = store.readSession(sessionId);
    if ((known?.revert_id ?? null) !== revertId) store.resetSession(sessionId, revertId);
    let cutoff = Number.POSITIVE_INFINITY;
    if (revertId) {
      // Unknown boundary: index nothing rather than text the user took back.
      const reverted = createdSchema.safeParse(
        await client.session.message.get({ sessionID: sessionId, messageID: revertId }).catch(() => null),
      );
      cutoff = reverted.success ? reverted.data.time.created : Number.NEGATIVE_INFINITY;
    }

    const readingSession = store.readSession(sessionId);
    for (const role of ROLES) {
      // While reverted, the tail beyond the boundary will change: read from
      // the start each time and keep no cursor.
      let cursor = revertId ? null : (role === 'user' ? readingSession?.user_cursor : readingSession?.assistant_cursor) ?? null;
      for (;;) {
        let page;
        try {
          page = messagePageSchema.parse(await client.message.list({
            sessionID: sessionId,
            limit: pageSize,
            type: role,
            ...(cursor ? { cursor } : { order: 'asc' }),
          }));
        } catch (error) {
          // The message the cursor names is gone (deleted, reverted and
          // replaced): read the session again from the start, once.
          if (cursor && !retried && (isTag(error, 'InvalidCursorError') || isTag(error, 'MessageNotFoundError') || isTag(error, 'InvalidRequestError'))) {
            store.resetSession(sessionId, revertId);
            return syncSession(sessionId, directory, { retried: true });
          }
          throw error;
        }
        const records = page.data;
        const rows = [];
        let complete = true;
        for (const record of records) {
          const parsed = messageSchema.safeParse(record);
          // A record this reader does not understand carries nothing it can
          // index; passing over it keeps the rest of the session searchable.
          if (!parsed.success) continue;
          const message = parsed.data;
          if (message.time.created >= cutoff || !isSettled(message)) {
            complete = false;
            break;
          }
          const text = readSearchableText(message);
          if (text) rows.push({ id: message.id, sessionId, role, createdAt: message.time.created, text });
          // A row of its own: the reply and the reasoning are found, filtered
          // and dropped separately, and both lead to the same message.
          const reasoning = message.type === 'assistant' && includeReasoning() ? joinParts(message, reasoningPartSchema) : null;
          if (reasoning) {
            rows.push({ id: `${message.id}:reasoning`, messageId: message.id, sessionId, role: 'reasoning', createdAt: message.time.created, text: reasoning });
          }
        }
        store.putMessages(rows);
        if (!complete) break;
        const next = page.cursor?.next ?? null;
        if (next && !revertId) store.setCursor(sessionId, role, next);
        if (!next || records.length < pageSize) break;
        cursor = next;
      }
    }
    store.markSynced(sessionId, session.time?.updated ?? null);
  };

  const takeNext = () => {
    for (const queue of [liveQueue, backfillQueue]) {
      const first = queue.entries().next();
      if (!first.done) {
        const [sessionId, directory] = first.value;
        queue.delete(sessionId);
        backfillQueue.delete(sessionId);
        return { sessionId, directory, fromBackfill: queue === backfillQueue };
      }
    }
    return null;
  };

  const drain = () => {
    if (draining || stopped) return draining;
    draining = (async () => {
      for (let job = takeNext(); job && !stopped; job = takeNext()) {
        try {
          await syncSession(job.sessionId, job.directory);
        } catch (error) {
          logger.warn?.('[message-search] could not index a session:', error?.message ?? error);
        }
        if (job.fromBackfill) {
          backfill = { ...backfill, done: backfill.done + 1 };
          if (backfillPauseMs > 0) await new Promise((resolve) => setTimeout(resolve, backfillPauseMs));
        }
      }
      if (backfill.state === 'running' && backfillQueue.size === 0) backfill = { ...backfill, state: 'done' };
    })().finally(() => {
      draining = null;
      if (!stopped && (liveQueue.size > 0 || backfillQueue.size > 0)) void drain();
    });
    return draining;
  };

  const queueLive = (sessionId, directory) => {
    if (!sessionId || stopped) return;
    clearTimeout(liveTimers.get(sessionId));
    liveTimers.set(sessionId, setTimeout(() => {
      liveTimers.delete(sessionId);
      liveQueue.set(sessionId, directory);
      void drain();
    }, liveDebounceMs));
  };

  /**
   * Walks every root session OpenCode lists and queues the ones changed since
   * they were read. Sessions the index holds that OpenCode no longer lists are
   * dropped, but only after the whole list arrived: a failed page is not an
   * empty list.
   */
  const startBackfill = async () => {
    const run = ++backfillRun;
    const client = createClient('');
    const listed = new Map();
    let cursor = null;
    try {
      for (;;) {
        const page = sessionPageSchema.parse(await client.session.list({ parentID: null, limit: SESSION_PAGE_SIZE, ...(cursor ? { cursor } : { order: 'desc' }) }));
        for (const record of page.data) {
          const session = sessionSchema.safeParse(record);
          if (session.success && !session.data.parentID) listed.set(session.data.id, session.data);
        }
        const next = page.cursor?.next ?? null;
        if (!next || page.data.length < SESSION_PAGE_SIZE) break;
        cursor = next;
      }
    } catch (error) {
      logger.warn?.('[message-search] could not list sessions:', error?.message ?? error);
      return;
    }
    if (run !== backfillRun || stopped) return;
    for (const id of store.sessionIds()) {
      if (!listed.has(id)) store.deleteSession(id);
    }
    let queued = 0;
    for (const session of listed.values()) {
      const known = store.readSession(session.id);
      const updatedAt = session.time?.updated ?? null;
      if (known && known.synced_updated_at !== null && updatedAt !== null && known.synced_updated_at >= updatedAt) continue;
      backfillQueue.set(session.id, session.location?.directory ?? '');
      queued += 1;
    }
    backfill = { state: queued > 0 ? 'running' : 'done', total: queued, done: 0 };
    void drain();
  };

  return {
    /** Translated OpenCode events (event-stream/translate-v2.js vocabulary). */
    processPayload(payload, directory = '') {
      if (stopped) return;
      const event = eventSchema.safeParse(payload);
      if (!event.success) return;
      const { type, properties: { sessionID: sessionId, info } } = event.data;
      switch (type) {
        case 'session.idle':
          queueLive(sessionId, directory);
          return;
        case 'message.updated':
          if (Number.isFinite(info?.time?.completed)) queueLive(sessionId, directory);
          return;
        case 'session.updated': {
          if (info?.title !== undefined) store.renameSession(sessionId, info.title);
          if (info?.directory) store.moveSession(sessionId, info.directory);
          return;
        }
        case 'session.deleted':
          clearTimeout(liveTimers.get(sessionId));
          liveTimers.delete(sessionId);
          liveQueue.delete(sessionId);
          backfillQueue.delete(sessionId);
          store.deleteSession(sessionId);
          return;
        default:
      }
    },

    /** OpenCode (re)connected: catch up on whatever changed while it was not watched. */
    onConnected() {
      if (stopped) return;
      void startBackfill();
    },

    status() {
      return { backfill: { ...backfill, queued: backfillQueue.size }, ...store.counts() };
    },

    /** Test seam: wait for the queue to drain. */
    idle: () => draining ?? Promise.resolve(),

    syncSession,

    stop() {
      stopped = true;
      for (const timer of liveTimers.values()) clearTimeout(timer);
      liveTimers.clear();
    },
  };
};
