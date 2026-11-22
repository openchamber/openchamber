import { randomUUID } from 'node:crypto';

import { createUpstreamSseReader } from './upstream-reader.js';
import { parseSseEventEnvelope, serializeMessageStreamWsEvent } from './protocol.js';
import {
  encodeOpenChamberCursor,
  isOpenCodeEventId,
  parseSseBlock,
  SSE_RESYNC_PAYLOAD_TYPE,
} from './sse-cursor.js';
import { createReplayStore, resolveGlobalReplayFilePath } from './replay-store.js';
import { translateWireEvent } from './translate-v2.js';
import { createDeltaCoalescer, DELTA_COALESCE_WINDOW_MS } from './delta-coalescer.js';
import { DEFAULT_RESUME_IDLE_TIMEOUT_MS } from './timeouts.js';

// Raised from 512 → 2048 to improve recovery after brief disconnects during
// long-running agent sessions where many events accumulate quickly.
const MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT = 2048;
const MESSAGE_STREAM_GLOBAL_REPLAY_BYTES = 8 * 1024 * 1024;

// Local frames are synthetic announcements, not a copy of the chat stream, so their durable store
// is deliberately smaller than the in-memory replay buffer.
const MESSAGE_STREAM_LOCAL_REPLAY_LIMIT = 512;
const MESSAGE_STREAM_LOCAL_REPLAY_BYTES = 2 * 1024 * 1024;
const MESSAGE_STREAM_LOCAL_REPLAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SERVER_CONNECTED_PAYLOAD_TYPE = 'server.connected';
const GLOBAL_MESSAGE_STREAM_ID = 'global';

// The upstream's `id:` line is the cursor OpenCode replays from (`<instance>:<sequence>`), so it is
// the reader's `eventId`, and only such a line moves the reader's cursor. A block without one, which
// OpenCode sends outside its feed (`server.connected`), keeps its payload id as the buffer's id.
export const parseGlobalBlock = (block) => {
  const envelope = parseSseEventEnvelope(block);
  if (!envelope) return envelope;
  const { id } = parseSseBlock(block);
  return { ...envelope, eventId: id || undefined, bufferId: envelope.eventId };
};

// A hub built outside production keeps its replay state in memory unless it is handed a store. Tests
// pass one store to two hubs to model a restart; the server gets a file under the data directory.
const resolveReplayStore = (replayStore) => {
  if (replayStore === null) return createReplayStore();
  if (replayStore !== undefined) return replayStore;
  if (process.env.NODE_ENV === 'test') return createReplayStore();
  return createReplayStore({ filePath: resolveGlobalReplayFilePath() });
};

