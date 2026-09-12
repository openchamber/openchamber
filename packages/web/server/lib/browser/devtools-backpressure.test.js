import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserDevTools } from './devtools.js';

class PageSocket extends EventEmitter {
  readyState = 1;
  CLOSED = 3;
  isPaused = false;
  bufferedAmount = 0;
  sent = [];
  send(raw) { this.sent.push(JSON.parse(raw)); }
  pause() { this.isPaused = true; }
  resume() { this.isPaused = false; }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}

const start = async () => {
  const pageSocket = new PageSocket();
  const messages = [];
  const logger = { warn: vi.fn() };
  const releaseTrace = vi.fn();
  const viewer = {
    id: 'viewer', socket: { readyState: 1, bufferedAmount: 0 }, attached: true,
    tabId: 'sc:page', attachmentGeneration: 1, attachmentRequestId: 'attachment',
    surfaceSession: { sessionId: 'session', closed: false },
  };
  const devtools = createBrowserDevTools({
    browserSessionManager: {
      getLease: () => ({ actor: 'user', viewerId: viewer.id, generation: 1 }),
      getPageConnection: async () => ({ browserContextId: 'context', targetId: 'page',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/private-id' }),
      acquireExclusiveBrowserContext: async () => releaseTrace,
    },
    runViewerOperation: async (_viewer, _target, operation) => operation({ isCurrent: () => true }),
    connectWebSocket: async () => pageSocket,
    sendJson: (_socket, message) => messages.push(message),
    logger,
  });
  devtools.handle(viewer, { type: 'devtoolsStart', tabId: viewer.tabId, requestId: 'start',
    attachmentRequestId: viewer.attachmentRequestId }, 'devtoolsStart');
  await nextTurn();
  const devtoolsId = messages.find((message) => message.type === 'devtoolsStarted').devtoolsId;
  const acknowledge = (chunk) => devtools.handle(viewer, {
    type: 'devtoolsChunkAck', devtoolsId, direction: 'message', messageId: chunk.messageId, index: chunk.index,
  }, 'devtoolsChunkAck');
  const command = (message) => {
    const raw = JSON.stringify(message);
    devtools.handle(viewer, { type: 'devtoolsCommandChunk', devtoolsId,
      messageId: `command-${message.id}`, index: 0, count: 1,
      byteLength: Buffer.byteLength(raw), data: Buffer.from(raw).toString('base64') }, 'devtoolsCommandChunk');
  };
  return { devtools, pageSocket, messages, logger, acknowledge, command, releaseTrace, viewer };
};

describe('DevTools CDP intake backpressure', () => {
  it('drains a decoded burst larger than the outbound count limit without loss or reordering', async () => {
    const ctx = await start();
    try {
      // A paused WebSocket can still emit every message already decoded from its current TCP read.
      for (let index = 0; index < 1000; index++) {
        ctx.pageSocket.emit('message', Buffer.from(JSON.stringify({ method: 'Debugger.scriptParsed', params: { index } })));
      }
      expect(ctx.messages.some((message) => message.type === 'devtoolsClosed')).toBe(false);
      const received = [];
      for (let turn = 0; turn < 1000 && received.length < 1000; turn++) {
        const chunks = ctx.messages.filter((message) => message.type === 'devtoolsMessageChunk').slice(received.length);
        for (const chunk of chunks) {
          received.push(JSON.parse(Buffer.from(chunk.data, 'base64').toString()).params.index);
          ctx.acknowledge(chunk);
        }
        await nextTurn();
      }
      expect(received).toEqual(Array.from({ length: 1000 }, (_, index) => index));
      expect(ctx.logger.warn).not.toHaveBeenCalled();
    } finally { ctx.devtools.dispose(); }
  });

  it('closes a stalled viewer once with payload-free queue and ACK diagnostics', async () => {
    const ctx = await start();
    vi.useFakeTimers();
    try {
      for (let index = 0; index < 300; index++) {
        ctx.pageSocket.emit('message', Buffer.from(JSON.stringify({ method: 'Runtime.consoleAPICalled',
          params: { secret: 'PRIVATE-PAYLOAD' } })));
      }
      await vi.advanceTimersByTimeAsync(15_000);
      expect(ctx.messages.filter((message) => message.type === 'devtoolsClosed')).toMatchObject([
        { code: 'DEVTOOLS_BACKPRESSURE' },
      ]);
      expect(ctx.pageSocket.readyState).toBe(3);
      expect(ctx.logger.warn).toHaveBeenCalledOnce();
      expect(ctx.logger.warn.mock.calls[0][1]).toMatchObject({ code: 'DEVTOOLS_BACKPRESSURE',
        cause: 'ack-timeout', queueCount: 2, inFlightMessages: 2, unackedChunks: 2,
        oldestAckAgeMs: 15_000, viewerBufferedBytes: 0, cdpBufferedBytes: 0 });
      expect(JSON.stringify(ctx.logger.warn.mock.calls)).not.toMatch(/PRIVATE-PAYLOAD|private-id|consoleAPICalled/);
    } finally { ctx.devtools.dispose(); vi.useRealTimers(); }
  });

  it('continues reading tracing completion when teardown starts with paused CDP intake', async () => {
    const ctx = await start();
    try {
      ctx.command({ id: 1, method: 'Tracing.start', params: {} });
      await nextTurn();
      ctx.pageSocket.emit('message', Buffer.from(JSON.stringify({ id: 1, result: {} })));
      ctx.pageSocket.emit('message', Buffer.from(JSON.stringify({ method: 'Tracing.dataCollected', params: { value: [] } })));
      ctx.devtools.detach(ctx.viewer);
      expect(ctx.pageSocket.sent.at(-1).method).toBe('Tracing.end');
      ctx.pageSocket.emit('message', Buffer.from(JSON.stringify({ method: 'Tracing.tracingComplete', params: {} })));
      await nextTurn();
      expect(ctx.releaseTrace).toHaveBeenCalledOnce();
      expect(ctx.pageSocket.readyState).toBe(3);
    } finally { ctx.devtools.dispose(); }
  });

  it('releases tracing when its buffered completion arrives immediately before the socket closes', async () => {
    const ctx = await start();
    try {
      ctx.command({ id: 1, method: 'Tracing.start', params: {} });
      await nextTurn();
      ctx.pageSocket.emit('message', Buffer.from(JSON.stringify({ id: 1, result: {} })));
      ctx.pageSocket.emit('message', Buffer.from(JSON.stringify({ method: 'Tracing.dataCollected', params: { value: [] } })));
      ctx.pageSocket.emit('message', Buffer.from(JSON.stringify({ method: 'Tracing.tracingComplete', params: {} })));
      ctx.pageSocket.close();
      await nextTurn();
      expect(ctx.releaseTrace).toHaveBeenCalledOnce();
    } finally { ctx.devtools.dispose(); }
  });

  it('releases tracing when its buffered completion arrives immediately before a socket error', async () => {
    const ctx = await start();
    try {
      ctx.command({ id: 1, method: 'Tracing.start', params: {} });
      await nextTurn();
      ctx.pageSocket.emit('message', Buffer.from(JSON.stringify({ id: 1, result: {} })));
      ctx.pageSocket.emit('message', Buffer.from(JSON.stringify({ method: 'Tracing.dataCollected', params: { value: [] } })));
      ctx.pageSocket.emit('message', Buffer.from(JSON.stringify({ method: 'Tracing.tracingComplete', params: {} })));
      ctx.pageSocket.emit('error', new Error('socket failure'));
      ctx.pageSocket.close();
      await nextTurn();
      expect(ctx.releaseTrace).toHaveBeenCalledOnce();
    } finally { ctx.devtools.dispose(); }
  });

  it('keeps buffered CDP input inside the aggregate message-byte budget', async () => {
    const ctx = await start();
    try {
      ctx.pageSocket.emit('message', Buffer.from('{"id":1,"result":{}}'));
      ctx.pageSocket.emit('message', Buffer.from('{"id":2,"result":{}}'));
      const message = Buffer.alloc(64 * 1024 * 1024, ' ');
      message.write('{"id":3,"result":{}}');
      ctx.pageSocket.emit('message', message);
      expect(ctx.logger.warn).toHaveBeenCalledOnce();
      expect(ctx.logger.warn.mock.calls[0][1]).toMatchObject({ cause: 'ingress-bytes',
        queuedCdpBytes: message.length, queueCount: 2 });
      expect(ctx.pageSocket.readyState).toBe(3);
    } finally { ctx.devtools.dispose(); }
  });
});
