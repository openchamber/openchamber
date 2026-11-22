import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';
import { createGlobalMessageStreamWsBridge } from './global-ws-bridge.js';
import { createMessageStreamWsRuntime } from './runtime.js';
import { decodeOpenChamberCursor, isOpenChamberCursor } from './sse-cursor.js';
import { createReplayStore } from './replay-store.js';

// OpenCode's side of the contract (packages/server/src/event-feed.ts): every frame carries
// `id: <instance>:<sequence>`. A cursor from this instance is replayed from a bounded window; any
// other cursor, or one that has aged out, is answered with one `server.resync` frame at the head.
function createFakeOpenCode({ instance = randomUUID(), windowFrames = 1024 } = {}) {
  let sequence = 0;
  const retained = [];
  const live = new Set();
  const cursors = [];
  const idOf = (seq) => `${instance}:${seq}`;
  const frameOf = (event, id) => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
  const sequenceOf = (cursor) => {
    if (!cursor.startsWith(`${instance}:`)) return undefined;
    const digits = cursor.slice(instance.length + 1);
    return /^\d+$/.test(digits) ? Number(digits) : undefined;
  };

  const feed = {
    instance,
    cursors,
    get connections() {
      return cursors.length;
    },
    // Streams open right now: a connection that the hub closed no longer counts.
    get open() {
      return live.size;
    },
    // Publishes one event: the feed retains it, and every open stream receives it.
    publish() {
      sequence += 1;
      const frame = frameOf({ id: `evt_${sequence}`, type: 'message.updated', properties: { n: sequence } }, idOf(sequence));
      retained.push({ seq: sequence, frame });
      if (retained.length > windowFrames) retained.shift();
      for (const connection of live) connection.push(frame);
      return idOf(sequence);
    },
    // Publishes an event with no id line. OpenCode sends some outside its feed; it is not retained, so no cursor names it.
    publishUnnumbered(event) {
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      for (const connection of live) connection.push(frame);
    },
    // Ends every open stream, as a dropped connection would.
    cut() {
      for (const connection of Array.from(live)) connection.end();
      live.clear();
    },
    fetch(_url, { headers = {}, signal } = {}) {
      const connection = createConnection(signal, () => live.delete(connection));
      const cursor = headers['Last-Event-ID'] ?? '';
      cursors.push(cursor);
      if (cursor) {
        const after = sequenceOf(cursor);
        const oldest = retained[0]?.seq ?? sequence + 1;
        if (after === undefined || after < oldest - 1 || after > sequence) {
          connection.push(frameOf({ id: 'evt_resync', type: 'server.resync', data: {} }, idOf(sequence)));
        } else {
          for (const entry of retained) if (entry.seq > after) connection.push(entry.frame);
        }
      }
      live.add(connection);
      return Promise.resolve({ ok: true, status: 200, body: connection.body });
    },
  };
  return feed;
}

