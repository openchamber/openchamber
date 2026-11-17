import { create } from 'zustand';
import type { SyncEvent } from '@/lib/opencode/events';
import type { JsonValue } from '@/lib/opencode/model';
import { contextTokensFromBreakdown } from '@/stores/utils/tokenUtils';


type LiveTool = {
  partID: string;
  name: string;
  path: string | null;
};

type SessionCalls = {
  running: readonly LiveTool[];
  last: LiveTool | null;
};

type ContextReading =
  | { state: 'measured'; tokens: number }
  | { state: 'compacted' };

type SessionLiveWorkState = {
  tools: ReadonlyMap<string, SessionCalls>;
  context: ReadonlyMap<string, ContextReading>;
};

export const SESSION_LIVE_WORK_MAX = 2000;
const CALLS_MAX = 16;

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

export const sessionContextRevision = (): number => revision;

export const currentLiveTool = (calls: SessionCalls | undefined): LiveTool | undefined => calls?.running.at(-1) ?? calls?.last ?? undefined;

export const useSessionLiveWorkStore = create<SessionLiveWorkState>()(() => ({
  tools: new Map(),
  context: new Map(),
}));

const RAW_INPUT_MAX = 4096;
const rawInputs = new Map<string, string>();
const STREAMED_PATH = /"(?:path|filePath|file_path)"\s*:\s*("(?:[^"\\]|\\.)*")/u;

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
        if (info.role === 'user') endCalls(info.sessionID);
        else if (info.role === 'assistant' && info.tokens) measure(info.sessionID, info.tokens);
        else if (info.role === 'compaction' && info.status === 'completed' && !info.error) read(info.sessionID, { state: 'compacted' });
        break;
      }
      case 'session.status':
        if (payload.properties.status.type === 'idle') endCalls(payload.properties.sessionID);
        break;
      case 'session.idle':
      case 'session.error':
        endCalls(payload.properties.sessionID);
        break;
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

export const resetSessionLiveWork = (): void => {
  touchedAt.clear();
  rawInputs.clear();
  useSessionLiveWorkStore.setState({ tools: new Map(), context: new Map() });
};
