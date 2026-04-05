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
});