// A response body that yields what is pushed to it, and ends when told to or when aborted.
function createConnection(signal, onClose) {
  const encoder = new TextEncoder();
  const chunks = [];
  let ended = false;
  let wake = null;
  const notify = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  const end = () => {
    ended = true;
    onClose();
    notify();
  };
  signal?.addEventListener('abort', end, { once: true });
  const connection = {
    push(text) {
      if (ended) return;
      chunks.push(text);
      notify();
    },
    end,
    body: {
      getReader() {
        return {
          async read() {
            for (;;) {
              if (chunks.length > 0) return { value: encoder.encode(chunks.shift()), done: false };
              if (ended || signal?.aborted) return { value: undefined, done: true };
              await new Promise((resolve) => { wake = resolve; });
            }
          },
          async cancel() {
            end();
          },
        };
      },
    },
  };
  return connection;
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  ping() {
    void 0;
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

const createHub = (fetchImpl, overrides = {}) => createGlobalMessageStreamHub({
  buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
  getOpenCodeAuthHeaders: () => ({}),
  fetchImpl,
  upstreamStallTimeoutMs: 0,
  upstreamReconnectDelayMs: 0,
  ...overrides,
});
// A block-driven upstream ends its stream after the blocks: hold the reconnect back so it does not spin.
const HOLD_RECONNECT = { upstreamReconnectDelayMs: 60_000 };

const createRuntime = (hub, fetchImpl) => createMessageStreamWsRuntime({
  server: new EventEmitter(),
  globalEventHub: hub,
  wsClients: new Set(),
  uiAuthController: null,
  isRequestOriginAllowed: async () => true,
  rejectWebSocketUpgrade() {},
  buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
  getOpenCodeAuthHeaders: () => ({}),
  processForwardedEventPayload() {},
  heartbeatIntervalMs: 60_000,
  fetchImpl,
});

// A followed upstream is the OpenCode a restart replaced: it runs on its own port and has its own instance.
const FOLLOWED_URL = 'http://127.0.0.1:5000';

const connect = (runtime, lastEventId) => {
  const socket = new FakeSocket();
  const query = lastEventId ? `?lastEventId=${encodeURIComponent(lastEventId)}` : '';
  runtime.wsServer.emit('connection', socket, { url: `/api/global/event/ws${query}` });
  return socket;
};

const eventCursors = (socket) => socket.sent.filter((frame) => frame.type === 'event').map((frame) => frame.eventId);
// The OpenCode id a frame's cursor sits on. A local frame keeps the id of the upstream event it
// followed, so an upstream-only stream maps to exactly the ids OpenCode published.
const eventIds = (socket) => eventCursors(socket).map((cursor) => decodeOpenChamberCursor(cursor)?.upstream || undefined);
const readyFrames = (socket) => socket.sent.filter((frame) => frame.type === 'ready');
// A ready frame's head is the hub's latest cursor at that moment, which a race with the feed can
// move: the resume contract is checked here without it, and the head is pinned where the test fixes it.
const readyWithoutHead = (socket) => readyFrames(socket).map((frame) => Object.fromEntries(
  Object.entries(frame).filter(([key]) => key !== 'headEventId'),
));
const headOf = (frame) => decodeOpenChamberCursor(frame.headEventId)?.upstream;

describe('global hub: upstream ids and resync', () => {
  it('keys the replay buffer by the upstream id line, and passes a resync on without buffering it', async () => {
    const instance = randomUUID();
    const block = (seq, body) => `id: ${instance}:${seq}\ndata: ${JSON.stringify(body)}\n\n`;
    const blocks = [
      block(1, { id: 'evt_a', type: 'message.updated', properties: {} }),
      block(2, { id: 'evt_resync', type: 'server.resync', data: {} }),
      block(3, { id: 'evt_b', type: 'message.updated', properties: {} }),
    ];
    const encoder = new TextEncoder();
    let index = 0;
    const hub = createHub(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          async read() {
            if (index < blocks.length) return { value: encoder.encode(blocks[index++]), done: false };
            return { value: undefined, done: true };
          },
        }),
      },
    }), HOLD_RECONNECT);
    const received = [];
    hub.subscribeEvent((event) => received.push({ eventId: event.eventId, resync: event.resync }));
    try {
      hub.start();
      await expect.poll(() => received.length).toBe(3);
      expect(received).toEqual([
        { eventId: `${instance}:1`, resync: false },
        { eventId: `${instance}:2`, resync: true },
        { eventId: `${instance}:3`, resync: false },
      ]);
      // The payload's own id is not a cursor OpenCode can replay from.
      expect(hub.replayAfter('evt_a')).toBeNull();
      // The resync cleared what came before it: nothing replays across it.
      expect(hub.replayAfter(`${instance}:1`)).toBeNull();
      expect(hub.replayAfter(`${instance}:2`)).toBeNull();
      expect(hub.replayAfter(`${instance}:3`)).toEqual([]);
      expect(hub.upstreamCursor()).toBe(`${instance}:3`);
    } finally {
      hub.stop();
    }
  });

  it('leaves the upstream cursor where it was for a block that carries no id line', async () => {
    const instance = randomUUID();
    const encoder = new TextEncoder();
    const blocks = [
      `id: ${instance}:1\ndata: ${JSON.stringify({ id: 'evt_a', type: 'message.updated', properties: {} })}\n\n`,
      // OpenCode sends `server.connected` outside its feed, so it has no id line.
      `data: ${JSON.stringify({ id: 'evt_connected', type: 'server.connected', data: {} })}\n\n`,
    ];
    let index = 0;
    const hub = createHub(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          async read() {
            if (index < blocks.length) return { value: encoder.encode(blocks[index++]), done: false };
            return { value: undefined, done: true };
          },
        }),
      },
    }), HOLD_RECONNECT);
    const received = [];
    hub.subscribeEvent((event) => received.push(event.eventId));
    try {
      hub.start();
      await expect.poll(() => received.length).toBe(2);
      expect(received).toEqual([`${instance}:1`, 'evt_connected']);
      // The reconnect cursor stays an OpenCode id, so OpenCode can replay from it.
      expect(hub.upstreamCursor()).toBe(`${instance}:1`);
      // The greeting went live to subscribers, but it is not replayed: it is not part of the feed.
      expect(hub.replayAfter(`${instance}:1`)).toEqual([]);
    } finally {
      hub.stop();
    }
  });

  it('records, per client, the last upstream id it was sent', async () => {
    const feed = createFakeOpenCode();
    const hub = createHub(feed.fetch);
    const bridge = createGlobalMessageStreamWsBridge({
      globalHub: hub,
      ownsGlobalHub: true,
      wsClients: new Set(),
      processForwardedEventPayload() {},
      triggerHealthCheck() {},
      heartbeatIntervalMs: 60_000,
    });
    const socket = new FakeSocket();
    try {
      bridge.accept(socket, { requestedLastEventId: '' });
      await expect.poll(() => feed.connections).toBe(1);
      await expect.poll(() => readyFrames(socket).length).toBe(1);
      feed.publish();
      const last = feed.publish();
      await expect.poll(() => eventIds(socket).length).toBe(2);
      expect(decodeOpenChamberCursor(bridge.lastEventIdOf(socket))?.upstream).toBe(last);
    } finally {
      socket.close();
      bridge.close();
    }
  });
});

