import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import type { createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import type { JsonValue } from '../event-stream/contracts.js';

const FILE_NAME = 'session-todos.json';
const FILE_VERSION = 1;
const TOOL_NAME = 'todowrite';
const FLAG_KEY = 'todo';
const PAGE_SIZE = 50;
const MAX_SESSIONS = 2000;
const MAX_OPEN_CALLS = 500;
const MAX_TODOS = 200;
const MAX_TODO_LENGTH = 2000;
const PERSIST_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 15_000;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

export const sessionIdSchema = z.string().regex(SESSION_ID_PATTERN);

const todoSchema = z.object({
  content: z.string().min(1).transform((content) => content.slice(0, MAX_TODO_LENGTH)),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).catch('pending'),
});

export type SessionTodo = z.infer<typeof todoSchema>;

interface SessionTodoRecord {
  directory: string;
  todos: SessionTodo[];
  checkedThrough: number | null;
  updatedAt: number;
  verified: boolean;
  generation: number;
}

interface OpenTodoCall {
  sessionId: string;
  directory: string;
  todos: SessionTodo[] | null;
}

interface OpenCodeHeaders extends Record<string, string> {
  Accept: string;
  'x-opencode-directory'?: string;
}

export interface SessionTodosEvent {
  type: 'openchamber:session-todos';
  properties: {
    revision: number;
    sessionId: string | null;
    directory: string | null;
    todos: SessionTodo[] | null;
  };
}

export type SessionTodosResult =
  | { revision: number; state: 'off' }
  | { revision: number; state: 'ready'; todos: SessionTodo[] };

export interface SessionTodosOptions {
  dataDir: string;
  buildOpenCodeUrl: (route: string, directory: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  globalEventHub: Pick<ReturnType<typeof createGlobalMessageStreamHub>, 'subscribeEvent' | 'subscribeStatus'>;
  getFlagOverrides: () => string | undefined;
  isSpaceDirectory: (directory: string) => boolean;
  broadcast?: (event: SessionTodosEvent) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  logger?: Pick<Console, 'warn'>;
}

const hasProperty = <Key extends PropertyKey>(value: unknown, key: Key): value is { [Property in Key]: unknown } =>
  value !== null && value !== undefined && key in Object(value);

const hasEventType = (value: unknown): value is { type: string } =>
  hasProperty(value, 'type') && typeof value.type === 'string';

const hasCallId = (value: unknown): value is { data: { id: string } } =>
  hasProperty(value, 'data') && hasProperty(value.data, 'id')
  && typeof value.data.id === 'string';

const parseTodos = (value: TodoInput) => {
  const list = z.array(z.unknown()).safeParse(value);
  if (!list.success) return null;
  return list.data
    .map((item) => todoSchema.safeParse(item))
    .filter((parsed) => parsed.success)
    .slice(0, MAX_TODOS)
    .map((parsed) => parsed.data);
};

const storedRecordSchema = z.object({
  directory: z.string(),
  todos: z.array(z.unknown()),
  checkedThrough: z.number().finite().nullable(),
  updatedAt: z.number().finite(),
});
const storedFileSchema = z.object({
  version: z.literal(FILE_VERSION),
  sessions: z.record(z.string(), z.unknown()),
});

const experimentalSchema = z.object({ todo: z.boolean().optional(), all_flags: z.unknown() }).passthrough();
const configEntrySchema = z.object({
  type: z.string(),
  info: z.object({ experimental: experimentalSchema.nullish().catch(undefined) }).passthrough().nullish(),
}).passthrough();
const configEntriesSchema = z.array(z.unknown());
const infoSchema = z.object({ version: z.string() });
const sessionSchema = z.object({ revert: z.object({ messageID: z.string() }).nullish() }).passthrough();
const createdSchema = z.object({ time: z.object({ created: z.number() }) });
const messageTimeSchema = z.object({ time: z.object({ created: z.number(), completed: z.number().optional().catch(undefined) }) });
const pageSchema = z.object({
  data: z.array(z.unknown()),
  cursor: z.object({ next: z.string().nullish() }).nullish(),
});

const wireEventSchema = z.object({
  type: z.string(),
  created: z.number().finite().optional().catch(undefined),
  data: z.object({
    sessionID: z.string().trim().optional().catch(undefined),
    id: z.string().optional().catch(undefined),
    name: z.string().optional().catch(undefined),
    input: z.object({ todos: z.unknown() }).partial().optional().catch(undefined),
    metadata: z.object({ todos: z.unknown() }).partial().optional().catch(undefined),
  }).passthrough().catch({}),
  location: z.object({ directory: z.string().trim() }).partial().nullish().catch(undefined),
}).passthrough();
const todoCallSchema = z.object({
  type: z.literal('tool'),
  name: z.literal(TOOL_NAME),
  state: z.object({ status: z.literal('completed'), input: z.object({ todos: z.unknown() }).partial() }),
});
const messageContentSchema = z.object({ content: z.array(z.unknown()).catch([]) });

type TodoInput = z.infer<typeof todoCallSchema>['state']['input']['todos'];
type HistoryMessage = z.infer<typeof pageSchema>['data'][number];

const SESSION_EVENT_TYPES = new Set([
  'session.tool.input.started',
  'session.revert.staged',
  'session.revert.cleared',
  'session.revert.committed',
  'session.deleted',
  'config.updated',
]);
const CALL_EVENT_TYPES = new Set(['session.tool.called', 'session.tool.success', 'session.tool.failed']);

export const flagFromOverrides = (overrides: string | undefined) => {
  const entries = new Map<string, boolean>((overrides ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith('-') ? [item.slice(1), false] : [item, true])));
  if (entries.has(FLAG_KEY)) return entries.get(FLAG_KEY);
  return entries.get('all') === true ? true : undefined;
};

