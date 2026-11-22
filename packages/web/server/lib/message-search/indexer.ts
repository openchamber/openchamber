import { z } from 'zod';
import { sessionParentId } from '../session-lineage.js';
import type { MessageListInput, OpenCodeClient, SessionMessageGetInput } from '@opencode/client';
import type { SQLOutputValue } from 'node:sqlite';
import type { GlobalStreamEvent } from '../event-stream/global-hub.js';
import type { applyOwnedArchiveState } from '../opencode/proxy.js';
import type { IndexedMessage, openMessageSearchStore } from './store.js';

import { combineAbortSignals } from '../shared/bounded-fetch.js';

const PAGE_SIZE = 100;
const SESSION_PAGE_SIZE = 200;
// A cursor walk must always end: a repeated cursor or this many full
// pages stops it (the house cap order: GitLab/Linear walks cap at 20).
const MAX_PAGES_PER_WALK = 20;
const LIVE_DEBOUNCE_MS = 1_500;
const INDEXER_READ_TIMEOUT_MS = 5_000;
const BACKFILL_PAUSE_MS = 25;
const ROLES: readonly ('user' | 'assistant')[] = ['user', 'assistant'];

const hasTag = (error: unknown): error is { _tag: unknown } =>
  error != null && '_tag' in Object(error);
const hasMessage = (error: unknown): error is { message: unknown } =>
  error != null && 'message' in Object(error);
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);
const isBigInt = (value: SQLOutputValue | undefined): value is bigint => typeof value === 'bigint';

