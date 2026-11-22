import { create } from 'zustand';
import { z } from 'zod';
import type { SyncEvent } from '@/lib/opencode/events';
import type { Message, Part, Session } from '@/lib/opencode/model';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

const timestamp = z.number().finite().nonnegative();
const stampsSchema = z.object({ input: timestamp.optional(), output: timestamp.optional(), activity: timestamp.optional() });
const spanSchema = z.object({ start: timestamp.optional(), end: timestamp.optional() });
const snapshotSchema = z.object({
  sessions: z.record(z.string(), stampsSchema),
  spans: z.record(z.string(), spanSchema),
});
type SessionActivityTimestamps = z.infer<typeof stampsSchema>;
type EntryTimeSpan = z.infer<typeof spanSchema>;
type SessionTimestampField = 'created' | 'input' | 'output' | 'activity';
type SessionTimestampSortDirection = 'asc' | 'desc';
/** The four times a sidebar row shows; null when nothing recorded the event. */
type ResolvedSessionTimestamps = { created: number | null; input: number | null; output: number | null; activity: number | null };
type TimestampState = {
  byId: ReadonlyMap<string, SessionActivityTimestamps>;
  /** Last ordering publication; streamed deltas do not rebuild the sidebar. */
  sortById: ReadonlyMap<string, SessionActivityTimestamps>;
  spans: ReadonlyMap<string, EntryTimeSpan>;
};
const emptyState = (): TimestampState => ({ byId: new Map(), sortById: new Map(), spans: new Map() });
const storageKey = (runtime: string) => `oc.session-timestamps.v1:${runtime}`;
const spanKey = (sessionId: string, entryId: string) => JSON.stringify([sessionId, entryId]);
let runtime = getRuntimeKey();

const read = (owner: string): TimestampState => {
  try {
    const raw = getSafeStorage().getItem(storageKey(owner));
    if (!raw) return emptyState();
    const parsed = snapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return emptyState();
    const byId = new Map(Object.entries(parsed.data.sessions));
    return { byId, sortById: byId, spans: new Map(Object.entries(parsed.data.spans)) };
  } catch {
    // A failed read grants no timing authority and never deletes stored data.
    return emptyState();
  }
};
export const useSessionActivityTimestampsStore = create<TimestampState>(() => read(runtime));

const maxTime = (...values: Array<number | undefined | null>): number | undefined => {
  const valid = values.filter((value): value is number => value !== undefined && value !== null && Number.isFinite(value) && value >= 0);
  return valid.length ? Math.max(...valid) : undefined;
};
const mergeStamps = (left: SessionActivityTimestamps = {}, right: SessionActivityTimestamps): SessionActivityTimestamps => ({
  input: maxTime(left.input, right.input),
  output: maxTime(left.output, right.output),
  activity: maxTime(left.activity, right.activity, left.input, right.input, left.output, right.output),
});

// Match the existing session snapshot write cadence. Streaming events update
// memory immediately; serialization runs once per two-second window and on hide.
const PERSIST_INTERVAL_MS = 2_000;
let timer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
const deleted = new Set<string>();
export const flushSessionActivityTimestamps = (): void => {
  clearTimeout(timer);
  timer = undefined;
  if (!dirty) return;
  const current = useSessionActivityTimestampsStore.getState();
  if (current.sortById !== current.byId) useSessionActivityTimestampsStore.setState({ sortById: current.byId });
  const stored = read(runtime);
  const sessions = new Map(stored.byId);
  const spans = new Map(stored.spans);
  for (const id of deleted) {
    sessions.delete(id);
    for (const key of spans.keys()) if (key.startsWith(`[${JSON.stringify(id)},`)) spans.delete(key);
  }
  for (const [id, value] of current.byId) sessions.set(id, mergeStamps(sessions.get(id), value));
  for (const [key, value] of current.spans) spans.set(key, { ...spans.get(key), ...value });
  try {
    getSafeStorage().setItem(storageKey(runtime), JSON.stringify({ sessions: Object.fromEntries(sessions), spans: Object.fromEntries(spans) }));
    dirty = false;
    deleted.clear();
  } catch {
    // Keep pending state for a later mutation or lifecycle flush.
  }
};
let lifecycleHooked = false;
const schedulePersist = (): void => {
  dirty = true;
  if (!timer) timer = setTimeout(flushSessionActivityTimestamps, PERSIST_INTERVAL_MS);
  if (lifecycleHooked || !('window' in globalThis)) return;
  lifecycleHooked = true;
  window.addEventListener('pagehide', flushSessionActivityTimestamps, { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSessionActivityTimestamps();
  });
  document.addEventListener('freeze', flushSessionActivityTimestamps);
};
subscribeRuntimeEndpointWillChange(flushSessionActivityTimestamps);

