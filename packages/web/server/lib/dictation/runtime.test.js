import { describe, expect, it, afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { createDictationRuntime } from './runtime.js';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';


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

// ---- upstream tests ----

let modelsDir;
const runtimes = [];

beforeEach(async () => {
  modelsDir = await mkdtemp(path.join(os.tmpdir(), 'dictation-runtime-'));
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.stop();
  await rm(modelsDir, { recursive: true, force: true });
});

function setup() {
  const routes = new Map();
  const app = {
    post: (path, ...handlers) => routes.set(path, handlers.at(-1)),
    get: (path, handler) => routes.set(path, handler),
    delete: (path, handler) => routes.set(`DELETE ${path}`, handler),
  };
  const server = new EventEmitter();
  const rejectWebSocketUpgrade = vi.fn();
  const runtime = createDictationRuntime({
    app,
    server,
    express: { json: () => () => {} },
    isRequestOriginAllowed: () => false,
    rejectWebSocketUpgrade,
    modelsDir,
  });
  runtimes.push(runtime);
  return { routes, server, rejectWebSocketUpgrade };
}

function response() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    send: vi.fn(),
  };
}

describe('dictation runtime boundaries', () => {
  it('keeps rejection of missing, non-string and blank speech text', async () => {
    const { routes } = setup();
    const speak = routes.get('/api/dictation/tts/speak');
    for (const body of [null, undefined, false, 2, 'text', [], { text: '  ' }, { text: 42 }]) {
      const res = response();
      await speak({ body }, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Text is required' });
    }
  });

  it('keeps inherited speech fields and arbitrary rejection messages', async () => {
    const { routes } = setup();
    const speak = routes.get('/api/dictation/tts/speak');
    for (const rejection of [{ message: 42 }, null, { message: '' }]) {
      const body = Object.create({
        text: 'inherited',
        get model() { throw rejection; },
      });
      const res = response();
      await speak({ body }, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: rejection?.message || 'Failed to synthesize speech',
      });
    }
  });

  it('reads status with unchecked query values without downloading models', async () => {
    const { routes } = setup();
    const res = response();
    await routes.get('/api/dictation/status')({
      query: { provider: 'openai-compatible', localModel: ['not-a-model'] },
    }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai-compatible',
      available: true,
      models: expect.arrayContaining([expect.objectContaining({ installed: false })]),
    }));
  });

  it('keeps opaque-origin and refused-origin upgrade rejection', async () => {
    const { server, rejectWebSocketUpgrade } = setup();
    const socket = {};
    server.emit('upgrade', {
      url: '/api/dictation/ws', headers: { origin: 'null' },
    }, socket, Buffer.alloc(0));
    expect(rejectWebSocketUpgrade).toHaveBeenCalledWith(socket, 403, 'Invalid origin');
    rejectWebSocketUpgrade.mockClear();
    server.emit('upgrade', {
      url: '/api/dictation/ws', headers: { origin: 'https://refused.example' },
    }, socket, Buffer.alloc(0));
    await vi.waitFor(() => {
      expect(rejectWebSocketUpgrade).toHaveBeenCalledWith(socket, 403, 'Invalid origin');
    });
  });
});

const FORMAT = 'audio/pcm;rate=16000;bits=16';

const sessions = [];
let sessionCreations = 0;

class FakeSttSession extends EventEmitter {
  constructor() {
    super();
    this.requiredSampleRate = 16000;
    this.commits = 0;
    this.closed = false;
    this.segmentCounter = 0;
  }

  appendPcm16() {}

  commit() {
    const segmentId = `seg-${this.segmentCounter}`;
    this.segmentCounter += 1;
    this.commits += 1;
    this.emit('committed', { segmentId, previousSegmentId: null });
    setImmediate(() => {
      this.emit('transcript', { segmentId, transcript: 'hello world', isFinal: true });
    });
  }

  clear() {}

  close() {
    this.closed = true;
  }
}

// The runtime is tested over its real WebSocket route, with only the speech
// provider replaced: no model, no worker, no network.
const fakeService = {
  createSttSession: async () => {
    sessionCreations += 1;
    const session = new FakeSttSession();
    sessions.push(session);
    return { session };
  },
  shutdown: () => {},
};

function loudChunkBase64(samples = 1600, amplitude = 8000) {
  const arr = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    arr[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return Buffer.from(arr.buffer).toString('base64');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages = [];
    socket.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString('utf8')));
    });
    socket.on('error', reject);
    socket.on('open', () => resolve({ socket, messages }));
  });
}

const send = (socket, message) => socket.send(JSON.stringify(message));

