import { randomUUID } from 'node:crypto';

import { createUpstreamSseReader } from './upstream-reader.js';
import { parseSseEventEnvelope, serializeMessageStreamWsEvent } from './protocol.js';
import { isOpenCodeEventId, parseSseBlock, SSE_RESYNC_PAYLOAD_TYPE } from './sse-cursor.js';
import { translateWireEvent } from './translate-v2.js';
import { createDeltaCoalescer, DELTA_COALESCE_WINDOW_MS } from './delta-coalescer.js';
import { DEFAULT_RESUME_IDLE_TIMEOUT_MS } from './timeouts.js';

// Raised from 512 → 2048 to improve recovery after brief disconnects during
// long-running agent sessions where many events accumulate quickly.
const MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT = 2048;
const MESSAGE_STREAM_GLOBAL_REPLAY_BYTES = 8 * 1024 * 1024;

const SERVER_CONNECTED_PAYLOAD_TYPE = 'server.connected';

// The upstream's `id:` line is the cursor OpenCode replays from (`<instance>:<sequence>`), so it is
// the reader's `eventId`, and only such a line moves the reader's cursor. A block without one, which
// OpenCode sends outside its feed (`server.connected`), keeps its payload id as the buffer's id.
export const parseGlobalBlock = (block) => {
  const envelope = parseSseEventEnvelope(block);
  if (!envelope) return envelope;
  const { id } = parseSseBlock(block);
  return { ...envelope, eventId: id || undefined, bufferId: envelope.eventId };
};

// OpenCode opens every connection with a `server.connected` greeting, which carries no `id:` line,
// and the UI answers a greeting by re-reading what it shows, since it means the stream started over.
// A connection that resumed from an OpenCode cursor started over only when OpenCode could not honour
// the cursor, which it says with a `server.resync` as the first event after the greeting
// (packages/server/src/event-feed.ts queues the resync before the connection goes live). So the
// greeting of such a connection is held until the connection's next event: a resync passes it on,
// ahead of the resync; a replayed or live event drops it, because nothing was missed. A connection
// without a cursor passes its greeting on at once.
const createResumedGreetingGate = () => {
  let deciding = false;
  let greeting = null;
  return {
    connected(lastEventId) {
      deciding = isOpenCodeEventId(lastEventId);
      greeting = null;
    },
    /** The events to pass on, in order, for one the connection delivered. */
    admit(event) {
      if (!deciding) return [event];
      if (event.payload?.type === SERVER_CONNECTED_PAYLOAD_TYPE && !event.eventId) {
        greeting = event;
        return [];
      }
      deciding = false;
      const held = greeting;
      greeting = null;
      return held && event.payload?.type === SSE_RESYNC_PAYLOAD_TYPE ? [held, event] : [event];
    },
  };
};

