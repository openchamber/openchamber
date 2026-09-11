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