describe('dictation runtime', () => {
  let server;
  let runtime;
  let url;

  beforeAll(async () => {
    const app = express();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    url = `ws://127.0.0.1:${port}/api/dictation/ws`;
    runtime = createDictationRuntime({
      app,
      server,
      express,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade: (socket, status, message) => {
        socket.write(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
        socket.destroy();
      },
      modelsDir: path.join(os.tmpdir(), 'openchamber-dictation-runtime-test'),
      service: fakeService,
    });
  });

  afterAll(() => {
    runtime?.stop();
    server?.close();
  });

  it('answers a repeated start of a finished dictation with the same final', async () => {
    const { socket, messages } = await connect(url);
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'ready')).toBe(true));

    send(socket, { type: 'start', dictationId: 'd1', format: FORMAT, options: { provider: 'local' } });
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'ack')).toBe(true));
    send(socket, { type: 'chunk', dictationId: 'd1', seq: 0, audio: loudChunkBase64() });
    send(socket, { type: 'finish', dictationId: 'd1', finalSeq: 0 });

    await vi.waitFor(() => expect(messages.some((m) => m.type === 'final')).toBe(true));
    const first = messages.find((m) => m.type === 'final');
    expect(first.text).toBe('hello world');
    expect(sessionCreations).toBe(1);

    const closed = once(socket, 'close');
    socket.terminate();
    await closed;
    const reconnected = await connect(url);
    send(reconnected.socket, { type: 'start', dictationId: 'd1', format: FORMAT, options: { provider: 'local' } });

    await vi.waitFor(() => expect(reconnected.messages.some((m) => m.type === 'final')).toBe(true));
    const second = reconnected.messages.find((m) => m.type === 'final');
    expect(second.dictationId).toBe('d1');
    expect(second.text).toBe('hello world');
    // No second stream, no second transcription session.
    expect(sessionCreations).toBe(1);
    expect(reconnected.messages.some((m) => m.type === 'error')).toBe(false);

    reconnected.socket.close();
  });

  it('does not answer a different id from the cache', async () => {
    const { socket, messages } = await connect(url);
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'ready')).toBe(true));

    // Finish d5 so the runtime holds its final in the cache.
    send(socket, { type: 'start', dictationId: 'd5', format: FORMAT, options: { provider: 'local' } });
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'ack')).toBe(true));
    send(socket, { type: 'chunk', dictationId: 'd5', seq: 0, audio: loudChunkBase64() });
    send(socket, { type: 'finish', dictationId: 'd5', finalSeq: 0 });
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'final')).toBe(true));
    const creationsBefore = sessionCreations;

    send(socket, { type: 'start', dictationId: 'd2', format: FORMAT, options: { provider: 'local' } });
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'ack' && m.dictationId === 'd2')).toBe(true));

    // A fresh id gets a fresh stream, not the finished text of d5.
    expect(sessionCreations).toBe(creationsBefore + 1);
    expect(messages.filter((m) => m.type === 'final').map((m) => m.dictationId)).toEqual(['d5']);

    send(socket, { type: 'cancel', dictationId: 'd2' });
    socket.close();
  });

  it('forgets a finished dictation when the client cancels it', async () => {
    const { socket, messages } = await connect(url);
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'ready')).toBe(true));

    send(socket, { type: 'start', dictationId: 'd4', format: FORMAT, options: { provider: 'local' } });
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'ack')).toBe(true));
    send(socket, { type: 'chunk', dictationId: 'd4', seq: 0, audio: loudChunkBase64() });
    send(socket, { type: 'finish', dictationId: 'd4', finalSeq: 0 });
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'final')).toBe(true));

    const creationsBefore = sessionCreations;
    send(socket, { type: 'cancel', dictationId: 'd4' });
    send(socket, { type: 'start', dictationId: 'd4', format: FORMAT, options: { provider: 'local' } });

    // The cancel dropped the cached text, so the start opens a fresh stream
    // instead of answering with the old final.
    await vi.waitFor(() => expect(sessionCreations).toBe(creationsBefore + 1));
    expect(messages.filter((m) => m.type === 'final').length).toBe(1);

    send(socket, { type: 'cancel', dictationId: 'd4' });
    socket.close();
  });

  // Last: it shuts the runtime down.
  it('closes the open transcription sessions when the runtime stops', async () => {
    const { socket, messages } = await connect(url);
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'ready')).toBe(true));

    send(socket, { type: 'start', dictationId: 'd3', format: FORMAT, options: { provider: 'local' } });
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'ack')).toBe(true));
    const session = sessions[sessions.length - 1];
    expect(session.closed).toBe(false);

    runtime.stop();

    expect(session.closed).toBe(true);
    socket.close();
  });
});
