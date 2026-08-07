import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocket } from 'ws';
import { createBrowserRuntime } from './runtime.js';
import { registerBrowserRoutes } from './routes.js';

const TAG = 1;
const encode = (message) => {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from([TAG]), payload]);
};
const decode = (raw) => {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const body = buffer[0] === TAG ? buffer.subarray(1) : buffer;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
};

// A deterministic in-memory Chrome DevTools Protocol connection. It answers the
// exact commands the runtime issues and emits the events the runtime listens
// for, so the WebSocket transport, screencast broadcast, and input dispatch can
// be tested without launching a real browser.
const createFakeCdp = () => {
  const listeners = new Set();
  const calls = [];
  const emit = (method, params, sessionId) => {
    for (const listener of listeners) listener(method, params, sessionId);
  };
  const connection = {
    isOpen: true,
    send: async (method, params = {}, sessionId) => {
      calls.push({ method, params, sessionId });
      switch (method) {
        case 'Target.createTarget':
          return { targetId: `target-${calls.length}` };
        case 'Target.attachToTarget':
          return { sessionId: `session-${params.targetId}` };
        case 'Runtime.evaluate':
          return { result: { value: 'Fake Title' } };
        case 'Page.navigate':
          queueMicrotask(() => emit('Page.loadEventFired', {}, sessionId));
          return {};
        case 'Page.startScreencast':
          queueMicrotask(() => emit('Page.screencastFrame', { data: Buffer.from('frame-bytes').toString('base64'), metadata: {}, sessionId: 1 }, sessionId));
          return {};
        case 'Page.captureScreenshot':
          return { data: Buffer.from('png-bytes').toString('base64') };
        default:
          return {};
      }
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose: () => () => {},
    close: () => { connection.isOpen = false; },
  };
  return { connection, calls };
};

describe('browser websocket transport (fake CDP)', () => {
  let dataDir;
  let runtime;
  let appServer;
  let wsUrl;
  let fake;

  // Buffers every decoded message from the moment the socket is created so a
  // waiter can never miss the synchronous snapshot sent on connect.
  const track = (socket) => {
    const received = [];
    const waiters = [];
    socket.on('message', (raw) => {
      const message = decode(raw);
      if (!message) return;
      received.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        }
      }
    });
    return (predicate, timeoutMs = 5000) => new Promise((resolve, reject) => {
      const existing = received.find(predicate);
      if (existing) {
        resolve(existing);
        return;
      }
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for browser socket message')), timeoutMs);
      waiters.push({ predicate, resolve, timeout });
    });
  };

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-browser-ws-'));
    fake = createFakeCdp();
    runtime = createBrowserRuntime({
      fs,
      fsPromises: fs.promises,
      path,
      spawn: () => ({ once: () => {}, kill: () => {}, pid: 1234 }),
      crypto,
      dataDir,
      searchPathFor: () => '/usr/bin/fake-chrome',
      findBrowserExecutable: () => '/usr/bin/fake-chrome',
      launchChrome: async () => ({ process: { once: () => {}, kill: () => {}, pid: 1234 }, webSocketDebuggerUrl: 'ws://127.0.0.1:0/devtools/browser/fake' }),
      connectCdp: async () => fake.connection,
    });
    const app = express();
    registerBrowserRoutes(app, { browserRuntime: runtime });
    appServer = http.createServer(app);
    runtime.attachWebSocket(appServer);
    await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
    wsUrl = `ws://127.0.0.1:${appServer.address().port}/api/browser/ws`;
  });

  afterAll(async () => {
    await runtime?.shutdown();
    await new Promise((resolve) => {
      appServer.closeAllConnections?.();
      appServer.close(() => resolve());
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports supported and running state', () => {
    expect(runtime.state().supported).toBe(true);
  });

  it('streams a snapshot, screencast frames, and dispatches input over the socket', async () => {
    const created = await runtime.executeAction('tab.create', { url: 'https://example.com' });
    const tabId = created.tab.id;

    const socket = new WebSocket(wsUrl);
    socket.binaryType = 'arraybuffer';
    const waitFor = track(socket);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const snapshot = await waitFor((message) => message.t === 'snapshot');
    expect(snapshot.state.supported).toBe(true);
    expect(snapshot.state.tabs.some((tab) => tab.id === tabId)).toBe(true);

    // Watching the tab starts the screencast and the frame is broadcast.
    socket.send(encode({ t: 'watch', tabId }));
    const frame = await waitFor((message) => message.t === 'frame' && message.tabId === tabId);
    expect(typeof frame.data).toBe('string');
    expect(frame.data.length).toBeGreaterThan(0);

    // Driving a click over the socket reaches the DevTools input domain and
    // broadcasts a cursor update.
    socket.send(encode({ t: 'input', action: 'click', params: { tabId, x: 42, y: 24 } }));
    const cursorMessage = await waitFor((message) => message.t === 'cursor' && message.tabId === tabId);
    expect(cursorMessage.cursor).toMatchObject({ x: 42, y: 24, visible: true });
    expect(fake.calls.some((call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed')).toBe(true);

    socket.close();
  });

  it('produces a screenshot artifact reachable over HTTP', async () => {
    const { artifact } = await runtime.executeAction('screenshot', {});
    const read = await runtime.readArtifact(artifact.id);
    expect(read.contentType).toBe('image/png');
    expect(read.buffer.toString('utf8')).toBe('png-bytes');
  });
});