export function createGlobalMessageStreamHub({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  upstreamStallTimeoutMs,
  upstreamReconnectDelayMs,
  replayLimit = MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT,
  replayByteLimit = MESSAGE_STREAM_GLOBAL_REPLAY_BYTES,
  localReplayLimit = MESSAGE_STREAM_LOCAL_REPLAY_LIMIT,
  localReplayByteLimit = MESSAGE_STREAM_LOCAL_REPLAY_BYTES,
  localReplayMaxAgeMs = MESSAGE_STREAM_LOCAL_REPLAY_MAX_AGE_MS,
  deltaCoalesceWindowMs = DELTA_COALESCE_WINDOW_MS,
  resumeIdleTimeoutMs,
  replayStore,
  now = () => Date.now(),
}) {
  if (
    !Number.isSafeInteger(replayLimit) || replayLimit < 0
    || !Number.isSafeInteger(replayByteLimit) || replayByteLimit < 0
    || !Number.isSafeInteger(localReplayLimit) || localReplayLimit < 0
    || !Number.isSafeInteger(localReplayByteLimit) || localReplayByteLimit < 0
    || !Number.isSafeInteger(localReplayMaxAgeMs) || localReplayMaxAgeMs < 0
  ) {
    throw new RangeError('Replay limits must be nonnegative safe integers');
  }

  const durable = resolveReplayStore(replayStore);
  const persisted = durable.load();

  const eventSubscribers = new Set();
  // The event subscribers that also take the events of isolated spaces.
  const spaceSubscribers = new Set();
  const statusSubscribers = new Set();
  // The replay buffer holds every state frame committed in this process: OpenCode's own events, and
  // the local frames (synthetic announcements, id-less events) that OpenCode cannot reconstruct.
  // Each entry keeps its stream position and the OpenCode id it sits after, so a browser cursor
  // resolves to exactly the frames it has not applied.
  const replay = [];
  let replayBytes = 0;
  // Local frames retained for replay across a process restart. They are written to the store before
  // the frame is sent; the in-memory buffer is what answers an in-process resume.
  let localEntries = [];
  let localBytes = 0;
  // Bumped whenever a local frame is committed or the store is reset. A resume read that sees this
  // change knows a local frame it did not plan for now sits in its path, so it refetches instead of
  // handing the client to live past it.
  let localGeneration = 0;
  let droppedLocalThroughPosition = persisted.droppedLocalThroughPosition;
  // The newest OpenCode id the hub has seen: the head of the feed, which a browser may adopt as its
  // cursor. Undefined until OpenCode has sent one, and after a resync that carries none.
  let latestEventId = isOpenCodeEventId(persisted.head.upstream) ? persisted.head.upstream : undefined;
  // The upstream cursor, kept across a stop so the next connection replays what it missed. After a
  // restart it is the persisted head, so the shared reader resumes instead of starting at the tail.
  let resumeCursor = latestEventId ?? '';
  // An event without an OpenCode id (an upstream that carries no SSE ids, verified on 1.18.30, or
  // an event this hub injects) is numbered here, so it has an id for fan-out. The per-process prefix
  // keeps such an id from matching an unrelated cursor after a restart.
  const replayIdPrefix = `oc-${randomUUID().slice(0, 8)}-`;
  let replaySequence = 0;
  // The OpenChamber stream position of the newest state frame, committed or sent by a resume read.
  let position = persisted.head.position;

  let controller = null;
  let reader = null;
  let connected = false;
  let everConnected = false;
  let buildUrlFailed = false;

  const cursorAt = (entryPosition, upstream) => encodeOpenChamberCursor({
    stream: GLOBAL_MESSAGE_STREAM_ID,
    position: entryPosition,
    upstream: upstream ?? '',
  });

  const trimLocalEntries = () => {
    const cutoff = now() - localReplayMaxAgeMs;
    let removedThrough = droppedLocalThroughPosition;
    while (
      localEntries.length > 0
      && (
        localEntries.length > localReplayLimit
        || localBytes > localReplayByteLimit
        || localEntries[0].committedAt < cutoff
      )
    ) {
      const removed = localEntries.shift();
      localBytes -= removed.bytes;
      removedThrough = Math.max(removedThrough, removed.position);
    }
    if (removedThrough > droppedLocalThroughPosition) {
      droppedLocalThroughPosition = removedThrough;
      durable.appendTrim(removedThrough);
    }
  };

  localEntries = persisted.entries.map((entry) => ({
    position: entry.position,
    eventId: entry.eventId,
    upstream: entry.upstream,
    serializedFrame: entry.serializedFrame,
    bytes: entry.bytes,
    cursor: cursorAt(entry.position, entry.upstream),
    committedAt: entry.committedAt,
  }));
  localBytes = localEntries.reduce((total, entry) => total + entry.bytes, 0);
  trimLocalEntries();

  const notifySubscriber = (kind, subscriber, payload) => {
    try {
      const result = subscriber(payload);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.warn(`Global message stream ${kind} subscriber failed:`, error);
        });
      }
    } catch (error) {
      console.warn(`Global message stream ${kind} subscriber failed:`, error);
    }
  };

  const notifyStatus = (status) => {
    for (const subscriber of Array.from(statusSubscribers)) {
      notifySubscriber('status', subscriber, status);
    }
  };

  const normalizeEvent = ({ envelope, payload }) => {
    const directory =
      typeof envelope?.directory === 'string' && envelope.directory.length > 0 ? envelope.directory : 'global';
    const eventId = envelope?.eventId || envelope?.bufferId || `${replayIdPrefix}${String(++replaySequence).padStart(12, '0')}`;
    // An event of an isolated space carries the space's id; subscribers see it only when they
    // asked for space events, because a consumer that acts on the host's OpenCode by
    // directory must never act on a space's directory.
    const spaceId = typeof envelope?.spaceId === 'string' && envelope.spaceId.length > 0 ? envelope.spaceId : null;
    let serializedFrame;
    let translated;
    return {
      envelope,
      payload,
      directory,
      eventId,
      spaceId,
      // Assigned when the frame is committed, or when a resume read sends it ahead of the shared
      // stream. A frame with no position is not part of the stream state (a greeting, a resync).
      position: 0,
      upstream: '',
      local: false,
      // OpenCode's answer to a cursor it cannot honour. It is never replayed: it tells subscribers to
      // have their clients refetch.
      resync: payload?.type === SSE_RESYNC_PAYLOAD_TYPE,
      cursor() {
        return cursorAt(this.position, this.upstream);
      },
      serialize() {
        // Only a committed or sent frame names a cursor. A greeting and a resync are stream edges,
        // not state, so a browser must not advance its cursor past them.
        const cursor = this.position > 0 ? this.cursor() : undefined;
        serializedFrame ??= serializeMessageStreamWsEvent(payload, { directory, eventId: cursor });
        return serializedFrame;
      },
      // Browser clients receive the raw wire payload and translate it
      // themselves; server-side subscribers read this instead. Translating
      // lazily keeps the cost off the WS fan-out path when nothing listens.
      translated() {
        translated ??= translateWireEvent(payload);
        return translated;
      },
    };
  };

  // Replay and fan-out see the same committed sequence: an event enters the
  // replay buffer in the same step that delivers it, so a client's cursor
  // always names a frame the buffer can find. Durable state is written first,
  // so a local frame is never sent before it can be replayed after a restart.
  const commitEvent = (event) => {
    const normalized = normalizeEvent(event);
    if (normalized.resync) {
      // The upstream lost the cursor, so what is retained does not run on into what follows it: a
      // cursor from before the resync must not replay across it. The resync carries the head OpenCode
      // restarts from when it has an OpenCode id; otherwise there is no head until the next event.
      position += 1;
      replay.length = 0;
      replayBytes = 0;
      localEntries = [];
      localBytes = 0;
      localGeneration += 1;
      latestEventId = isOpenCodeEventId(normalized.eventId) ? normalized.eventId : undefined;
      resumeCursor = latestEventId ?? '';
      droppedLocalThroughPosition = Math.max(droppedLocalThroughPosition, position);
      durable.appendReset({ position, upstream: latestEventId ?? '' });
    } else if (normalized.payload?.type === SERVER_CONNECTED_PAYLOAD_TYPE && !isOpenCodeEventId(normalized.eventId)) {
      // An id-less greeting is OpenCode's hello to one connection, not part of the state a browser
      // holds: it goes live without a position, a cursor or a replay entry. A greeting that carries
      // an OpenCode id line is an ordinary upstream event and is buffered like one.
    } else {
      position += 1;
      normalized.position = position;
      const upstreamEvent = isOpenCodeEventId(normalized.eventId);
      normalized.upstream = upstreamEvent ? normalized.eventId : (latestEventId ?? '');
      normalized.local = !upstreamEvent;
      if (upstreamEvent) latestEventId = normalized.eventId;

      const serializedFrame = normalized.serialize();
      const bytes = Buffer.byteLength(serializedFrame);
      const entry = {
        position,
        eventId: normalized.eventId,
        upstream: normalized.upstream,
        local: normalized.local,
        serializedFrame,
        bytes,
        cursor: normalized.cursor(),
      };

      if (normalized.local) {
        const localEntry = {
          position,
          eventId: normalized.eventId,
          upstream: normalized.upstream,
          serializedFrame,
          bytes,
          cursor: entry.cursor,
          committedAt: now(),
        };
        // Persist before fan-out. A cursor cannot name a frame the store has not accepted:
        // when the store refuses the frame (a failed durable append, #2111) it is not
        // retained as committed replay state either. It still fans out live below —
        // live delivery is not a durability claim.
        if (durable.appendLocal(localEntry)) {
          localEntries.push(localEntry);
          localBytes += bytes;
          localGeneration += 1;
          trimLocalEntries();
        }
      } else {
        durable.appendHead({ position, upstream: latestEventId });
      }

      if (bytes > replayByteLimit) {
        // An oversized live event creates a hole: retain only a contiguous suffix after it, never
        // replay an older prefix across the gap. OpenCode can replay an upstream hole; a local hole
        // is answered by the durable store until retention drops it and resets the client.
        replay.length = 0;
        replayBytes = 0;
      } else {
        replay.push(entry);
        replayBytes += bytes;
        while (replay.length > replayLimit || replayBytes > replayByteLimit) {
          replayBytes -= replay.shift().bytes;
        }
      }
    }
    // Every client that is live receives every frame, local or not.

    for (const subscriber of Array.from(eventSubscribers)) {
      if (normalized.spaceId !== null && !spaceSubscribers.has(subscriber)) continue;
      notifySubscriber('event', subscriber, normalized);
    }
  };

  const coalescer = createDeltaCoalescer({ emit: commitEvent, windowMs: deltaCoalesceWindowMs });

  // A resume read can send an upstream event the shared stream has not committed yet. Give it a
  // position and the OpenCode id it stands on before it goes out, so the browser's cursor is a real
  // position in this stream and a later reconnect resumes after it. It is not added to the buffer:
  // the shared stream owns committing upstream events, and the read stops at the first one the
  // buffer already holds.
  const assignResumeCursor = (normalized) => {
    if (normalized.position > 0) return;
    const alreadyCommitted = replay.find((entry) => entry.eventId === normalized.eventId);
    if (alreadyCommitted) {
      normalized.position = alreadyCommitted.position;
      normalized.upstream = alreadyCommitted.upstream;
      return;
    }
    if (!isOpenCodeEventId(normalized.eventId)) return;
    position += 1;
    normalized.position = position;
    normalized.upstream = normalized.eventId;
    latestEventId = normalized.eventId;
    durable.appendHead({ position, upstream: latestEventId });
  };

  const replayAfter = (eventId) => {
    if (!eventId) {
      return [];
    }

    // The head can sit outside the buffer after a resync that named it, so it is answered by the buffer's
    // whole tail. Any other cursor the buffer does not hold cannot be answered.
    const index = replay.findIndex((entry) => entry.eventId === eventId);
    if (index === -1 && eventId !== latestEventId) return null;
    return index === -1 ? replay.slice() : replay.slice(index + 1);
  };

  // Answers a versioned OpenChamber cursor from the in-memory buffer only when the buffer is
  // contiguous from the frame the cursor names. A gap is left to `durableResumePlan`, which can
  // replay durable local frames and read the upstream events OpenCode still holds.
  const replayAfterCursor = (cursor) => {
    if (!cursor) return [];
    if (cursor.stream !== GLOBAL_MESSAGE_STREAM_ID) return null;
    if (cursor.position > position) return null;
    if (cursor.position === position) return [];
    const start = replay.length > 0 ? replay[0].position : position + 1;
    if (cursor.position === start - 1) return replay.slice();
    const index = replay.findIndex((entry) => entry.position === cursor.position);
    if (index === -1) return null;
    if (replay[index].upstream !== cursor.upstream) return null;
    return replay.slice(index + 1);
  };

  // What a cursor the buffer cannot answer still needs. `entries` covers the local frames in the gap
  // that the durable store still holds; the caller reads upstream from `upstream` and interleaves
  // them by anchor. `null` means the cursor cannot be honoured and the client must refetch.
  const durableResumePlan = (cursor) => {
    if (!cursor || cursor.stream !== GLOBAL_MESSAGE_STREAM_ID) return null;
    if (cursor.position > position) return null;
    if (cursor.position === position) return { kind: 'locals', upstream: '', entries: [] };
    // A local frame after the cursor was dropped: OpenCode cannot reconstruct it.
    if (cursor.position < droppedLocalThroughPosition) return null;

    const start = replay.length > 0 ? replay[0].position : position + 1;
    const entries = localEntries.filter(
      (entry) => entry.position > cursor.position && entry.position < start,
    );
    if (cursor.upstream) {
      if (!isOpenCodeEventId(cursor.upstream)) return null;
      return { kind: 'upstream', upstream: cursor.upstream, entries };
    }
    // No upstream id: the client never applied an OpenCode event. If one exists in this stream, the
    // missed upstream frames cannot be replayed from nothing.
    if (latestEventId) return null;
    return { kind: 'locals', upstream: '', entries };
  };

  const start = () => {
    if (reader) {
      return;
    }

    controller = new AbortController();
    reader = createUpstreamSseReader({
      signal: controller.signal,
      stallTimeoutMs: upstreamStallTimeoutMs,
      reconnectDelayMs: upstreamReconnectDelayMs,
      fetchImpl,
      parseBlock: parseGlobalBlock,
      initialLastEventId: resumeCursor,
      buildUrl: () => {
        buildUrlFailed = false;
        try {
          return new URL(buildOpenCodeUrl('/api/event', ''));
        } catch {
          buildUrlFailed = true;
          throw new Error('OpenCode service unavailable');
        }
      },
      getHeaders: getOpenCodeAuthHeaders,
      onConnect() {
        connected = true;
        const wasReady = everConnected;
        everConnected = true;
        notifyStatus({ type: 'connect', wasReady });
      },
      onDisconnect({ reason }) {
        connected = false;
        notifyStatus({ type: 'disconnect', reason });
      },
      onEvent(event) {
        coalescer.push(event);
      },
      onError(error) {
        if (controller?.signal.aborted) {
          return;
        }

        notifyStatus({
          type: everConnected ? 'error' : 'initial-error',
          error,
          buildUrlFailed,
        });
      },
    });

    void reader.start();
  };

  const stop = () => {
    connected = false;
    // Text that already arrived belongs in the retained replay suffix.
    coalescer.flush();
    if (reader) {
      resumeCursor = reader.getLastEventId();
    }
    reader?.stop();
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    reader = null;
    controller = null;
    everConnected = false;
    buildUrlFailed = false;
  };

  // The silence a catch-up read tolerates before it hands its client over to live. A healthy
  // connection delivers its replay at once, so a read silent this long has nothing left to hand over.
  // It is its own bound, not derived from the stall timeout: the bound must outlast a reader's
  // reconnect, so a connection that went quiet is reconnected by its own reader before the read gives
  // up on it.
  const resumeIdleMs = () => resumeIdleTimeoutMs ?? DEFAULT_RESUME_IDLE_TIMEOUT_MS;

  // Reads what OpenCode holds after a cursor the replay buffer cannot answer, for one client. It
  // reads on a connection of its own, from the cursor, and ends at the first event the hub also
  // holds: the shared stream carries everything after that event, so the client takes the rest from
  // the buffer. Nothing is committed here, but upstream events sent ahead of the shared stream get a
  // stream position first, so their cursors are resumable. `onResync` and `onFailed` both mean the
  // client cannot be resumed and must refetch. `onIdle` means the read went silent past the idle
  // bound after connecting: nothing after the cursor is left to replay, so the client goes live
  // without one. Each callback runs once, after the read has ended.
  const openUpstreamAfter = (cursor, { onEvent, onCaughtUp, onIdle, onResync, onFailed }) => {
    const readController = new AbortController();
    // A local frame committed while this read runs is a frame its plan did not include: the read
    // cannot place it among the upstream frames it forwards, so the client refetches instead.
    const localAtStart = localGeneration;
    const lostLocal = () => localGeneration !== localAtStart;
    let done = false;
    let connectedOnce = false;
    // Whether the read is connected right now. Silence while it is down (a failed reconnect, say)
    // proves nothing about what OpenCode holds, so only silence on a live connection is a hand-over.
    let attached = false;
    let idleTimer = null;
    const assignResumeCursorFromBuffer = (normalized) => {
      const entry = replay.find((candidate) => candidate.eventId === normalized.eventId);
      if (entry) {
        normalized.position = entry.position;
        normalized.upstream = entry.upstream;
      } else if (normalized.eventId === latestEventId) {
        normalized.position = position;
        normalized.upstream = latestEventId ?? '';
      }
    };
    const finish = () => {
      done = true;
      clearTimeout(idleTimer);
      readController.abort();
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (done) return;
        const handover = attached && !lostLocal() ? onIdle : onFailed;
        finish();
        handover();
      }, resumeIdleMs());
      idleTimer.unref?.();
    };
    const resumeReader = createUpstreamSseReader({
      signal: readController.signal,
      stallTimeoutMs: upstreamStallTimeoutMs,
      reconnectDelayMs: upstreamReconnectDelayMs,
      fetchImpl,
      parseBlock: parseGlobalBlock,
      initialLastEventId: cursor,
      buildUrl: () => new URL(buildOpenCodeUrl('/api/event', '')),
      getHeaders: getOpenCodeAuthHeaders,
      onConnect() {
        connectedOnce = true;
        attached = true;
        armIdle();
      },
      onDisconnect() {
        attached = false;
      },
      onEvent(event) {
        if (done) return;
        armIdle();
        const normalized = normalizeEvent(event);
        if (normalized.resync) {
          finish();
          onResync();
          return;
        }
        // Pending text is committed first, so a buffer that holds this event is complete up to it.
        coalescer.flush();
        if (lostLocal()) {
          finish();
          onFailed();
          return;
        }
        if (replayAfter(normalized.eventId) !== null) {
          assignResumeCursorFromBuffer(normalized);
          finish();
          onCaughtUp(normalized);
          return;
        }
        assignResumeCursor(normalized);
        onEvent(normalized);
      },
      onError() {
        // A read that never connected cannot be retried into a resume: the client refetches. Once
        // connected, the reader reconnects from its own cursor, as the shared stream does.
        if (done || connectedOnce) return;
        finish();
        onFailed();
      },
    });
    armIdle();
    void resumeReader.start();
    return () => {
      if (!done) finish();
    };
  };

  return {
    start,
    stop,
    openUpstreamAfter,
    streamId() {
      return GLOBAL_MESSAGE_STREAM_ID;
    },
    /** The id of the last upstream event read, or the cursor the connection started from. */
    upstreamCursor() {
      return reader ? reader.getLastEventId() : resumeCursor;
    },
    /** The newest OpenCode id the hub has seen, or undefined before the first one. */
    headEventId() {
      return latestEventId;
    },
    /** The cursor a browser with no cursor adopts: current stream position and upstream head. */
    headCursor() {
      return cursorAt(position, latestEventId ?? '');
    },
    isConnected() {
      return connected;
    },
    hasConnected() {
      return everConnected;
    },
    /**
     * `spaces: true` also delivers the events of isolated spaces, which carry `spaceId`.
     * Without it a subscriber sees the host's events only, as every consumer did before spaces.
     */
    subscribeEvent(subscriber, { spaces = false } = {}) {
      eventSubscribers.add(subscriber);
      if (spaces) spaceSubscribers.add(subscriber);
      return () => {
        eventSubscribers.delete(subscriber);
        spaceSubscribers.delete(subscriber);
      };
    },
    /**
     * One event of an isolated space, from that space's own connection, entered here as if it
     * had arrived upstream: numbered, coalesced, replayed and fanned out with the host's, so
     * a client keeps one cursor for everything. `directory` is the space's, `spaceId` marks it.
     */
    injectEvent({ payload, directory, spaceId, eventId }) {
      // The OpenCode id of a followed upstream or a space's stream is kept, so it is replayed like the host's
      // events. An event without one (a synthetic announcement) is numbered by the hub and is a local frame.
      coalescer.push({ envelope: { directory, spaceId, eventId }, payload });
    },
    /** Local frames retained for restart replay. */
    localFrames() {
      return localEntries.length;
    },
    subscribeStatus(subscriber) {
      statusSubscribers.add(subscriber);
      return () => {
        statusSubscribers.delete(subscriber);
      };
    },
    // A client that becomes ready must not receive text from before it was
    // ready merged into its first live delta, so the bridge commits pending
    // deltas before it reads the replay tail.
    flushPending() {
      coalescer.flush();
    },
    replayAfter,
    replayAfterCursor,
    durableResumePlan,
    /** The in-memory buffer, in commit order, for a resume that sent durable frames first. */
    replayEntries() {
      return replay.slice();
    },
  };
}
