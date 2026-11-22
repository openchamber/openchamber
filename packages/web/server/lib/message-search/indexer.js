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

import { combineAbortSignals } from '../shared/bounded-fetch.js';

const PAGE_SIZE = 100;
const SESSION_PAGE_SIZE = 200;
// A cursor walk must always end: a repeated cursor or this many full
// pages stops it (the house cap order: GitLab/Linear walks cap at 20).
const MAX_PAGES_PER_WALK = 20;
const LIVE_DEBOUNCE_MS = 1_500;
const INDEXER_READ_TIMEOUT_MS = 5_000;
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
const recordIdSchema = z.object({ id: z.string().min(1) });
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
  readTimeoutMs = INDEXER_READ_TIMEOUT_MS,
  // Read per record, so switching it takes effect from the next one.
  includeReasoning = () => false,
  logger = console,
}) => {
  // One controller for the active runs: created when a drain or backfill
  // run starts, aborted by stop() so an in-flight read rejects at once and
  // idle() settles instead of waiting on OpenCode. A run that starts after
  // an abort gets a fresh controller, so a restarted indexer reads normally.
  let runController = null;
  const runSignal = () => {
    // Once stopped, cancellation is sticky: a read that starts (or a sync
    // that continues) after stop() must see the aborted signal, not a
    // fresh controller — otherwise idle() waits on that read's deadline
    // instead of settling at once.
    if (stopped) {
      if (!runController) runController = new AbortController();
      if (!runController.signal.aborted) runController.abort();
      return runController.signal;
    }
    if (!runController || runController.signal.aborted) runController = new AbortController();
    return runController.signal;
  };

  // Every client read carries a per-call deadline, composed with the run
  // signal — either firing aborts the read. The deadline value matches the
  // sibling bounded clients (session-work, session-assist: 5 s).
  const readWithDeadline = async (call) => {
    const combined = combineAbortSignals([runSignal(), AbortSignal.timeout(readTimeoutMs)]);
    try {
      return await call({ signal: combined.signal });
    } finally {
      combined.detach();
    }
  };

  const messageExists = async (client, sessionId, messageId) => {
    if (!messageId) return false;
    try {
      await readWithDeadline((options) => client.session.message.get({ sessionID: sessionId, messageID: messageId }, options));
      return true;
    } catch (error) {
      if (isTag(error, 'MessageNotFoundError')) return false;
      throw error;
    }
  };

  const liveTimers = new Map();
  const liveQueue = new Map();
  const backfillQueue = new Map();
  let draining = null;
  let backfill = { state: 'idle', total: 0, done: 0 };
  let backfillRun = 0;
  // Backfill runs are serialized through this chain (see onConnected):
  // overlapping walks share the continuation and protection state, and
  // one run resetting that state mid-walk could make another run's
  // completion cleanup delete sessions it never listed.
  let backfillInFlight = Promise.resolve();
  // Where a page-capped session-list walk stopped, with the sessions it had
  // already listed: the next backfill resumes there instead of restarting,
  // so a list longer than the cap is still walked to the end, in chunks.
  let backfillContinuation = null;
  // Sessions synced while an assembled list walk is in progress (across
  // cap chunks, that can span connections): a session created after the
  // walk passed its sort position is not in the walk's list, so the
  // completion cleanup must not treat its absence as a deletion.
  let backfillWalkProtected = null;
  let stopped = false;

  const syncSession = async (sessionId, directoryHint, { retried = false } = {}) => {
    const client = createClient(directoryHint);
    let session;
    try {
      session = sessionSchema.parse(await readWithDeadline((options) => client.session.get({ sessionID: sessionId }, options)));
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
    backfillWalkProtected?.add(sessionId);

    // A revert hides the tail of the conversation, and the next prompt
    // deletes it: what was read past the boundary is no longer the session.
    const revertId = session.revert?.messageID ?? null;
    const known = store.readSession(sessionId);
    if ((known?.revert_id ?? null) !== revertId) store.resetSession(sessionId, revertId);
    let cutoff = Number.POSITIVE_INFINITY;
    if (revertId) {
      // Unknown boundary: index nothing rather than text the user took back.
      let revertedRaw = null;
      try {
        revertedRaw = await readWithDeadline((options) => client.session.message.get({ sessionID: sessionId, messageID: revertId }, options));
      } catch (error) {
        // Only a genuinely missing boundary uses the index-nothing
        // fallback. A timeout or a stop abort must fail this sync (so
        // it is not marked synced) and stop any further reads, so the
        // session is retried on a later connect instead of being
        // silently dropped from search.
        if (!isTag(error, 'MessageNotFoundError')) throw error;
      }
      const reverted = createdSchema.safeParse(revertedRaw);
      cutoff = reverted.success ? reverted.data.time.created : Number.NEGATIVE_INFINITY;
    }

    // The history under the cursors changed: read the session again from the start, once.
    const startOver = () => {
      store.resetSession(sessionId, revertId);
      return syncSession(sessionId, directory, { retried: true });
    };

    const readingSession = store.readSession(sessionId);
    let walkTruncated = false;
    for (const role of ROLES) {
      // While reverted, the tail beyond the boundary will change: read from
      // the start each time and keep no cursor.
      let cursor = revertId ? null : (role === 'user' ? readingSession?.user_cursor : readingSession?.assistant_cursor) ?? null;
      let anchor = role === 'user' ? readingSession?.user_anchor : readingSession?.assistant_anchor;
      const seenCursors = new Set();
      let pages = 0;
      for (;;) {
        let page;
        try {
          page = messagePageSchema.parse(await readWithDeadline((options) => client.message.list({
            sessionID: sessionId,
            limit: pageSize,
            type: role,
            ...(cursor ? { cursor } : { order: 'asc' }),
          }, options)));
        } catch (error) {
          if (cursor && !retried && (isTag(error, 'InvalidCursorError') || isTag(error, 'InvalidRequestError'))) return startOver();
          throw error;
        }
        const records = page.data;
        // OpenCode answers a cursor whose message is gone (a revert followed
        // by a new prompt deletes the tail) with an empty page, the same as
        // "nothing new". Taken at its word, the session would never be read
        // past that point again.
        if (records.length === 0 && cursor && !retried && !(await messageExists(client, sessionId, anchor))) return startOver();
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
        const last = recordIdSchema.safeParse(records.at(-1));
        if (next && !revertId && last.success) {
          // The cursor points after the page's last record.
          anchor = last.data.id;
          store.setCursor(sessionId, role, next, anchor);
        }
        if (!next || records.length < pageSize) break;
        pages += 1;
        if (next === cursor || seenCursors.has(next)) {
          logger.warn?.(`[message-search] message pagination for session ${sessionId} (${role}) repeated a cursor; stopping the walk`);
          walkTruncated = true;
          break;
        }
        if (pages >= MAX_PAGES_PER_WALK) {
          logger.warn?.(`[message-search] message pagination for session ${sessionId} (${role}) hit the ${MAX_PAGES_PER_WALK}-page cap; stopping the walk`);
          walkTruncated = true;
          break;
        }
        if (cursor) seenCursors.add(cursor);
        seenCursors.add(next);
        cursor = next;
      }
    }
    // A walk the guard or the cap stopped is not a completed sync: the
    // per-page cursors were stored as they were read, so leaving the
    // session un-marked lets a later sync resume from the last stored
    // cursor instead of skipping the unread remainder as if it were read.
    if (!walkTruncated) store.markSynced(sessionId, session.time?.updated ?? null);
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
      runSignal();
      for (let job = takeNext(); job && !stopped; job = takeNext()) {
        try {
          await syncSession(job.sessionId, job.directory);
        } catch (error) {
          if (!stopped) logger.warn?.('[message-search] could not index a session:', error?.message ?? error);
        }
        if (job.fromBackfill) {
          backfill = { ...backfill, done: backfill.done + 1 };
          if (backfillPauseMs > 0) await new Promise((resolve) => setTimeout(resolve, backfillPauseMs));
        }
      }
      if (backfill.state === 'running' && backfillQueue.size === 0 && !backfillContinuation) backfill = { ...backfill, state: 'done' };
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
    const resumed = backfillContinuation;
    if (!resumed) backfillWalkProtected = new Set();
    runSignal();
    const client = createClient('');
    const listed = resumed?.listed ?? new Map();
    let cursor = resumed?.cursor ?? null;
    let listComplete = false;
    try {
      const seenCursors = new Set();
      let pages = 0;
      // A resumed walk's saved head pages are stale: a session changed
      // while disconnected keeps its old time.updated in the saved list,
      // so the queue check below would skip it as if it had been read,
      // and a session created in the gap sorts before the saved cursor
      // and is never listed at all. Re-read the head fresh, up to the
      // saved boundary cursor, before continuing the tail; the refresh
      // keeps its own page cap and repeated-cursor guard.
      let walkPending = true;
      if (resumed) {
        const boundary = resumed.cursor;
        // A refresh that hit its page cap on an earlier connection resumes
        // where it stopped instead of re-reading the same first pages and
        // never reaching the boundary: its progress (cursor, the fresh
        // entries read so far, and the saved ids it is replacing) is kept
        // on the continuation alongside the tail cursor.
        const freshHead = resumed.refresh?.freshHead ?? new Map();
        const segmentIds = resumed.refresh?.segmentIds ?? new Set(listed.keys());
        let headCursor = resumed.refresh?.cursor ?? null;
        if (headCursor) seenCursors.add(headCursor);
        let headPages = 0;
        walkPending = false;
        for (;;) {
          const page = sessionPageSchema.parse(await readWithDeadline((options) => client.session.list({ parentID: null, limit: SESSION_PAGE_SIZE, ...(headCursor ? { cursor: headCursor } : { order: 'desc' }) }, options)));
          for (const record of page.data) {
            const session = sessionSchema.safeParse(record);
            if (session.success && !session.data.parentID) freshHead.set(session.data.id, session.data);
          }
          const next = page.cursor?.next ?? null;
          if (!next || page.data.length < SESSION_PAGE_SIZE) {
            // The whole list now fits before the old boundary: the fresh
            // head is the complete list and replaces the assembled one.
            // Entries it no longer lists were deleted while disconnected:
            // the replacement is authoritative, so their walk protection
            // ends here and the completion cleanup must remove them even
            // if this walk synced them before the disconnect.
            for (const id of listed.keys()) {
              if (!freshHead.has(id)) backfillWalkProtected?.delete(id);
            }
            listed.clear();
            for (const [id, session] of freshHead) listed.set(id, session);
            listComplete = true;
            backfillContinuation = null;
            break;
          }
          if (next === boundary) {
            // The refresh now covers the whole saved segment, so it
            // REPLACES that segment: a saved entry the fresh head no
            // longer lists was deleted while disconnected, and keeping
            // it would leave its messages searchable after the tail
            // completes and cleanup trusts the assembled list. Entries
            // outside the segment (none yet: the tail has not run) and
            // the live-session protection set are untouched.
            for (const id of segmentIds) {
              if (!freshHead.has(id)) {
                listed.delete(id);
                // Authoritative removal, as above: a session this walk
                // synced before the disconnect loses its protection, so
                // the completion cleanup deletes it instead of keeping
                // its messages searchable.
                backfillWalkProtected?.delete(id);
              }
            }
            for (const [id, session] of freshHead) listed.set(id, session);
            walkPending = true;
            break;
          }
          headPages += 1;
          if (next === headCursor || seenCursors.has(next)) {
            logger.warn?.('[message-search] session list pagination repeated a cursor while refreshing a resumed backfill; stopping the walk with a partial list');
            // As with a fresh walk: drop the continuation, keep the
            // partial (now refreshed) list for queueing, delete nothing.
            backfillContinuation = null;
            backfillWalkProtected = null;
            for (const [id, session] of freshHead) listed.set(id, session);
            break;
          }
          if (headPages >= MAX_PAGES_PER_WALK) {
            logger.warn?.(`[message-search] session list pagination hit the ${MAX_PAGES_PER_WALK}-page cap while refreshing a resumed backfill; keeping the refresh progress and the saved tail cursor for the next walk`);
            // Do not merge the partial head: the segment is replaced
            // whole when the refresh reaches the boundary, and a partial
            // merge would resurrect entries the refresh has not covered
            // yet. The saved progress lets the next walk continue the
            // refresh from this cursor instead of starting it over.
            backfillContinuation = { cursor: boundary, listed, refresh: { cursor: next, freshHead, segmentIds } };
            break;
          }
          if (headCursor) seenCursors.add(headCursor);
          seenCursors.add(next);
          headCursor = next;
        }
      }
      if (walkPending) {
        pages = 0;
      for (;;) {
        const page = sessionPageSchema.parse(await readWithDeadline((options) => client.session.list({ parentID: null, limit: SESSION_PAGE_SIZE, ...(cursor ? { cursor } : { order: 'desc' }) }, options)));
        for (const record of page.data) {
          const session = sessionSchema.safeParse(record);
          if (session.success && !session.data.parentID) listed.set(session.data.id, session.data);
        }
        const next = page.cursor?.next ?? null;
        if (!next || page.data.length < SESSION_PAGE_SIZE) {
          listComplete = true;
          backfillContinuation = null;
          break;
        }
        pages += 1;
        if (next === cursor || seenCursors.has(next)) {
          logger.warn?.('[message-search] session list pagination repeated a cursor; stopping the backfill walk with a partial list');
          // A cursor that repeats will repeat again on a resume; drop the
          // continuation so the next walk starts fresh.
          backfillContinuation = null;
          backfillWalkProtected = null;
          break;
        }
        if (pages >= MAX_PAGES_PER_WALK) {
          logger.warn?.(`[message-search] session list pagination hit the ${MAX_PAGES_PER_WALK}-page cap; stopping the backfill walk with a partial list`);
          // A healthy list longer than the cap is not finished: keep the
          // place so the next backfill resumes past this chunk rather than
          // re-reading the same first pages and never reaching the rest.
          backfillContinuation = { cursor: next, listed };
          break;
        }
        if (cursor) seenCursors.add(cursor);
        seenCursors.add(next);
        cursor = next;
      }
      }
    } catch (error) {
      if (!stopped) logger.warn?.('[message-search] could not list sessions:', error?.message ?? error);
      // A failed fresh walk protects nothing; a failed resumed walk keeps
      // its protection for the retry of the same assembled walk.
      if (!backfillContinuation) backfillWalkProtected = null;
      return;
    }
    if (run !== backfillRun || stopped) return;
    // Only a complete list replaces the known set: a walk stopped by the
    // repeated-cursor guard or the page cap read a partial list, and a
    // partial list must not delete sessions it never reached.
    if (listComplete) {
      for (const id of store.sessionIds()) {
        if (!listed.has(id) && !backfillWalkProtected?.has(id)) store.deleteSession(id);
      }
      backfillWalkProtected = null;
    }
    let queued = 0;
    for (const session of listed.values()) {
      const known = store.readSession(session.id);
      const updatedAt = session.time?.updated ?? null;
      if (known && known.synced_updated_at !== null && updatedAt !== null && known.synced_updated_at >= updatedAt) continue;
      backfillQueue.set(session.id, session.location?.directory ?? '');
      queued += 1;
    }
    backfill = { state: queued > 0 || backfillContinuation ? 'running' : 'done', total: queued, done: 0 };
    // Await the drain so a serialized next run (see onConnected) starts
    // only after this run's syncs have finished adding to the protection
    // set its cleanup consults.
    await drain();
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
      backfillInFlight = backfillInFlight
        .catch(() => {})
        .then(() => (stopped ? undefined : startBackfill()));
    },

    status() {
      return { backfill: { ...backfill, queued: backfillQueue.size }, ...store.counts() };
    },

    /** Test seam: wait for the queue to drain. */
    idle: () => draining ?? Promise.resolve(),

    syncSession,

    stop() {
      stopped = true;
      runController?.abort();
      for (const timer of liveTimers.values()) clearTimeout(timer);
      liveTimers.clear();
    },
  };
};
