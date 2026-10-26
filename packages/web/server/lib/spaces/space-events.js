// One event connection per space, with its own state and its own backoff, attached to the
// host's event hub after the v2 translation layer: a space's events enter the hub as the
// host's do, numbered, coalesced, replayed and fanned out, marked with the space's id. They
// feed the same watcher, so live status, unread marks and notifications work for a space's
// sessions, and the same browser streams, so a client keeps one cursor for everything.
//
// Every event is untrusted and passes the session index first: a directory outside the
// space's root or a session id of the host's drops it. When a connection is made the host
// asks the space for its live status and enters it the same way. A gap is reported to the
// clients as `openchamber:space-stream`, so a client re-reads that one space.
//
// Two more connections per space read what the server inside keeps for the space's own sessions,
// since it sees its OpenCode and acts on it: its control stream for changes to a session's message
// queue, and its notification stream for the permission modes and the requests it left for the
// user. Each change passes the same rules and goes to the browsers marked with the space's id, on
// the host's stream that carries the host's own; each connection announces itself, so a client
// re-reads that space's state after a gap.

import { Readable } from 'node:stream';

import { z } from 'zod';

import { UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS, createUpstreamSseReader } from '../event-stream/upstream-reader.js';

const EVENT_PATH = '/api/event';
const CONTROL_PATH = '/api/openchamber/events';
const NOTIFICATIONS_PATH = '/api/notifications/stream';
const QUEUE_UPDATED = 'openchamber:message-queue.updated';
const MODES_UPDATED = 'openchamber:permission-auto-accept.updated';
const LEFT_FOR_USER = 'openchamber:permission-auto-accept.left-for-user';
// Both streams inside are quiet but for a heartbeat, every 25 and 20 seconds, so a quiet minute
// is a dead stream; the reader's default of 20 seconds would drop and remake a healthy idle one.
const SPACE_STATE_STALL_TIMEOUT_MS = UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS;
const STATUS_PATH = '/api/sessions/status';
const STATUS_TIMEOUT_MS = 10_000;
const MAX_STATUS_BYTES = 4 * 1024 * 1024;

// Backoff between attempts: doubling from one second to a minute, reset by a connection.
const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 60_000;
export const reconnectDelayAfter = (failures) => Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, failures - 1));

// What the host reads of an answer from inside; the rest is carried, not read.
const liveStatusSchema = z.object({ status: z.enum(['busy', 'idle']) });
const statusSchema = z.object({ sessions: z.record(z.string(), z.unknown()).default({}) }).passthrough();
const eventPayloadSchema = z.object({ location: z.object({ directory: z.string() }).passthrough().optional() }).passthrough();
// A queue change inside, rebuilt from these fields only; the items are the space's own, carried for display.
// The permission modes of the space's sessions and a request left for the user, rebuilt the same way.
const modesUpdateSchema = z.object({
  type: z.literal(MODES_UPDATED),
  properties: z.object({ modes: z.record(z.string(), z.enum(['ask', 'safety', 'auto'])), revision: z.number() }),
});
const leftForUserSchema = z.object({
  type: z.literal(LEFT_FOR_USER),
  properties: z.object({ permissionId: z.string().min(1), sessionId: z.string().min(1), directory: z.string().nullable() }),
});
const queueUpdateSchema = z.object({
  type: z.literal(QUEUE_UPDATED),
  properties: z.object({
    revision: z.number(),
    session: z.object({
      sessionId: z.string(),
      directory: z.string(),
      items: z.array(z.unknown()),
      sendingId: z.string().nullable(),
    }),
  }),
});

/** Reads a whole body up to a cap, as text. */
const readBody = (response, cap) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  response.on('data', (chunk) => {
    size += chunk.length;
    if (size > cap) {
      response.destroy();
      reject(new Error(`the answer exceeds ${cap} bytes`));
      return;
    }
    chunks.push(chunk);
  });
  response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  response.on('error', reject);
});

/**
 * `requestInside(spaceId, { path, headers, timeoutMs })` is the dispatcher's; `index` the
 * session index; `hub` the global event hub; `broadcastUiEvent` the host's control stream and
 * `broadcastGlobalUiEvent` its notification stream, and without one the connection that feeds it
 * is not made. `stallTimeoutMs`, `stateStallTimeoutMs` and `now` are for the tests.
 */
