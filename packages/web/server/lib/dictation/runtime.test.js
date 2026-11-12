import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';

import { createDictationRuntime } from './runtime.js';

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
    setTimeout(() => {
      this.emit('transcript', { segmentId, transcript: 'hello world', isFinal: true });
    }, 0);
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

function waitFor(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve(undefined);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
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
    await waitFor(() => messages.some((m) => m.type === 'ready'));

    send(socket, { type: 'start', dictationId: 'd1', format: FORMAT, options: { provider: 'local' } });
    await waitFor(() => messages.some((m) => m.type === 'ack'));
    send(socket, { type: 'chunk', dictationId: 'd1', seq: 0, audio: loudChunkBase64() });
    send(socket, { type: 'finish', dictationId: 'd1', finalSeq: 0 });

    await waitFor(() => messages.some((m) => m.type === 'final'));
    const first = messages.find((m) => m.type === 'final');
    expect(first.text).toBe('hello world');
    expect(sessionCreations).toBe(1);

    // The socket died between `finish` and `final` for this client, so it
    // comes back with the id it had. The server answers from its cache.
    send(socket, { type: 'start', dictationId: 'd1', format: FORMAT, options: { provider: 'local' } });

    await waitFor(() => messages.filter((m) => m.type === 'final').length === 2);
    const second = messages.filter((m) => m.type === 'final')[1];
    expect(second.dictationId).toBe('d1');
    expect(second.text).toBe('hello world');
    // No second stream, no second transcription session.
    expect(sessionCreations).toBe(1);
    expect(messages.some((m) => m.type === 'error')).toBe(false);

    socket.close();
  });

  it('does not answer a different id from the cache', async () => {
    const { socket, messages } = await connect(url);
    await waitFor(() => messages.some((m) => m.type === 'ready'));

    send(socket, { type: 'start', dictationId: 'd2', format: FORMAT, options: { provider: 'local' } });
    await waitFor(() => messages.some((m) => m.type === 'ack'));

    // A fresh id gets a fresh stream, not the finished text of d1.
    expect(sessionCreations).toBe(2);
    expect(messages.some((m) => m.type === 'final')).toBe(false);

    send(socket, { type: 'cancel', dictationId: 'd2' });
    socket.close();
  });

  it('forgets a finished dictation when the client cancels it', async () => {
    const { socket, messages } = await connect(url);
    await waitFor(() => messages.some((m) => m.type === 'ready'));

    send(socket, { type: 'start', dictationId: 'd4', format: FORMAT, options: { provider: 'local' } });
    await waitFor(() => messages.some((m) => m.type === 'ack'));
    send(socket, { type: 'chunk', dictationId: 'd4', seq: 0, audio: loudChunkBase64() });
    send(socket, { type: 'finish', dictationId: 'd4', finalSeq: 0 });
    await waitFor(() => messages.some((m) => m.type === 'final'));

    const creationsBefore = sessionCreations;
    send(socket, { type: 'cancel', dictationId: 'd4' });
    send(socket, { type: 'start', dictationId: 'd4', format: FORMAT, options: { provider: 'local' } });

    // The cancel dropped the cached text, so the start opens a fresh stream
    // instead of answering with the old final.
    await waitFor(() => sessionCreations === creationsBefore + 1);
    expect(messages.filter((m) => m.type === 'final').length).toBe(1);

    send(socket, { type: 'cancel', dictationId: 'd4' });
    socket.close();
  });

  // Last: it shuts the runtime down.
  it('closes the open transcription sessions when the runtime stops', async () => {
    const { socket, messages } = await connect(url);
    await waitFor(() => messages.some((m) => m.type === 'ready'));

    send(socket, { type: 'start', dictationId: 'd3', format: FORMAT, options: { provider: 'local' } });
    await waitFor(() => messages.some((m) => m.type === 'ack'));
    const session = sessions[sessions.length - 1];
    expect(session.closed).toBe(false);

    runtime.stop();

    expect(session.closed).toBe(true);
    socket.close();
  });
});