const sessionSchema = z.object({
  id: z.string().min(1),
  parentID: z.string().nullish(),
  metadata: z.unknown().optional(),
  title: z.string().nullish(),
  location: z.object({ directory: z.string() }).partial().nullish(),
  time: z.object({ created: z.number(), updated: z.number(), archived: z.number().nullish() }).partial().nullish(),
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
const archivedEventSchema = z.object({
  type: z.literal('session.archived'),
  created: z.number().finite().nullable().catch(null),
  data: z.object({ sessionID: z.string().min(1) }),
});

type StoredIdentifier = NonNullable<SQLOutputValue>;
type Session = z.output<typeof sessionSchema>;
type Message = z.output<typeof messageSchema>;
type AssistantMessage = Extract<Message, { type: 'assistant' }>;
type ArchiveTimes = Record<string, number | null> | null;

interface ReadOptions {
  signal?: AbortSignal;
}

export interface IndexerClient {
  session: {
    get: OpenCodeClient['session']['get'];
    list: OpenCodeClient['session']['list'];
    message: { get(input: Omit<SessionMessageGetInput, 'messageID'> & { messageID: StoredIdentifier }, options?: ReadOptions): ReturnType<OpenCodeClient['session']['message']['get']> };
  };
  message: { list(input: Omit<MessageListInput, 'cursor'> & { cursor?: StoredIdentifier | undefined }, options?: ReadOptions): ReturnType<OpenCodeClient['message']['list']> };
}

export interface IndexerOptions {
  store: ReturnType<typeof openMessageSearchStore>;
  createClient: (directory: string) => IndexerClient;
  pageSize?: number;
  liveDebounceMs?: number;
  backfillPauseMs?: number;
  readTimeoutMs?: number;
  includeReasoning?: () => boolean;
  getArchivedSessions?: () => Promise<ArchiveTimes>;
  applyOwnedArchiveState?: typeof applyOwnedArchiveState<Session>;
  logger?: Pick<Console, 'warn'>;
}

const hasArchiveTime = (value: unknown): value is { time: { archived: number } } => {
  if (value == null) return false;
  const session: object = Object(value);
  if (!('time' in session) || session.time == null) return false;
  const time: object = Object(session.time);
  return 'archived' in time && isFiniteNumber(time.archived);
};

const stripTerminalContext = (text: string) => text.replace(/\n*<terminal_context>\n[\s\S]*?\n<\/terminal_context>\s*$/, '');

const joinParts = (message: AssistantMessage, schema: typeof textPartSchema | typeof reasoningPartSchema) => {
  const blocks = [];
  for (const part of message.content ?? []) {
    const parsed = schema.safeParse(part);
    if (parsed.success && parsed.data.text.trim()) blocks.push(parsed.data.text.trim());
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null;
};

const readSearchableText = (message: Message) => {
  if (message.type === 'user') return stripTerminalContext(message.text ?? '').trim() || null;
  return joinParts(message, textPartSchema);
};

const isSettled = (message: Message) => message.type !== 'assistant' || Number.isFinite(message.time.completed);

export const createMessageSearchIndexer = ({
  store,
  createClient,
  pageSize = PAGE_SIZE,
  liveDebounceMs = LIVE_DEBOUNCE_MS,
  backfillPauseMs = BACKFILL_PAUSE_MS,
  readTimeoutMs = INDEXER_READ_TIMEOUT_MS,
  includeReasoning = () => false,
  getArchivedSessions = async () => null,
  applyOwnedArchiveState = (session) => session,
  logger = console,
}: IndexerOptions) => {
  // One controller for the active runs: created when a drain or backfill
  // run starts, aborted by stop() so an in-flight read rejects at once and
  // idle() settles instead of waiting on OpenCode. A run that starts after
  // an abort gets a fresh controller, so a restarted indexer reads normally.
  let runController: AbortController | null = null;
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
  const readWithDeadline = async <Result>(call: (options: ReadOptions) => Promise<Result>) => {
    const combined = combineAbortSignals([runSignal(), AbortSignal.timeout(readTimeoutMs)]);
    try {
      return await call({ signal: combined.signal });
    } finally {
      combined.detach();
    }
  };

  const messageExists = async (client: IndexerClient, sessionId: string, messageId: StoredIdentifier | null | undefined) => {
    if (!messageId) return false;
    try {
      await readWithDeadline((options) => client.session.message.get({ sessionID: sessionId, messageID: messageId }, options));
      return true;
    } catch (error) {
      if ((hasTag(error) && error._tag === 'MessageNotFoundError')) return false;
      throw error;
    }
  };

  const liveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const liveQueue = new Map<string, string>();
  const backfillQueue = new Map<string, string>();
  let draining: Promise<void> | null = null;
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
  let backfillContinuation: {
    cursor: string;
    listed: Map<SQLOutputValue | undefined, Session>;
    refresh?: { cursor: string | null; freshHead: Map<SQLOutputValue | undefined, Session>; segmentIds: Set<SQLOutputValue | undefined> };
  } | null = null;
  // Sessions synced while an assembled list walk is in progress (across
  // cap chunks, that can span connections): a session created after the
  // walk passed its sort position is not in the walk's list, so the
  // completion cleanup must not treat its absence as a deletion.
  let backfillWalkProtected: Set<SQLOutputValue | undefined> | null = null;
  let stopped = false;
  let lifecycleRevision = 0;
  const lifecycleMutations = new Map<SQLOutputValue, { revision: number; archivedAt: SQLOutputValue | undefined; lifecycleKnown: boolean }>();
  const pendingLifecycleWork = new Set<Promise<void>>();
  const activeLifecycleReaders = new Map<number, number>();
  const deletedLifecycleSessions = new Map<SQLOutputValue, number>();

  const cleanupDeletedLifecycleMutations = () => {
    for (const [sessionId, deletedAtRevision] of deletedLifecycleSessions) {
      const hasOlderReader = [...activeLifecycleReaders.keys()].some((revision) => revision < deletedAtRevision);
      if (hasOlderReader) continue;
      lifecycleMutations.delete(sessionId);
      deletedLifecycleSessions.delete(sessionId);
    }
  };

  const recordSessionDeletion = (sessionId: SQLOutputValue) => {
    deletedLifecycleSessions.set(sessionId, ++lifecycleRevision);
    cleanupDeletedLifecycleMutations();
  };

  const withLifecycleReader = async <T>(read: (revision: number) => Promise<T>) => {
    const startedAtRevision = lifecycleRevision;
    activeLifecycleReaders.set(startedAtRevision, (activeLifecycleReaders.get(startedAtRevision) ?? 0) + 1);
    try {
      return await read(startedAtRevision);
    } finally {
      const remaining = (activeLifecycleReaders.get(startedAtRevision) ?? 1) - 1;
      if (remaining > 0) activeLifecycleReaders.set(startedAtRevision, remaining);
      else activeLifecycleReaders.delete(startedAtRevision);
      cleanupDeletedLifecycleMutations();
    }
  };

  const withArchiveTime = (session: Session, archivedAt: SQLOutputValue | undefined) => {
    const time = { ...(session.time ?? {}) };
    if (isFiniteNumber(archivedAt)) time.archived = archivedAt;
    else delete time.archived;
    return { ...session, time };
  };

  const applySnapshotLifecycle = (session: Session, archivedById: ArchiveTimes, startedAtRevision: number) => {
    const overlaid = sessionSchema.parse(applyOwnedArchiveState(session, archivedById));
    const mutation = lifecycleMutations.get(overlaid.id);
    if (!mutation) return overlaid;
    if (mutation.lifecycleKnown && mutation.revision > startedAtRevision) {
      return withArchiveTime(overlaid, mutation.archivedAt);
    }
    if (mutation.revision <= startedAtRevision) {
      lifecycleMutations.set(overlaid.id, {
        revision: mutation.revision,
        archivedAt: isFiniteNumber(overlaid.time?.archived) ? overlaid.time.archived : null,
        lifecycleKnown: true,
      });
    }
    return overlaid;
  };

  const processLifecycleEvent = async (sessionId: string, archivedAt: number | null) => {
    const revision = ++lifecycleRevision;
    const current = store.readSession(sessionId);
    const hasEffectiveState = current?.lifecycle_known === 1;
    lifecycleMutations.set(sessionId, {
      revision,
      archivedAt: hasEffectiveState ? current.archived_at : null,
      lifecycleKnown: hasEffectiveState,
    });
    let archivedById;
    try {
      archivedById = await getArchivedSessions();
    } catch (error) {
      logger.warn?.('[message-search] could not read archive overlay:', (hasMessage(error) ? error.message : undefined) ?? error);
      return;
    }
    const upstream = withArchiveTime({ id: sessionId }, archivedAt);
    const overlaid = applyOwnedArchiveState(upstream, archivedById);
    const effectiveArchiveTime = hasArchiveTime(overlaid) ? overlaid.time.archived : null;
    if (lifecycleMutations.get(sessionId)?.revision !== revision) return;
    lifecycleMutations.set(sessionId, { revision, archivedAt: effectiveArchiveTime, lifecycleKnown: true });
    store.setArchiveState(sessionId, effectiveArchiveTime);
  };

  const trackLifecycleEvent = (sessionId: string, archivedAt: number | null) => {
    const work = processLifecycleEvent(sessionId, archivedAt).catch((error) => {
      logger.warn?.('[message-search] could not apply lifecycle event:', (hasMessage(error) ? error.message : undefined) ?? error);
    });
    pendingLifecycleWork.add(work);
    void work.finally(() => pendingLifecycleWork.delete(work));
    return work;
  };

  const runSyncSession = async (sessionId: string, directoryHint: string, { retried = false }: { retried?: boolean } = {}, startedAtRevision: number): Promise<void> => {
    const client = createClient(directoryHint);
    let session;
    try {
      const archived = await getArchivedSessions();
      const upstream = sessionSchema.parse(await readWithDeadline((options) => client.session.get({ sessionID: sessionId }, options)));
      session = applySnapshotLifecycle(upstream, archived, startedAtRevision);
    } catch (error) {
      if (hasTag(error) && error._tag === 'SessionNotFoundError') {
        store.deleteSession(sessionId);
        return;
      }
      throw error;
    }
    if ((deletedLifecycleSessions.get(sessionId) ?? 0) > startedAtRevision) return;
    if (sessionParentId(session)) {
      store.deleteSession(sessionId);
      return;
    }
    const directory = session.location?.directory || directoryHint || '';
    store.upsertSession({ id: sessionId, directory, title: session.title ?? '', createdAt: session.time?.created, archivedAt: session.time?.archived, lifecycleKnown: true });
    backfillWalkProtected?.add(sessionId);

    const revertId = session.revert?.messageID ?? null;
    const known = store.readSession(sessionId);
    if ((known?.revert_id ?? null) !== revertId) store.resetSession(sessionId, revertId);
    let cutoff = Number.POSITIVE_INFINITY;
    if (revertId) {
      let revertedRaw = null;
      try {
        revertedRaw = await readWithDeadline((options) => client.session.message.get({ sessionID: sessionId, messageID: revertId }, options));
      } catch (error) {
        // Only a genuinely missing boundary uses the index-nothing
        // fallback. A timeout or a stop abort must fail this sync (so
        // it is not marked synced) and stop any further reads, so the
        // session is retried on a later connect instead of being
        // silently dropped from search.
        if (!(hasTag(error) && error._tag === 'MessageNotFoundError')) throw error;
      }
      const reverted = createdSchema.safeParse(revertedRaw);
      cutoff = reverted.success ? reverted.data.time.created : Number.NEGATIVE_INFINITY;
    }

    const startOver = (): Promise<void> => {
      store.resetSession(sessionId, revertId);
      return syncSession(sessionId, directory, { retried: true });
    };

    const readingSession = store.readSession(sessionId);
    let walkTruncated = false;
    for (const role of ROLES) {
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
          if (cursor && !retried && hasTag(error) && (error._tag === 'InvalidCursorError' || error._tag === 'InvalidRequestError')) return startOver();
          throw error;
        }
        const records = page.data;
        if (records.length === 0 && cursor && !retried && !(await messageExists(client, sessionId, anchor))) return startOver();
        const rows: IndexedMessage[] = [];
        let complete = true;
        for (const record of records) {
          const parsed = messageSchema.safeParse(record);
          if (!parsed.success) continue;
          const message = parsed.data;
          if (message.time.created >= cutoff || !isSettled(message)) {
            complete = false;
            break;
          }
          const text = readSearchableText(message);
          if (text) rows.push({ id: message.id, sessionId, role, createdAt: message.time.created, text });
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

  const syncSession = (sessionId: string, directoryHint: string, options?: { retried?: boolean }): Promise<void> => withLifecycleReader(
    (startedAtRevision) => runSyncSession(sessionId, directoryHint, options, startedAtRevision),
  );

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
          if (!stopped) logger.warn?.('[message-search] could not index a session:', (hasMessage(error) ? error.message : undefined) ?? error);
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

  const queueLive = (sessionId: string, directory: string) => {
    if (!sessionId || stopped) return;
    clearTimeout(liveTimers.get(sessionId));
    liveTimers.set(sessionId, setTimeout(() => {
      liveTimers.delete(sessionId);
      liveQueue.set(sessionId, directory);
      void drain();
    }, liveDebounceMs));
  };

  const runBackfill = async (startedAtRevision: number) => {
    const run = ++backfillRun;
    const resumed = backfillContinuation;
    if (!resumed) backfillWalkProtected = new Set();
    runSignal();
    const client = createClient('');
    const listed: Map<SQLOutputValue | undefined, Session> = resumed?.listed ?? new Map<SQLOutputValue | undefined, Session>();
    let cursor: string | null = resumed?.cursor ?? null;
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
          if (session.success && !sessionParentId(session.data)) listed.set(session.data.id, session.data);
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
      if (!stopped) logger.warn?.('[message-search] could not list sessions:', (hasMessage(error) ? error.message : undefined) ?? error);
      // A failed fresh walk protects nothing; a failed resumed walk keeps
      // its protection for the retry of the same assembled walk.
      if (!backfillContinuation) backfillWalkProtected = null;
      return;
    }
    if (run !== backfillRun || stopped) return;
    let archived;
    try {
      archived = await getArchivedSessions();
    } catch (error) {
      logger.warn?.('[message-search] could not read archive overlay:', (hasMessage(error) ? error.message : undefined) ?? error);
      return;
    }
    if (run !== backfillRun || stopped) return;
    // Only a complete list replaces the known set: a walk stopped by the
    // repeated-cursor guard or the page cap read a partial list, and a
    // partial list must not delete sessions it never reached.
    if (listComplete) {
      for (const id of store.sessionIds()) {
        if (listed.has(id) || backfillWalkProtected?.has(id)) continue;
        if (id === undefined) throw new TypeError('Missing id column in search index');
        store.deleteSession(id);
        recordSessionDeletion(id);
      }
      backfillWalkProtected = null;
    }
    let queued = 0;
    for (const rawSession of listed.values()) {
      if ((deletedLifecycleSessions.get(rawSession.id) ?? 0) > startedAtRevision) continue;
      const session = applySnapshotLifecycle(rawSession, archived, startedAtRevision);
      store.upsertSession({ id: session.id, directory: session.location?.directory ?? '', title: session.title ?? '', createdAt: session.time?.created, archivedAt: session.time?.archived, lifecycleKnown: true });
      const known = store.readSession(session.id);
      const updatedAt = session.time?.updated ?? null;
      const synced = known?.synced_updated_at;
      if (known && synced !== null && updatedAt !== null && (isBigInt(synced) ? synced >= updatedAt : Number(synced) >= updatedAt)) continue;
      backfillQueue.set(session.id, session.location?.directory ?? '');
      queued += 1;
    }
    store.markLifecycleComplete();
    backfill = { state: queued > 0 || backfillContinuation ? 'running' : 'done', total: queued, done: 0 };
    // Await the drain so a serialized next run (see onConnected) starts
    // only after this run's syncs have finished adding to the protection
    // set its cleanup consults.
    await drain();
  };

  const startBackfill = () => withLifecycleReader(runBackfill);

  return {
    processPayload(payload: ReturnType<GlobalStreamEvent['translated']>[number], directory = '') {
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
        case 'session.unarchived':
          return trackLifecycleEvent(sessionId, null);
        case 'session.deleted':
          clearTimeout(liveTimers.get(sessionId));
          liveTimers.delete(sessionId);
          liveQueue.delete(sessionId);
          backfillQueue.delete(sessionId);
          store.deleteSession(sessionId);
          recordSessionDeletion(sessionId);
          return;
        default:
      }
    },

    onConnected() {
      if (stopped) return;
      backfillInFlight = backfillInFlight
        .catch(() => {})
        .then(() => (stopped ? undefined : startBackfill()));
    },

    processArchiveEvent(payload: GlobalStreamEvent['payload']) {
      if (stopped) return;
      const event = archivedEventSchema.safeParse(payload);
      if (!event.success) return;
      return trackLifecycleEvent(event.data.data.sessionID, event.data.created);
    },

    status() {
      return { backfill: { ...backfill, queued: backfillQueue.size }, ...store.counts() };
    },

    idle: async () => {
      await (draining ?? Promise.resolve());
      while (pendingLifecycleWork.size > 0) await Promise.all(pendingLifecycleWork);
    },

    syncSession,

    stop() {
      stopped = true;
      runController?.abort();
      for (const timer of liveTimers.values()) clearTimeout(timer);
      liveTimers.clear();
    },
  };
};
