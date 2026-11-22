import { describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';

// OpenCode's cursor form, `<instance>:<sequence>`: the only ids the replay buffer holds.
const INSTANCE = '6b1f3c2e-8d4a-4f7b-9c3e-2a5d7e9f1b40';
const ocId = (sequence) => `${INSTANCE}:${sequence}`;

it('bounds a contiguous replay suffix by UTF-8 bytes and event count', async () => {
  const blocks = Array.from({ length: 8 }, (_, i) => `id: ${ocId(i)}\ndata: ${JSON.stringify({ id: `e${i}`, type: 'message', properties: { text: '界'.repeat(40) } })}\n\n`);
  const received = [];
  const hub = createGlobalMessageStreamHub({
    buildOpenCodeUrl: path => `http://127.0.0.1:4096${path}`,
    getOpenCodeAuthHeaders: () => ({}), replayLimit: 3, replayByteLimit: 600,
    upstreamReconnectDelayMs: 60_000,
    fetchImpl: async () => createSseResponse({ blocks }),
  });
  hub.subscribeEvent(event => received.push(event.eventId));
  try {
    hub.start();
    await waitForAssertion(() => expect(received).toHaveLength(8));
    expect(hub.replayAfter(ocId(0))).toBeNull();
    expect(hub.replayAfter(ocId(5))).toBeNull();
    const tail = hub.replayAfter(ocId(6));
    expect(tail.map(entry => entry.eventId)).toEqual([ocId(7)]);
    expect(Buffer.byteLength(tail[0].serializedFrame) * 2).toBeLessThanOrEqual(600);
    expect(Buffer.byteLength(tail[0].serializedFrame) * 3).toBeGreaterThan(600);
  } finally { hub.stop(); }
});

function createSseResponse({ blocks = [] } = {}) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index < blocks.length) {
              return { value: encoder.encode(blocks[index++]), done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    },
  };
}

async function waitForAssertion(assertion) {
  const deadline = Date.now() + 1000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}

const deltaBlock = (id, text, ordinal = 1) => `id: ${id}\ndata: ${JSON.stringify({
  id, type: 'session.text.delta',
  data: { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal, delta: text },
})}\n\n`;

const createDeltaHub = ({ blocks, deltaCoalesceWindowMs }) => createGlobalMessageStreamHub({
  buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
  getOpenCodeAuthHeaders: () => ({}),
  upstreamReconnectDelayMs: 60_000,
  deltaCoalesceWindowMs,
  fetchImpl: async () => createSseResponse({ blocks }),
});

// What a browser holds after applying frames in order: text per stream
// ordinal, and the text each stream had when a snapshot barrier passed.
const applyFrames = (frames) => {
  const text = {};
  const barriers = [];
  for (const frame of frames) {
    const payload = frame.payload;
    if (payload.type === 'session.text.delta') {
      text[payload.data.ordinal] = (text[payload.data.ordinal] ?? '') + payload.data.delta;
    } else {
      barriers.push({ id: payload.id, seen: { ...text } });
    }
  }
  return { text, barriers };
};

