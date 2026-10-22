import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';
import { createGlobalMessageStreamWsBridge } from './global-ws-bridge.js';
import { createMessageStreamWsRuntime } from './runtime.js';
import { resolveEventStreamTimeouts } from './timeouts.js';
import { DEFAULT_UPSTREAM_RECONNECT_DELAY_MS } from './upstream-reader.js';

// OpenCode's side of the contract (packages/server/src/event-feed.ts): every frame carries
// `id: <instance>:<sequence>`. A cursor from this instance is replayed from a bounded window; any
// other cursor, or one that has aged out, is answered with one `server.resync` frame at the head.
// With `greet`, each connection opens as OpenCode's does (packages/server/src/handlers/event.ts): a
// `server.connected` greeting without an id line, ahead of the replay or the resync. With
// `heartbeatMs`, a heartbeat comment follows at that cadence.
function createFakeOpenCode({ instance = randomUUID(), windowFrames = 1024, greet = false, heartbeatMs = 0 } = {}) {
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
      let heartbeat = null;
      const connection = createConnection(signal, () => {
        live.delete(connection);
        clearInterval(heartbeat);
      });
      const cursor = headers['Last-Event-ID'] ?? '';
      cursors.push(cursor);
      if (greet) {
        connection.push(`data: ${JSON.stringify({ id: `evt_connected_${cursors.length}`, type: 'server.connected', data: {} })}\n\n`);
      }
      if (cursor) {
        const after = sequenceOf(cursor);
        const oldest = retained[0]?.seq ?? sequence + 1;
        if (after === undefined || after < oldest - 1 || after > sequence) {
          connection.push(frameOf({ id: 'evt_resync', type: 'server.resync', data: {} }, idOf(sequence)));
        } else {
          for (const entry of retained) if (entry.seq > after) connection.push(entry.frame);
        }
      }
      if (heartbeatMs > 0) {
        connection.push(': heartbeat\n\n');
        heartbeat = setInterval(() => connection.push(': heartbeat\n\n'), heartbeatMs);
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

const eventIds = (socket) => socket.sent.filter((frame) => frame.type === 'event').map((frame) => frame.eventId);
const readyFrames = (socket) => socket.sent.filter((frame) => frame.type === 'ready');
const greetings = (socket) => socket.sent.filter((frame) => frame.type === 'event' && frame.payload?.type === 'server.connected');
// A ready frame's head is the hub's latest id at that moment, which a race with the feed can move: the
// resume contract is checked here without it, and the head is pinned where the test fixes it.
const readyWithoutHead = (socket) => readyFrames(socket).map((frame) => Object.fromEntries(
  Object.entries(frame).filter(([key]) => key !== 'headEventId'),
));

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
      expect(bridge.lastEventIdOf(socket)).toBe(last);
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
    const hub1 = createHub(feed.fetch);
    const runtime1 = createRuntime(hub1);
    const before = connect(runtime1);
    await expect.poll(() => feed.connections).toBe(1);
    await expect.poll(() => readyFrames(before).length).toBe(1);
    feed.publish();
    feed.publish();
    const third = feed.publish();
    await expect.poll(() => eventIds(before).length).toBe(3);
    const cursor = eventIds(before).at(-1);
    expect(cursor).toBe(third);

    // OpenChamber restarts: its hub and sockets go away. OpenCode keeps running and keeps publishing.
    before.close();
    await runtime1.close();
    hub1.stop();
    const missed = [feed.publish(), feed.publish()];

    const hub2 = createHub(feed.fetch);
    const runtime2 = createRuntime(hub2);
    const after = connect(runtime2, cursor);
    try {
      await expect.poll(() => readyFrames(after).length).toBe(1);
      expect(readyFrames(after)[0]).toEqual({ type: 'ready', scope: 'global', resumed: true });
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
      expect(readyFrames(browser).slice(1)).toEqual([
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
      expect(readyFrames(legacy)).toEqual([{ type: 'ready', scope: 'global', replayReset: true, headEventId: head }]);
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
      expect(readyFrames(browser).slice(0, 2)).toEqual([
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
      expect(eventIds(browser)).toEqual([`${instance}:1`, undefined, undefined]);
      // The last id the browser holds is the last OpenCode id, so a reconnect resumes from that one.
      expect(eventIds(browser).filter(Boolean).at(-1)).toBe(`${instance}:1`);
      // The hub-numbered event is a local frame: the browser applied it live, and nothing can replay it. A
      // reconnect from the OpenCode cursor before it must refetch rather than resume past it. The greeting
      // itself is never replayed.
      expect(hub.replayAfter(`${instance}:1`)).toBeNull();
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('never sends a resuming browser a frame it already applied: the buffer holds OpenCode frames only', async () => {
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
      expect(eventIds(browser)).toEqual([expect.any(String), cursor, undefined]);
      browser.close();

      // While the browser is away, OpenCode produces one more event, which the hub buffers.
      const missed = feed.publish();
      await expect.poll(() => hub.headEventId()).toBe(missed);

      // It resumes from its cursor. The unnumbered frame lies after that cursor and cannot be replayed, so the
      // browser is reset to refetch. Nothing it already applied is sent again.
      const resumed = connect(runtime, cursor);
      try {
        await expect.poll(() => readyFrames(resumed).length).toBe(1);
        expect(readyFrames(resumed)).toEqual([{ type: 'ready', scope: 'global', replayReset: true, headEventId: missed }]);
        expect(eventIds(resumed)).toEqual([]);
      } finally {
        resumed.close();
      }

      // A browser whose cursor is past the unnumbered frame is replayed only what came after it.
      const later = feed.publish();
      const past = connect(runtime, missed);
      try {
        await expect.poll(() => eventIds(past).length).toBe(1);
        expect(eventIds(past)).toEqual([later]);
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
        expect(readyFrames(idle)).toEqual([{ type: 'ready', scope: 'global', headEventId: head }]);
        idle.close();

        // Reconnecting from that head resumes: nothing was missed, so there is no refetch.
        const back = connect(runtime, head);
        await expect.poll(() => readyFrames(back).length).toBe(1);
        expect(readyFrames(back)).toEqual([{ type: 'ready', scope: 'global', resumed: true, headEventId: head }]);
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

  it('resets a browser disconnected across a local frame, rather than replaying past it', async () => {
    const feed = createFakeOpenCode();
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const browser = connect(runtime);
    try {
      await expect.poll(() => feed.connections).toBe(1);
      const before = feed.publish();
      await expect.poll(() => eventIds(browser).length).toBe(1);
      // A frame with no OpenCode id reaches the browser live, and no reconnect can replay it.
      feed.publishUnnumbered({ type: 'message.updated', properties: { local: true } });
      await expect.poll(() => eventIds(browser).length).toBe(2);
      browser.close();

      const head = feed.publish();
      await expect.poll(() => hub.headEventId()).toBe(head);
      const back = connect(runtime, before);
      try {
        await expect.poll(() => readyFrames(back).length).toBe(1);
        expect(readyFrames(back)).toEqual([{ type: 'ready', scope: 'global', replayReset: true, headEventId: head }]);
        expect(eventIds(back)).toEqual([]);
      } finally {
        back.close();
      }

      // The same for a browser holding the head, when the local frame came after it.
      feed.publishUnnumbered({ type: 'message.updated', properties: { local: true } });
      await expect.poll(() => hub.localFrames()).toBe(2);
      const atHead = connect(runtime, head);
      try {
        await expect.poll(() => readyFrames(atHead).length).toBe(1);
        expect(readyFrames(atHead)).toEqual([{ type: 'ready', scope: 'global', replayReset: true, headEventId: head }]);
        expect(eventIds(atHead)).toEqual([]);
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

describe('a quiet OpenCode stream', () => {
  // OpenCode 2.x writes a heartbeat comment every 15 s while it has no event to send
  // (packages/server/src/handlers/event.ts, `Stream.tick("15 seconds")`).
  const OPENCODE_HEARTBEAT_MS = 15_000;
  // The windows the server runs with when no environment variable sets them.
  const windows = resolveEventStreamTimeouts({}, () => undefined);

  it.each([
    ['at most one session busy', windows.stallTimeoutMs],
    ['several sessions busy', windows.concurrentStallTimeoutMs],
  ])('stays on one upstream connection with %s, so a browser gets one ready frame and one greeting', async (_busy, stallTimeoutMs) => {
    vi.useFakeTimers();
    const feed = createFakeOpenCode({ greet: true, heartbeatMs: OPENCODE_HEARTBEAT_MS });
    const hub = createHub(feed.fetch, { upstreamStallTimeoutMs: stallTimeoutMs, upstreamReconnectDelayMs: DEFAULT_UPSTREAM_RECONNECT_DELAY_MS });
    const runtime = createRuntime(hub);
    const browser = connect(runtime);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const head = feed.publish();
      // Three quiet minutes: OpenCode sends nothing but its heartbeat.
      await vi.advanceTimersByTimeAsync(3 * 60_000);

      // The premise: the browser was live and was sent the event.
      expect(eventIds(browser).filter(Boolean)).toEqual([head]);
      // A stall window shorter than the heartbeat reconnected this healthy stream at every window,
      // and each reconnect reached the browser as a ready frame.
      expect(feed.connections).toBe(1);
      expect(readyFrames(browser)).toHaveLength(1);
      expect(greetings(browser)).toHaveLength(1);
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
      vi.useRealTimers();
    }
  });
});

// What makes the UI re-read what it shows (sync/sync-context.tsx): OpenCode's greeting, and a ready
// frame that did not resume the stream or that reset its replay. Both are ignored while the UI boots.
const rereadSignals = (socket) => socket.sent.flatMap((frame) => {
  if (frame.type === 'event') return frame.payload?.type === 'server.connected' ? ['greeting'] : [];
  if (frame.type !== 'ready') return [];
  if (frame.replayReset === true) return ['replayReset'];
  return frame.resumed === true ? [] : ['ready'];
});

describe('a reconnect that resumed from a cursor', () => {
  it('reaches the browser as a resumed ready alone when OpenCode honours the cursor, with or without events to replay', async () => {
    const feed = createFakeOpenCode({ greet: true });
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const browser = connect(runtime);
    try {
      // The first connection carries no cursor, so its greeting is the one a client starts from.
      await expect.poll(() => greetings(browser).length).toBe(1);
      const first = feed.publish();
      await expect.poll(() => eventIds(browser).filter(Boolean)).toEqual([first]);
      const before = rereadSignals(browser).length;

      // OpenCode has nothing after the cursor; the next event is live.
      feed.cut();
      await expect.poll(() => readyFrames(browser).length).toBe(2);
      const live = feed.publish();
      await expect.poll(() => eventIds(browser).filter(Boolean)).toEqual([first, live]);

      // OpenCode replays what the stream missed.
      feed.cut();
      const missed = feed.publish();
      await expect.poll(() => eventIds(browser).filter(Boolean)).toEqual([first, live, missed]);

      expect(feed.cursors).toEqual(['', first, live]);
      expect(readyWithoutHead(browser).slice(1)).toEqual([
        { type: 'ready', scope: 'global', resumed: true },
        { type: 'ready', scope: 'global', resumed: true },
      ]);
      expect(rereadSignals(browser).slice(before)).toEqual([]);
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('still makes the browser re-read when the cursor aged out of OpenCode\'s window', async () => {
    const feed = createFakeOpenCode({ greet: true, windowFrames: 2 });
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const browser = connect(runtime);
    try {
      await expect.poll(() => greetings(browser).length).toBe(1);
      const first = feed.publish();
      await expect.poll(() => eventIds(browser).filter(Boolean)).toEqual([first]);
      const before = rereadSignals(browser).length;

      // While the stream is down, OpenCode moves past its two-frame window.
      feed.cut();
      feed.publish();
      feed.publish();
      feed.publish();
      await expect.poll(() => readyFrames(browser).some((frame) => frame.replayReset === true)).toBe(true);

      expect(feed.cursors[1]).toBe(first);
      expect(rereadSignals(browser).slice(before)).toEqual(['greeting', 'replayReset']);
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('still makes the browser re-read when OpenCode restarted', async () => {
    let current = createFakeOpenCode({ greet: true });
    const hub = createHub((url, options) => current.fetch(url, options));
    const runtime = createRuntime(hub);
    const browser = connect(runtime);
    try {
      await expect.poll(() => greetings(browser).length).toBe(1);
      const first = current.publish();
      await expect.poll(() => eventIds(browser).filter(Boolean)).toEqual([first]);
      const before = rereadSignals(browser).length;

      const previous = current;
      current = createFakeOpenCode({ greet: true });
      previous.cut();
      await expect.poll(() => readyFrames(browser).some((frame) => frame.replayReset === true)).toBe(true);

      // The hub asked the new instance for the old cursor, which it cannot know.
      expect(current.cursors[0]).toBe(first);
      expect(rereadSignals(browser).slice(before)).toEqual(['greeting', 'replayReset']);
      const live = current.publish();
      await expect.poll(() => eventIds(browser).filter(Boolean)).toEqual([first, live]);
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  // A cursor the new hub does not hold after an OpenChamber restart is resumed on a read of its own.
  const resumeAfterOpenChamberRestart = async ({ openCodeRestarts }) => {
    let current = createFakeOpenCode({ greet: true });
    const fetchImpl = (url, options) => current.fetch(url, options);
    const hub1 = createHub(fetchImpl);
    const runtime1 = createRuntime(hub1);
    const earlier = connect(runtime1);
    await expect.poll(() => greetings(earlier).length).toBe(1);
    current.publish();
    const cursor = current.publish();
    await expect.poll(() => eventIds(earlier).filter(Boolean).at(-1)).toBe(cursor);
    earlier.close();
    await runtime1.close();
    hub1.stop();

    if (openCodeRestarts) current = createFakeOpenCode({ greet: true });
    const missed = current.publish();
    const hub2 = createHub(fetchImpl);
    const runtime2 = createRuntime(hub2);
    const browser = connect(runtime2, cursor);
    return {
      browser,
      missed,
      async close() {
        browser.close();
        hub2.stop();
        await runtime2.close();
      },
    };
  };

  it('resumes a browser on its own read with no greeting when OpenCode honours its cursor', async () => {
    const { browser, missed, close } = await resumeAfterOpenChamberRestart({ openCodeRestarts: false });
    try {
      await expect.poll(() => eventIds(browser).filter(Boolean)).toEqual([missed]);
      expect(readyWithoutHead(browser)).toEqual([{ type: 'ready', scope: 'global', resumed: true }]);
      expect(rereadSignals(browser)).toEqual([]);
    } finally {
      await close();
    }
  });

  it('makes a browser resuming on its own read re-read when OpenCode restarted too', async () => {
    const { browser, close } = await resumeAfterOpenChamberRestart({ openCodeRestarts: true });
    try {
      await expect.poll(() => readyFrames(browser).some((frame) => frame.replayReset === true)).toBe(true);
      expect(rereadSignals(browser)).toEqual(['greeting', 'replayReset']);
    } finally {
      await close();
    }
  });
});
