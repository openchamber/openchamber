import { create } from 'zustand';
import type { SyncEvent } from '@/lib/opencode/events';
import type { JsonValue } from '@/lib/opencode/model';
import { contextTokensFromBreakdown } from '@/stores/utils/tokenUtils';

// Cross-directory index of what each session is doing right now and how full
// its context window is, for surfaces that show many sessions at once without
// loading their messages (extension session records, `lib/guests/workspace.ts`).
//
// Messages and parts live in a directory's store, which exists only for
// directories something rendered; events for other directories reach only
// these cross-directory indexes. So this index reads the tool and step events
// themselves, from the dispatcher, before the store gate.
//
// `tools` holds each session's unfinished tool calls in the order they
// started, and the call that ended last. The session works with the newest
// unfinished call, else with the one that just ended while the agent thinks
// about its result: most calls run for milliseconds, often inside one batch of
// events, so a reading of only running calls would rarely see one. Parallel
// calls end in any order, so the one that ends leaves the others in place.
// None of this is proof of activity: a lost end event would leave a call
// there, so it all clears when the session goes idle or errors, and readers
// show it only while the session's status says it runs.
//
// `context` holds what the window held after the session's latest step, the
// same reading the chat header takes from the newest assistant message
// (`findLatestContextFill`): the step's reported total, else the sum of its
// breakdown. A finished compaction makes the size unknown until the next step
// reports one. The host keeps the latest readings too, and a client that
// starts later, or reconnects after a gap, takes the host's reading for every
// session it has seen nothing newer of since its request began
// (`seedSessionContextFromHost`).

type LiveTool = {
  /** The tool part's id, to match the call's later transitions. */
  partID: string;
  name: string;
  /** The path the call names, as the agent wrote it; null until its input arrives or when it names none. */
  path: string | null;
};

type SessionCalls = {
  /** Unfinished calls, oldest first. */
  running: readonly LiveTool[];
  /** The call that ended last in this turn. */
  last: LiveTool | null;
};

type ContextReading =
  | { state: 'measured'; tokens: number }
  /** Compacted since the last step; the window's size is unknown. */
  | { state: 'compacted' };

type SessionLiveWorkState = {
  tools: ReadonlyMap<string, SessionCalls>;
  context: ReadonlyMap<string, ContextReading>;
};

/** Sessions kept in each map; the oldest entry goes first. */
export const SESSION_LIVE_WORK_MAX = 2000;
/** Unfinished calls kept per session; a session never runs this many at once. */
const CALLS_MAX = 16;

// A host reading answers a request: a live reading that arrived after the
// request began is newer and stays. Every live reading stamps its session
// with the revision it was applied at.
let revision = 0;
const touchedAt = new Map<string, number>();

const touch = (sessionID: string): void => {
  revision += 1;
  touchedAt.delete(sessionID);
  touchedAt.set(sessionID, revision);
  if (touchedAt.size > SESSION_LIVE_WORK_MAX) {
    const oldest = touchedAt.keys().next().value;
    if (oldest !== undefined) touchedAt.delete(oldest);
  }
};

/** The revision a host read starts at, for `seedSessionContextFromHost`. */
export const sessionContextRevision = (): number => revision;

/** The call a session works with: the newest it has not finished, else the one that ended last. */
export const currentLiveTool = (calls: SessionCalls | undefined): LiveTool | undefined => calls?.running.at(-1) ?? calls?.last ?? undefined;

export const useSessionLiveWorkStore = create<SessionLiveWorkState>()(() => ({
  tools: new Map(),
  context: new Map(),
}));

// The agent writes a call's input for longer than most calls run, so the
// path is read from the input as it streams in: it comes first in a file
// tool's input. Only the start of each input is kept, until a path shows.
const RAW_INPUT_MAX = 4096;
const rawInputs = new Map<string, string>();
const STREAMED_PATH = /"(?:path|filePath|file_path)"\s*:\s*("(?:[^"\\]|\\.)*")/u;

