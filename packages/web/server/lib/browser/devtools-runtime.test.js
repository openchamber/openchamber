import { once } from 'node:events';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { createBrowserDevTools } from './devtools.js';

const { expect, test } = process.versions.bun ? await import('bun:test') : await import('vitest');

const createPageServer = async () => {
  const opened = Promise.withResolvers();
  if (process.versions.bun) {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, bunServer) {
        if (bunServer.upgrade(request)) return;
        return new Response('WebSocket upgrade required', { status: 426 });
      },
      websocket: {
        open(socket) { opened.resolve(socket); },
        message() {},
      },
    });
    return { opened: opened.promise, port: server.port, stop: () => server.stop(true) };
  }

  const requireWebSocketPackage = createRequire(import.meta.resolve('ws/package.json'));
  const { WebSocketServer } = requireWebSocketPackage('./');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.once('connection', opened.resolve);
  await once(server, 'listening');
  return {
    opened: opened.promise,
    port: server.address().port,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
};

test('DevTools forwards and bounds CDP messages over a real WebSocket', async () => {
  // Given: a real loopback WebSocket standing in for Chrome's page endpoint.
  const pageServer = await createPageServer();
  const viewer = {
    id: 'viewer', socket: { readyState: 1, bufferedAmount: 0 }, attached: true,
    tabId: 'sc:page', attachmentGeneration: 1, attachmentRequestId: 'attachment',
    surfaceSession: { sessionId: 'session', closed: false },
  };
  const started = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const secondChunk = Promise.withResolvers();
  const thirdChunk = Promise.withResolvers();
  const messages = [];
  const devtools = createBrowserDevTools({
    browserSessionManager: {
      getLease: () => ({ actor: 'user', viewerId: viewer.id, generation: 1 }),
      getPageConnection: async () => ({
        browserContextId: 'context', targetId: 'page',
        webSocketDebuggerUrl: `ws://127.0.0.1:${pageServer.port}/devtools/browser/private-id`,
      }),
    },
    runViewerOperation: async (_viewer, _target, operation) => operation({ isCurrent: () => true }),
    sendJson: (_socket, message) => {
      messages.push(message);
      if (message.type === 'devtoolsStarted') started.resolve(message);
      if (message.type === 'devtoolsError') started.reject(new Error(message.code));
      if (message.type === 'devtoolsClosed') closed.resolve(message);
      const chunkCount = messages.filter((entry) => entry.type === 'devtoolsMessageChunk').length;
      if (chunkCount === 2) secondChunk.resolve();
      if (chunkCount === 3) thirdChunk.resolve();
    },
    logger: { warn() {} },
  });

  try {
    // When: DevTools starts and Chrome emits three messages before the viewer acknowledges any.
    devtools.handle(viewer, {
      type: 'devtoolsStart', tabId: viewer.tabId, requestId: 'start',
      attachmentRequestId: viewer.attachmentRequestId,
    }, 'devtoolsStart');
    const startMessage = await started.promise;
    const pageSocket = await pageServer.opened;
    for (let index = 0; index < 3; index++) {
      pageSocket.send(JSON.stringify({ method: 'Debugger.scriptParsed', params: { index } }));
    }
    await secondChunk.promise;
    await nextTurn();

    // Then: two messages fill the outbound window, the third waits, and one ACK resumes delivery.
    let chunks = messages.filter((message) => message.type === 'devtoolsMessageChunk');
    expect(chunks).toHaveLength(2);
    devtools.handle(viewer, {
      type: 'devtoolsChunkAck', devtoolsId: startMessage.devtoolsId, direction: 'message',
      messageId: chunks[0].messageId, index: chunks[0].index,
    }, 'devtoolsChunkAck');
    await thirdChunk.promise;
    chunks = messages.filter((message) => message.type === 'devtoolsMessageChunk');
    expect(chunks.map((chunk) => JSON.parse(Buffer.from(chunk.data, 'base64').toString()).params.index)).toEqual([0, 1, 2]);

    pageSocket.close();
    await expect(closed.promise).resolves.toMatchObject({ code: 'DEVTOOLS_CONNECTION_CLOSED' });
  } finally {
    devtools.dispose();
    await pageServer.stop();
  }
});
