import { z } from 'zod';
import { sessionParentId } from '../session-lineage.js';
import type { MessageListInput, OpenCodeClient, SessionMessageGetInput } from '@opencode/client';
import type { SQLOutputValue } from 'node:sqlite';
import type { GlobalStreamEvent } from '../event-stream/global-hub.js';
import type { applyOwnedArchiveState } from '../opencode/proxy.js';
import type { IndexedMessage, openMessageSearchStore } from './store.js';

const PAGE_SIZE = 100;
const SESSION_PAGE_SIZE = 200;
const LIVE_DEBOUNCE_MS = 1_500;
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

export interface IndexerClient {
  session: {
    get: OpenCodeClient['session']['get'];
    list: OpenCodeClient['session']['list'];
    message: { get(input: Omit<SessionMessageGetInput, 'messageID'> & { messageID: StoredIdentifier }): ReturnType<OpenCodeClient['session']['message']['get']> };
  };
  message: { list(input: Omit<MessageListInput, 'cursor'> & { cursor?: StoredIdentifier | undefined }): ReturnType<OpenCodeClient['message']['list']> };
}

export interface IndexerOptions {
  store: ReturnType<typeof openMessageSearchStore>;
  createClient: (directory: string) => IndexerClient;
  pageSize?: number;
  liveDebounceMs?: number;
  backfillPauseMs?: number;
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

const messageExists = async (client: IndexerClient, sessionId: string, messageId: SQLOutputValue | undefined) => {
  if (!messageId) return false;
  try {
    await client.session.message.get({ sessionID: sessionId, messageID: messageId });
    return true;
  } catch (error) {
    if (hasTag(error) && error._tag === 'MessageNotFoundError') return false;
    throw error;
  }
};

const isSettled = (message: Message) => message.type !== 'assistant' || Number.isFinite(message.time.completed);

export const createMessageSearchIndexer = ({
  store,
  createClient,
  pageSize = PAGE_SIZE,
  liveDebounceMs = LIVE_DEBOUNCE_MS,
  backfillPauseMs = BACKFILL_PAUSE_MS,
  includeReasoning = () => false,
  getArchivedSessions = async () => null,
  applyOwnedArchiveState = (session) => session,
  logger = console,
}: IndexerOptions) => {
  const liveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const liveQueue = new Map<string, string>();
  const backfillQueue = new Map<string, string>();
  let draining: Promise<void> | null = null;
  let backfill = { state: 'idle', total: 0, done: 0 };
  let backfillRun = 0;
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
      const upstream = sessionSchema.parse(await client.session.get({ sessionID: sessionId }));
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

    const revertId = session.revert?.messageID ?? null;
    const known = store.readSession(sessionId);
    if ((known?.revert_id ?? null) !== revertId) store.resetSession(sessionId, revertId);
    let cutoff = Number.POSITIVE_INFINITY;
    if (revertId) {
      const reverted = createdSchema.safeParse(
        await client.session.message.get({ sessionID: sessionId, messageID: revertId }).catch(() => null),
      );
      cutoff = reverted.success ? reverted.data.time.created : Number.NEGATIVE_INFINITY;
    }

    const startOver = (): Promise<void> => {
      store.resetSession(sessionId, revertId);
      return syncSession(sessionId, directory, { retried: true });
    };

    const readingSession = store.readSession(sessionId);
    for (const role of ROLES) {
      let cursor = revertId ? null : (role === 'user' ? readingSession?.user_cursor : readingSession?.assistant_cursor) ?? null;
      let anchor = role === 'user' ? readingSession?.user_anchor : readingSession?.assistant_anchor;
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
        cursor = next;
      }
    }
    store.markSynced(sessionId, session.time?.updated ?? null);
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
      for (let job = takeNext(); job && !stopped; job = takeNext()) {
        try {
          await syncSession(job.sessionId, job.directory);
        } catch (error) {
          logger.warn?.('[message-search] could not index a session:', (hasMessage(error) ? error.message : undefined) ?? error);
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
    const client = createClient('');
    const listed = new Map<SQLOutputValue | undefined, Session>();
    let cursor: string | null = null;
    try {
      for (;;) {
        const page: z.output<typeof sessionPageSchema> = sessionPageSchema.parse(await client.session.list({ parentID: null, limit: SESSION_PAGE_SIZE, ...(cursor ? { cursor } : { order: 'desc' }) }));
        for (const record of page.data) {
          const session = sessionSchema.safeParse(record);
          if (session.success && !sessionParentId(session.data)) listed.set(session.data.id, session.data);
        }
        const next = page.cursor?.next ?? null;
        if (!next || page.data.length < SESSION_PAGE_SIZE) break;
        cursor = next;
      }
    } catch (error) {
      logger.warn?.('[message-search] could not list sessions:', (hasMessage(error) ? error.message : undefined) ?? error);
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
    for (const id of store.sessionIds()) {
      if (listed.has(id)) continue;
      if (id === undefined) throw new TypeError('Missing id column in search index');
      store.deleteSession(id);
      recordSessionDeletion(id);
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
    backfill = { state: queued > 0 ? 'running' : 'done', total: queued, done: 0 };
    void drain();
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
      void startBackfill();
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
      for (const timer of liveTimers.values()) clearTimeout(timer);
      liveTimers.clear();
    },
  };
};
