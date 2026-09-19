import { describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';

it('bounds a contiguous replay suffix by UTF-8 bytes and event count', async () => {
  const blocks = Array.from({ length: 8 }, (_, i) => `id: e${i}\ndata: ${JSON.stringify({ type: 'message', properties: { text: '界'.repeat(40) } })}\n\n`);
  const received = [];
  const hub = createGlobalMessageStreamHub({
    buildOpenCodeUrl: path => `http://127.0.0.1:4096${path}`,
    getOpenCodeAuthHeaders: () => ({}), replayLimit: 3, replayByteLimit: 550,
    upstreamReconnectDelayMs: 60_000,
    fetchImpl: async () => createSseResponse({ blocks }),
  });
  hub.subscribeEvent(event => received.push(event.eventId));
  try {
    hub.start();
    await waitForAssertion(() => expect(received).toHaveLength(8));
    expect(hub.replayAfter('e0')).toBeNull();
    expect(hub.replayAfter('e5')).toBeNull();
    const tail = hub.replayAfter('e6');
    expect(tail.map(entry => entry.eventId)).toEqual(['e7']);
    expect(Buffer.byteLength(tail[0].serializedFrame) * 2).toBeLessThanOrEqual(550);
    expect(Buffer.byteLength(tail[0].serializedFrame) * 3).toBeGreaterThan(550);
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

const deltaBlock = (id, text, partID = 'prt_a') => `id: ${id}\ndata: ${JSON.stringify({
  id, type: 'message.part.delta',
  properties: { sessionID: 'ses_1', messageID: 'msg_1', partID, field: 'text', delta: text },
})}\n\n`;

const createDeltaHub = ({ blocks, deltaCoalesceWindowMs }) => createGlobalMessageStreamHub({
  buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
  getOpenCodeAuthHeaders: () => ({}),
  upstreamReconnectDelayMs: 60_000,
  deltaCoalesceWindowMs,
  fetchImpl: async () => createSseResponse({ blocks }),
});

// What a browser holds after applying frames in order: text per part, and the
// text each part had when a snapshot barrier passed.
const applyFrames = (frames) => {
  const text = {};
  const barriers = [];
  for (const frame of frames) {
    const payload = frame.payload;
    if (payload.type === 'message.part.delta') {
      text[payload.properties.partID] = (text[payload.properties.partID] ?? '') + payload.properties.delta;
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
      await waitForAssertion(() => expect(applyFrames(received).text.prt_a).toBe(words.join('')));
      expect(received.length).toBeLessThanOrEqual(3);
      expect(received.at(-1).eventId).toBe('e0119');
    } finally { hub.stop(); }
  });

  it('resumes from any cursor without losing or repeating text', async () => {
    const blocks = [];
    let id = 0;
    const nextId = () => `e${String(id++).padStart(4, '0')}`;
    for (let index = 0; index < 40; index += 1) blocks.push(deltaBlock(nextId(), `a${index}.`, index % 3 === 0 ? 'prt_b' : 'prt_a'));
    const snapshotId = nextId();
    blocks.push(`id: ${snapshotId}\ndata: ${JSON.stringify({ id: snapshotId, type: 'message.part.updated', properties: { part: { id: 'prt_a', messageID: 'msg_1' } } })}\n\n`);
    for (let index = 0; index < 40; index += 1) blocks.push(deltaBlock(nextId(), `b${index}.`));

    const hub = createDeltaHub({ blocks });
    const received = [];
    hub.subscribeEvent((event) => received.push(event));
    try {
      hub.start();
      const expectedA = [...Array(40).keys()].filter((index) => index % 3 !== 0).map((index) => `a${index}.`).join('')
        + [...Array(40).keys()].map((index) => `b${index}.`).join('');
      await waitForAssertion(() => expect(applyFrames(received).text.prt_a).toBe(expectedA));
      expect(received.length).toBeLessThan(blocks.length / 4);

      const complete = applyFrames(received);
      // The snapshot barrier saw exactly the text that arrived before it.
      expect(complete.barriers).toHaveLength(1);
      expect(complete.barriers[0].seen.prt_a).toBe([...Array(40).keys()].filter((index) => index % 3 !== 0).map((index) => `a${index}.`).join(''));

      // A socket that drops after any frame reconnects with that frame's id.
      for (let cut = 0; cut < received.length; cut += 1) {
        const tail = hub.replayAfter(received[cut].eventId);
        expect(tail).not.toBeNull();
        const replayed = tail.map((entry) => JSON.parse(entry.serializedFrame));
        expect(applyFrames([...received.slice(0, cut + 1), ...replayed])).toEqual(complete);
      }
    } finally { hub.stop(); }
  });

  // OpenCode 1.18 sends no SSE ids at all. Before the hub numbered such events
  // itself the replay buffer stayed empty and every reconnect lost its gap.
  it('numbers id-less upstream events so a reconnect resumes from any cursor', async () => {
    const idless = (type, properties) => `data: ${JSON.stringify({ type, properties })}\n\n`;
    const blocks = [];
    for (let index = 0; index < 30; index += 1) {
      blocks.push(idless('message.part.delta', { sessionID: 'ses_1', messageID: 'msg_1', partID: 'prt_a', field: 'text', delta: `a${index}.` }));
    }
    blocks.push(idless('message.part.updated', { part: { id: 'prt_a', messageID: 'msg_1' } }));
    for (let index = 0; index < 30; index += 1) {
      blocks.push(idless('message.part.delta', { sessionID: 'ses_1', messageID: 'msg_1', partID: 'prt_a', field: 'text', delta: `b${index}.` }));
    }

    const hub = createDeltaHub({ blocks });
    const received = [];
    hub.subscribeEvent((event) => received.push(event));
    try {
      hub.start();
      const expected = [...Array(30).keys()].map((index) => `a${index}.`).join('') + [...Array(30).keys()].map((index) => `b${index}.`).join('');
      await waitForAssertion(() => expect(applyFrames(received).text.prt_a).toBe(expected));

      const ids = received.map((event) => event.eventId);
      expect(ids.every((eventId) => typeof eventId === 'string' && eventId.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual([...ids].sort());

      const complete = applyFrames(received);
      for (let cut = 0; cut < received.length; cut += 1) {
        const tail = hub.replayAfter(received[cut].eventId);
        expect(tail).not.toBeNull();
        const replayed = tail.map((entry) => JSON.parse(entry.serializedFrame));
        expect(replayed.every((frame) => typeof frame.eventId === 'string')).toBe(true);
        expect(applyFrames([...received.slice(0, cut + 1), ...replayed])).toEqual(complete);
      }

      // A cursor minted by another server process must miss, never match by
      // sequence number: the bridge then reports replayReset and the client
      // repairs from HTTP instead of trusting a wrong tail.
      const foreign = ids[0].replace(/^oc-[^-]+-/, 'oc-00000000-');
      expect(foreign).not.toBe(ids[0]);
      expect(hub.replayAfter(foreign)).toBeNull();
    } finally { hub.stop(); }
  });

  it('keeps pending text for replay when the hub stops', async () => {
    const hub = createDeltaHub({
      deltaCoalesceWindowMs: 60_000,
      blocks: ['one ', 'two ', 'three'].map((text, index) => deltaBlock(`e${index}`, text)),
    });
    const received = [];
    hub.subscribeEvent((event) => received.push(event));
    hub.start();
    // The window is a minute, so only the leading delta has been delivered.
    await waitForAssertion(() => expect(received).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    hub.stop();

    const tail = hub.replayAfter('e0').map((entry) => JSON.parse(entry.serializedFrame));
    expect(applyFrames(tail).text.prt_a).toBe('two three');
    expect(tail.at(-1).eventId).toBe('e2');
  });

  it('commits pending text on demand, so a client readied later starts after it', async () => {
    const hub = createDeltaHub({
      deltaCoalesceWindowMs: 60_000,
      blocks: ['one ', 'two ', 'three'].map((text, index) => deltaBlock(`e${index}`, text)),
    });
    const received = [];
    hub.subscribeEvent((event) => received.push(event));
    try {
      hub.start();
      await waitForAssertion(() => expect(received).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));

      hub.flushPending();

      expect(applyFrames(received).text.prt_a).toBe('one two three');
      expect(hub.replayAfter('e2')).toEqual([]);
    } finally { hub.stop(); }
  });
});

describe('createGlobalMessageStreamHub', () => {
  it('uses the configured upstream event path', async () => {
    const paths = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => {
        paths.push(pathname);
        return `http://127.0.0.1:4096${pathname}`;
      },
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodeProtocol: () => 'opencode2',
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse(),
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(paths[0]).toBe('/api/event');
      });
    } finally {
      hub.stop();
    }
  });

  it('normalizes real opencode2 execution and form events at the shared hub boundary', async () => {
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodeProtocol: () => 'opencode2',
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'data: {"id":"evt-v2","type":"session.execution.failed","data":{"sessionID":"ses-1","error":{"type":"unknown","message":"Agent failed"}},"location":{"directory":"/tmp/project"}}\n\n',
          'data: {"id":"evt-v2-next","type":"form.created","data":{"form":{"id":"form-1","sessionID":"ses-1","title":"Choose a target","fields":[{"key":"target","type":"string","title":"Target","description":"Where should this go?","options":[{"value":"prod","label":"Production"}]}]}},"location":{"directory":"/tmp/project"}}\n\n',
        ],
      }),
    });
    hub.subscribeEvent((event) => received.push(event));

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received[0]).toMatchObject({
          envelope: {
            eventId: undefined,
            directory: '/tmp/project',
            payload: {
              id: 'evt-v2',
              type: 'session.error',
              properties: {
                sessionID: 'ses-1',
                error: { name: 'UnknownError', data: { message: 'Agent failed' } },
                directory: '/tmp/project',
              },
            },
          },
          payload: {
            id: 'evt-v2',
            type: 'session.error',
            properties: {
              sessionID: 'ses-1',
              error: { name: 'UnknownError', data: { message: 'Agent failed' } },
              directory: '/tmp/project',
            },
          },
          directory: '/tmp/project',
          eventId: expect.stringMatching(/^oc-/),
        });
        expect(received[1]).toMatchObject({
          payload: {
            type: 'question.asked',
            properties: {
              id: 'form-1',
              sessionID: 'ses-1',
              questions: [{
                question: 'Where should this go?',
                header: 'Target',
                options: [{ label: 'Production', description: '' }],
              }],
              directory: '/tmp/project',
            },
          },
          directory: '/tmp/project',
          eventId: expect.stringMatching(/^oc-/),
        });
        expect(hub.replayAfter('evt-v2')).toBeNull();
        expect(hub.replayAfter(received[0].eventId).map(({ serializedFrame }) => JSON.parse(serializedFrame).payload))
          .toEqual([received[1].payload]);
      });
    } finally {
      hub.stop();
    }
  });

  it('uses the upstream SSE cursor for replay while preserving the JSON event id', async () => {
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodeProtocol: () => 'opencode2',
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: cursor-1\ndata: {"id":"json-1","type":"server.connected","data":{}}\n\n',
        ],
      }),
    });
    hub.subscribeEvent((event) => received.push(event));

    try {
      hub.start();
      await waitForAssertion(() => expect(received).toHaveLength(1));
      expect(received[0].eventId).toBe('cursor-1');
      expect(received[0].payload.id).toBe('json-1');
      expect(hub.replayAfter('cursor-1')).toEqual([]);
    } finally {
      hub.stop();
    }
  });

  it('keeps session lineage while translating V2 session updates', async () => {
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodeProtocol: () => 'opencode2',
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'data: {"id":"evt-created","type":"session.created","created":1,"data":{"sessionID":"ses-1","projectID":"project-1","location":{"directory":"/tmp/project"},"parentID":"parent-1","slug":"session-1","title":"Original","version":"2"},"location":{"directory":"/tmp/project"}}\n\n',
          'data: {"id":"evt-renamed","type":"session.renamed","created":2,"data":{"sessionID":"ses-1","title":"Renamed"},"location":{"directory":"/tmp/project"}}\n\n',
          'data: {"id":"evt-model","type":"session.model.selected","created":3,"data":{"sessionID":"ses-1","model":{"id":"model-1","providerID":"provider-1","variant":"high"}},"location":{"directory":"/tmp/project"}}\n\n',
          'data: {"id":"evt-moved","type":"session.moved","created":4,"data":{"sessionID":"ses-1","projectID":"project-2","location":{"directory":"/tmp/other","workspaceID":"workspace-1"},"subpath":"nested"},"location":{"directory":"/tmp/other"}}\n\n',
        ],
      }),
    });
    hub.subscribeEvent((event) => received.push(event));

    try {
      hub.start();
      await waitForAssertion(() => expect(received).toHaveLength(4));

      expect(received[1].payload).toMatchObject({
        type: 'session.updated',
        properties: {
          info: {
            id: 'ses-1',
            parentID: 'parent-1',
            title: 'Renamed',
          },
        },
      });
      expect(received[2].payload.properties.info.model).toEqual({
        id: 'model-1',
        providerID: 'provider-1',
        variant: 'high',
      });
      expect(received[3].payload).toMatchObject({
        type: 'session.updated',
        properties: {
          directory: '/tmp/other',
          info: {
            directory: '/tmp/other',
            parentID: 'parent-1',
            projectID: 'project-2',
            path: 'nested',
            workspaceID: 'workspace-1',
          },
        },
      });
    } finally {
      hub.stop();
    }
  });

  it('continues fanout when an event subscriber throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{}}\n\n',
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
          'id: evt-1\ndata: {"type":"session.updated","properties":{}}\n\n',
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
