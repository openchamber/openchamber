import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { createBrowserDevTools } from './devtools.js';

const settle = () => nextTurn();

class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 0; this.sent = []; this.CLOSED = 3; this.isPaused = false; }
  pause() { this.isPaused = true; }
  resume() { this.isPaused = false; }
  send(value) {
    if (this.failMethod && JSON.parse(value).method === this.failMethod) throw new Error('send failed');
    this.sent.push(String(value));
  }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.terminated = true; this.close(); }
}

const chunk = (value) => Buffer.from(value, 'utf8').toString('base64');

const setup = () => {
  const socket = new FakeSocket();
  const messages = [];
  const viewport = [];
  const lease = { actor: 'user', viewerId: 'viewer-a', generation: 4 };
  const traceRelease = vi.fn();
  const manager = {
    getLease: () => lease,
    acquireExclusiveBrowserContext: vi.fn(() => traceRelease),
    getPageConnection: vi.fn(async () => ({
      browserContextId: 'context-a', targetId: 'page-a',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/private-browser-id',
    })),
  };
  const viewer = {
    id: 'viewer-a', socket: { readyState: 1, bufferedAmount: 0 }, attached: true,
    tabId: 'sc:page-a', attachmentGeneration: 3, attachmentRequestId: 'attach-a',
    surfaceSession: { sessionId: 'session-a', closed: false },
  };
  const devtools = createBrowserDevTools({
    browserSessionManager: manager,
    runViewerOperation: async (_viewer, _targetId, operation) => operation({ isCurrent: () => true }),
    sendJson: (_surface, message) => messages.push(message),
    onViewportOverride: (_viewer, change) => {
      viewport.push(change);
      return change.apply?.();
    },
    connectWebSocket: async (url) => { socket.url = url; socket.readyState = 1; return socket; },
    randomBytes: () => Buffer.alloc(24, 5),
    logger: { warn: vi.fn() },
  });
  return { devtools, manager, messages, socket, viewer, viewport, lease, traceRelease };
};