/** Called by the established runtime-reset path, after the endpoint changes. */
export const resetSessionActivityTimestamps = (options: { reload?: boolean } = { reload: true }): void => {
  flushSessionActivityTimestamps();
  runtime = getRuntimeKey();
  deleted.clear();
  shellSessions.clear();
  useSessionActivityTimestampsStore.setState(options.reload ? read(runtime) : emptyState());
};

const stampsFromMessage = (message: Message): SessionActivityTimestamps => {
  const created = message.time.created;
  if (message.role === 'user') return { input: created, activity: created };
  if (message.role === 'assistant') return {
    output: message.closedLocally || message.error ? undefined : message.time.completed,
    activity: maxTime(created, message.time.streamed, message.closedLocally ? undefined : message.time.completed),
  };
  if (message.role === 'shell' || message.role === 'compaction') return { activity: maxTime(created, message.time.completed) };
  return { activity: created };
};

/** Only exact event/item times belong here. Legacy rendering bounds stay separate. */
export const spanFromPart = (part: Part): EntryTimeSpan => {
  if (part.displayTime) return part.displayTime;
  if (part.type === 'text' || part.type === 'reasoning') return {};
  if (part.type === 'tool') {
    if (part.state.status === 'pending') return {};
    return part.state.time;
  }
  return {};
};

const shellSessions = new Map<string, string>();

type Recording = { sessionId: string; stamps: SessionActivityTimestamps; entryId?: string; span?: EntryTimeSpan };
const apply = (recordings: readonly Recording[], removals: readonly string[] = [], publishOrder = true): void => {
  const current = useSessionActivityTimestampsStore.getState();
  let byId: Map<string, SessionActivityTimestamps> | undefined;
  let spans: Map<string, EntryTimeSpan> | undefined;
  for (const id of removals) {
    deleted.add(id);
    byId ??= new Map(current.byId);
    byId.delete(id);
    for (const key of (spans ?? current.spans).keys()) {
      if (!key.startsWith(`[${JSON.stringify(id)},`)) continue;
      spans ??= new Map(current.spans);
      spans.delete(key);
    }
  }
  for (const { sessionId, stamps, entryId, span } of recordings) {
    if (deleted.has(sessionId)) continue;
    const previous = (byId ?? current.byId).get(sessionId);
    const merged = mergeStamps(previous, stamps);
    if (merged.input !== previous?.input || merged.output !== previous?.output || merged.activity !== previous?.activity) {
      byId ??= new Map(current.byId);
      byId.set(sessionId, merged);
    }
    if (!entryId || !span || (span.start === undefined && span.end === undefined)) continue;
    const key = spanKey(sessionId, entryId);
    const old = (spans ?? current.spans).get(key);
    const next = {
      start: span.start ?? old?.start,
      end: maxTime(span.end, old?.end),
    };
    if (next.start === old?.start && next.end === old?.end) continue;
    spans ??= new Map(current.spans);
    spans.set(key, next);
  }
  if (!byId && !spans) return;
  useSessionActivityTimestampsStore.setState({
    byId: byId ?? current.byId,
    sortById: publishOrder ? byId ?? current.byId : current.sortById,
    spans: spans ?? current.spans,
  });
  schedulePersist();
};

export const recordSessionTimestampEvents = (events: readonly SyncEvent[], now = Date.now()): void => {
  const recordings: Recording[] = [];
  const removals: string[] = [];
  for (const event of events) {
    const at = event.at ?? now;
    switch (event.type) {
      case 'message.updated': {
        const message = event.properties.info;
        recordings.push({ sessionId: message.sessionID, stamps: { ...stampsFromMessage(message), activity: maxTime(stampsFromMessage(message).activity, event.at) } });
        break;
      }
      case 'message.patched': {
        const { sessionID, patch } = event.properties;
        recordings.push({ sessionId: sessionID, stamps: {
          output: patch.shell || patch.error || patch.finish === 'error' ? undefined : patch.time?.completed,
          activity: maxTime(patch.time?.completed, patch.time?.streamed, event.at),
        } });
        break;
      }
      case 'message.part.updated': {
        const { part, sessionID } = event.properties;
        const span = spanFromPart(part);
        recordings.push({ sessionId: sessionID, entryId: part.id, span, stamps: { activity: maxTime(span.start, span.end, at) } });
        break;
      }
      case 'message.parts.replaced':
        for (const part of event.properties.parts) {
          const span = spanFromPart(part);
          recordings.push({ sessionId: event.properties.sessionID, entryId: part.id, span, stamps: { activity: maxTime(span.start, span.end, event.at) } });
        }
        break;
      case 'message.tool.transition': {
        const { sessionID, partID, transition } = event.properties;
        const span = transition.kind === 'called' ? { start: transition.start }
          : transition.kind === 'success' || transition.kind === 'failed' ? { end: transition.end } : {};
        recordings.push({ sessionId: sessionID, entryId: partID, span, stamps: { activity: maxTime(span.start, span.end, at) } });
        break;
      }
      case 'message.part.delta':
      case 'message.compaction.delta':
      case 'session.status':
      case 'session.idle':
      case 'session.error':
        recordings.push({ sessionId: event.properties.sessionID, stamps: { activity: at } });
        break;
      case 'shell.started':
        shellSessions.set(event.properties.shell.id, event.properties.shell.sessionID);
        recordings.push({ sessionId: event.properties.shell.sessionID, stamps: { activity: event.properties.shell.startedAt } });
        break;
      case 'shell.ended': {
        // The end event names only the shell; its start named the session.
        const sessionId = shellSessions.get(event.properties.shellID);
        shellSessions.delete(event.properties.shellID);
        if (sessionId) recordings.push({ sessionId, stamps: { activity: event.properties.endedAt } });
        break;
      }
      case 'session.deleted': removals.push(event.properties.sessionID); break;
      default: break;
    }
  }
  const onlyStreaming = events.every((event) => event.type === 'message.part.delta' || event.type === 'message.compaction.delta'
    || (event.type === 'message.tool.transition' && (event.properties.transition.kind === 'progress' || event.properties.transition.kind === 'input')));
  apply(recordings, removals, !onlyStreaming);
};

