
import { Readable } from 'node:stream';

import { z } from 'zod';

import { UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS, createUpstreamSseReader } from '../event-stream/upstream-reader.js';
import { SPACE_TASK_TITLE_EVENT, SPACE_TASK_TITLE_ROUTE, sanitizeSpaceTaskTitle } from './task-title.js';

const EVENT_PATH = '/api/event';
const CONTROL_PATH = '/api/openchamber/events';
const NOTIFICATIONS_PATH = '/api/notifications/stream';
const QUEUE_UPDATED = 'openchamber:message-queue.updated';
const AUTO_REVIEW_UPDATED = 'openchamber:auto-review.updated';
const MODES_UPDATED = 'openchamber:permission-auto-accept.updated';
const LEFT_FOR_USER = 'openchamber:permission-auto-accept.left-for-user';
const SPACE_STATE_STALL_TIMEOUT_MS = UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS;
const STATUS_PATH = '/api/sessions/status';
const STATUS_TIMEOUT_MS = 10_000;
const MAX_STATUS_BYTES = 4 * 1024 * 1024;

const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 60_000;
export const reconnectDelayAfter = (failures) => Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, failures - 1));

const liveStatusSchema = z.object({ status: z.enum(['busy', 'idle']) });
const statusSchema = z.object({ sessions: z.record(z.string(), z.unknown()).default({}) }).passthrough();
const eventPayloadSchema = z.object({ location: z.object({ directory: z.string() }).passthrough().optional() }).passthrough();
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
const autoReviewRunSchema = z.object({
  originalSessionID: z.string().min(1),
  reviewSessionID: z.string().min(1),
  directory: z.string().min(1),
  status: z.enum(['running', 'clean', 'disputed', 'limit', 'failed', 'stopped']),
  step: z.enum(['handoff', 'review', 'implement']),
  round: z.number().int().nonnegative(),
  maxRounds: z.number().int().positive(),
  startedAt: z.number(),
  updatedAt: z.number(),
  error: z.string().transform((error) => error.slice(0, 2_000)).optional(),
  dispute: z.string().transform((dispute) => dispute.slice(0, 2_000)).optional(),
});
const autoReviewUpdateSchema = z.object({
  type: z.literal(AUTO_REVIEW_UPDATED),
  properties: z.object({
    revision: z.number(),
    originalSessionID: z.string().min(1),
    directory: z.string().min(1),
    run: autoReviewRunSchema.nullable(),
  }),
});

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

export function createSpaceEventSources({ requestInside, index, hub, broadcastUiEvent = null, broadcastGlobalUiEvent = null, onTaskTitle = null, logger = console, stallTimeoutMs, stateStallTimeoutMs = SPACE_STATE_STALL_TIMEOUT_MS, now = Date.now }) {
  const sources = new Map();
  const titleProposalSchema = z.object({ properties: z.object({ spaceId: z.string(), title: z.unknown() }) });
  const takeTaskTitle = (spaceId, title) => {
    const clean = sanitizeSpaceTaskTitle(title);
    if (clean) onTaskTitle?.(spaceId, clean);
  };
  const seedTaskTitle = async (spaceId, isCurrent) => {
    const response = await requestInside(spaceId, { path: SPACE_TASK_TITLE_ROUTE, headers: { accept: 'application/json' }, timeoutMs: STATUS_TIMEOUT_MS });
    if (response.statusCode !== 200) { response.resume(); return; }
    const body = z.object({ title: z.unknown() }).safeParse(JSON.parse(await readBody(response, 1024)));
    if (body.success && isCurrent()) takeTaskTitle(spaceId, body.data.title);
  };

  const inject = (spaceId, payload, directory) => hub.injectEvent({ payload, directory, spaceId });

  const announce = (spaceId, status, wasReady) => {
    inject(spaceId, { type: 'openchamber:space-stream', properties: { spaceId, status, wasReady, timestamp: now() } }, 'global');
  };

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
    const source = { failures: 0, everConnected: false, reader: null, controller, titleRevision: 0 };
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
      onError(error) {
        if (controller.signal.aborted) return;
        logger.warn?.(`[spaces] event stream of space ${spaceId}: ${error?.type ?? 'error'} ${error?.status ?? error?.error?.code ?? ''}`.trim());
      },
    });
    source.stateReaders = [];
    if (broadcastUiEvent) {
      source.stateReaders.push(startStateReader(spaceId, controller.signal, {
        path: CONTROL_PATH,
        announce: () => {
          broadcastUiEvent({ type: 'openchamber:space-queue-stream', properties: { spaceId, status: 'connected' } });
          if (onTaskTitle) {
            const revision = ++source.titleRevision;
            seedTaskTitle(spaceId, () => !controller.signal.aborted && revision === source.titleRevision)
              .catch((error) => logger.warn?.(`[spaces] could not read the task title of space ${spaceId}: ${error?.code ?? error?.message ?? error}`));
          }
        },
        forward: (payload) => {
          if (payload?.type === QUEUE_UPDATED) forwardQueueUpdate(spaceId, payload);
          else if (payload?.type === AUTO_REVIEW_UPDATED) forwardAutoReviewUpdate(spaceId, payload);
          else if (payload?.type === SPACE_TASK_TITLE_EVENT && onTaskTitle) {
            const proposal = titleProposalSchema.safeParse(payload);
            if (!proposal.success || proposal.data.properties.spaceId !== spaceId) return;
            source.titleRevision += 1;
            takeTaskTitle(spaceId, proposal.data.properties.title);
          }
        },
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

  const speaksFor = (spaceId, what, sessionId, directory = null) => {
    const code = index.spaceSessionDropCode(spaceId, sessionId, directory);
    if (code !== null) logger.warn?.(`[spaces] dropped ${what} of space ${spaceId}: ${code}`);
    return code === null;
  };

  const forwardQueueUpdate = (spaceId, payload) => {
    const parsed = queueUpdateSchema.safeParse(payload);
    if (!parsed.success) return;
    const { revision, session } = parsed.data.properties;
    if (!speaksFor(spaceId, 'a queue update', session.sessionId, session.directory)) return;
    broadcastUiEvent({ type: QUEUE_UPDATED, properties: { revision, session, spaceId } });
  };

  const forwardAutoReviewUpdate = (spaceId, payload) => {
    const parsed = autoReviewUpdateSchema.safeParse(payload);
    if (!parsed.success) return;
    const { revision, originalSessionID, directory, run } = parsed.data.properties;
    if (!speaksFor(spaceId, 'an auto-review update', originalSessionID, directory)) return;
    if (run) {
      if (run.originalSessionID !== originalSessionID || run.directory !== directory) {
        logger.warn?.(`[spaces] dropped an auto-review update of space ${spaceId}: run_mismatch`);
        return;
      }
      if (!speaksFor(spaceId, 'an auto-review update', run.reviewSessionID, directory)) return;
    }
    broadcastUiEvent({ type: AUTO_REVIEW_UPDATED, properties: { revision, originalSessionID, directory, run, spaceId } });
  };

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

  const forwardLeftForUser = (spaceId, payload) => {
    const parsed = leftForUserSchema.safeParse(payload);
    if (!parsed.success) return;
    const { permissionId, sessionId, directory } = parsed.data.properties;
    if (!speaksFor(spaceId, 'a request left for the user', sessionId, directory)) return;
    broadcastGlobalUiEvent({ type: LEFT_FOR_USER, properties: { permissionId, sessionId, directory, spaceId } });
  };

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
    has: (spaceId) => sources.has(spaceId),
    close() {
      for (const spaceId of Array.from(sources.keys())) stop(spaceId);
    },
  };
}