describe('full browser DevTools bridge', () => {
  it('binds start to the current attachment and opens a dedicated owned page socket', async () => {
    const ctx = setup();
    expect(ctx.devtools.handle(ctx.viewer, {
      type: 'devtoolsStart', tabId: 'sc:page-a', requestId: 'request-a', attachmentRequestId: 'attach-a',
    }, 'devtoolsStart')).toBe(true);
    await settle();
    expect(ctx.socket.url).toBe('ws://127.0.0.1:9222/devtools/page/page-a');
    expect(ctx.messages.at(-1)).toMatchObject({
      type: 'devtoolsStarted', tabId: 'sc:page-a', requestId: 'request-a', attachmentRequestId: 'attach-a',
    });
    expect(ctx.messages.at(-1).frontendPath).toMatch(/^\/api\/browser-devtools\/[^/]+\/inspector\.html$/);
    expect(JSON.stringify(ctx.messages)).not.toContain('private-browser-id');
    expect(ctx.viewport).toEqual([expect.objectContaining({ type: 'open', tabId: 'sc:page-a', sessionId: 'session-a' })]);
  });

  it('reassembles bounded commands, applies policy, and forwards responses without truncation', async () => {
    const ctx = setup();
    ctx.devtools.handle(ctx.viewer, { type: 'devtoolsStart', tabId: 'sc:page-a', requestId: 'request-a', attachmentRequestId: 'attach-a' }, 'devtoolsStart');
    await settle();
    const raw = JSON.stringify({ id: 7, method: 'CSS.setStyleTexts', params: { edits: [] } });
    ctx.devtools.handle(ctx.viewer, {
      type: 'devtoolsCommandChunk', devtoolsId: ctx.messages.at(-1).devtoolsId,
      messageId: 'command-a', index: 0, count: 1, byteLength: Buffer.byteLength(raw), data: chunk(raw),
    }, 'devtoolsCommandChunk');
    await settle();
    expect(JSON.parse(ctx.socket.sent.at(-1))).toEqual(JSON.parse(raw));
    const reply = JSON.stringify({ id: 7, result: { style: 'x'.repeat(90_000) } });
    ctx.socket.emit('message', Buffer.from(reply));
    await settle();
    const chunks = ctx.messages.filter((message) => message.type === 'devtoolsMessageChunk');
    expect(chunks.length).toBeGreaterThan(1);
    expect(Buffer.concat(chunks.map((entry) => Buffer.from(entry.data, 'base64'))).toString('utf8')).toBe(reply);
  });

  it('closes with a fixed error on forbidden commands and never exposes raw content', async () => {
    const ctx = setup();
    ctx.devtools.handle(ctx.viewer, { type: 'devtoolsStart', tabId: 'sc:page-a', requestId: 'request-a', attachmentRequestId: 'attach-a' }, 'devtoolsStart');
    await settle();
    const raw = JSON.stringify({ id: 9, method: 'Page.navigate', params: { url: 'file:///private/secret.txt' } });
    ctx.devtools.handle(ctx.viewer, {
      type: 'devtoolsCommandChunk', devtoolsId: ctx.messages.at(-1).devtoolsId,
      messageId: 'command-a', index: 0, count: 1, byteLength: Buffer.byteLength(raw), data: chunk(raw),
    }, 'devtoolsCommandChunk');
    expect(ctx.messages.at(-1)).toMatchObject({ type: 'devtoolsClosed', code: 'DEVTOOLS_PROTOCOL_REJECTED' });
    expect(JSON.stringify(ctx.messages)).not.toContain('secret.txt');
  });

  it('returns a fixed CDP error for optional unsupported probes without closing DevTools', async () => {
    const ctx = setup();
    ctx.devtools.handle(ctx.viewer, { type: 'devtoolsStart', tabId: 'sc:page-a', requestId: 'request-a', attachmentRequestId: 'attach-a' }, 'devtoolsStart');
    await settle();
    const devtoolsId = ctx.messages.at(-1).devtoolsId;
    const raw = JSON.stringify({ id: 10, method: 'Target.setDiscoverTargets', params: { discover: true } });
    ctx.devtools.handle(ctx.viewer, {
      type: 'devtoolsCommandChunk', devtoolsId, messageId: 'probe-a', index: 0, count: 1,
      byteLength: Buffer.byteLength(raw), data: chunk(raw),
    }, 'devtoolsCommandChunk');
    const responseChunk = ctx.messages.at(-1);
    expect(responseChunk).toMatchObject({ type: 'devtoolsMessageChunk', devtoolsId });
    expect(JSON.parse(Buffer.from(responseChunk.data, 'base64').toString('utf8'))).toEqual({
      id: 10, error: { code: -32_000, message: 'Command is not available for this page' },
    });
    expect(ctx.socket.readyState).toBe(1);
  });

  it('drops stale CDP events after lease takeover or attachment replacement', async () => {
    const ctx = setup();
    ctx.devtools.handle(ctx.viewer, { type: 'devtoolsStart', tabId: 'sc:page-a', requestId: 'request-a', attachmentRequestId: 'attach-a' }, 'devtoolsStart');
    await settle();
    ctx.lease.viewerId = 'viewer-b';
    ctx.socket.emit('message', Buffer.from(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { value: 'private-event' } })));
    await settle();
    expect(JSON.stringify(ctx.messages)).not.toContain('private-event');
    expect(ctx.messages.at(-1)).toMatchObject({ type: 'devtoolsClosed', code: 'DEVTOOLS_CONTROL_LOST' });
    expect(ctx.viewport.at(-1)).toEqual(expect.objectContaining({ type: 'close', tabId: 'sc:page-a', sessionId: 'session-a' }));
  });

  it('admits browser-wide tracing only through the exclusive-context hook and releases it on completion', async () => {
    const ctx = setup();
    ctx.devtools.handle(ctx.viewer, { type: 'devtoolsStart', tabId: 'sc:page-a', requestId: 'request-a', attachmentRequestId: 'attach-a' }, 'devtoolsStart');
    await settle();
    const devtoolsId = ctx.messages.at(-1).devtoolsId;
    const raw = JSON.stringify({ id: 12, method: 'Tracing.start', params: {} });
    ctx.devtools.handle(ctx.viewer, {
      type: 'devtoolsCommandChunk', devtoolsId, messageId: 'trace-a', index: 0, count: 1,
      byteLength: Buffer.byteLength(raw), data: chunk(raw),
    }, 'devtoolsCommandChunk');
    await settle();
    expect(ctx.manager.acquireExclusiveBrowserContext).toHaveBeenCalledWith('session-a');
    expect(JSON.parse(ctx.socket.sent.at(-1))).toEqual(JSON.parse(raw));
    expect(ctx.traceRelease).not.toHaveBeenCalled();
    ctx.socket.emit('message', JSON.stringify({ method: 'Tracing.tracingComplete', params: { stream: 'trace-stream' } }));
    await settle();
    expect(ctx.traceRelease).toHaveBeenCalledOnce();
  });

  it('releases tracing admission when Chrome rejects the start command', async () => {
    const ctx = setup();
    ctx.devtools.handle(ctx.viewer, { type: 'devtoolsStart', tabId: 'sc:page-a', requestId: 'request-a', attachmentRequestId: 'attach-a' }, 'devtoolsStart');
    await settle();
    const devtoolsId = ctx.messages.at(-1).devtoolsId;
    const raw = JSON.stringify({ id: 13, method: 'Tracing.start', params: {} });
    ctx.devtools.handle(ctx.viewer, {
      type: 'devtoolsCommandChunk', devtoolsId, messageId: 'trace-a', index: 0, count: 1,
      byteLength: Buffer.byteLength(raw), data: chunk(raw),
    }, 'devtoolsCommandChunk');
    await settle();
    ctx.socket.emit('message', JSON.stringify({ id: 13, error: { code: -32000, message: 'start failed' } }));
    await settle();
    expect(ctx.traceRelease).toHaveBeenCalledOnce();
  });

  it('ends active tracing and holds admission until Chrome confirms teardown', async () => {
    const ctx = setup();
    ctx.devtools.handle(ctx.viewer, { type: 'devtoolsStart', tabId: 'sc:page-a', requestId: 'request-a', attachmentRequestId: 'attach-a' }, 'devtoolsStart');
    await settle();
    const devtoolsId = ctx.messages.at(-1).devtoolsId;
    const raw = JSON.stringify({ id: 14, method: 'Tracing.start', params: {} });
    ctx.devtools.handle(ctx.viewer, {
      type: 'devtoolsCommandChunk', devtoolsId, messageId: 'trace-a', index: 0, count: 1,
      byteLength: Buffer.byteLength(raw), data: chunk(raw),
    }, 'devtoolsCommandChunk');
    await settle();
    ctx.socket.emit('message', JSON.stringify({ id: 14, result: {} }));
    ctx.devtools.detach(ctx.viewer);
    expect(ctx.socket.sent.map((value) => JSON.parse(value).method).filter(Boolean).at(-1)).toBe('Tracing.end');
    expect(ctx.traceRelease).not.toHaveBeenCalled();
    expect(ctx.socket.readyState).toBe(1);
    ctx.socket.emit('message', JSON.stringify({ method: 'Tracing.tracingComplete', params: {} }));
    await settle();
    expect(ctx.traceRelease).toHaveBeenCalledOnce();
    expect(ctx.socket.readyState).toBe(3);
  });

  it('keeps tracing admission after teardown timeout and an uncertain socket close', async () => {
    vi.useFakeTimers();
    try {
      const ctx = setup();
      ctx.devtools.handle(ctx.viewer, { type: 'devtoolsStart', tabId: 'sc:page-a', requestId: 'request-a', attachmentRequestId: 'attach-a' }, 'devtoolsStart');
      await settle();
      const devtoolsId = ctx.messages.at(-1).devtoolsId;
      const raw = JSON.stringify({ id: 15, method: 'Tracing.start', params: {} });
      ctx.devtools.handle(ctx.viewer, {
        type: 'devtoolsCommandChunk', devtoolsId, messageId: 'trace-a', index: 0, count: 1,
        byteLength: Buffer.byteLength(raw), data: chunk(raw),
      }, 'devtoolsCommandChunk');
      await settle();
      ctx.socket.emit('message', JSON.stringify({ id: 15, result: {} }));
      ctx.devtools.detach(ctx.viewer);
      vi.advanceTimersByTime(15_000);
      await settle();
      expect(ctx.socket.terminated).toBe(true);
      expect(ctx.traceRelease).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps tracing admission when sending the teardown command fails', async () => {
    const ctx = setup();
    ctx.devtools.handle(ctx.viewer, { type: 'devtoolsStart', tabId: 'sc:page-a', requestId: 'request-a', attachmentRequestId: 'attach-a' }, 'devtoolsStart');
    await settle();
    const devtoolsId = ctx.messages.at(-1).devtoolsId;
    const raw = JSON.stringify({ id: 16, method: 'Tracing.start', params: {} });
    ctx.devtools.handle(ctx.viewer, {
      type: 'devtoolsCommandChunk', devtoolsId, messageId: 'trace-a', index: 0, count: 1,
      byteLength: Buffer.byteLength(raw), data: chunk(raw),
    }, 'devtoolsCommandChunk');
    await settle();
    ctx.socket.emit('message', JSON.stringify({ id: 16, result: {} }));
    ctx.socket.failMethod = 'Tracing.end';
    ctx.devtools.detach(ctx.viewer);
    expect(ctx.socket.terminated).toBe(true);
    expect(ctx.traceRelease).not.toHaveBeenCalled();
  });

  it('rejects replayed cumulative acknowledgements instead of letting them postpone backpressure', async () => {
    const ctx = setup();
    ctx.devtools.handle(ctx.viewer, { type: 'devtoolsStart', tabId: 'sc:page-a', requestId: 'request-a', attachmentRequestId: 'attach-a' }, 'devtoolsStart');
    await settle();
    const devtoolsId = ctx.messages.at(-1).devtoolsId;
    ctx.socket.emit('message', JSON.stringify({ id: 1, result: { value: 'x'.repeat(300_000) } }));
    await settle();
    const first = ctx.messages.find((message) => message.type === 'devtoolsMessageChunk');
    const ack = { type: 'devtoolsChunkAck', devtoolsId, direction: 'message', messageId: first.messageId, index: 0 };
    ctx.devtools.handle(ctx.viewer, ack, 'devtoolsChunkAck');
    ctx.devtools.handle(ctx.viewer, ack, 'devtoolsChunkAck');
    expect(ctx.messages.at(-1)).toMatchObject({ type: 'devtoolsClosed', code: 'DEVTOOLS_INVALID_REQUEST' });
  });

  it('keeps DevTools emulation inside the shared viewport writer until its CDP response', async () => {
    const ctx = setup();
    ctx.devtools.handle(ctx.viewer, { type: 'devtoolsStart', tabId: 'sc:page-a', requestId: 'request-a', attachmentRequestId: 'attach-a' }, 'devtoolsStart');
    await settle();
    const devtoolsId = ctx.messages.at(-1).devtoolsId;
    const sendCommand = (messageId, raw) => ctx.devtools.handle(ctx.viewer, {
      type: 'devtoolsCommandChunk', devtoolsId, messageId, index: 0, count: 1,
      byteLength: Buffer.byteLength(raw), data: chunk(raw),
    }, 'devtoolsCommandChunk');
    const emulation = JSON.stringify({
      id: 20, method: 'Emulation.setDeviceMetricsOverride',
      params: { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    });
    const css = JSON.stringify({ id: 21, method: 'CSS.enable', params: {} });
    sendCommand('emulation-a', emulation);
    sendCommand('css-a', css);
    await settle();
    expect(ctx.socket.sent.map((raw) => JSON.parse(raw).id)).toEqual([20]);
    ctx.socket.emit('message', JSON.stringify({ id: 20, result: {} }));
    await settle();
    expect(ctx.socket.sent.map((raw) => JSON.parse(raw).id)).toEqual([20, 21]);
    expect(ctx.viewport).toContainEqual(expect.objectContaining({ type: 'changed', devtoolsId }));
  });
});