describe('WebSocket resume through the global hub', () => {
  it('delivers exactly the events missed across an upstream disconnect, once and in order', async () => {
    const feed = createFakeOpenCode();
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const browser = connect(runtime);
    try {
      await expect.poll(() => feed.connections).toBe(1);
      const ids = [feed.publish(), feed.publish(), feed.publish()];
      await expect.poll(() => eventIds(browser).length).toBe(3);

      feed.cut();
      ids.push(feed.publish(), feed.publish());
      await expect.poll(() => feed.connections).toBe(2);
      ids.push(feed.publish());

      await expect.poll(() => eventIds(browser).length).toBe(6);
      expect(eventIds(browser)).toEqual(ids);
      // The hub passed its own cursor upstream, so OpenCode replayed from it.
      expect(feed.cursors[1]).toBe(ids[2]);
      // The first connect is as it always was; the reconnect resumed and so needs no refetch.
      expect(readyWithoutHead(browser)).toEqual([
        { type: 'ready', scope: 'global' },
        { type: 'ready', scope: 'global', resumed: true },
      ]);
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('resumes a browser across an OpenChamber restart: the missed events once, and no refetch', async () => {
    const feed = createFakeOpenCode();
    const replayStore = createReplayStore();
    const hub1 = createHub(feed.fetch, { replayStore });
    const runtime1 = createRuntime(hub1);
    const before = connect(runtime1);
    await expect.poll(() => feed.connections).toBe(1);
    await expect.poll(() => readyFrames(before).length).toBe(1);
    feed.publish();
    feed.publish();
    const third = feed.publish();
    await expect.poll(() => eventIds(before).length).toBe(3);
    const cursor = eventCursors(before).at(-1);
    expect(isOpenChamberCursor(cursor)).toBe(true);
    expect(decodeOpenChamberCursor(cursor)?.upstream).toBe(third);

    // OpenChamber restarts: its hub and sockets go away. OpenCode keeps running and keeps publishing.
    before.close();
    await runtime1.close();
    hub1.stop();
    const missed = [feed.publish(), feed.publish()];

    const hub2 = createHub(feed.fetch, { replayStore });
    const runtime2 = createRuntime(hub2);
    const after = connect(runtime2, cursor);
    try {
      await expect.poll(() => readyFrames(after).length).toBe(1);
      expect(readyWithoutHead(after)).toEqual([{ type: 'ready', scope: 'global', resumed: true }]);
      await expect.poll(() => eventIds(after).length).toBe(2);
      expect(eventIds(after)).toEqual(missed);

      // Live events after the restart reach the browser once, whichever path carries them.
      const live = feed.publish();
      await expect.poll(() => eventIds(after).length).toBe(3);
      const last = feed.publish();
      await expect.poll(() => eventIds(after).length).toBe(4);
      expect(eventIds(after)).toEqual([...missed, live, last]);
      expect(readyFrames(after)).toHaveLength(1);
    } finally {
      after.close();
      hub2.stop();
      await runtime2.close();
    }
  });

  it('answers a cursor from another OpenCode instance with a refetch, and replays nothing', async () => {
    const feed = createFakeOpenCode();
    feed.publish();
    feed.publish();
    feed.publish();
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const foreign = connect(runtime, `${randomUUID()}:7`);
    try {
      await expect.poll(() => readyFrames(foreign).length).toBe(2);
      expect(readyFrames(foreign)).toEqual([
        { type: 'ready', scope: 'global', resumed: true },
        { type: 'ready', scope: 'global', replayReset: true },
      ]);
      expect(eventIds(foreign)).toEqual([]);

      // Live from then on: the refetch repairs the gap, and the stream carries the rest.
      const live = feed.publish();
      await expect.poll(() => eventIds(foreign).length).toBe(1);
      expect(eventIds(foreign)).toEqual([live]);
    } finally {
      foreign.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('tells the ready clients to refetch when OpenCode resyncs the shared stream', async () => {
    let current = createFakeOpenCode();
    const hub = createHub((url, options) => current.fetch(url, options));
    const runtime = createRuntime(hub);
    const browser = connect(runtime);
    try {
      await expect.poll(() => readyFrames(browser).length).toBe(1);
      current.publish();
      current.publish();
      await expect.poll(() => eventIds(browser).length).toBe(2);

      // OpenCode restarts: a new instance answers the old cursor with a resync.
      const restarted = createFakeOpenCode();
      const previous = current;
      current = restarted;
      previous.cut();
      // The reconnect is announced as resumed before OpenCode's answer is known; the answer then
      // turns the client's state into a refetch.
      await expect.poll(() => readyFrames(browser).length).toBe(3);
      // The resumed ready names the head the hub had before OpenCode answered; the refetch names the
      // head the resync left, which is the restarted OpenCode's own.
      const reconnectReady = readyFrames(browser).slice(1).map((frame) => ({
        ...frame,
        headEventId: headOf(frame),
      }));
      expect(reconnectReady).toEqual([
        { type: 'ready', scope: 'global', resumed: true, headEventId: `${previous.instance}:2` },
        { type: 'ready', scope: 'global', replayReset: true, headEventId: `${restarted.instance}:0` },
      ]);
      expect(restarted.cursors[0]).toMatch(/^[0-9a-f-]{36}:2$/);

      const live = restarted.publish();
      await expect.poll(() => eventIds(browser).length).toBe(3);
      expect(eventIds(browser)[2]).toBe(live);
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('keeps the older clients as they were: no cursor is a first connect, and a legacy cursor is reset', async () => {
    const feed = createFakeOpenCode();
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const first = connect(runtime);
    await expect.poll(() => readyFrames(first).length).toBe(1);
    const head = feed.publish();
    await expect.poll(() => eventIds(first).length).toBe(1);

    const legacy = connect(runtime, 'evt_from_an_older_hub');
    try {
      await expect.poll(() => readyFrames(legacy).length).toBe(1);
      expect(readyFrames(first)).toEqual([{ type: 'ready', scope: 'global' }]);
      expect(readyFrames(legacy).map((frame) => ({ ...frame, headEventId: headOf(frame) })))
        .toEqual([{ type: 'ready', scope: 'global', replayReset: true, headEventId: head }]);
      expect(eventIds(legacy)).toEqual([]);
    } finally {
      first.close();
      legacy.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('lets the resume read go once OpenCode is idle, and the client is live from then on', async () => {
    const feed = createFakeOpenCode();
    const first = feed.publish();
    const second = feed.publish();
    const third = feed.publish();
    const hub = createHub(feed.fetch, { resumeIdleTimeoutMs: 50 });
    const runtime = createRuntime(hub);
    const browser = connect(runtime, first);
    try {
      await expect.poll(() => eventIds(browser).length).toBe(2);
      expect(eventIds(browser)).toEqual([second, third]);
      // The shared stream and the resume read are open. Once the read has been silent past the bound,
      // only the shared stream is left, and the client has not been sent a second ready frame.
      await expect.poll(() => feed.open).toBe(1);
      expect(readyFrames(browser)).toEqual([{ type: 'ready', scope: 'global', resumed: true }]);

      // The first event after the hand-over reaches the client once, through the shared stream.
      const live = feed.publish();
      await expect.poll(() => eventIds(browser).length).toBe(3);
      expect(eventIds(browser)).toEqual([second, third, live]);
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('refetches, rather than goes live, when the resume read is down at the idle bound', async () => {
    const feed = createFakeOpenCode();
    const first = feed.publish();
    const second = feed.publish();
    const third = feed.publish();
    // Once switched on, the resume read's reconnects (those carrying a cursor) fail, as a dead OpenCode would.
    let failing = false;
    const hub = createHub((url, options) => (
      failing && options.headers?.['Last-Event-ID'] ? Promise.resolve(new Response('', { status: 503 })) : feed.fetch(url, options)
    ), { resumeIdleTimeoutMs: 50, upstreamReconnectDelayMs: 5 });
    const runtime = createRuntime(hub);
    const browser = connect(runtime, first);
    try {
      await expect.poll(() => eventIds(browser).length).toBe(2);
      failing = true;
      feed.cut();
      // Silence while the read is down proves nothing about what OpenCode holds: the client is refetched.
      await expect.poll(() => readyFrames(browser).some((frame) => frame.replayReset === true)).toBe(true);
      expect(readyWithoutHead(browser).slice(0, 2)).toEqual([
        { type: 'ready', scope: 'global', resumed: true },
        { type: 'ready', scope: 'global', replayReset: true },
      ]);
      // Nothing else arrives as an event: the shared stream's reconnect may add a plain ready, which is not pinned here.
      expect(eventIds(browser)).toEqual([second, third]);
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('keeps the browser cursor on OpenCode ids: events without one are sent without an id', async () => {
    const instance = randomUUID();
    const encoder = new TextEncoder();
    const blocks = [
      `id: ${instance}:1\ndata: ${JSON.stringify({ id: 'evt_a', type: 'message.updated', properties: {} })}\n\n`,
      // OpenCode sends `server.connected` outside its feed: no id line, only the payload's own id.
      `data: ${JSON.stringify({ id: 'evt_connected', type: 'server.connected', data: {} })}\n\n`,
      // An event with no id of its own is numbered by the hub, which OpenCode cannot replay from.
      `data: ${JSON.stringify({ type: 'message.updated', properties: {} })}\n\n`,
    ];
    let index = 0;
    const hub = createHub(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          async read() {
            if (index < blocks.length) return { value: encoder.encode(blocks[index++]), done: false };
            return { value: undefined, done: true };
          },
        }),
      },
    }), HOLD_RECONNECT);
    const runtime = createRuntime(hub);
    const browser = connect(runtime);
    try {
      await expect.poll(() => eventIds(browser).length).toBe(3);
      // The greeting has no cursor; the id-less event carries one and keeps its upstream anchor.
      expect(eventIds(browser)).toEqual([`${instance}:1`, undefined, `${instance}:1`]);
      const localCursor = eventCursors(browser)[2];
      expect(decodeOpenChamberCursor(localCursor)).toMatchObject({ stream: 'global', upstream: `${instance}:1` });
      // Local frames are buffered now, so a reconnect from the OpenCode cursor replays the local one.
      expect(hub.replayAfter(`${instance}:1`).map((entry) => entry.cursor)).toContain(localCursor);
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('replays a local frame once, then only what came after it', async () => {
    const feed = createFakeOpenCode();
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const browser = connect(runtime);
    try {
      await expect.poll(() => feed.connections).toBe(1);
      feed.publish();
      const cursor = feed.publish();
      // An event with no id is applied live, after the last OpenCode id the browser holds.
      feed.publishUnnumbered({ id: 'evt_unnumbered', type: 'message.updated', properties: {} });
      await expect.poll(() => eventIds(browser).length).toBe(3);
      expect(eventIds(browser)).toEqual([expect.any(String), cursor, cursor]);
      const localCursor = eventCursors(browser)[2];
      browser.close();

      // While the browser is away, OpenCode produces one more event, which the hub buffers.
      const missed = feed.publish();
      await expect.poll(() => hub.headEventId()).toBe(missed);

      // The browser's cursor already names the local frame, so it is not sent again. Only the missed
      // upstream frame follows.
      const resumed = connect(runtime, localCursor);
      try {
        await expect.poll(() => eventIds(resumed).length).toBe(1);
        expect(eventIds(resumed)).toEqual([missed]);
        expect(readyWithoutHead(resumed)).toEqual([{ type: 'ready', scope: 'global', resumed: true }]);
      } finally {
        resumed.close();
      }

      // A cursor before the local frame receives it, then the buffer tail, and nothing it had applied.
      const later = feed.publish();
      const past = connect(runtime, cursor);
      try {
        await expect.poll(() => eventIds(past).length).toBe(3);
        expect(eventIds(past)).toEqual([cursor, missed, later]);
        expect(readyWithoutHead(past)).toEqual([{ type: 'ready', scope: 'global', resumed: true }]);
      } finally {
        past.close();
      }
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('hands an idle browser the hub\'s head, so its reconnect resumes with no refetch', async () => {
    const feed = createFakeOpenCode();
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    // Another browser keeps the shared stream read and sees the feed; this one stays idle.
    const busy = connect(runtime);
    try {
      await expect.poll(() => readyFrames(busy).length).toBe(1);
      const head = feed.publish();
      await expect.poll(() => eventIds(busy).length).toBe(1);

      // A browser that connects now has no cursor, so the ready frame hands it the head as one.
      const idle = connect(runtime);
      try {
        await expect.poll(() => readyFrames(idle).length).toBe(1);
        const headCursor = readyFrames(idle)[0].headEventId;
        expect(decodeOpenChamberCursor(headCursor)).toMatchObject({ stream: 'global', upstream: head });
        idle.close();

        // Reconnecting from that cursor resumes: nothing was missed, so there is no refetch.
        const back = connect(runtime, headCursor);
        await expect.poll(() => readyFrames(back).length).toBe(1);
        expect(readyFrames(back)).toEqual([{ type: 'ready', scope: 'global', resumed: true, headEventId: headCursor }]);
        expect(eventIds(back)).toEqual([]);

        // Live from then on, the browser is sent what OpenCode publishes, once.
        const live = feed.publish();
        await expect.poll(() => eventIds(back).length).toBe(1);
        expect(eventIds(back)).toEqual([live]);
      } finally {
        idle.close();
      }
    } finally {
      busy.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('replays a followed upstream\'s events under their own ids after a reconnect, once and in order', async () => {
    const host = createFakeOpenCode();
    const followed = createFakeOpenCode();
    const fetchImpl = (url, options) => (url.startsWith(FOLLOWED_URL) ? followed.fetch(url, options) : host.fetch(url, options));
    const hub = createHub(fetchImpl);
    const runtime = createRuntime(hub, fetchImpl);
    const stopFollowing = runtime.followUpstream({ url: FOLLOWED_URL, headers: {} });
    const browser = connect(runtime);
    try {
      await expect.poll(() => host.connections).toBe(1);
      await expect.poll(() => followed.connections).toBe(1);
      await expect.poll(() => readyFrames(browser).length).toBe(1);
      const first = followed.publish();
      const second = followed.publish();
      await expect.poll(() => eventIds(browser).length).toBe(2);
      expect(eventIds(browser)).toEqual([first, second]);
      browser.close();

      // While the browser is away, the followed OpenCode produces one more event.
      const missed = followed.publish();
      await expect.poll(() => hub.headEventId()).toBe(missed);

      const back = connect(runtime, second);
      try {
        await expect.poll(() => readyFrames(back).length).toBe(1);
        expect(readyWithoutHead(back)).toEqual([{ type: 'ready', scope: 'global', resumed: true }]);
        await expect.poll(() => eventIds(back).length).toBe(1);
        // Only what came after the cursor: the two it already applied are not sent again.
        expect(eventIds(back)).toEqual([missed]);
        const live = followed.publish();
        await expect.poll(() => eventIds(back).length).toBe(2);
        expect(eventIds(back)).toEqual([missed, live]);
      } finally {
        back.close();
      }
    } finally {
      stopFollowing();
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('replays an isolated space\'s events under their own ids after a reconnect, once', async () => {
    const feed = createFakeOpenCode();
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const browser = connect(runtime);
    const spaceInstance = randomUUID();
    const inject = (sequence) => {
      const eventId = `${spaceInstance}:${sequence}`;
      hub.injectEvent({
        payload: { id: `space_evt_${sequence}`, type: 'session.execution.started', data: { sessionID: 's1' } },
        directory: '/spaces/a1b2c3d4e5f6/repo',
        spaceId: 'a1b2c3d4e5f6',
        eventId,
      });
      return eventId;
    };
    try {
      await expect.poll(() => feed.connections).toBe(1);
      await expect.poll(() => readyFrames(browser).length).toBe(1);
      const first = inject(1);
      const second = inject(2);
      await expect.poll(() => eventIds(browser).length).toBe(2);
      expect(eventIds(browser)).toEqual([first, second]);
      browser.close();

      const missed = inject(3);
      const back = connect(runtime, second);
      try {
        await expect.poll(() => readyFrames(back).length).toBe(1);
        expect(readyWithoutHead(back)).toEqual([{ type: 'ready', scope: 'global', resumed: true }]);
        await expect.poll(() => eventIds(back).length).toBe(1);
        expect(eventIds(back)).toEqual([missed]);
      } finally {
        back.close();
      }
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('replays the local frames a disconnected browser missed, rather than refetching', async () => {
    const feed = createFakeOpenCode();
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const browser = connect(runtime);
    try {
      await expect.poll(() => feed.connections).toBe(1);
      const before = feed.publish();
      await expect.poll(() => eventIds(browser).length).toBe(1);
      const beforeCursor = eventCursors(browser).at(-1);
      // A frame with no OpenCode id reaches the browser live and is durable.
      feed.publishUnnumbered({ type: 'message.updated', properties: { local: true } });
      await expect.poll(() => eventIds(browser).length).toBe(2);
      const localCursor = eventCursors(browser).at(-1);
      browser.close();

      const head = feed.publish();
      await expect.poll(() => hub.headEventId()).toBe(head);
      const back = connect(runtime, beforeCursor);
      try {
        await expect.poll(() => readyFrames(back).length).toBe(1);
        expect(readyWithoutHead(back)).toEqual([{ type: 'ready', scope: 'global', resumed: true }]);
        await expect.poll(() => eventCursors(back).length).toBe(2);
        // The local frame is replayed under the same cursor, then the upstream event after it.
        expect(eventCursors(back)).toEqual([localCursor, expect.any(String)]);
        expect(eventIds(back)).toEqual([before, head]);
      } finally {
        back.close();
      }

      // A browser holding the local frame's cursor gets only what came after it.
      feed.publishUnnumbered({ type: 'message.updated', properties: { local: true } });
      await expect.poll(() => hub.localFrames()).toBe(2);
      const atHead = connect(runtime, localCursor);
      try {
        await expect.poll(() => eventIds(atHead).length).toBe(2);
        expect(eventIds(atHead)).toEqual([head, head]);
        expect(readyWithoutHead(atHead)).toEqual([{ type: 'ready', scope: 'global', resumed: true }]);
      } finally {
        atHead.close();
      }
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('does not resume upstream from a cursor the buffer lacks once a local frame has been committed', async () => {
    const feed = createFakeOpenCode();
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const browser = connect(runtime);
    try {
      await expect.poll(() => feed.connections).toBe(1);
      await expect.poll(() => readyFrames(browser).length).toBe(1);
      feed.publishUnnumbered({ type: 'message.updated', properties: {} });
      await expect.poll(() => hub.localFrames()).toBe(1);

      // OpenCode could honour this cursor, but the local frame after it cannot be replayed: reset, no resume.
      const back = connect(runtime, `${feed.instance}:0`);
      try {
        await expect.poll(() => readyFrames(back).length).toBe(1);
        expect(readyFrames(back)).toEqual([{ type: 'ready', scope: 'global', replayReset: true }]);
        // Only the shared stream is open upstream: no resume read was opened.
        expect(feed.connections).toBe(1);
      } finally {
        back.close();
      }
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('refetches a resume read that a local frame overtakes, rather than going live past it', async () => {
    const feed = createFakeOpenCode();
    const first = feed.publish();
    feed.publish();
    const hub = createHub(feed.fetch, { resumeIdleTimeoutMs: 5_000 });
    const runtime = createRuntime(hub);
    const back = connect(runtime, first);
    try {
      // The resume read is the second connection the feed sees.
      await expect.poll(() => feed.connections).toBe(2);
      hub.injectEvent({ payload: { type: 'session.updated', data: {} } });
      await expect.poll(() => hub.localFrames()).toBe(1);
      feed.publish();
      await expect.poll(() => readyFrames(back).some((frame) => frame.replayReset === true)).toBe(true);
    } finally {
      back.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('gives a browser no head until OpenCode has sent an event: its reconnect still refetches', async () => {
    const feed = createFakeOpenCode();
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const first = connect(runtime);
    try {
      await expect.poll(() => feed.connections).toBe(1);
      await expect.poll(() => readyFrames(first).length).toBe(1);
      // Only an event with no OpenCode id has arrived: the hub numbers it, but it is no head.
      feed.publishUnnumbered({ type: 'message.updated', properties: {} });
      await expect.poll(() => eventIds(first).length).toBe(1);
      expect(hub.headEventId()).toBeUndefined();
      first.close();

      const second = connect(runtime);
      try {
        await expect.poll(() => readyFrames(second).length).toBe(1);
        // No head and no resumed: the browser has no cursor, so this reconnect refetches, as before.
        expect(readyFrames(second)).toEqual([{ type: 'ready', scope: 'global' }]);
      } finally {
        second.close();
      }
    } finally {
      first.close();
      hub.stop();
      await runtime.close();
    }
  });
});

describe('durable OpenChamber cursors', () => {
  it('replays the local frames missed across an OpenChamber restart, then the upstream tail', async () => {
    const feed = createFakeOpenCode();
    const replayStore = createReplayStore();
    const hub1 = createHub(feed.fetch, { replayStore });
    const runtime1 = createRuntime(hub1);
    const before = connect(runtime1);
    await expect.poll(() => feed.connections).toBe(1);
    const first = feed.publish();
    await expect.poll(() => eventIds(before).length).toBe(1);
    const beforeLocal = eventCursors(before).at(-1);
    feed.publishUnnumbered({ type: 'message.updated', properties: { local: true } });
    await expect.poll(() => eventIds(before).length).toBe(2);
    before.close();
    await runtime1.close();
    hub1.stop();

    // OpenChamber is down; OpenCode keeps publishing.
    const missed = feed.publish();

    const hub2 = createHub(feed.fetch, { replayStore });
    const runtime2 = createRuntime(hub2);
    const after = connect(runtime2, beforeLocal);
    try {
      await expect.poll(() => readyFrames(after).length).toBe(1);
      expect(readyWithoutHead(after)).toEqual([{ type: 'ready', scope: 'global', resumed: true }]);
      await expect.poll(() => eventIds(after).length).toBe(2);
      // The local frame the browser missed comes first, then the upstream event after it.
      expect(eventIds(after)).toEqual([first, missed]);
      expect(decodeOpenChamberCursor(eventCursors(after)[0])).toMatchObject({ stream: 'global', upstream: first });
      expect(decodeOpenChamberCursor(eventCursors(after)[1])?.upstream).toBe(missed);
    } finally {
      after.close();
      hub2.stop();
      await runtime2.close();
    }
  });

  it('resets a cursor whose local frames were dropped by retention', async () => {
    const feed = createFakeOpenCode();
    const replayStore = createReplayStore();
    const hub1 = createHub(feed.fetch, { replayStore, localReplayLimit: 1 });
    const runtime1 = createRuntime(hub1);
    const browser = connect(runtime1);
    await expect.poll(() => feed.connections).toBe(1);
    feed.publish();
    await expect.poll(() => eventIds(browser).length).toBe(1);
    const beforeLocal = eventCursors(browser).at(-1);
    feed.publishUnnumbered({ type: 'message.updated', properties: { local: true } });
    await expect.poll(() => eventIds(browser).length).toBe(2);
    feed.publishUnnumbered({ type: 'message.updated', properties: { local: true } });
    // The limit of one drops the older local frame.
    await expect.poll(() => hub1.localFrames()).toBe(1);
    browser.close();
    await runtime1.close();
    hub1.stop();

    const hub2 = createHub(feed.fetch, { replayStore, localReplayLimit: 1 });
    const runtime2 = createRuntime(hub2);
    const after = connect(runtime2, beforeLocal);
    try {
      await expect.poll(() => readyFrames(after).length).toBe(1);
      expect(readyFrames(after)[0]).toMatchObject({ type: 'ready', replayReset: true });
      expect(eventIds(after)).toEqual([]);
    } finally {
      after.close();
      hub2.stop();
      await runtime2.close();
    }
  });

  it('resets invalid, wrong-stream and out-of-range versioned cursors', async () => {
    const feed = createFakeOpenCode();
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const sockets = [
      connect(runtime, 'occ1.directory.1.'),
      connect(runtime, 'occ1.global.99.'),
      connect(runtime, 'occ1.global.not-a-number.'),
      connect(runtime, 'occ2.global.1.'),
    ];
    try {
      for (const socket of sockets) {
        await expect.poll(() => readyFrames(socket).length).toBe(1);
        expect(readyFrames(socket)[0].replayReset).toBe(true);
        expect(eventIds(socket)).toEqual([]);
        socket.close();
      }
    } finally {
      hub.stop();
      await runtime.close();
    }
  });

  it('resets a versioned cursor after OpenCode resyncs the restarted stream', async () => {
    const feed = createFakeOpenCode();
    const replayStore = createReplayStore();
    const hub1 = createHub(feed.fetch, { replayStore });
    const runtime1 = createRuntime(hub1);
    const browser = connect(runtime1);
    await expect.poll(() => feed.connections).toBe(1);
    feed.publish();
    feed.publish();
    await expect.poll(() => eventIds(browser).length).toBe(2);
    const cursor = eventCursors(browser).at(-1);
    browser.close();
    await runtime1.close();
    hub1.stop();

    // OpenCode restarts: a new instance answers the old cursor with a resync.
    const restarted = createFakeOpenCode();
    const hub2 = createHub(restarted.fetch, { replayStore });
    const runtime2 = createRuntime(hub2);
    const after = connect(runtime2, cursor);
    try {
      await expect.poll(() => readyFrames(after).some((frame) => frame.replayReset === true)).toBe(true);
      expect(eventIds(after)).toEqual([]);
    } finally {
      after.close();
      hub2.stop();
      await runtime2.close();
    }
  });

  it('persists a local frame before it is sent to the browser', async () => {
    const order = [];
    const feed = createFakeOpenCode();
    const store = createReplayStore();
    const spyingStore = {
      load: () => store.load(),
      state: () => store.state(),
      appendTrim: (position) => store.appendTrim(position),
      appendReset: (head) => store.appendReset(head),
      appendHead: (head) => store.appendHead(head),
      appendLocal: (entry) => { order.push('persist'); return store.appendLocal(entry); },
    };
    const hub = createHub(feed.fetch, { replayStore: spyingStore });
    const runtime = createRuntime(hub);
    const socket = connect(runtime);
    const send = socket.send.bind(socket);
    socket.send = (payload) => {
      if (JSON.parse(payload).type === 'event') order.push('send');
      return send(payload);
    };
    try {
      await expect.poll(() => readyFrames(socket).length).toBe(1);
      feed.publishUnnumbered({ type: 'message.updated', properties: { local: true } });
      await expect.poll(() => order.includes('send')).toBe(true);
      expect(order.indexOf('persist')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('persist')).toBeLessThan(order.indexOf('send'));
    } finally {
      socket.close();
      hub.stop();
      await runtime.close();
    }
  });
});
