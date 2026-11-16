/**
 * The agent's todo list of each session, from OpenCode's experimental
 * `todowrite` tool. OpenCode keeps no state for it: the list is the input of
 * the session's newest completed `todowrite` call before its revert boundary.
 * This server keeps that list per session from the event stream and finds it
 * in the history once, when a session is first asked for. See DOCUMENTATION.md.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';

const FILE_NAME = 'session-todos.json';
const FILE_VERSION = 1;
const TOOL_NAME = 'todowrite';
const FLAG_KEY = 'todo';
const PAGE_SIZE = 50;
/** Sessions kept on disk; the least recently changed go first. */
const MAX_SESSIONS = 2000;
/** Calls between their start and their end; a call whose end never came is dropped first. */
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

/** OpenCode's own reading of a list: an item needs text; an unknown status is pending. Null for no list. */
const parseTodos = (value) => {
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

// The wire event and the message parts this module reads; anything else passes.
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

// Every event of the stream reaches this module, text deltas included; only
// these are parsed. A call's own events are parsed only for a followed call.
const SESSION_EVENT_TYPES = new Set([
  'session.tool.input.started',
  'session.revert.staged',
  'session.revert.cleared',
  'session.revert.committed',
  'session.deleted',
  'config.updated',
]);
const CALL_EVENT_TYPES = new Set(['session.tool.called', 'session.tool.success', 'session.tool.failed']);

/**
 * `OPENCODE_FLAGS` as OpenCode reads it: `todo` or `-todo` decides, `all`
 * turns it on unless the list opts it out. Undefined when the list says nothing.
 */
export const flagFromOverrides = (overrides) => {
  const entries = new Map((overrides ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith('-') ? [item.slice(1), false] : [item, true])));
  if (entries.has(FLAG_KEY)) return entries.get(FLAG_KEY);
  return entries.get('all') === true ? true : undefined;
};

/**
 * The flag as OpenCode resolves it from the location's config documents
 * (lowest priority first): `experimental.todo` from the highest document that
 * sets `experimental`, else `experimental.all_flags: true` from the highest
 * document that sets `all_flags`. Undefined when the config says nothing.
 */
export const flagFromConfig = (entries) => {
  const documents = entries
    .map((entry) => configEntrySchema.safeParse(entry))
    .filter((parsed) => parsed.success && parsed.data.type === 'document')
    .map((parsed) => parsed.data.info?.experimental);
  const experimental = documents.findLast((value) => value !== undefined && value !== null);
  if (experimental?.todo !== undefined) return experimental.todo;
  const allFlags = documents.findLast((value) => value?.all_flags !== undefined);
  return allFlags?.all_flags === true ? true : undefined;
};

/** Flags default to on in OpenCode's local and `dev` channel builds, off in releases. */
export const flagOnByDefault = (version) => version === 'local' || version.startsWith('0.0.0-dev-');

