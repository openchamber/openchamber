import { afterEach, describe, expect, it } from 'bun:test';
import { createEventPipeline } from '../event-pipeline';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

function installDomStubs() {
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };

  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
  };
}

afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
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

// Run a pipeline against a pre-seeded event stream, collect every dispatched
// event, wait long enough for the 16ms flush window to elapse, then tear it
// down. Returns the list of { directory, payload } that onEvent saw.
async function runPipelineWithEvents(events, waitMs = 80) {
  installDomStubs();

  let releaseStream;
  const hold = new Promise((resolve) => {
    releaseStream = resolve;
  });

  const received = [];
  const sdk = createSdkWithEvents(events, hold);
  const { cleanup } = createEventPipeline({
    sdk,
    onEvent: (directory, payload) => {
      received.push({ directory, payload });
    },
  });

  await new Promise((resolve) => setTimeout(resolve, waitMs));
  cleanup();
  releaseStream();

  return received;
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
});

// ---------------------------------------------------------------------------
// P1 — Per-directory queue isolation
// ---------------------------------------------------------------------------

describe('createEventPipeline — per-directory isolation (P1)', () => {
  it('delivers events from two directories without losing either', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's-a', status: { type: 'busy' } },
        },
      },
      {
        directory: 'dir-b',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's-b', status: { type: 'idle' } },
        },
      },
    ]);

    const dirs = received.map((r) => r.directory).sort();
    expect(dirs).toEqual(['dir-a', 'dir-b']);
  });

  it('keeps distinct sessionIDs in the same directory as independent coalesce slots', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's1', status: { type: 'busy' } },
        },
      },
      {
        directory: 'dir-a',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's2', status: { type: 'busy' } },
        },
      },
    ]);

    expect(received).toHaveLength(2);
    const sessionIds = received.map((r) => r.payload.properties.sessionID).sort();
    expect(sessionIds).toEqual(['s1', 's2']);
  });

  it('collapses repeated session.status for the same session down to the latest', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's1', status: { type: 'busy' } },
        },
      },
      {
        directory: 'dir-a',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's1', status: { type: 'idle' } },
        },
      },
    ]);

    expect(received).toHaveLength(1);
    expect(received[0].payload.properties.status.type).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Option C — message.part.delta coalescing
// ---------------------------------------------------------------------------

describe('createEventPipeline — delta coalescing (Option C)', () => {
  it('accumulates consecutive deltas for the same (messageID, partID, field) into one event', async () => {
    const events = ['Hello ', 'world', ', ', 'how ', 'are ', 'you?'].map((chunk) => ({
      directory: 'dir-a',
      payload: {
        type: 'message.part.delta',
        properties: {
          messageID: 'msg-1',
          partID: 'part-1',
          field: 'text',
          delta: chunk,
        },
      },
    }));

    const received = await runPipelineWithEvents(events);

    expect(received).toHaveLength(1);
    expect(received[0].payload.type).toBe('message.part.delta');
    expect(received[0].payload.properties.delta).toBe('Hello world, how are you?');
    expect(received[0].payload.properties.messageID).toBe('msg-1');
    expect(received[0].payload.properties.partID).toBe('part-1');
    expect(received[0].payload.properties.field).toBe('text');
  });

  it('does NOT merge deltas across different fields on the same part', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'text',
            delta: 'A',
          },
        },
      },
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'reasoning',
            delta: 'B',
          },
        },
      },
    ]);

    expect(received).toHaveLength(2);
    const fieldDelta = received.map((r) => [
      r.payload.properties.field,
      r.payload.properties.delta,
    ]).sort();
    expect(fieldDelta).toEqual([
      ['reasoning', 'B'],
      ['text', 'A'],
    ]);
  });

  it('does NOT merge deltas across different parts on the same message', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'text',
            delta: 'AAA',
          },
        },
      },
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-2',
            field: 'text',
            delta: 'BBB',
          },
        },
      },
    ]);

    expect(received).toHaveLength(2);
    const byPart = Object.fromEntries(
      received.map((r) => [r.payload.properties.partID, r.payload.properties.delta]),
    );
    expect(byPart['part-1']).toBe('AAA');
    expect(byPart['part-2']).toBe('BBB');
  });

  it('does NOT merge deltas across different directories (per-directory queues)', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'text',
            delta: 'from-a',
          },
        },
      },
      {
        directory: 'dir-b',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'text',
            delta: 'from-b',
          },
        },
      },
    ]);

    expect(received).toHaveLength(2);
    const byDir = Object.fromEntries(
      received.map((r) => [r.directory, r.payload.properties.delta]),
    );
    expect(byDir['dir-a']).toBe('from-a');
    expect(byDir['dir-b']).toBe('from-b');
  });

  it('does not touch non-delta events (session.status still replaced, not concatenated)', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's1', status: { type: 'busy' } },
        },
      },
      {
        directory: 'dir-a',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's1', status: { type: 'idle' } },
        },
      },
    ]);

    expect(received).toHaveLength(1);
    expect(received[0].payload.properties.status.type).toBe('idle');
  });
});