export function createSpaceEventSources({ requestInside, index, hub, broadcastUiEvent = null, broadcastGlobalUiEvent = null, logger = console, stallTimeoutMs, stateStallTimeoutMs = SPACE_STATE_STALL_TIMEOUT_MS, now = Date.now }) {
  const sources = new Map();

  const inject = (spaceId, payload, directory) => hub.injectEvent({ payload, directory, spaceId });

  const announce = (spaceId, status, wasReady) => {
    inject(spaceId, { type: 'openchamber:space-stream', properties: { spaceId, status, wasReady, timestamp: now() } }, 'global');
  };

  /** The live status inside, entered as status events, so a busy session shows busy from the first moment. */
  const seedStatus = async (spaceId) => {
    const response = await requestInside(spaceId, { path: STATUS_PATH, headers: { accept: 'application/json' }, timeoutMs: STATUS_TIMEOUT_MS });
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error(`status ${response.statusCode}`);
    }
    const parsed = statusSchema.safeParse(JSON.parse(await readBody(response, MAX_STATUS_BYTES)));
    if (!parsed.success) return;
    for (const [sessionID, state] of Object.entries(parsed.data.sessions)) {
      const live = liveStatusSchema.safeParse(state);
      if (!live.success) continue;
      const payload = { type: 'session.status', data: { sessionID, status: { type: live.data.status } } };
      if (index.acceptSpaceEvent(spaceId, payload)) inject(spaceId, payload, '');
    }
  };

  /** A stream inside, over the dispatcher's channel, in the shape the reader expects. */
  const fetchInside = (spaceId, path) => async (_url, { headers, signal }) => {
    const response = await requestInside(spaceId, { path, headers });
    const stop = () => response.destroy();
    if (signal?.aborted) { stop(); throw new Error('aborted'); }
    signal?.addEventListener('abort', stop, { once: true });
    const contentType = String(response.headers['content-type'] ?? '');
    const ok = response.statusCode === 200 && contentType.includes('text/event-stream');
    return { ok, status: response.statusCode, body: ok ? Readable.toWeb(response) : null };
  };

  const start = (spaceId) => {
    if (sources.has(spaceId)) return;
    const controller = new AbortController();
    const source = { failures: 0, everConnected: false, reader: null, controller };
    source.reader = createUpstreamSseReader({
      signal: controller.signal,
      fetchImpl: fetchInside(spaceId, EVENT_PATH),
      stallTimeoutMs,
      reconnectDelayMs: () => reconnectDelayAfter(source.failures),
      buildUrl: () => new URL(`http://space${EVENT_PATH}`),
      onConnect() {
        source.failures = 0;
        const wasReady = source.everConnected;
        source.everConnected = true;
        announce(spaceId, 'connected', wasReady);
        seedStatus(spaceId).catch((error) => logger.warn?.(`[spaces] could not read the status of space ${spaceId}: ${error?.code ?? error?.message ?? error}`));
      },
      onDisconnect({ reason }) {
        source.failures += 1;
        if (source.everConnected && reason !== 'stopped') announce(spaceId, 'disconnected', true);
      },
      onEvent({ payload }) {
        const parsed = eventPayloadSchema.safeParse(payload);
        if (!parsed.success || !index.acceptSpaceEvent(spaceId, payload)) return;
        inject(spaceId, payload, parsed.data.location?.directory ?? '');
      },
      // Every failed attempt ends in `onDisconnect`, which is where it is counted.
      onError(error) {
        if (controller.signal.aborted) return;
        logger.warn?.(`[spaces] event stream of space ${spaceId}: ${error?.type ?? 'error'} ${error?.status ?? error?.error?.code ?? ''}`.trim());
      },
    });
    source.stateReaders = [];
    if (broadcastUiEvent) {
      source.stateReaders.push(startStateReader(spaceId, controller.signal, {
        path: CONTROL_PATH,
        announce: () => broadcastUiEvent({ type: 'openchamber:space-queue-stream', properties: { spaceId, status: 'connected' } }),
        forward: (payload) => { if (payload?.type === QUEUE_UPDATED) forwardQueueUpdate(spaceId, payload); },
      }));
    }
    if (broadcastGlobalUiEvent) {
      source.stateReaders.push(startStateReader(spaceId, controller.signal, {
        path: NOTIFICATIONS_PATH,
        announce: () => broadcastGlobalUiEvent({ type: 'openchamber:space-permission-stream', properties: { spaceId, status: 'connected' } }),
        forward: (payload) => {
          if (payload?.type === MODES_UPDATED) forwardModesUpdate(spaceId, payload);
          else if (payload?.type === LEFT_FOR_USER) forwardLeftForUser(spaceId, payload);
        },
      }));
    }
    sources.set(spaceId, source);
    void source.reader.start();
  };

  /** Whether a space may speak for one of its sessions; a drop is logged as a code with the space id. */
  const speaksFor = (spaceId, what, sessionId, directory = null) => {
    const code = index.spaceSessionDropCode(spaceId, sessionId, directory);
    if (code !== null) logger.warn?.(`[spaces] dropped ${what} of space ${spaceId}: ${code}`);
    return code === null;
  };

  /** A queue change of a space's session, to the browsers, when the space may speak for that session. */
  const forwardQueueUpdate = (spaceId, payload) => {
    const parsed = queueUpdateSchema.safeParse(payload);
    if (!parsed.success) return;
    const { revision, session } = parsed.data.properties;
    if (!speaksFor(spaceId, 'a queue update', session.sessionId, session.directory)) return;
    broadcastUiEvent({ type: QUEUE_UPDATED, properties: { revision, session, spaceId } });
  };

  /**
   * The space's permission modes, to the browsers, without the sessions it may not speak for.
   * `sessions` is the on/off shape older clients read, rebuilt from the modes.
   */
  const forwardModesUpdate = (spaceId, payload) => {
    const parsed = modesUpdateSchema.safeParse(payload);
    if (!parsed.success) return;
    const modes = {};
    const sessions = {};
    for (const [sessionId, mode] of Object.entries(parsed.data.properties.modes)) {
      if (!speaksFor(spaceId, 'a permission mode', sessionId)) continue;
      modes[sessionId] = mode;
      sessions[sessionId] = mode !== 'ask';
    }
    broadcastGlobalUiEvent({ type: MODES_UPDATED, properties: { sessions, modes, revision: parsed.data.properties.revision, spaceId } });
  };

  /** A request the server inside left for the user, so the browsers show it after all. */
  const forwardLeftForUser = (spaceId, payload) => {
    const parsed = leftForUserSchema.safeParse(payload);
    if (!parsed.success) return;
    const { permissionId, sessionId, directory } = parsed.data.properties;
    if (!speaksFor(spaceId, 'a request left for the user', sessionId, directory)) return;
    broadcastGlobalUiEvent({ type: LEFT_FOR_USER, properties: { permissionId, sessionId, directory, spaceId } });
  };

  /** One stream inside that feeds a space's own state to the browsers, with its own backoff. */
  const startStateReader = (spaceId, signal, { path, announce, forward }) => {
    const state = { failures: 0 };
    const reader = createUpstreamSseReader({
      signal,
      fetchImpl: fetchInside(spaceId, path),
      stallTimeoutMs: stateStallTimeoutMs,
      reconnectDelayMs: () => reconnectDelayAfter(state.failures),
      buildUrl: () => new URL(`http://space${path}`),
      onConnect() {
        state.failures = 0;
        announce();
      },
      onDisconnect() { state.failures += 1; },
      onEvent({ payload }) { forward(payload); },
      onError(error) {
        if (signal.aborted) return;
        logger.warn?.(`[spaces] stream ${path} of space ${spaceId}: ${error?.type ?? 'error'} ${error?.status ?? error?.error?.code ?? ''}`.trim());
      },
    });
    void reader.start();
    return reader;
  };

  const stop = (spaceId) => {
    const source = sources.get(spaceId);
    if (!source) return;
    sources.delete(spaceId);
    source.controller.abort();
    source.reader.stop();
    for (const reader of source.stateReaders) reader.stop();
  };

  return {
    /**
     * Follows the list of spaces: a connection for each new one, none for one that is gone. A
     * space in `paused` is kept, with its index, and not connected: its place cannot be asked, and
     * an attempt would only wait on a machine that is off.
     */
    sync(spaceIds, { paused = new Set() } = {}) {
      const wanted = new Set(spaceIds);
      for (const spaceId of Array.from(sources.keys())) {
        if (!wanted.has(spaceId)) {
          stop(spaceId);
          index.forget(spaceId);
        } else if (paused.has(spaceId)) {
          stop(spaceId);
        }
      }
      for (const spaceId of wanted) {
        if (!paused.has(spaceId)) start(spaceId);
      }
    },
    /** For the tests: whether a space has a connection right now. */
    has: (spaceId) => sources.has(spaceId),
    close() {
      for (const spaceId of Array.from(sources.keys())) stop(spaceId);
    },
  };
}