/** The path named in the start of a call's streamed input, once it is complete there. */
const readStreamedPath = (raw: string): string | null => {
  const quoted = STREAMED_PATH.exec(raw)?.[1];
  if (!quoted) return null;
  try {
    const path: unknown = JSON.parse(quoted);
    return typeof path === 'string' && path.trim() ? path.trim() : null;
  } catch {
    return null;
  }
};

/** Tool inputs that name a file or folder: v2 file tools, and what MCP and plugin tools use. */
const readInputPath = (input: Readonly<Partial<Record<string, JsonValue>>>): string | null => {
  for (const key of ['path', 'filePath', 'file_path']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

const setCapped = <V>(map: Map<string, V>, key: string, value: V): void => {
  map.delete(key);
  map.set(key, value);
  if (map.size > SESSION_LIVE_WORK_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
};

/** Applies the tool, step, compaction and lifecycle events of one batch. Other events are ignored cheaply. */
export const applySessionLiveWorkEvents = (payloads: readonly SyncEvent[]): void => {
  const state = useSessionLiveWorkStore.getState();
  let tools: Map<string, SessionCalls> | null = null;
  let context: Map<string, ContextReading> | null = null;
  const callsOf = (sessionID: string): SessionCalls => (tools ?? state.tools).get(sessionID) ?? { running: [], last: null };
  const setCalls = (sessionID: string, calls: SessionCalls) => {
    tools ??= new Map(state.tools);
    if (calls.running.length === 0 && !calls.last) tools.delete(sessionID);
    else setCapped(tools, sessionID, { running: calls.running.slice(-CALLS_MAX), last: calls.last });
  };
  const read = (sessionID: string, reading: ContextReading) => {
    touch(sessionID);
    const previous = (context ?? state.context).get(sessionID);
    if (previous && sameReading(previous, reading)) return;
    context ??= new Map(state.context);
    setCapped(context, sessionID, reading);
  };
  const measure = (sessionID: string, breakdown: Parameters<typeof contextTokensFromBreakdown>[0]) => {
    const tokens = contextTokensFromBreakdown(breakdown);
    if (tokens > 0) read(sessionID, { state: 'measured', tokens });
  };
  const endCalls = (sessionID: string) => {
    const calls = callsOf(sessionID);
    if (calls.running.length === 0 && !calls.last) return;
    for (const call of calls.running) rawInputs.delete(call.partID);
    setCalls(sessionID, { running: [], last: null });
  };
  /** Names the path of a running call, once its input says it. */
  const name = (sessionID: string, partID: string, path: string | null) => {
    const calls = callsOf(sessionID);
    const call = calls.running.find((entry) => entry.partID === partID);
    if (!call || !path || call.path === path) return;
    setCalls(sessionID, { ...calls, running: calls.running.map((entry) => (entry === call ? { ...entry, path } : entry)) });
  };
  for (const payload of payloads) {
    switch (payload.type) {
      case 'message.part.updated': {
        const { part, sessionID } = payload.properties;
        if (part.type !== 'tool' || part.state.status !== 'pending') break;
        const calls = callsOf(sessionID);
        if (calls.running.some((call) => call.partID === part.id)) break;
        setCalls(sessionID, { ...calls, running: [...calls.running, { partID: part.id, name: part.tool, path: null }] });
        break;
      }
      case 'message.part.delta': {
        const { sessionID, partID, field, delta } = payload.properties;
        if (field !== 'raw') break;
        const call = callsOf(sessionID).running.find((entry) => entry.partID === partID);
        if (!call || call.path !== null) break;
        const kept = rawInputs.get(partID) ?? '';
        // Past the start with no path yet: this input names none up front.
        if (kept.length >= RAW_INPUT_MAX) break;
        const raw = (kept + delta).slice(0, RAW_INPUT_MAX);
        const path = readStreamedPath(raw);
        if (path) {
          rawInputs.delete(partID);
          name(sessionID, partID, path);
        } else {
          setCapped(rawInputs, partID, raw);
        }
        break;
      }
      case 'message.tool.transition': {
        const { sessionID, partID, transition } = payload.properties;
        const calls = callsOf(sessionID);
        const call = calls.running.find((entry) => entry.partID === partID);
        if (!call) break;
        if (transition.kind === 'input') {
          rawInputs.delete(partID);
          name(sessionID, partID, readStreamedPath(transition.raw));
        } else if (transition.kind === 'called') {
          rawInputs.delete(partID);
          name(sessionID, partID, readInputPath(transition.input));
        } else if (transition.kind === 'success' || transition.kind === 'failed') {
          rawInputs.delete(partID);
          const current = callsOf(sessionID);
          const ended = current.running.find((entry) => entry.partID === partID) ?? call;
          setCalls(sessionID, { running: current.running.filter((entry) => entry.partID !== partID), last: ended });
        }
        break;
      }
      case 'message.patched':
        if (payload.properties.patch.tokens) measure(payload.properties.sessionID, payload.properties.patch.tokens);
        break;
      case 'message.updated': {
        const { info } = payload.properties;
        // The user's message starts a new turn: whatever the last one worked
        // with is over, even when its idle fell into a stream gap.
        if (info.role === 'user') endCalls(info.sessionID);
        else if (info.role === 'assistant' && info.tokens) measure(info.sessionID, info.tokens);
        else if (info.role === 'compaction' && info.status === 'completed' && !info.error) read(info.sessionID, { state: 'compacted' });
        break;
      }
      // Going idle ends whatever calls were running.
      case 'session.status':
        if (payload.properties.status.type === 'idle') endCalls(payload.properties.sessionID);
        break;
      case 'session.idle':
      case 'session.error':
        endCalls(payload.properties.sessionID);
        break;
      // After a stream gap any call may have ended unseen.
      case 'server.connected':
        if ((tools ?? state.tools).size > 0) {
          rawInputs.clear();
          tools = new Map();
        }
        break;
      case 'session.deleted': {
        const { sessionID } = payload.properties;
        endCalls(sessionID);
        touch(sessionID);
        if ((context ?? state.context).has(sessionID)) {
          context ??= new Map(state.context);
          context.delete(sessionID);
        }
        break;
      }
      default:
        break;
    }
  }
  if (tools || context) useSessionLiveWorkStore.setState({ tools: tools ?? state.tools, context: context ?? state.context });
};

const sameReading = (a: ContextReading, b: ContextReading): boolean => (
  a.state === b.state && (a.state !== 'measured' || b.state !== 'measured' || a.tokens === b.tokens)
);

/**
 * The host's latest context readings. `since` is the revision the request
 * started at (`sessionContextRevision()`): a session read live after that
 * keeps its live reading, every other one takes the host's, which also
 * repairs a reading that went stale while the stream was down. A session the
 * host has no reading for keeps whatever this client has.
 */
export const seedSessionContextFromHost = (readings: ReadonlyMap<string, ContextReading>, since: number): void => {
  const state = useSessionLiveWorkStore.getState();
  let context: Map<string, ContextReading> | null = null;
  for (const [sessionID, reading] of readings) {
    if ((touchedAt.get(sessionID) ?? 0) > since) continue;
    const previous = state.context.get(sessionID);
    if (previous && sameReading(previous, reading)) continue;
    context ??= new Map(state.context);
    setCapped(context, sessionID, reading);
  }
  if (context) useSessionLiveWorkStore.setState({ context });
};

/** A runtime switch: the readings belong to the previous instance's sessions. */
export const resetSessionLiveWork = (): void => {
  touchedAt.clear();
  rawInputs.clear();
  useSessionLiveWorkStore.setState({ tools: new Map(), context: new Map() });
};