export const recordSessionTimestampsFromHistory = (sessionId: string, records: Iterable<{ info: Message; parts: readonly Part[] }>): void => {
  const recordings: Recording[] = [];
  for (const { info, parts } of records) {
    recordings.push({ sessionId, stamps: stampsFromMessage(info) });
    for (const part of parts) {
      const span = spanFromPart(part);
      recordings.push({ sessionId, entryId: part.id, span, stamps: { activity: maxTime(span.start, span.end) } });
    }
  }
  apply(recordings);
};

export const readRecordedEntrySpan = (state: TimestampState, sessionId: string, entryId: string): EntryTimeSpan | undefined => state.spans.get(spanKey(sessionId, entryId));

/** Confirmed deletion that did not arrive as an event. */
export const removeSessionActivityTimestamps = (sessionId: string): void => apply([], [sessionId]);

export const resolveSessionTimestamps = (session: Pick<Session, 'time'>, recorded?: SessionActivityTimestamps): ResolvedSessionTimestamps => ({
  created: maxTime(session.time.created) ?? null,
  input: recorded?.input ?? null,
  // idle includes interrupted/failed turns and is not proof an output completed.
  output: recorded?.output ?? null,
  activity: maxTime(recorded?.activity, recorded?.input, recorded?.output, session.time.created, session.time.idle) ?? null,
});

const compareByTimestamp = (left: number | null, right: number | null, direction: SessionTimestampSortDirection): number => {
  if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
  return direction === 'asc' ? left - right : right - left;
};

/** Timestamp sorts preserve the hierarchy and pins, then use ID for stable ties. */
export const sortSessionScopesByTimestamp = (
  sessions: readonly Session[], field: SessionTimestampField, direction: SessionTimestampSortDirection,
  recorded: ReadonlyMap<string, SessionActivityTimestamps>, isPinned: (session: Session) => boolean,
): Session[] => {
  const ids = new Set(sessions.map((session) => session.id));
  const values = new Map(sessions.map((session) => [session.id, resolveSessionTimestamps(session, recorded.get(session.id))[field]]));
  const roots: Session[] = [];
  const children = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!session.parentID || !ids.has(session.parentID)) roots.push(session);
    else {
      const siblings = children.get(session.parentID) ?? [];
      siblings.push(session);
      children.set(session.parentID, siblings);
    }
  }
  const compare = (left: Session, right: Session) => {
    const pinnedDelta = Number(isPinned(right)) - Number(isPinned(left));
    return pinnedDelta || compareByTimestamp(values.get(left.id) ?? null, values.get(right.id) ?? null, direction) || left.id.localeCompare(right.id);
  };
  roots.sort(compare);
  for (const siblings of children.values()) siblings.sort(compare);
  const result: Session[] = [];
  const visited = new Set<string>();
  const append = (session: Session): void => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    result.push(session);
    for (const child of children.get(session.id) ?? []) append(child);
  };
  for (const session of roots) append(session);
  for (const session of sessions) append(session);
  return result;
};

/**
 * How long the session's last run took: from the last prompt to the last
 * activity after it. Auto-continues and background waits stay inside it,
 * because neither records a new prompt. Null without both records.
 */
export const lastRunDurationMs = (recorded: SessionActivityTimestamps | undefined): number | null => {
  if (recorded?.input === undefined || recorded.activity === undefined || recorded.activity < recorded.input) return null;
  return recorded.activity - recorded.input;
};