describe('delta coalescing in the global hub', () => {
  it('delivers the same text in far fewer frames', async () => {
    const words = Array.from({ length: 120 }, (_, index) => `w${index} `);
    const hub = createDeltaHub({ blocks: words.map((word, index) => deltaBlock(`e${String(index).padStart(4, '0')}`, word)) });
    const received = [];
    hub.subscribeEvent((event) => received.push(event));
    try {
      hub.start();
      await waitForAssertion(() => expect(applyFrames(received).text[1]).toBe(words.join('')));
      expect(received.length).toBeLessThanOrEqual(3);
      expect(received.at(-1).eventId).toBe('e0119');
    } finally { hub.stop(); }
  });

  it('resumes from any cursor without losing or repeating text', async () => {
    const blocks = [];
    let id = 0;
    const nextId = () => ocId(id++);
    for (let index = 0; index < 40; index += 1) blocks.push(deltaBlock(nextId(), `a${index}.`, index % 3 === 0 ? 2 : 1));
    const snapshotId = nextId();
    blocks.push(`id: ${snapshotId}\ndata: ${JSON.stringify({ id: snapshotId, type: 'session.text.ended', data: { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 1, text: '' } })}\n\n`);
    for (let index = 0; index < 40; index += 1) blocks.push(deltaBlock(nextId(), `b${index}.`));

    const hub = createDeltaHub({ blocks });
    const received = [];
    hub.subscribeEvent((event) => received.push(event));
    try {
      hub.start();
      const expectedA = [...Array(40).keys()].filter((index) => index % 3 !== 0).map((index) => `a${index}.`).join('')
        + [...Array(40).keys()].map((index) => `b${index}.`).join('');
      await waitForAssertion(() => expect(applyFrames(received).text[1]).toBe(expectedA));
      expect(received.length).toBeLessThan(blocks.length / 4);

      const complete = applyFrames(received);
      // The snapshot barrier saw exactly the text that arrived before it.
      expect(complete.barriers).toHaveLength(1);
      expect(complete.barriers[0].seen[1]).toBe([...Array(40).keys()].filter((index) => index % 3 !== 0).map((index) => `a${index}.`).join(''));

      // A socket that drops after any frame reconnects with that frame's id.
      for (let cut = 0; cut < received.length; cut += 1) {
        const tail = hub.replayAfter(received[cut].eventId);
        expect(tail).not.toBeNull();
        const replayed = tail.map((entry) => JSON.parse(entry.serializedFrame));
        expect(applyFrames([...received.slice(0, cut + 1), ...replayed])).toEqual(complete);
      }
    } finally { hub.stop(); }
  });

  // OpenCode sends no SSE ids at all. Its events still reach every live browser, numbered by the hub
  // so fan-out has an id. None of them is buffered or sent as a cursor, so nothing is replayed twice,
  // and a browser holding none of OpenCode's ids refetches on reconnect.
  it('delivers id-less upstream events live, numbered by the hub but never buffered or used as a cursor', async () => {
    const idless = (type, data) => `data: ${JSON.stringify({ type, data })}\n\n`;
    const blocks = [];
    for (let index = 0; index < 30; index += 1) {
      blocks.push(idless('session.text.delta', { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 1, delta: `a${index}.` }));
    }
    blocks.push(idless('session.text.ended', { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 1, text: '' }));
    for (let index = 0; index < 30; index += 1) {
      blocks.push(idless('session.text.delta', { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 1, delta: `b${index}.` }));
    }

    const hub = createDeltaHub({ blocks });
    const received = [];
    hub.subscribeEvent((event) => received.push(event));
    try {
      hub.start();
      const expected = [...Array(30).keys()].map((index) => `a${index}.`).join('') + [...Array(30).keys()].map((index) => `b${index}.`).join('');
      await waitForAssertion(() => expect(applyFrames(received).text[1]).toBe(expected));

      const ids = received.map((event) => event.eventId);
      expect(ids.every((eventId) => typeof eventId === 'string' && eventId.startsWith('oc-'))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual([...ids].sort());
      // No OpenCode id was seen, so the head carries no upstream id.
      expect(hub.headEventId()).toBeUndefined();

      for (const event of received) {
        // A local frame carries a versioned OpenChamber cursor, never the hub's own id.
        expect(JSON.parse(event.serialize()).eventId).toMatch(/^occ1\.global\.\d+\.$/);
        expect(JSON.parse(event.serialize()).eventId).not.toBe(event.eventId);
        // The frames are buffered and replayable; the hub id is not what a cursor names.
        expect(hub.replayAfter(event.eventId)).not.toBeNull();
      }
      expect(hub.replayAfterCursor({ version: 1, stream: 'global', position: received[0].position, upstream: '' }))
        .toHaveLength(received.length - 1);
    } finally { hub.stop(); }
  });

  it('keeps pending text for replay when the hub stops', async () => {
    const hub = createDeltaHub({
      deltaCoalesceWindowMs: 60_000,
      blocks: ['one ', 'two ', 'three'].map((text, index) => deltaBlock(ocId(index), text)),
    });
    const received = [];
    hub.subscribeEvent((event) => received.push(event));
    hub.start();
    // The window is a minute, so only the leading delta has been delivered.
    await waitForAssertion(() => expect(received).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    hub.stop();

    const entries = hub.replayAfter(ocId(0));
    expect(applyFrames(entries.map((entry) => JSON.parse(entry.serializedFrame))).text[1]).toBe('two three');
    // The buffer keeps the id of the last merged fragment, which is what a cursor names.
    expect(entries.at(-1).eventId).toBe(ocId(2));
  });

  it('commits pending text on demand, so a client readied later starts after it', async () => {
    const hub = createDeltaHub({
      deltaCoalesceWindowMs: 60_000,
      blocks: ['one ', 'two ', 'three'].map((text, index) => deltaBlock(ocId(index), text)),
    });
    const received = [];
    hub.subscribeEvent((event) => received.push(event));
    try {
      hub.start();
      await waitForAssertion(() => expect(received).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));

      hub.flushPending();

      expect(applyFrames(received).text[1]).toBe('one two three');
      expect(hub.replayAfter(ocId(2))).toEqual([]);
    } finally { hub.stop(); }
  });
});

describe('createGlobalMessageStreamHub', () => {
  it('continues fanout when an event subscriber throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'data: {"id":"evt-1","type":"session.updated","properties":{}}\n\n',
        ],
      }),
    });

    hub.subscribeEvent(() => {
      throw new Error('subscriber failed');
    });
    hub.subscribeEvent((event) => {
      received.push(event.eventId);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toEqual(['evt-1']);
      });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });

  it('continues status fanout when a status subscriber throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse(),
    });

    hub.subscribeStatus(() => {
      throw new Error('status subscriber failed');
    });
    hub.subscribeStatus((status) => {
      received.push(status.type);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toContain('connect');
      });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });

  it('continues fanout when an async event subscriber rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'data: {"id":"evt-1","type":"session.updated","properties":{}}\n\n',
        ],
      }),
    });

    hub.subscribeEvent(async () => {
      throw new Error('async subscriber failed');
    });
    hub.subscribeEvent((event) => {
      received.push(event.eventId);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toEqual(['evt-1']);
      });
      await waitForAssertion(() => {
        expect(warnSpy).toHaveBeenCalled();
      });
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });
});

