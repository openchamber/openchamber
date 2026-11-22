import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';

import { createDictationRuntime } from './runtime.js';

const DICTATION_WS_MAX_PAYLOAD_BYTES = 512 * 1024;

// A fake socket emitted straight into the server bypasses the transport, so
// nothing but the handler's own check can refuse an oversized frame — under
// Bun the bundled ws does not enforce maxPayload (#1464).
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closeCalls = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  ping() {}

  close(code, reason) {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.emit('close');
  }
}

function createRuntime() {
  return createDictationRuntime({
    app: { post() {}, get() {}, delete() {} },
    server: new EventEmitter(),
    express: { json: () => (_req, _res, next) => next?.() },
    uiAuthController: null,
    isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade() {},
    modelsDir: '/tmp/openchamber-dictation-test-models',
  });
}

describe('dictation runtime frame guard', () => {
  it('closes over-cap frames with 1009 in the handler and does not parse them', () => {
    const runtime = createRuntime();
    try {
      const socket = new FakeSocket();
      runtime.wsServer.emit('connection', socket);
      socket.emit('message', Buffer.alloc(DICTATION_WS_MAX_PAYLOAD_BYTES + 1), false);
      expect(socket.closeCalls).toEqual([{ code: 1009, reason: 'Dictation frame too large' }]);
      // Only the ready frame was sent: the oversized frame never reached JSON.parse.
      expect(socket.sent).toEqual([{ type: 'ready' }]);
    } finally {
      runtime.stop();
    }
  });

  it('processes an at-cap frame and answers ping with pong', () => {
    const runtime = createRuntime();
    try {
      const socket = new FakeSocket();
      runtime.wsServer.emit('connection', socket);
      const base = JSON.stringify({ type: 'ping', pad: '' });
      const frame = JSON.stringify({ type: 'ping', pad: 'x'.repeat(DICTATION_WS_MAX_PAYLOAD_BYTES - base.length) });
      expect(Buffer.byteLength(frame)).toBe(DICTATION_WS_MAX_PAYLOAD_BYTES);
      socket.emit('message', Buffer.from(frame), false);
      expect(socket.closeCalls).toEqual([]);
      expect(socket.sent).toEqual([{ type: 'ready' }, { type: 'pong' }]);
      socket.close();
    } finally {
      runtime.stop();
    }
  });
});