export const flagFromConfig = (entries: z.infer<typeof configEntriesSchema>) => {
  const documents = entries
    .map((entry) => configEntrySchema.safeParse(entry))
    .filter((parsed): parsed is Extract<typeof parsed, { success: true }> => parsed.success && parsed.data.type === 'document')
    .map((parsed) => parsed.data.info?.experimental);
  const experimental = documents.findLast((value) => value !== undefined && value !== null);
  if (experimental?.todo !== undefined) return experimental.todo;
  const allFlags = documents.findLast((value) => value?.all_flags !== undefined);
  return allFlags?.all_flags === true ? true : undefined;
};

export const flagOnByDefault = (version: string) => version === 'local' || version.startsWith('0.0.0-dev-');

const todosInMessage = (message: HistoryMessage) => {
  const parsed = messageContentSchema.safeParse(message);
  const content = parsed.success ? parsed.data.content : [];
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const call = todoCallSchema.safeParse(content[index]);
    const todos = call.success ? parseTodos(call.data.state.input.todos) : null;
    if (todos) return todos;
  }
  return null;
};

export const createSessionTodosRuntime = ({
  dataDir,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  globalEventHub,
  getFlagOverrides,
  isSpaceDirectory,
  broadcast = () => {},
  fetchImpl = fetch,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
}: SessionTodosOptions) => {
  const filePath = path.join(dataDir, FILE_NAME);

  let revision = now();
  const records = new Map<string, SessionTodoRecord>();
  const openCalls = new Map<string, OpenTodoCall>();
  const flags = new Map<string, Promise<boolean>>();
  const observed = new Set<string>();
  let versionRead: Promise<string> | null = null;
  const reads = new Map<string, Promise<void>>();
  let lane = Promise.resolve();
  let generation = 0;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let writeChain = Promise.resolve();
  let stopped = false;
  const unsubscribers: Array<() => void> = [];

  const headers = (directory: string) => {
    const result: OpenCodeHeaders = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
    if (directory) result['x-opencode-directory'] = encodeURIComponent(directory);
    return result;
  };

  const readJson = async (route: string, { directory = '', query }: { directory?: string; query?: Record<string, string> } = {}) => {
    const url = buildOpenCodeUrl(route, '');
    const response = await fetchImpl(query ? `${url}?${new URLSearchParams(query)}` : url, {
      method: 'GET',
      headers: headers(directory),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${route} answered ${response.status}`);
    const body: unknown = unwrapOpenCodeResponse(await response.json());
    return body;
  };


  const writeFile = () => {
    const sessions: Record<string, Pick<SessionTodoRecord, 'directory' | 'todos' | 'checkedThrough' | 'updatedAt'>> = {};
    for (const [sessionId, record] of records) {
      sessions[sessionId] = {
        directory: record.directory,
        todos: record.todos,
        checkedThrough: record.checkedThrough,
        updatedAt: record.updatedAt,
      };
    }
    const payload = JSON.stringify({ version: FILE_VERSION, sessions });
    writeChain = writeChain
      .then(async () => {
        await fs.promises.mkdir(dataDir, { recursive: true });
        const tmpPath = `${filePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmpPath, payload, 'utf8');
        await fs.promises.rename(tmpPath, filePath);
      })
      .catch((cause: unknown) => logger.warn?.('[session-todos] failed to save:', (hasProperty(cause, 'message') ? cause.message : undefined) ?? cause));
    return writeChain;
  };

  const schedulePersist = () => {
    if (persistTimer || stopped) return;
    persistTimer = setTimer(() => {
      persistTimer = null;
      void writeFile();
    }, PERSIST_DELAY_MS);
  };

  const load = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (!hasProperty(error, 'code') || error.code !== 'ENOENT') logger.warn?.('[session-todos] failed to read:', (hasProperty(error, 'message') ? error.message : undefined) ?? error);
      return;
    }
    let parsed: ReturnType<typeof storedFileSchema.safeParse> | { success: false };
    try {
      parsed = storedFileSchema.safeParse(JSON.parse(raw));
    } catch {
      parsed = { success: false };
    }
    if (!parsed.success) return;
    for (const [sessionId, value] of Object.entries(parsed.data.sessions)) {
      const record = storedRecordSchema.safeParse(value);
      if (!sessionIdSchema.safeParse(sessionId).success || !record.success || records.has(sessionId)) continue;
      records.set(sessionId, { ...record.data, todos: parseTodos(record.data.todos) ?? [], verified: false, generation: ++generation });
    }
  };


  const announce = (sessionId: string, directory: string, todos: SessionTodo[] | null) => {
    revision += 1;
    broadcast({ type: 'openchamber:session-todos', properties: { revision, sessionId, directory, todos } });
  };

  const trim = () => {
    if (records.size <= MAX_SESSIONS) return;
    const oldest = [...records].sort(([, a], [, b]) => a.updatedAt - b.updatedAt);
    for (const [sessionId] of oldest.slice(0, records.size - MAX_SESSIONS)) records.delete(sessionId);
  };

  const writeRecord = (sessionId: string, directory: string, todos: SessionTodo[], checkedThrough: number | null) => {
    const previous = records.get(sessionId);
    records.set(sessionId, {
      directory: directory || previous?.directory || '',
      todos,
      checkedThrough: Math.max(checkedThrough ?? 0, previous?.checkedThrough ?? 0) || null,
      updatedAt: now(),
      verified: true,
      generation: ++generation,
    });
    trim();
    schedulePersist();
    const record = records.get(sessionId);
    if (!record) throw new TypeError('Session todo record missing after trim');
    announce(sessionId, record.directory, todos);
  };

  const invalidate = (sessionId: string) => {
    const record = records.get(sessionId);
    if (!record) return;
    records.set(sessionId, { ...record, checkedThrough: null, verified: false, generation: ++generation });
    schedulePersist();
    announce(sessionId, record.directory, null);
  };


  const processPayload = (payload: JsonValue | undefined) => {
    const kind = hasEventType(payload) ? payload.type : '';
    if (!SESSION_EVENT_TYPES.has(kind) && !(CALL_EVENT_TYPES.has(kind) && hasCallId(payload) && openCalls.has(payload.data.id))) return;
    const event = wireEventSchema.safeParse(payload);
    if (stopped || !event.success) return;
    const { type, data } = event.data;
    const sessionId = data.sessionID ?? '';
    const directory = event.data.location?.directory ?? '';

    switch (type) {
      case 'session.tool.input.started': {
        if (data.name !== TOOL_NAME || !sessionId || !data.id) return;
        if (openCalls.size >= MAX_OPEN_CALLS) {
          const oldest = openCalls.keys().next();
          if (!oldest.done) openCalls.delete(oldest.value);
        }
        openCalls.set(data.id, { sessionId, directory, todos: null });
        if (directory) observed.add(directory);
        return;
      }
      case 'session.tool.called': {
        const call = data.id === undefined ? undefined : openCalls.get(data.id);
        if (call) call.todos = parseTodos(data.input?.todos);
        return;
      }
      case 'session.tool.success': {
        const call = data.id === undefined ? undefined : openCalls.get(data.id);
        if (!call) return;
        if (data.id !== undefined) openCalls.delete(data.id);
        const todos = parseTodos(data.metadata?.todos) ?? call.todos;
        if (!todos) return;
        const at = event.data.created ?? now();
        writeRecord(call.sessionId, call.directory || directory, todos, at);
        return;
      }
      case 'session.tool.failed':
        if (data.id !== undefined) openCalls.delete(data.id);
        return;
      case 'session.revert.staged':
      case 'session.revert.cleared':
      case 'session.revert.committed':
        if (sessionId) invalidate(sessionId);
        return;
      case 'session.deleted':
        if (records.delete(sessionId)) schedulePersist();
        return;
      case 'config.updated':
        if (!directory) {
          flags.clear();
          observed.clear();
        } else {
          flags.delete(directory);
          observed.delete(directory);
        }
        revision += 1;
        broadcast({ type: 'openchamber:session-todos', properties: { revision, sessionId: null, directory: directory || null, todos: null } });
        return;
      default:
    }
  };

  const onConnected = () => {
    openCalls.clear();
    flags.clear();
    observed.clear();
    versionRead = null;
    for (const [sessionId, record] of records) {
      if (record.verified) records.set(sessionId, { ...record, verified: false, generation: ++generation });
    }
    revision += 1;
    broadcast({ type: 'openchamber:session-todos', properties: { revision, sessionId: null, directory: null, todos: null } });
  };


  const readVersion = () => {
    versionRead ??= readJson('/api/info').then((info) => infoSchema.parse(info).version);
    versionRead.catch(() => { versionRead = null; });
    return versionRead;
  };

  const readFlag = async (directory: string) => {
    const override = flagFromOverrides(getFlagOverrides());
    if (override !== undefined) return override;
    const configured = flagFromConfig(configEntriesSchema.parse(await readJson('/api/config', { directory })));
    if (configured !== undefined) return configured;
    return flagOnByDefault(await readVersion());
  };

  const isEnabled = async (directory: string) => {
    if (observed.has(directory)) return true;
    let pending = flags.get(directory);
    if (!pending) {
      pending = readFlag(directory);
      flags.set(directory, pending);
      pending.catch(() => {
        if (flags.get(directory) === pending) flags.delete(directory);
      });
    }
    return pending;
  };


  const readPage = async (sessionId: string, cursor: string | undefined) => {
    const query: Record<string, string> = cursor
      ? { limit: String(PAGE_SIZE), cursor, type: 'assistant' }
      : { limit: String(PAGE_SIZE), order: 'desc', type: 'assistant' };
    return pageSchema.parse(await readJson(`/api/session/${encodeURIComponent(sessionId)}/message`, { query }));
  };

  const readBoundary = async (sessionId: string) => {
    const session = sessionSchema.parse(await readJson(`/api/session/${encodeURIComponent(sessionId)}`));
    const messageId = session.revert?.messageID;
    if (!messageId) return null;
    const message = await readJson(`/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`);
    return createdSchema.parse(message).time.created;
  };

  const findInHistory = async (sessionId: string, checkedThrough: number | null) => {
    const boundary = await readBoundary(sessionId);
    const stopAt = boundary !== null && checkedThrough !== null && checkedThrough >= boundary ? null : checkedThrough;
    let newest: number | null = null;
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const page = await readPage(sessionId, cursor);
      for (const value of page.data) {
        const time = messageTimeSchema.safeParse(value);
        if (!time.success) continue;
        const { created, completed } = time.data.time;
        if (boundary !== null && created >= boundary) continue;
        if (stopAt !== null && completed !== undefined && completed <= stopAt) return { todos: null, newest };
        if (completed !== undefined) newest = Math.max(newest ?? 0, completed);
        const todos = todosInMessage(value);
        if (todos) return { todos, newest };
      }
      const next = page.cursor?.next;
      if (page.data.length === 0 || !next || seen.has(next)) return { todos: [], newest };
      seen.add(next);
      cursor = next;
    }
  };

  const refreshFromHistory = (sessionId: string, directory: string) => {
    const running = reads.get(sessionId);
    if (running) return running;
    const before = records.get(sessionId);
    const startedAt = before?.generation ?? null;
    const run = lane.then(async () => {
      if (stopped) return;
      const found = await findInHistory(sessionId, before?.checkedThrough ?? null);
      if ((records.get(sessionId)?.generation ?? null) !== startedAt) return;
      const todos = found.todos ?? before?.todos ?? [];
      const unchanged = before && found.todos === null;
      if (unchanged) {
        records.set(sessionId, { ...before, checkedThrough: Math.max(found.newest ?? 0, before.checkedThrough ?? 0) || null, verified: true, generation: ++generation });
        schedulePersist();
        return;
      }
      writeRecord(sessionId, directory, todos, found.newest ?? now());
    });
    lane = run.catch(() => {});
    const tracked = run.finally(() => {
      if (reads.get(sessionId) === tracked) reads.delete(sessionId);
    });
    reads.set(sessionId, tracked);
    return tracked;
  };

  const read = async (sessionId: string, directory: string): Promise<SessionTodosResult> => {
    if (isSpaceDirectory(directory) || !(await isEnabled(directory))) return { revision, state: 'off' };
    if (!records.get(sessionId)?.verified) await refreshFromHistory(sessionId, directory);
    return { revision, state: 'ready', todos: records.get(sessionId)?.todos ?? [] };
  };

  const start = async () => {
    await load();
    unsubscribers.push(globalEventHub.subscribeEvent((event) => processPayload(event?.payload)));
    unsubscribers.push(globalEventHub.subscribeStatus((status) => {
      if (status?.type === 'connect') onConnected();
    }));
  };

  const stop = async () => {
    stopped = true;
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe?.();
    if (persistTimer) {
      clearTimer(persistTimer);
      persistTimer = null;
      await writeFile();
    }
    await writeChain;
  };

  return { start, stop, read, processPayload, onConnected };
};
