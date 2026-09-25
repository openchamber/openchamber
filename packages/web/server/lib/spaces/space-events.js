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

import { Readable } from 'node:stream';

import { z } from 'zod';

import { createUpstreamSseReader } from '../event-stream/upstream-reader.js';

const EVENT_PATH = '/api/event';
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
 * session index; `hub` the global event hub. `stallTimeoutMs` and `now` are for the tests.
 */
export function createSpaceEventSources({ requestInside, index, hub, logger = console, stallTimeoutMs, now = Date.now }) {
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

  /** The event stream inside, over the dispatcher's channel, in the shape the reader expects. */
  const fetchInside = (spaceId) => async (_url, { headers, signal }) => {
    const response = await requestInside(spaceId, { path: EVENT_PATH, headers });
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
      fetchImpl: fetchInside(spaceId),
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
    sources.set(spaceId, source);
    void source.reader.start();
  };

  const stop = (spaceId) => {
    const source = sources.get(spaceId);
    if (!source) return;
    sources.delete(spaceId);
    source.controller.abort();
    source.reader.stop();
  };

  return {
    /** Follows the list of spaces: a connection for each new one, none for one that is gone. */
    sync(spaceIds) {
      const wanted = new Set(spaceIds);
      for (const spaceId of Array.from(sources.keys())) {
        if (!wanted.has(spaceId)) {
          stop(spaceId);
          index.forget(spaceId);
        }
      }
      for (const spaceId of wanted) start(spaceId);
    },
    /** For the tests: whether a space has a connection right now. */
    has: (spaceId) => sources.has(spaceId),
    close() {
      for (const spaceId of Array.from(sources.keys())) stop(spaceId);
    },
  };
}
