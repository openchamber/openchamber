import { afterEach, describe, expect, it } from 'bun:test';
import { createEventPipeline } from '../event-pipeline';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalWebSocket = globalThis.WebSocket;

function installDomStubs() {
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };

  globalThis.window = {
    location: {
      href: 'http://127.0.0.1:3000/',
      origin: 'http://127.0.0.1:3000',
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.readyState = 3;
  }

  emitOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  emitMessage(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  emitClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  globalThis.WebSocket = originalWebSocket;
  FakeWebSocket.instances = [];
});

function createSdkWithSingleEvent(event, hold) {
  return {
    global: {
      event: async () => ({
        stream: (async function* () {
          yield event;
          await hold;
        })(),
      }),
    },
  };
}

// Helper to create an SDK that yields multiple events in sequence, then holds.
function createSdkWithEvents(events, hold) {
  return {
    global: {
      event: async () => ({
        stream: (async function* () {
          for (const event of events) {
            yield event;
          }
          await hold;
        })(),
      }),
    },
  };
}

describe('createEventPipeline', () => {
  it('falls back to payload.properties.directory when the SDK event omits top-level directory', async () => {
    installDomStubs();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];
    const sdk = createSdkWithSingleEvent({
      payload: {
        type: 'session.status',
        properties: {
          directory: 'C:/Users/daveotero/localdev/openchamber',
          sessionID: 'session-1',
          status: { type: 'busy' },
        },
      },
    }, hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        onEvent: (directory, payload) => {
          received.push({ directory, payload });
          cleanup();
          releaseStream();
          resolve();
        },
      });
    });

    await delivered;

    expect(received).toHaveLength(1);
    expect(received[0].directory).toBe('C:/Users/daveotero/localdev/openchamber');
    expect(received[0].payload.type).toBe('session.status');
  });

  it('prefers the explicit top-level event directory when present', async () => {
    installDomStubs();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];
    const sdk = createSdkWithSingleEvent({
      directory: 'C:/top-level',
      payload: {
        type: 'session.status',
        properties: {
          directory: 'C:/nested',
          sessionID: 'session-2',
          status: { type: 'busy' },
        },
      },
    }, hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        onEvent: (directory, payload) => {
          received.push({ directory, payload });
          cleanup();
          releaseStream();
          resolve();
        },
      });
    });

    await delivered;

    expect(received).toHaveLength(1);
    expect(received[0].directory).toBe('C:/top-level');
    expect(received[0].payload.type).toBe('session.status');
  });

  it('uses payload.properties.directory when the top-level directory is an empty string', async () => {
    installDomStubs();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];
    const sdk = createSdkWithSingleEvent({
      directory: '',
      payload: {
        type: 'message.part.updated',
        properties: {
          directory: 'C:/fallback-dir',
          part: {
            id: 'part-1',
            type: 'text',
            messageID: 'message-1',
          },
        },
      },
    }, hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        onEvent: (directory, payload) => {
          received.push({ directory, payload });
          cleanup();
          releaseStream();
          resolve();
        },
      });
    });

    await delivered;

    expect(received).toHaveLength(1);
    expect(received[0].directory).toBe('C:/fallback-dir');
    expect(received[0].payload.type).toBe('message.part.updated');
  });

  it('keeps truly global events on the global channel when no directory is present anywhere', async () => {
    installDomStubs();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];
    const sdk = createSdkWithSingleEvent({
      payload: {
        type: 'server.connected',
        properties: {},
      },
    }, hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        onEvent: (directory, payload) => {
          received.push({ directory, payload });
          cleanup();
          releaseStream();
          resolve();
        },
      });
    });

    await delivered;

    expect(received).toHaveLength(1);
    expect(received[0].directory).toBe('global');
    expect(received[0].payload.type).toBe('server.connected');
  });

  it('delivers message.part.delta events after a coalesced message.part.updated (no stale-delta skip)', async () => {
    installDomStubs();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];

    // Simulate: part.updated arrives first, then delta, then part.updated again (coalesces with first).
    // After coalescing, the delta should still be delivered — NOT skipped.
    const directory = '/test/dir';
    const sdk = createSdkWithEvents([
      // T0: message.part.updated for part-A
      {
        payload: {
          type: 'message.part.updated',
          properties: {
            directory,
            part: { id: 'part-A', type: 'text', messageID: 'msg-1' },
          },
        },
      },
      // T1: message.part.delta for part-A (should flow through even after coalesce)
      {
        payload: {
          type: 'message.part.delta',
          properties: {
            directory,
            messageID: 'msg-1',
            partID: 'part-A',
            field: 'text',
            delta: ' world',
          },
        },
      },
      // T2: message.part.updated for part-A — coalesces with T0
      {
        payload: {
          type: 'message.part.updated',
          properties: {
            directory,
            part: { id: 'part-A', type: 'text', messageID: 'msg-1' },
          },
        },
      },
    ], hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        onEvent: (dir, payload) => {
          received.push({ directory: dir, payload });
          if (received.length === 2) {
            cleanup();
            releaseStream();
            resolve();
          }
        },
      });
    });

    await delivered;

    // Coalescing means T0 and T2 merge into one event at T0's queue position.
    // The delta is a different event type with no coalesce key, so it gets
    // its own queue slot. After coalesce:
    //   - queue[0] = coalesced part.updated (from T2, replacing T0)
    //   - queue[1] = part.delta (from T1)
    // Total: 2 events delivered
    expect(received.length).toBe(2);

    // The first event should be the coalesced message.part.updated
    expect(received[0].payload.type).toBe('message.part.updated');

    // The delta MUST be delivered — it should NOT be skipped
    expect(received[1].payload.type).toBe('message.part.delta');
    expect(received[1].payload.properties.delta).toBe(' world');
  });

  it('coalesces message.part.updated events for the same part', async () => {
    installDomStubs();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];
    const directory = '/test/dir';

    const sdk = createSdkWithEvents([
      {
        payload: {
          type: 'message.part.updated',
          properties: {
            directory,
            part: { id: 'part-A', type: 'text', messageID: 'msg-1' },
          },
        },
      },
      {
        payload: {
          type: 'message.part.updated',
          properties: {
            directory,
            part: { id: 'part-A', type: 'text', messageID: 'msg-1' },
          },
        },
      },
    ], hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        onEvent: (dir, payload) => {
          received.push({ directory: dir, payload });
          cleanup();
          releaseStream();
          resolve();
        },
      });
    });

    await delivered;

    // Only 1 event should be delivered (coalesced)
    expect(received.length).toBe(1);
    expect(received[0].payload.type).toBe('message.part.updated');
  });

  it('consumes websocket message stream frames when transport is ws', async () => {
    installDomStubs();
    globalThis.WebSocket = FakeWebSocket;

    const received = [];
    const sdk = {
      global: {
        event: async () => {
          throw new Error('SSE should not be used in ws mode');
        },
      },
    };

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'ws',
        onEvent: (directory, payload) => {
          received.push({ directory, payload });
          cleanup();
          resolve();
        },
      });
    });

    await Promise.resolve();

    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toContain('/api/global/event/ws');

    socket.emitOpen();
    socket.emitMessage({ type: 'ready', scope: 'global' });
    socket.emitMessage({
      type: 'event',
      eventId: 'evt-1',
      directory: '/tmp/project',
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'session-1',
        },
      },
    });

    await delivered;

    expect(received).toEqual([
      {
        directory: '/tmp/project',
        payload: {
          type: 'session.status',
          properties: {
            sessionID: 'session-1',
          },
        },
      },
    ]);
  });

  it('falls back to SSE when websocket closes before ready in auto mode', async () => {
    installDomStubs();
    globalThis.WebSocket = FakeWebSocket;

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];
    const sdk = createSdkWithSingleEvent({
      payload: {
        type: 'server.connected',
        properties: {},
      },
    }, hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'auto',
        onEvent: (directory, payload) => {
          received.push({ directory, payload });
          cleanup();
          releaseStream();
          resolve();
        },
      });
    });

    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.emitClose();

    await delivered;

    expect(received).toEqual([
      {
        directory: 'global',
        payload: {
          type: 'server.connected',
          properties: {},
        },
      },
    ]);
  });
});