describe('events of isolated spaces in the global hub', () => {
  const makeHub = () => createGlobalMessageStreamHub({
    buildOpenCodeUrl: path => `http://127.0.0.1:4096${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    deltaCoalesceWindowMs: 0,
    fetchImpl: async () => createSseResponse({ blocks: [] }),
  });

  // An injected event has no OpenCode id, so it is numbered by the hub and delivered live only.
  it('delivers an injected space event to subscribers that asked for spaces only, numbered by the hub and not buffered', () => {
    const hub = makeHub();
    const plain = [];
    const withSpaces = [];
    hub.subscribeEvent(event => plain.push(event));
    hub.subscribeEvent(event => withSpaces.push(event), { spaces: true });
    hub.injectEvent({ payload: { type: 'session.execution.started', data: { sessionID: 's1' } }, directory: '/spaces/a1b2c3d4e5f6/repo', spaceId: 'a1b2c3d4e5f6' });
    expect(plain).toHaveLength(0);
    expect(withSpaces).toHaveLength(1);
    expect(withSpaces[0]).toMatchObject({ spaceId: 'a1b2c3d4e5f6', directory: '/spaces/a1b2c3d4e5f6/repo' });
    expect(withSpaces[0].eventId).toMatch(/^oc-/);
    expect(withSpaces[0].translated()).toEqual([expect.objectContaining({ type: 'session.status' })]);
    expect(JSON.parse(withSpaces[0].serialize())).toMatchObject({ type: 'event', directory: '/spaces/a1b2c3d4e5f6/repo', payload: { type: 'session.execution.started' } });
    hub.injectEvent({ payload: { type: 'session.execution.succeeded', data: { sessionID: 's1' } }, directory: '/spaces/a1b2c3d4e5f6/repo', spaceId: 'a1b2c3d4e5f6' });
    expect(withSpaces[1].eventId).toMatch(/^oc-/);
    // Local frames are buffered: a cursor at the first replays the second.
    expect(hub.replayAfter(withSpaces[0].eventId).map((entry) => entry.cursor)).toContain(JSON.parse(withSpaces[1].serialize()).eventId);
  });

  it('marks a host event with no space, so every subscriber sees it', () => {
    const hub = makeHub();
    const seen = [];
    hub.subscribeEvent(event => seen.push(event.spaceId));
    hub.subscribeEvent(event => seen.push(event.spaceId), { spaces: true });
    hub.injectEvent({ payload: { type: 'session.execution.started', data: { sessionID: 's1' } }, directory: '/home/me', spaceId: null });
    expect(seen).toEqual([null, null]);
  });
});
