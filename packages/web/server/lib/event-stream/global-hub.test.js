import { describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';

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

  it('normalizes opencode2 events at the shared hub boundary and preserves their replay IDs', async () => {
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodeProtocol: () => 'opencode2',
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'data: {"id":"evt-v2","type":"permission.asked","data":{"id":"perm-1","sessionID":"ses-1"},"location":{"directory":"/tmp/project"}}\n\n',
          'data: {"id":"evt-v2-next","type":"session.updated","data":{"info":{"id":"ses-1"}},"location":{"directory":"/tmp/project"}}\n\n',
        ],
      }),
    });
    hub.subscribeEvent((event) => received.push(event));

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received[0]).toEqual({
          envelope: {
            eventId: 'evt-v2',
            directory: '/tmp/project',
            payload: {
              type: 'permission.asked',
              properties: { id: 'perm-1', sessionID: 'ses-1' },
            },
          },
          payload: {
            type: 'permission.asked',
            properties: { id: 'perm-1', sessionID: 'ses-1' },
          },
          directory: '/tmp/project',
          eventId: 'evt-v2',
        });
        expect(received[1]).toMatchObject({
          payload: { type: 'session.updated', properties: { info: { id: 'ses-1' } } },
          directory: '/tmp/project',
          eventId: 'evt-v2-next',
        });
        expect(hub.replayAfter('evt-v2')).toEqual([received[1]]);
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