/** The newest completed `todowrite` call in one assistant message, or null. */
const todosInMessage = (message) => {
  const parsed = messageContentSchema.safeParse(message);
  const content = parsed.success ? parsed.data.content : [];
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const call = todoCallSchema.safeParse(content[index]);
    const todos = call.success ? parseTodos(call.data.state.input.todos) : null;
    if (todos) return todos;
  }
  return null;
};

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {(path: string, directory: string) => string} options.buildOpenCodeUrl
 * @param {() => Record<string, string>} options.getOpenCodeAuthHeaders
 * @param {{ subscribeEvent: Function, subscribeStatus: Function, isConnected?: () => boolean }} options.globalEventHub
 * @param {() => string | undefined} options.getFlagOverrides `OPENCODE_FLAGS` of the OpenCode this server talks to.
 * @param {(directory: string) => boolean} options.isSpaceDirectory
 * @param {(event: object) => void} [options.broadcast] Sends an event to every connected client.
 */
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
}) => {
  const filePath = path.join(dataDir, FILE_NAME);

  // Starts from the clock so an answer after a restart still reads as newer.
  let revision = now();
  /**
   * sessionId → { directory, todos, checkedThrough, updatedAt, verified, generation }.
   * `checkedThrough` is a time by which every finished agent message is
   * accounted for: a later look at the history stops at the first message
   * that finished by then. A message still streaming at that time is looked
   * at again, since a call in it may have ended unseen. `verified` (memory
   * only) means the event stream has been followed without a gap since the
   * list was right; `generation` changes with every write, so a history read
   * that an event overtook does not commit.
   */
  const records = new Map();
  /** callId → { sessionId, directory, todos } for `todowrite` calls that started and have not ended. */
  const openCalls = new Map();
  /** directory → Promise<boolean>: whether the tool is on there. */
  const flags = new Map();
  /** Directories where a `todowrite` call was seen since their config last changed. */
  const observed = new Set();
  let versionRead = null;
  /** sessionId → Promise of the running history read. */
  const reads = new Map();
  // One history read at a time, so opening several old sessions does not load OpenCode.
  let lane = Promise.resolve();
  let generation = 0;
  let persistTimer = null;
  let writeChain = Promise.resolve();
  let stopped = false;
  const unsubscribers = [];

  const headers = (directory) => {
    const result = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
    // v2 scopes by header and rejects non-ASCII header values.
    if (directory) result['x-opencode-directory'] = encodeURIComponent(directory);
    return result;
  };

  const readJson = async (route, { directory = '', query } = {}) => {
    const url = buildOpenCodeUrl(route, '');
    const response = await fetchImpl(query ? `${url}?${new URLSearchParams(query)}` : url, {
      method: 'GET',
      headers: headers(directory),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${route} answered ${response.status}`);
    return unwrapOpenCodeResponse(await response.json());
  };

  // ----- Persistence -----

  const writeFile = () => {
    const sessions = {};
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
      .catch((error) => logger.warn?.('[session-todos] failed to save:', error?.message ?? error));
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
      if (error?.code !== 'ENOENT') logger.warn?.('[session-todos] failed to read:', error?.message ?? error);
      return;
    }
    let parsed;
    try {
      parsed = storedFileSchema.safeParse(JSON.parse(raw));
    } catch {
      parsed = { success: false };
    }
    // Derived data: a file this version cannot read is rebuilt from the history.
    if (!parsed.success) return;
    for (const [sessionId, value] of Object.entries(parsed.data.sessions)) {
      const record = storedRecordSchema.safeParse(value);
      if (!sessionIdSchema.safeParse(sessionId).success || !record.success || records.has(sessionId)) continue;
      // Events may have been missed while this server was down.
      records.set(sessionId, { ...record.data, todos: parseTodos(record.data.todos) ?? [], verified: false, generation: ++generation });
    }
  };

  // ----- State changes -----

  const announce = (sessionId, directory, todos) => {
    revision += 1;
    broadcast({ type: 'openchamber:session-todos', properties: { revision, sessionId, directory, todos } });
  };

  const trim = () => {
    if (records.size <= MAX_SESSIONS) return;
    const oldest = [...records].sort(([, a], [, b]) => a.updatedAt - b.updatedAt);
    for (const [sessionId] of oldest.slice(0, records.size - MAX_SESSIONS)) records.delete(sessionId);
  };

  const writeRecord = (sessionId, directory, todos, checkedThrough) => {
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
    announce(sessionId, records.get(sessionId).directory, todos);
  };

  /** The history behind the list changed: it is looked up again from the start on the next read. */
  const invalidate = (sessionId) => {
    const record = records.get(sessionId);
    if (!record) return;
    records.set(sessionId, { ...record, checkedThrough: null, verified: false, generation: ++generation });
    schedulePersist();
    announce(sessionId, record.directory, null);
  };

  // ----- Events -----

  const processPayload = (payload) => {
    const kind = payload?.type;
    if (!SESSION_EVENT_TYPES.has(kind) && !(CALL_EVENT_TYPES.has(kind) && openCalls.has(payload.data?.id))) return;
    const event = wireEventSchema.safeParse(payload);
    if (stopped || !event.success) return;
    const { type, data } = event.data;
    const sessionId = data.sessionID ?? '';
    const directory = event.data.location?.directory ?? '';

    switch (type) {
      case 'session.tool.input.started': {
        if (data.name !== TOOL_NAME || !sessionId || !data.id) return;
        if (openCalls.size >= MAX_OPEN_CALLS) openCalls.delete(openCalls.keys().next().value);
        openCalls.set(data.id, { sessionId, directory, todos: null });
        if (directory) observed.add(directory);
        return;
      }
      case 'session.tool.called': {
        const call = openCalls.get(data.id);
        if (call) call.todos = parseTodos(data.input?.todos);
        return;
      }
      case 'session.tool.success': {
        const call = openCalls.get(data.id);
        if (!call) return;
        openCalls.delete(data.id);
        // The tool hands its list back as metadata, the same as its input.
        const todos = parseTodos(data.metadata?.todos) ?? call.todos;
        if (!todos) return;
        const at = event.data.created ?? now();
        writeRecord(call.sessionId, call.directory || directory, todos, at);
        return;
      }
      case 'session.tool.failed':
        openCalls.delete(data.id);
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

  /**
   * A gap in OpenCode's stream may hide calls and config changes: everything
   * is checked again when asked, and clients are told to ask, since their own
   * connection to this server may not have dropped.
   */
  const onConnected = () => {
    openCalls.clear();
    flags.clear();
    // The flag may have been turned off unseen.
    observed.clear();
    versionRead = null;
    for (const [sessionId, record] of records) {
      if (record.verified) records.set(sessionId, { ...record, verified: false, generation: ++generation });
    }
    revision += 1;
    broadcast({ type: 'openchamber:session-todos', properties: { revision, sessionId: null, directory: null, todos: null } });
  };

  // ----- Whether the tool is on -----

  const readVersion = () => {
    versionRead ??= readJson('/api/info').then((info) => infoSchema.parse(info).version);
    versionRead.catch(() => { versionRead = null; });
    return versionRead;
  };

  const readFlag = async (directory) => {
    const override = flagFromOverrides(getFlagOverrides());
    if (override !== undefined) return override;
    const configured = flagFromConfig(configEntriesSchema.parse(await readJson('/api/config', { directory })));
    if (configured !== undefined) return configured;
    return flagOnByDefault(await readVersion());
  };

  /** Throws when it cannot be told; the caller keeps what it shows. */
  const isEnabled = async (directory) => {
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

  // ----- The history -----

  const readPage = async (sessionId, cursor) => {
    // The type filter travels with every page; the order rides in the cursor.
    const query = cursor
      ? { limit: String(PAGE_SIZE), cursor, type: 'assistant' }
      : { limit: String(PAGE_SIZE), order: 'desc', type: 'assistant' };
    return pageSchema.parse(await readJson(`/api/session/${encodeURIComponent(sessionId)}/message`, { query }));
  };

  /** Creation time of the session's revert boundary, null without one. */
  const readBoundary = async (sessionId) => {
    const session = sessionSchema.parse(await readJson(`/api/session/${encodeURIComponent(sessionId)}`));
    const messageId = session.revert?.messageID;
    if (!messageId) return null;
    const message = await readJson(`/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`);
    return createdSchema.parse(message).time.created;
  };

  /**
   * Walks the session's agent messages newest first until the newest
   * completed `todowrite` call before the revert boundary, or until a message
   * that finished by the time the stored list accounts for. A walk that
   * reaches the start of the history without a call settles on "no list".
   * `newest` is the latest finish time the walk saw, the next `checkedThrough`.
   */
  const findInHistory = async (sessionId, checkedThrough) => {
    const boundary = await readBoundary(sessionId);
    // A revert this server did not see may have hidden the stored list's call.
    const stopAt = boundary !== null && checkedThrough !== null && checkedThrough >= boundary ? null : checkedThrough;
    let newest = null;
    let cursor;
    const seen = new Set();
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

  const refreshFromHistory = (sessionId, directory) => {
    const running = reads.get(sessionId);
    if (running) return running;
    const before = records.get(sessionId);
    const startedAt = before?.generation ?? null;
    const run = lane.then(async () => {
      if (stopped) return;
      const found = await findInHistory(sessionId, before?.checkedThrough ?? null);
      // An event wrote a newer list meanwhile.
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

  /**
   * What the Work Status section shows for a session: `off` while the tool is
   * off in the session's directory (and for an isolated space, whose history
   * this server cannot read), else the list. Throws when it cannot be told.
   */
  const read = async (sessionId, directory) => {
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
