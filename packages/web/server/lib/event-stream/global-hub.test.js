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

  it('observes rejections from a thenable with an async catch method', async () => {
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

    hub.subscribeEvent(() => ({
      catch: async (onRejected) => {
        await Promise.resolve();
        onRejected(new Error('async thenable subscriber failed'));
      },
    }));
    hub.subscribeEvent((event) => {
      received.push(event.eventId);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toEqual(['evt-1']);
      });
      await waitForAssertion(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          'Global message stream event subscriber failed:',
          expect.any(Error),
        );
      });
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });

  it('keeps the latest non-idle status with its envelope directory and clears terminal events', async () => {
    const snapshots = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 1000,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"directory":"/tmp/one","payload":{"type":"session.status","properties":{"sessionID":"ses_1","status":{"type":"busy"}}}}\n\n',
          'id: evt-2\ndata: {"directory":"/tmp/two","payload":{"type":"session.status","properties":{"sessionID":"ses_1","status":{"type":"retry","attempt":2,"message":"retrying","next":10}}}}\n\n',
          'id: evt-3\ndata: {"directory":"/tmp/two","payload":{"type":"session.status","properties":{"sessionID":"ses_1","status":{"type":"idle"}}}}\n\n',
          'id: evt-4\ndata: {"directory":"/tmp/two","payload":{"type":"session.idle","properties":{"sessionID":"ses_1"}}}\n\n',
          'id: evt-5\ndata: {"directory":"/tmp/three","payload":{"type":"session.status","properties":{"sessionID":"ses_2","status":{"type":"busy"}}}}\n\n',
          'id: evt-6\ndata: {"directory":"/tmp/three","payload":{"type":"session.error","properties":{"sessionID":"ses_2"}}}\n\n',
          'id: evt-7\ndata: {"directory":"/tmp/four","payload":{"type":"session.status","properties":{"sessionID":"ses_3","status":{"type":"busy"}}}}\n\n',
          'id: evt-8\ndata: {"directory":"/tmp/four","payload":{"type":"session.deleted","properties":{"info":{"id":"ses_3"}}}}\n\n',
        ],
      }),
    });

    hub.subscribeEvent(() => {
      snapshots.push(hub.getSessionStatusSnapshot());
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(snapshots).toHaveLength(8);
      });
    } finally {
      hub.stop();
    }

    expect(snapshots).toEqual([
      [{ sessionID: 'ses_1', status: { type: 'busy' }, directory: '/tmp/one' }],
      [{ sessionID: 'ses_1', status: { type: 'retry', attempt: 2, message: 'retrying', next: 10 }, directory: '/tmp/two' }],
      [],
      [],
      [{ sessionID: 'ses_2', status: { type: 'busy' }, directory: '/tmp/three' }],
      [],
      [{ sessionID: 'ses_3', status: { type: 'busy' }, directory: '/tmp/four' }],
      [],
    ]);
  });

  it('preserves cached status through unscoped and malformed status events', async () => {
    const snapshots = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 1000,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"directory":"/tmp/project","payload":{"type":"session.status","properties":{"sessionID":"ses_1","status":{"type":"busy"}}}}\n\n',
          'id: evt-2\ndata: {"type":"session.status","properties":{"sessionID":"ses_1","status":{"type":"retry","attempt":2}}}\n\n',
          'id: evt-3\ndata: {"type":"session.status","properties":{"sessionID":"ses_1","status":{"type":"paused"}}}\n\n',
          'id: evt-4\ndata: {"type":"session.status","properties":{"sessionID":"ses_1","status":{}}}\n\n',
          'id: evt-5\ndata: {"type":"session.status","properties":{"sessionID":"ses_1","status":{"type":"idle"}}}\n\n',
        ],
      }),
    });

    hub.subscribeEvent(() => {
      snapshots.push(hub.getSessionStatusSnapshot());
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(snapshots).toHaveLength(5);
      });
    } finally {
      hub.stop();
    }

    expect(snapshots).toEqual([
      [{ sessionID: 'ses_1', status: { type: 'busy' }, directory: '/tmp/project' }],
      [{ sessionID: 'ses_1', status: { type: 'retry', attempt: 2 }, directory: '/tmp/project' }],
      [{ sessionID: 'ses_1', status: { type: 'retry', attempt: 2 }, directory: '/tmp/project' }],
      [{ sessionID: 'ses_1', status: { type: 'retry', attempt: 2 }, directory: '/tmp/project' }],
      [],
    ]);
  });

  it('evicts the least-recent status while retaining the most-recent update', async () => {
    const blocks = Array.from({ length: 200 }, (_, index) => (
      `id: evt-${index}\ndata: ${JSON.stringify({
        directory: '/tmp/project',
        payload: {
          type: 'session.status',
          properties: { sessionID: `ses_${index}`, status: { type: 'busy' } },
        },
      })}\n\n`
    ));
    blocks.push(
      `id: evt-refresh\ndata: ${JSON.stringify({
        directory: '/tmp/project',
        payload: {
          type: 'session.status',
          properties: { sessionID: 'ses_0', status: { type: 'busy' } },
        },
      })}\n\n`,
      `id: evt-new\ndata: ${JSON.stringify({
        directory: '/tmp/project',
        payload: {
          type: 'session.status',
          properties: { sessionID: 'ses_200', status: { type: 'busy' } },
        },
      })}\n\n`,
    );
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 1000,
      fetchImpl: async () => createSseResponse({ blocks }),
    });
    let eventCount = 0;
    let snapshot;

    hub.subscribeEvent(() => {
      eventCount += 1;
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(eventCount).toBe(202);
      });
      snapshot = hub.getSessionStatusSnapshot();
    } finally {
      hub.stop();
    }

    expect(snapshot).toHaveLength(200);
    expect(snapshot.some(({ sessionID }) => sessionID === 'ses_1')).toBe(false);
    expect(snapshot.find(({ sessionID }) => sessionID === 'ses_0')).toEqual({
      sessionID: 'ses_0',
      status: { type: 'busy' },
      directory: '/tmp/project',
    });
    expect(snapshot.find(({ sessionID }) => sessionID === 'ses_200')).toEqual({
      sessionID: 'ses_200',
      status: { type: 'busy' },
      directory: '/tmp/project',
    });
  });

  it('caps copied status messages and bounds the cache by approximate bytes', async () => {
    const message = 'x'.repeat(10_000);
    const blocks = Array.from({ length: 100 }, (_, index) => (
      `id: evt-${index}\ndata: ${JSON.stringify({
        directory: '/tmp/project',
        payload: {
          type: 'session.status',
          properties: { sessionID: `ses_${index}`, status: { type: 'retry', message } },
        },
      })}\n\n`
    ));
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 1000,
      fetchImpl: async () => createSseResponse({ blocks }),
    });
    let eventCount = 0;
    let snapshot;

    hub.subscribeEvent(() => {
      eventCount += 1;
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(eventCount).toBe(100);
      });
      snapshot = hub.getSessionStatusSnapshot();
    } finally {
      hub.stop();
    }

    expect(snapshot.length).toBeLessThan(100);
    expect(snapshot.some(({ sessionID }) => sessionID === 'ses_0')).toBe(false);
    expect(snapshot.at(-1).status.message).toHaveLength(4096);
  });

  it('caps oversized status messages at a UTF-8 code-point boundary', async () => {
    const message = `${'x'.repeat(4093)}😀${'y'.repeat(10_000)}`;
    expect(Buffer.byteLength(message, 'utf8')).toBeGreaterThan(4 * 1024);
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 1000,
      fetchImpl: async () => createSseResponse({
        blocks: [
          `id: evt-emoji\ndata: ${JSON.stringify({
            directory: '/tmp/project',
            payload: {
              type: 'session.status',
              properties: { sessionID: 'ses_emoji', status: { type: 'retry', message } },
            },
          })}\n\n`,
        ],
      }),
    });
    let snapshot;

    hub.subscribeEvent(() => {
      snapshot = hub.getSessionStatusSnapshot();
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(snapshot).toHaveLength(1);
      });
    } finally {
      hub.stop();
    }

    const cachedMessage = snapshot[0].status.message;
    expect(cachedMessage).not.toContain('\uFFFD');
    expect(Buffer.byteLength(cachedMessage, 'utf8')).toBeLessThanOrEqual(4 * 1024);
  });

  it('clears the status cache when the upstream lifecycle stops', async () => {
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 1000,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"directory":"/tmp/project","payload":{"type":"session.status","properties":{"sessionID":"ses_1","status":{"type":"busy"}}}}\n\n',
        ],
      }),
    });

    hub.start();
    await waitForAssertion(() => {
      expect(hub.getSessionStatusSnapshot()).toEqual([
        { sessionID: 'ses_1', status: { type: 'busy' }, directory: '/tmp/project' },
      ]);
    });

    hub.stop();

    expect(hub.getSessionStatusSnapshot()).toEqual([]);
  });
});