export function createGlobalMessageStreamHub({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  upstreamStallTimeoutMs,
  upstreamReconnectDelayMs,
  replayLimit = MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT,
  replayByteLimit = MESSAGE_STREAM_GLOBAL_REPLAY_BYTES,
  deltaCoalesceWindowMs = DELTA_COALESCE_WINDOW_MS,
  resumeIdleTimeoutMs,
}) {
  if (!Number.isSafeInteger(replayLimit) || replayLimit < 0 || !Number.isSafeInteger(replayByteLimit) || replayByteLimit < 0) {
    throw new RangeError('Replay limits must be nonnegative safe integers');
  }
  const eventSubscribers = new Set();
  // The event subscribers that also take the events of isolated spaces.
  const spaceSubscribers = new Set();
  const statusSubscribers = new Set();
  // The replay buffer holds OpenCode's own `<instance>:<sequence>` events, the only ids a browser is
  // ever sent as a cursor, and a marker for each run of local frames. A local frame (no OpenCode id:
  // a synthetic space announcement, an event numbered by the hub) is delivered live but cannot be
  // replayed. A cursor that sits before a marker gets `null` from `replayAfter`, which is a reset: the
  // browser refetches rather than resume past a frame it never saw.
  const replay = [];
  let replayBytes = 0;
  // Local frames committed since this hub was created. A cursor the buffer does not hold may only go
  // upstream while this is zero: OpenCode cannot replay a local frame, so a resume could skip one.
  let localFrameCount = 0;
  // The newest OpenCode id the hub has seen: the head of the feed, which a browser may adopt as its
  // cursor. Undefined until OpenCode has sent one, and after a resync that carries none.
  let latestEventId;
  // The upstream cursor, kept across a stop so the next connection replays what it missed. Only
  // OpenCode's own `<instance>:<sequence>` ids mean anything to it; anything else is a hub id.
  let resumeCursor = '';
  // An event without an OpenCode id (an upstream that carries no SSE ids, verified on 1.18.30, or
  // an event this hub injects) is numbered here, so it has an id for fan-out. The per-process prefix
  // keeps such an id from matching an unrelated cursor after a restart.
  const replayIdPrefix = `oc-${randomUUID().slice(0, 8)}-`;
  let replaySequence = 0;

  let controller = null;
  let reader = null;
  let connected = false;
  let everConnected = false;
  let buildUrlFailed = false;

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
      // OpenCode's answer to a cursor it cannot honour. It is never replayed: it tells subscribers to
      // have their clients refetch.
      resync: payload?.type === SSE_RESYNC_PAYLOAD_TYPE,
      serialize() {
        // Only an OpenCode id goes to the browser as its cursor. A hub id or a payload id names a
        // position in this process's buffer or nothing OpenCode can replay from, so the frame omits it.
        const cursor = isOpenCodeEventId(eventId) ? eventId : undefined;
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
  // always names a frame the buffer can find.
  const commitEvent = (event) => {
    const normalized = normalizeEvent(event);
    if (normalized.resync) {
      // The upstream lost the cursor, so what is retained does not run on into what follows it: a
      // cursor from before the resync must not replay across it. The resync carries the head OpenCode
      // restarts from when it has an OpenCode id; otherwise there is no head until the next event.
      replay.length = 0;
      replayBytes = 0;
      latestEventId = isOpenCodeEventId(normalized.eventId) ? normalized.eventId : undefined;
    } else if (isOpenCodeEventId(normalized.eventId)) {
      latestEventId = normalized.eventId;
      const serializedFrame = normalized.serialize();
      const bytes = Buffer.byteLength(serializedFrame);
      if (bytes > replayByteLimit) {
        // An oversized live event creates a hole: retain only a contiguous
        // suffix after it, never replay an older prefix across the gap.
        replay.length = 0;
        replayBytes = 0;
      } else {
        replay.push({ eventId: normalized.eventId, serializedFrame, bytes });
        replayBytes += bytes;
        while (replay.length > replayLimit || replayBytes > replayByteLimit) {
          replayBytes -= replay.shift().bytes;
        }
      }
    } else if (normalized.payload?.type !== SERVER_CONNECTED_PAYLOAD_TYPE) {
      // A local frame. A greeting is not one: it is OpenCode's hello to one connection, not part of the
      // state a browser holds, so it goes live without a marker.
      localFrameCount += 1;
      if (replay.at(-1)?.marker !== true) replay.push({ marker: true, eventId: undefined, bytes: 0 });
    }
    // Every client that is live receives every frame, local or not.

    for (const subscriber of Array.from(eventSubscribers)) {
      if (normalized.spaceId !== null && !spaceSubscribers.has(subscriber)) continue;
      notifySubscriber('event', subscriber, normalized);
    }
  };

  const coalescer = createDeltaCoalescer({ emit: commitEvent, windowMs: deltaCoalesceWindowMs });

  const replayAfter = (eventId) => {
    if (!eventId) {
      return [];
    }

    // The head can sit outside the buffer after a resync that named it, so it is answered by the buffer's
    // whole tail. Any other cursor the buffer does not hold cannot be answered.
    const index = replay.findIndex((entry) => entry.eventId === eventId);
    if (index === -1 && eventId !== latestEventId) return null;
    const tail = index === -1 ? replay : replay.slice(index + 1);
    // A local frame after the cursor cannot be replayed to the browser, so it must refetch rather than resume.
    return tail.some((entry) => entry.marker) ? null : tail;
  };

  const start = () => {
    if (reader) {
      return;
    }

    controller = new AbortController();
    const greetings = createResumedGreetingGate();
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
      onConnect({ lastEventId }) {
        greetings.connected(lastEventId);
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
        for (const admitted of greetings.admit(event)) coalescer.push(admitted);
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
  // It is its own bound, not derived from the stall timeout, and by default the shorter of the two:
  // only events count here, so a quiet read is handed over at the bound while OpenCode's heartbeat
  // keeps its connection from stalling. A connection that dies without closing is handed over the
  // same way, before its reader's stall window would reconnect it, and its client goes live without
  // whatever that connection had not delivered.
  const resumeIdleMs = () => resumeIdleTimeoutMs ?? DEFAULT_RESUME_IDLE_TIMEOUT_MS;

  // Reads what OpenCode holds after a cursor the replay buffer cannot answer, for one client. It
  // reads on a connection of its own, from the cursor, and ends at the first event the hub also
  // holds: the shared stream carries everything after that event, so the client takes the rest from
  // the buffer. Nothing is committed here; the shared stream commits what it reads, as it always has.
  // `onResync` and `onFailed` both mean the client cannot be resumed and must refetch. `onIdle` means
  // the read went silent past the idle bound after connecting: nothing after the cursor is left to
  // replay, so the client goes live without one. Each callback runs once, after the read has ended.
  const openUpstreamAfter = (cursor, { onEvent, onCaughtUp, onIdle, onResync, onFailed }) => {
    const readController = new AbortController();
    // OpenCode cannot replay a local frame, so one committed while this read runs is a gap the read cannot
    // fill: every hand-over then refetches instead.
    const localAtStart = localFrameCount;
    const lostLocal = () => localFrameCount !== localAtStart;
    let done = false;
    let connectedOnce = false;
    // Whether the read is connected right now. Silence while it is down (a failed reconnect, say)
    // proves nothing about what OpenCode holds, so only silence on a live connection is a hand-over.
    let attached = false;
    let idleTimer = null;
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
    const readEvent = (event) => {
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
        finish();
        onCaughtUp(normalized);
        return;
      }
      onEvent(normalized);
    };
    // Every connection of this read carries a cursor, so its greeting reaches the client only when
    // OpenCode could not honour that cursor.
    const greetings = createResumedGreetingGate();
    const resumeReader = createUpstreamSseReader({
      signal: readController.signal,
      stallTimeoutMs: upstreamStallTimeoutMs,
      reconnectDelayMs: upstreamReconnectDelayMs,
      fetchImpl,
      parseBlock: parseGlobalBlock,
      initialLastEventId: cursor,
      buildUrl: () => new URL(buildOpenCodeUrl('/api/event', '')),
      getHeaders: getOpenCodeAuthHeaders,
      onConnect({ lastEventId }) {
        greetings.connected(lastEventId);
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
        for (const admitted of greetings.admit(event)) {
          if (done) return;
          readEvent(admitted);
        }
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
    /** The id of the last upstream event read, or the cursor the connection started from. */
    upstreamCursor() {
      return reader ? reader.getLastEventId() : resumeCursor;
    },
    /** The newest OpenCode id the hub has seen, or undefined before the first one. */
    headEventId() {
      return latestEventId;
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
    /** Local frames committed since this hub was created: the buffer cannot replay across any of them. */
    localFrames() {
      return localFrameCount;
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
  };
}
