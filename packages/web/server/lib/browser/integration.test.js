import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { createChromeProcessManager } from './chrome-process.js';
import { connectCdp } from './cdp.js';
import { classifyProxyTarget, createPolicyProxy } from './policy-proxy.js';
import { createBrowserSessionManager } from './session-manager.js';
import { createServerBrowserLifecycle, discoverActiveTunnelHost } from './server-browser-lifecycle.js';
import { createServerChromeBackend } from './server-chrome-backend.js';
import { createBrowserSurfaceGateway, SURFACE_WS_PATH } from './surface-gateway.js';
import { createBrowserBackendRouter } from '../browser-control/backend-router.js';
import { createTunnelHost } from '../relay/tunnel-host.js';
import {
  createFragmentAssembler,
  decodeTunnelFrame,
  encodeFragmentedMessage,
  encodeJsonPayload,
  encodeTunnelFrame,
  TunnelFrameType,
} from '../relay/tunnel-codec.js';

const CHROME = '/usr/sbin/chromium';
const hasChrome = fs.existsSync(CHROME);
const resources = [];
const surfaceReaders = new WeakMap();
const handleExpectedPeerTeardownError = (error) => {
  if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') throw error;
};
const waitFor = async (predicate, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for integration condition');
};

const listen = async (server) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return address.port;
};

const closeServer = async (server) => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
};

afterEach(async () => {
  while (resources.length) await resources.pop()().catch(() => {});
});

class FakeCdp {
  constructor() {
    this.targets = new Map();
    this.contexts = new Set();
    this.sessions = new Map();
    this.sockets = new Set();
    this.calls = [];
    this.nextContext = 1;
    this.nextTarget = 1;
    this.nextSession = 1;
  }

  async start() {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', handleExpectedPeerTeardownError);
      socket.on('message', (raw) => this.onCommand(socket, JSON.parse(raw.toString())));
    });
    await new Promise((resolve) => this.server.once('listening', resolve));
    this.url = `ws://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  reply(socket, message, result = {}) {
    socket.send(JSON.stringify({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
  }

  emit(method, params = {}, sessionId) {
    const message = JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) });
    for (const socket of this.sockets) socket.send(message);
  }

  createTarget(contextId, url = 'about:blank') {
    const target = { targetId: `target-${this.nextTarget++}`, type: 'page', title: '', url, browserContextId: contextId };
    const sessionId = `session-${this.nextSession++}`;
    this.targets.set(target.targetId, target);
    this.sessions.set(sessionId, target.targetId);
    this.emit('Target.targetCreated', { targetInfo: target });
    this.emit('Target.attachedToTarget', {
      sessionId,
      targetInfo: target,
      waitingForDebugger: false,
    });
    return target;
  }

  destroyTarget(targetId) {
    this.targets.delete(targetId);
    this.emit('Target.targetDestroyed', { targetId });
  }

  onCommand(socket, message) {
    this.calls.push(message);
    switch (message.method) {
      case 'Target.getTargets': return this.reply(socket, message, { targetInfos: [...this.targets.values()] });
      case 'Target.createBrowserContext': {
        const browserContextId = `context-${this.nextContext++}`;
        this.contexts.add(browserContextId);
        return this.reply(socket, message, { browserContextId });
      }
      case 'Target.createTarget': {
        const target = this.createTarget(message.params.browserContextId, message.params.url);
        return this.reply(socket, message, { targetId: target.targetId });
      }
      case 'Target.attachToTarget': {
        const sessionId = `session-${this.nextSession++}`;
        this.sessions.set(sessionId, message.params.targetId);
        return this.reply(socket, message, { sessionId });
      }
      case 'Target.disposeBrowserContext': return this.reply(socket, message);
      case 'Page.navigate': {
        const targetId = this.sessions.get(message.sessionId);
        if (targetId) this.targets.set(targetId, { ...this.targets.get(targetId), url: message.params.url });
        this.reply(socket, message, { frameId: 'frame-1' });
        setTimeout(() => this.emit('Page.loadEventFired', {}, message.sessionId), 10);
        return;
      }
      case 'Page.getFrameTree': return this.reply(socket, message, { frameTree: { frame: { id: 'frame-1' } } });
      case 'Page.getNavigationHistory': {
        const target = this.targets.get(this.sessions.get(message.sessionId));
        return this.reply(socket, message, { currentIndex: 0, entries: [{ id: 1, url: target.url, title: target.title }] });
      }
      case 'Runtime.evaluate': {
        if (message.params.expression === 'document.readyState !== "complete"') {
          return this.reply(socket, message, { result: { type: 'boolean', value: false } });
        }
        if (this.holdEvaluate) return;
        return this.reply(socket, message, { result: { type: 'object', value: { ok: true } } });
      }
      default: return this.reply(socket, message);
    }
  }

  async close() {
    await Promise.all([...this.sockets].map((socket) => new Promise((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once('close', resolve);
      socket.terminate();
    })));
    await new Promise((resolve) => this.server.close(resolve));
  }
}

class FakeProcessManager {
  constructor(url) {
    this.url = url;
    this.process = new EventEmitter();
    this.generation = 0;
    this.kills = 0;
  }
  ensureProcess = async () => ({ process: this.process, generation: this.generation, webSocketDebuggerUrl: this.url });
  kill = async () => { this.kills += 1; this.generation += 1; };
}

const fakeComposition = async () => {
  const fake = await new FakeCdp().start();
  const chromeProcessManager = new FakeProcessManager(fake.url);
  const browserSessionManager = createBrowserSessionManager({ chromeProcessManager });
  const backend = createServerChromeBackend({ browserSessionManager, chromeProcessManager });
  resources.push(() => fake.close(), () => browserSessionManager.close());
  return { fake, chromeProcessManager, browserSessionManager, backend };
};

const rejectUpgrade = (socket, status, reason) => {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
};

const openSurfaceServer = async (browserSessionManager, enabled) => {
  const server = http.createServer((_request, response) => response.end('ok'));
  const gateway = createBrowserSurfaceGateway({
    server,
    browserSessionManager,
    uiAuthController: enabled
      ? {
        enabled: true,
        ensureSessionToken: async (request) => (
          request.headers.cookie?.includes('oc_ui_session=')
          || new URL(request.url, 'http://localhost').searchParams.get('oc_url_token') === 'relay-token'
            ? 'session'
            : null
        ),
        resolveAuthContext: async (request) => (
          request.headers.cookie?.includes('oc_ui_session=')
          || new URL(request.url, 'http://localhost').searchParams.get('oc_url_token') === 'relay-token'
            ? { type: 'session', token: 'session' }
            : null
        ),
      }
      : { enabled: false, resolveAuthContext: async (request) => request.headers.authorization === 'Bearer client-token' ? { type: 'client' } : null },
    isRequestOriginAllowed: async (request) => String(request.headers.origin).startsWith('http://127.0.0.1:'),
    rejectWebSocketUpgrade: rejectUpgrade,
    logger: { warn() {}, info() {} },
  });
  const port = await listen(server);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    gateway.dispose();
  };
  resources.push(async () => { dispose(); await closeServer(server); });
  return { server, gateway, dispose, port };
};

const connectSurface = (port, { origin = 'http://127.0.0.1:3000', headers = {}, directory = '/project' } = {}) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${SURFACE_WS_PATH}?directory=${encodeURIComponent(directory)}`, { origin, headers });
  const reader = { queue: [], waiter: null, navigation: [] };
  surfaceReaders.set(socket, reader);
  socket.on('message', (data, isBinary) => {
    const message = { data: Buffer.from(data), isBinary };
    if (!isBinary && JSON.parse(message.data.toString()).type === 'navigation') {
      reader.navigation.push(JSON.parse(message.data.toString()));
      return;
    }
    if (reader.waiter) {
      const waiter = reader.waiter;
      reader.waiter = null;
      waiter(message);
    } else reader.queue.push(message);
  });
  socket.once('open', () => resolve(socket));
  socket.once('error', reject);
  socket.once('unexpected-response', (_request, response) => {
    response.resume();
    reject(new Error(`WebSocket upgrade rejected with ${response.statusCode}`));
  });
  socket.once('close', (code) => {
    if (code !== 1000) reject(new Error(`WebSocket closed during connect (${code})`));
  });
});

const nextSurfaceMessage = (socket, timeoutMs = 2_000) => {
  const reader = surfaceReaders.get(socket);
  if (!reader) throw new Error('Surface socket is not tracked');
  if (reader.queue.length) return Promise.resolve(reader.queue.shift());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reader.waiter = null;
      reject(new Error('Timed out waiting for surface message'));
    }, timeoutMs);
    reader.waiter = (message) => {
      clearTimeout(timeout);
      resolve(message);
    };
  });
};

const nextJson = async (socket, timeoutMs = 2_000) => {
  const message = await nextSurfaceMessage(socket, timeoutMs);
  if (message.isBinary) throw new Error('Expected JSON surface message');
  return JSON.parse(message.data.toString());
};

describe('Server Chrome integration: lifecycle, routing, and gateway', () => {
  it.each([false, true])('hostile WebSocket origin is rejected when UI auth enabled=%s', async (enabled) => {
    const { browserSessionManager } = await fakeComposition();
    const { port } = await openSurfaceServer(browserSessionManager, enabled);
    const headers = enabled ? { cookie: 'oc_ui_session=test' } : { authorization: 'Bearer client-token' };
    await expect(connectSurface(port, { origin: 'https://hostile.example', headers })).rejects.toThrow();
  });

  it('UI-auth-disabled surface rejects access without a client token', async () => {
    const { browserSessionManager } = await fakeComposition();
    const { port } = await openSurfaceServer(browserSessionManager, false);
    await expect(connectSurface(port)).rejects.toThrow('rejected with 401');
  });

  it('CDP connection failure after process launch kills the partial launch', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'browser-partial-launch-'));
    let profileDir;
    const child = new EventEmitter();
    child.pid = null;
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
      return true;
    };
    const manager = createChromeProcessManager({
      env: { OPENCHAMBER_CHROME_PATH: '/test/chrome', PATH: '' },
      platform: 'linux',
      tmpDir,
      isExecutable: () => true,
      spawn: (_binary, args) => {
        profileDir = args.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
        queueMicrotask(() => fs.promises.writeFile(
          path.join(profileDir, 'DevToolsActivePort'),
          '9222\n/devtools/browser/integration\n',
        ));
        return child;
      },
      probeVersion: async () => ({ product: 'Chromium/120.0.0.0' }),
      pollIntervalMs: 5,
    });
    const sessions = createBrowserSessionManager({
      chromeProcessManager: manager,
      connectCdp: async () => { throw new Error('synthetic CDP connection failure'); },
    });
    resources.push(() => fs.promises.rm(tmpDir, { recursive: true, force: true }), () => sessions.close());
    await sessions.createSession({ directory: '/project' });
    await expect(sessions.listTabs({ directory: '/project' })).rejects.toThrow();
    expect(child.killed).toBe(true);
    expect(fs.existsSync(profileDir)).toBe(false);
  });

  it('configuration reload during startup cancels the older generation and tears it down', async () => {
    let resolveComposition;
    let killed = 0;
    let closed = 0;
    const lifecycle = createServerBrowserLifecycle({
      compose: () => new Promise((resolve) => { resolveComposition = resolve; }),
      disposeGateway() {},
    });
    await lifecycle.apply(true);
    const pending = lifecycle.ensureComposition();
    const disabling = lifecycle.apply(false);
    resolveComposition({
      chromeProcessManager: { kill: async () => { killed += 1; } },
      browserSessionManager: { close: async () => { closed += 1; } },
      backend: {},
    });
    await Promise.all([pending, disabling]);
    expect({ killed, closed, enabled: lifecycle.isEnabled() }).toEqual({ killed: 1, closed: 1, enabled: false });
  });

  it('browser.open with an sc: id navigates that owned target instead of creating another', async () => {
    const { backend, fake } = await fakeComposition();
    const first = await backend.execute({ directory: '/project' }, 'browser.open', { url: 'data:text/html,one' });
    const sibling = await backend.execute({ directory: '/project' }, 'browser.open', { url: 'data:text/html,sibling' });
    const before = fake.calls.filter((call) => call.method === 'Target.createTarget').length;
    const second = await backend.execute({ directory: '/project', tabId: first.tabId }, 'browser.open', { url: 'data:text/html,two' });
    expect(second.tabId).toBe(first.tabId);
    expect(fake.calls.filter((call) => call.method === 'Target.createTarget')).toHaveLength(before);
    expect(fake.targets.get(first.tabId.slice(3)).url).toBe('data:text/html,two');
    expect(fake.targets.get(sibling.tabId.slice(3)).url).toBe('data:text/html,sibling');
  });

  it('one session cannot navigate another session sc: target', async () => {
    const { backend, fake } = await fakeComposition();
    const first = await backend.execute({ directory: '/one' }, 'browser.open', { url: 'data:text/html,one' });
    const second = await backend.execute({ directory: '/two' }, 'browser.open', { url: 'data:text/html,two' });
    await expect(backend.execute(
      { directory: '/one', tabId: second.tabId },
      'browser.open',
      { url: 'data:text/html,stolen' },
    )).rejects.toMatchObject({
      status: 400,
      target: { directory: '/one', tabId: second.tabId },
    });
    expect(fake.targets.get(first.tabId.slice(3)).url).toBe('data:text/html,one');
    expect(fake.targets.get(second.tabId.slice(3)).url).toBe('data:text/html,two');
  });

  it('merged browser.tabs lists only the requesting OpenCode session server tabs', async () => {
    const { backend } = await fakeComposition();
    const agentA = await backend.execute(
      { directory: '/repo', openCodeSessionId: 'agent-a' },
      'browser.open',
      { url: 'data:text/html,agent-a' },
    );
    const agentB = await backend.execute(
      { directory: '/repo', openCodeSessionId: 'agent-b' },
      'browser.open',
      { url: 'data:text/html,agent-b' },
    );
    const clientTab = { tabId: 'client-1', url: 'https://client.example/', title: 'Client', active: true };
    const router = createBrowserBackendRouter({
      broker: { request: async () => ({ tabs: [clientTab], target: { directory: '/repo' } }) },
      isServerBackendEnabled: () => true,
      getServerBackend: async () => backend,
      hasServingClient: () => true,
    });

    const listedForA = await router.request('browser.tabs', {}, {
      target: { directory: '/repo', openCodeSessionId: 'agent-a' },
    });
    expect(listedForA.tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ tabId: clientTab.tabId, backend: 'electron-webview' }),
      expect.objectContaining({ tabId: agentA.tabId, backend: 'server-chrome' }),
    ]));
    expect(listedForA.tabs).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ tabId: agentB.tabId }),
    ]));

    const listedForB = await router.request('browser.tabs', {}, {
      target: { directory: '/repo', openCodeSessionId: 'agent-b' },
    });
    expect(listedForB.tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ tabId: agentB.tabId, backend: 'server-chrome' }),
    ]));
    expect(listedForB.tabs).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ tabId: agentA.tabId }),
    ]));

    const listedForDefault = await router.request('browser.tabs', {}, { target: { directory: '/repo' } });
    expect(listedForDefault.tabs).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ tabId: agentA.tabId }),
      expect.objectContaining({ tabId: agentB.tabId }),
    ]));
  });

  it('tab-less server actions deliberately reject with a scoped tabId requirement', async () => {
    const { backend } = await fakeComposition();
    await backend.execute({ directory: '/project' }, 'browser.open', { url: 'data:text/html,one' });
    await expect(backend.execute({ directory: '/project' }, 'browser.snapshot', {})).rejects.toMatchObject({
      status: 400,
      target: { directory: '/project' },
    });
  });

  it('synthetic external targets reconcile into their owning context and disappear on targetDestroyed', async () => {
    const { backend, fake } = await fakeComposition();
    await backend.execute({ directory: '/project' }, 'browser.open', { url: 'data:text/html,opener' });
    const contextId = [...fake.contexts][0];
    const external = fake.createTarget(contextId, 'https://external.example/');
    await waitFor(async () => (await backend.listTabs({ directory: '/project' })).some((tab) => tab.tabId === `sc:${external.targetId}`));
    fake.destroyTarget(external.targetId);
    await waitFor(async () => !(await backend.listTabs({ directory: '/project' })).some((tab) => tab.tabId === `sc:${external.targetId}`));
  });

  it('owned CDP audit events emit lifecycle summaries without request secrets', async () => {
    const { browserSessionManager, fake } = await fakeComposition();
    const session = await browserSessionManager.createSession({ directory: '/audit' });
    const tab = await browserSessionManager.createTab(session.id);
    const summaries = await browserSessionManager.runReadOnlyOperation(session.id, {
      targetId: tab.targetId,
      requireTargetOwnership: true,
      operation: async ({ cdp }) => {
        const events = [];
        const unsubscribe = cdp.onAudit((event) => events.push(event));
        const sid = await waitFor(() => cdp.getSessionId(tab.targetId));
        const secret = 'sentinel-secret';
        fake.emit('Network.requestWillBeSent', {
          requestId: 'request-1',
          type: 'Fetch',
          request: {
            method: 'POST',
            url: `https://audit.example/path?token=${secret}`,
            headers: {
              Authorization: `Bearer ${secret}`,
              Cookie: `key=${secret}`,
              'Sec-WebSocket-Protocol': secret,
            },
            postData: secret,
          },
        }, sid);
        fake.emit('Network.responseReceived', {
          requestId: 'request-1', type: 'Fetch',
          response: { url: `https://audit.example/path?token=${secret}`, status: 204, headers: { 'Set-Cookie': `key=${secret}` } },
        }, sid);
        fake.emit('Network.loadingFailed', {
          requestId: 'request-1', type: 'Fetch', blockedReason: 'inspector', errorText: secret,
        }, sid);
        fake.emit('Network.requestWillBeSent', {
          requestId: 'foreign', request: { method: 'GET', url: `https://foreign.example/?secret=${secret}` },
        }, 'foreign-session');
        await waitFor(() => events.length === 3);
        unsubscribe();
        return events;
      },
    });
    expect(summaries.map((event) => event.eventType)).toEqual([
      'Network.requestWillBeSent',
      'Network.responseReceived',
      'Network.loadingFailed',
    ]);
    expect(summaries).toEqual([
      expect.objectContaining({ requestId: 'request-1', method: 'POST', origin: 'https://audit.example', resourceType: 'Fetch' }),
      expect.objectContaining({ requestId: 'request-1', origin: 'https://audit.example', statusCode: 204, resourceType: 'Fetch' }),
      expect.objectContaining({ requestId: 'request-1', failureCategory: 'blocked', resourceType: 'Fetch' }),
    ]);
    expect(JSON.stringify(summaries)).not.toContain('sentinel-secret');
  });

  it('Chrome crash with active viewers sends an honest error and rejects in-flight agent work without hanging', async () => {
    const { backend, browserSessionManager, chromeProcessManager, fake } = await fakeComposition();
    const opened = await backend.execute({ directory: '/project' }, 'browser.open', { url: 'data:text/html,viewer' });
    const { port } = await openSurfaceServer(browserSessionManager, false);
    const socket = await connectSurface(port, { headers: { authorization: 'Bearer client-token' } });
    resources.push(async () => socket.terminate());
    expect((await nextJson(socket)).type).toBe('hello');
    socket.send(JSON.stringify({ type: 'attach', sessionId: '/project\0server-chrome-control' }));
    expect((await nextJson(socket)).type).toBe('attached');
    socket.send(JSON.stringify({ type: 'attachTab', tabId: opened.tabId }));
    await nextJson(socket);
    fake.holdEvaluate = true;
    const evaluateCalls = fake.calls.filter((call) => call.method === 'Runtime.evaluate').length;
    const inFlight = backend.execute(
      { directory: '/project', tabId: opened.tabId },
      'browser.click',
      { selector: 'body' },
    );
    const inFlightOutcome = inFlight.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitFor(() => fake.calls.filter((call) => call.method === 'Runtime.evaluate').length > evaluateCalls);
    chromeProcessManager.process.emit('exit', 9, null);
    expect(await nextJson(socket)).toMatchObject({ type: 'error', code: 'SESSION_ENDED' });
    expect((await inFlightOutcome).error).toMatchObject({
      status: 503,
      target: { directory: '/project', tabId: opened.tabId },
    });
  });

  it('slow consumer enforces three sent/unacked frames and one latest replaceable frame', async () => {
    const { backend, browserSessionManager, fake } = await fakeComposition();
    const opened = await backend.execute({ directory: '/project' }, 'browser.open', { url: 'data:text/html,frames' });
    const { port } = await openSurfaceServer(browserSessionManager, false);
    const socket = await connectSurface(port, { headers: { authorization: 'Bearer client-token' } });
    resources.push(async () => socket.terminate());
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'attach', sessionId: '/project\0server-chrome-control' }));
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'attachTab', tabId: opened.tabId }));
    await nextJson(socket);
    const sessionId = fake.calls.find((call) => call.method === 'Page.startScreencast').sessionId;
    const frames = [];
    for (let index = 0; index < 3; index += 1) {
      fake.emit('Page.screencastFrame', {
        sessionId: index + 1,
        data: Buffer.from(`frame-${index}`).toString('base64'),
        metadata: { deviceWidth: 10, deviceHeight: 10, deviceScaleFactor: 1 },
      }, sessionId);
      const header = await nextJson(socket);
      frames.push(header.frameSeq);
      expect((await nextSurfaceMessage(socket)).isBinary).toBe(true);
    }
    for (let index = 3; index < 8; index += 1) {
      fake.emit('Page.screencastFrame', {
        sessionId: index + 1,
        data: Buffer.from(`frame-${index}`).toString('base64'),
        metadata: { deviceWidth: 10, deviceHeight: 10, deviceScaleFactor: 1 },
      }, sessionId);
    }
    await waitFor(() => fake.calls.filter((call) => call.method === 'Page.screencastFrameAck').length >= 8);
    socket.send(JSON.stringify({ type: 'frameAck', frameSeq: frames.at(-1) }));
    const latest = await nextJson(socket);
    expect(latest.frameSeq).toBeGreaterThan(frames.at(-1));
    const binary = await nextSurfaceMessage(socket);
    expect(binary.data.toString()).toBe('frame-7');
  });

  it('lifecycle.apply(false) closes the active viewer, Chrome, and every owned proxy listener', async () => {
    const composition = await fakeComposition();
    const surface = await openSurfaceServer(composition.browserSessionManager, false);
    const lifecycle = createServerBrowserLifecycle({
      compose: async () => composition,
      disposeGateway: async () => surface.dispose(),
    });
    await lifecycle.apply(true);
    await lifecycle.ensureComposition();
    const opened = await composition.backend.execute({ directory: '/project' }, 'browser.open', { url: 'data:text/html,shutdown' });
    await composition.backend.execute({ directory: '/other' }, 'browser.open', { url: 'data:text/html,other' });
    const session = composition.browserSessionManager.getSession({ directory: '/project', openCodeSessionId: 'server-chrome-control' });
    const proxies = composition.browserSessionManager.listSessions().map((entry) => entry.proxyServer);
    expect(proxies).toHaveLength(2);
    const socket = await connectSurface(surface.port, { headers: { authorization: 'Bearer client-token' } });
    resources.push(async () => socket.terminate());
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'attach', sessionId: session.id }));
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'attachTab', tabId: opened.tabId }));
    await nextJson(socket);
    const viewerClosed = new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    await lifecycle.apply(false);
    expect(composition.chromeProcessManager.kills).toBe(1);
    expect(composition.browserSessionManager.listSessions()).toEqual([]);
    await expect(viewerClosed).resolves.toMatchObject({ code: 1001, reason: 'Session ended' });
    for (const proxyServer of proxies) await expect(fetch(`http://${proxyServer}`)).rejects.toThrow();
  });
});

describe('Server Chrome integration: relay surface transport', () => {
  it('createTunnelHost accepts the surface path and the real codec reassembles inbound and outbound fragments', async () => {
    const { browserSessionManager, fake } = await fakeComposition();
    const session = await browserSessionManager.createSession({ directory: '/relay' });
    const tab = await browserSessionManager.createTab(session.id);
    const surface = await openSurfaceServer(browserSessionManager, true);
    const sentFrames = [];
    const host = createTunnelHost({
      connectionId: 'relay-integration',
      getLocalPort: () => surface.port,
      sendFrame: async (frame) => { sentFrames.push(frame); },
      getBufferedAmount: () => 0,
    });
    resources.push(async () => host.close());
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsOpen, 1, encodeJsonPayload({
      path: SURFACE_WS_PATH,
      query: 'directory=%2Frelay&oc_url_token=relay-token',
    })));

    const assembler = createFragmentAssembler();
    let cursor = 0;
    const received = { text: [], binary: [] };
    const drain = () => {
      while (cursor < sentFrames.length) {
        const frame = decodeTunnelFrame(sentFrames[cursor++]);
        if (frame.frameType !== TunnelFrameType.WsText && frame.frameType !== TunnelFrameType.WsBinary) continue;
        const message = assembler.push(frame);
        if (message) received[frame.frameType === TunnelFrameType.WsText ? 'text' : 'binary'].push(message);
      }
    };
    await waitFor(() => {
      drain();
      return sentFrames.some((frame) => decodeTunnelFrame(frame).frameType === TunnelFrameType.WsOpened);
    });

    const attachBase = JSON.stringify({ type: 'attach', sessionId: session.id, padding: '' });
    const attachPayload = new TextEncoder().encode(JSON.stringify({
      type: 'attach',
      sessionId: session.id,
      padding: 'x'.repeat(65_530 - Buffer.byteLength(attachBase)),
    }));
    const attachFrames = encodeFragmentedMessage(TunnelFrameType.WsText, 1, attachPayload);
    expect(attachFrames.length).toBeGreaterThan(1);
    for (const frame of attachFrames) await host.handleFrame(frame);
    await waitFor(() => {
      drain();
      return received.text.some((message) => JSON.parse(Buffer.from(message).toString()).type === 'attached');
    });
    for (const frame of encodeFragmentedMessage(
      TunnelFrameType.WsText,
      1,
      new TextEncoder().encode(JSON.stringify({ type: 'attachTab', tabId: tab.id })),
    )) await host.handleFrame(frame);
    const cdpSessionId = await waitFor(() => fake.calls.find((call) => call.method === 'Page.startScreencast')?.sessionId);

    const jpeg = Buffer.alloc(70_000, 0x5a);
    fake.emit('Page.screencastFrame', {
      sessionId: 1,
      data: jpeg.toString('base64'),
      metadata: { deviceWidth: 100, deviceHeight: 100, deviceScaleFactor: 1 },
    }, cdpSessionId);
    await waitFor(() => {
      drain();
      return received.binary.length === 1;
    });
    expect(Buffer.from(received.binary[0])).toEqual(jpeg);
    expect(sentFrames.map(decodeTunnelFrame).filter((frame) => frame.frameType === TunnelFrameType.WsBinary)).toHaveLength(2);
  });
});

const proxyRequest = (proxyServer, target, agent) => new Promise((resolve, reject) => {
  const [host, port] = proxyServer.split(':');
  const request = http.request({ host, port: Number(port), path: target, agent }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), headers: response.headers }));
  });
  request.once('error', reject);
  request.end();
});

const fixture = async (handler = (_request, response) => response.end('ok')) => {
  let connections = 0;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, host: request.headers.host });
    handler(request, response);
  });
  server.on('connection', (socket) => {
    connections += 1;
    socket.on('error', handleExpectedPeerTeardownError);
  });
  const port = await listen(server);
  resources.push(() => closeServer(server));
  return { server, port, requests, get connections() { return connections; } };
};

const webSocketFixture = async () => {
  const base = await fixture((_request, response) => response.end('ws fixture'));
  const sockets = new Set();
  const messages = [];
  let upgrades = 0;
  const wsServer = new WebSocketServer({ server: base.server });
  wsServer.on('connection', (socket) => {
    upgrades += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', handleExpectedPeerTeardownError);
    socket.on('message', (message) => {
      messages.push(message.toString());
      socket.send('hmr-ok');
    });
  });
  resources.push(async () => {
    await Promise.all([...sockets].map((socket) => new Promise((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once('close', resolve);
      socket.terminate();
    })));
    await new Promise((resolve) => wsServer.close(resolve));
  });
  return {
    server: base.server,
    port: base.port,
    requests: base.requests,
    messages,
    get connections() { return base.connections; },
    get upgrades() { return upgrades; },
  };
};

const tcpFixture = async () => {
  let connections = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('error', handleExpectedPeerTeardownError);
    socket.on('close', () => sockets.delete(socket));
    socket.destroy();
  });
  const port = await listen(server);
  resources.push(async () => {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
  });
  return { port, get connections() { return connections; } };
};

describe('Server Chrome integration: proxy policy and resource ownership', () => {
  it.each([
    ['metadata/link-local', 'http://169.254.169.254/latest/meta-data'],
    ['denied ws literal', 'ws://127.0.0.1:9001/socket'],
    ['denied ws hostname', 'ws://private.example/socket'],
  ])('%s is denied before any forbidden fixture connection', async (_name, target) => {
    const forbidden = await fixture();
    const result = await classifyProxyTarget(target, {
      lookup: async () => [{ address: target.includes('private.example') ? '127.0.0.1' : '93.184.216.34', family: 4 }],
    });
    expect(result.allowed).toBe(false);
    expect(forbidden.connections).toBe(0);
  });

  it('redirect public→private is denied at the second hop with zero private connections', async () => {
    const privateServer = await fixture();
    const publicServer = await fixture((_request, response) => response.writeHead(302, {
      location: `http://127.0.0.1:${privateServer.port}/private`,
    }).end());
    const proxy = createPolicyProxy({ grants: [{ host: '127.0.0.1', port: publicServer.port }] });
    await proxy.listen();
    resources.push(() => proxy.close());
    const first = await proxyRequest(proxy.proxyServer, `http://127.0.0.1:${publicServer.port}/`);
    expect((await proxyRequest(proxy.proxyServer, first.headers.location)).status).toBe(403);
    expect(privateServer.connections).toBe(0);
  });

  it('ungranted plain loopback reaches the proxy and is denied with zero upstream connections', async () => {
    const forbidden = await fixture();
    const proxy = createPolicyProxy();
    await proxy.listen();
    resources.push(() => proxy.close());
    expect((await proxyRequest(proxy.proxyServer, `http://127.0.0.1:${forbidden.port}/`)).status).toBe(403);
    expect(forbidden.connections).toBe(0);
  });

  it('DNS flip is pinned per request and revalidated before the next connect', async () => {
    const allowed = await fixture();
    let lookups = 0;
    const proxy = createPolicyProxy({
      grants: [{ host: 'flip.example', port: allowed.port }],
      lookup: async () => (++lookups === 1
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '169.254.169.254', family: 4 }]),
    });
    await proxy.listen();
    resources.push(() => proxy.close());
    expect((await proxyRequest(proxy.proxyServer, `http://flip.example:${allowed.port}/`)).status).toBe(200);
    expect((await proxyRequest(proxy.proxyServer, `http://flip.example:${allowed.port}/`)).status).toBe(403);
    expect(allowed.connections).toBe(1);
  });

  it('tunnel hostname HTTPS keeps the original endpoint while HTTP hairpins to loopback', async () => {
    const hairpin = await fixture();
    const policy = {
      discoverTunnelHosts: async () => [{ hostname: 'preview.example', port: hairpin.port }],
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    };
    await expect(classifyProxyTarget('http://preview.example/', policy)).resolves.toMatchObject({
      allowed: true, hostname: '127.0.0.1', address: '127.0.0.1', port: hairpin.port,
    });
    await expect(classifyProxyTarget('https://preview.example/', policy)).resolves.toMatchObject({
      allowed: true, hostname: 'preview.example', address: '93.184.216.34', port: 443,
    });
  });

  it('ending one session severs its CONNECT and keep-alive sockets until context recreation while the other proxy stays available', async () => {
    const upstream = await fixture((_request, response) => {
      response.setHeader('connection', 'keep-alive');
      response.end('ok');
    });
    const fake = await new FakeCdp().start();
    const chromeProcessManager = new FakeProcessManager(fake.url);
    const manager = createBrowserSessionManager({
      chromeProcessManager,
      proxyPolicy: { grants: [{ host: '127.0.0.1', port: upstream.port }] },
    });
    resources.push(() => fake.close(), () => manager.close());
    const first = await manager.createSession({ directory: '/first' });
    const second = await manager.createSession({ directory: '/second' });
    await manager.createTab(first.id);
    await manager.createTab(second.id);
    const firstState = manager.getSession(first.id);
    const secondState = manager.getSession(second.id);
    const firstAgent = new http.Agent({ keepAlive: true });
    const secondAgent = new http.Agent({ keepAlive: true });
    resources.push(async () => firstAgent.destroy(), async () => secondAgent.destroy());
    await expect(proxyRequest(firstState.proxyServer, `http://127.0.0.1:${upstream.port}/keep-alive`, firstAgent)).resolves.toMatchObject({ status: 200 });
    await expect(proxyRequest(secondState.proxyServer, `http://127.0.0.1:${upstream.port}/other`, secondAgent)).resolves.toMatchObject({ status: 200 });
    const firstKeepAliveSocket = Object.values(firstAgent.freeSockets)[0][0];
    const [proxyHost, proxyPort] = firstState.proxyServer.split(':');
    const connectClient = net.connect({ host: proxyHost, port: Number(proxyPort) });
    await new Promise((resolve, reject) => {
      connectClient.once('connect', resolve);
      connectClient.once('error', reject);
    });
    connectClient.on('error', () => {});
    connectClient.write(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\n\r\n`);
    await new Promise((resolve) => connectClient.once('data', resolve));
    const connectClosed = new Promise((resolve) => connectClient.once('close', resolve));

    await manager.endSession(first.id);
    await connectClosed;
    await waitFor(() => firstKeepAliveSocket.destroyed);
    await expect(fetch(`http://${firstState.proxyServer}`)).rejects.toThrow();
    await expect(proxyRequest(secondState.proxyServer, `http://127.0.0.1:${upstream.port}/still-open`, secondAgent)).resolves.toMatchObject({ status: 200 });

    const recreated = await manager.createSession({ directory: '/first' });
    await manager.createTab(recreated.id);
    const recreatedState = manager.getSession(recreated.id);
    expect(recreatedState.browserContextId).not.toBe(firstState.browserContextId);
    await expect(proxyRequest(recreatedState.proxyServer, `http://127.0.0.1:${upstream.port}/recreated`)).resolves.toMatchObject({ status: 200 });
  });

  it('production tunnel discovery uses the active listener port when configured with port zero', async () => {
    const server = http.createServer((_request, response) => response.end('ok'));
    const activePort = await listen(server);
    resources.push(() => closeServer(server));
    expect(discoverActiveTunnelHost(server, 'preview.example')).toEqual([{ hostname: 'preview.example', port: activePort }]);
    expect(activePort).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasChrome)('Server Chrome integration: real Chromium policy contexts', () => {
  let tmpDir;
  let chrome;
  let sessions;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'server-chrome-integration-'));
    chrome = createChromeProcessManager({ env: { ...process.env, OPENCHAMBER_CHROME_PATH: CHROME }, tmpDir });
  });

  afterAll(async () => {
    await sessions?.close();
    await chrome?.shutdown();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  const runInRealPage = async ({ directory, policy, pageUrl, expression, beforeEvaluate, inspect }) => {
    await sessions?.close();
    sessions = createBrowserSessionManager({ chromeProcessManager: chrome, proxyPolicy: policy });
    const session = await sessions.createSession({ directory, openCodeSessionId: directory });
    const tab = await sessions.createTab(session.id);
    return sessions.runReadOnlyOperation(session.id, {
      targetId: tab.targetId,
      operation: async ({ cdp }) => {
        const sid = await cdp.attach(tab.targetId);
        await cdp.sendSession(sid, 'Page.enable');
        await cdp.sendSession(sid, 'Page.navigate', { url: pageUrl });
        await new Promise((resolve) => setTimeout(resolve, 120));
        const prepared = await beforeEvaluate?.({ cdp, sid, tab });
        const response = await cdp.sendSession(sid, 'Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        return inspect
          ? inspect({ cdp, sid, tab, value: response.result?.value, prepared })
          : response.result?.value;
      },
    });
  };

  const blockedFetch = (url) => `fetch(${JSON.stringify(url)}, { cache: 'no-store', mode: 'no-cors' }).then(()=>true).catch(()=>false)`;
  const blockedWebSocket = (url) => `new Promise(r=>{const s=new WebSocket(${JSON.stringify(url)});s.onopen=()=>r(true);s.onerror=()=>r(false);setTimeout(()=>r(false),1000)})`;

  const runBlockedRequest = async ({ directory, targetUrl, expression = blockedFetch(targetUrl), policy = {} }) => {
    const top = await fixture();
    return runInRealPage({
      directory,
      policy: {
        ...policy,
        grants: [{ host: '127.0.0.1', port: top.port }, ...(policy.grants ?? [])],
      },
      pageUrl: `http://127.0.0.1:${top.port}/`,
      expression,
    });
  };

  it('real Chromium prevents direct STUN and TURN UDP/TCP/TLS egress outside the session proxy', async () => {
    const udp = dgram.createSocket('udp4');
    let packets = 0;
    udp.on('message', () => { packets += 1; });
    await new Promise((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(0, '127.0.0.1', resolve);
    });
    resources.push(() => new Promise((resolve) => udp.close(resolve)));
    const tcp = await tcpFixture();
    const tls = await tcpFixture();
    const page = await fixture((_request, response) => response.end('<!doctype html><title>WebRTC policy</title>'));
    const iceServers = [
      { urls: `stun:127.0.0.1:${udp.address().port}` },
      { urls: `turn:127.0.0.1:${udp.address().port}?transport=udp`, username: 'fixture', credential: 'fixture' },
      { urls: `turn:127.0.0.1:${tcp.port}?transport=tcp`, username: 'fixture', credential: 'fixture' },
      { urls: `turns:127.0.0.1:${tls.port}?transport=tcp`, username: 'fixture', credential: 'fixture' },
    ];
    const result = await runInRealPage({
      directory: '/policy/webrtc',
      policy: { grants: [{ host: '127.0.0.1', port: page.port }] },
      pageUrl: `http://127.0.0.1:${page.port}/`,
      expression: `(async () => {
        const peers = ${JSON.stringify(iceServers)}.map(server => {
          const peer = new RTCPeerConnection({ iceServers: [server] });
          peer.createDataChannel('policy-fixture');
          return peer;
        });
        try {
          await Promise.all(peers.map(async peer => peer.setLocalDescription(await peer.createOffer())));
          await new Promise(resolve => setTimeout(resolve, 1500));
          return { offers: peers.length, title: document.title };
        } finally {
          peers.forEach(peer => peer.close());
        }
      })()`,
    });
    expect(result).toEqual({ offers: 4, title: 'WebRTC policy' });
    expect(page.requests.length).toBeGreaterThan(0);
    expect({ udpPackets: packets, tcpConnections: tcp.connections, tlsConnections: tls.connections }).toEqual({
      udpPackets: 0, tcpConnections: 0, tlsConnections: 0,
    });
  }, 30_000);

  it('two sessions have isolated cookies', async () => {
    await sessions?.close();
    const page = await fixture((_request, response) => response.end('<!doctype html><title>cookies</title>'));
    sessions = createBrowserSessionManager({
      chromeProcessManager: chrome,
      proxyPolicy: { grants: [{ host: '127.0.0.1', port: page.port }] },
    });
    const first = await sessions.createSession({ directory: '/project', openCodeSessionId: 'one' });
    const second = await sessions.createSession({ directory: '/project', openCodeSessionId: 'two' });
    const firstTab = await sessions.createTab(first.id);
    const secondTab = await sessions.createTab(second.id);
    const visit = (session, tab, expression) => sessions.runReadOnlyOperation(session.id, {
      targetId: tab.targetId,
      operation: async ({ cdp }) => {
        const sid = await cdp.attach(tab.targetId);
        await cdp.sendSession(sid, 'Page.enable');
        await cdp.sendSession(sid, 'Page.navigate', { url: `http://127.0.0.1:${page.port}/` });
        await new Promise((resolve) => setTimeout(resolve, 100));
        return cdp.sendSession(sid, 'Runtime.evaluate', { expression, returnByValue: true });
      },
    });
    await visit(first, firstTab, 'document.cookie = "session=one"');
    const firstCookie = await visit(first, firstTab, 'document.cookie');
    const secondCookie = await visit(second, secondTab, 'document.cookie');
    expect(firstCookie.result.value).toContain('session=one');
    expect(secondCookie.result.value).toBe('');
  }, 30_000);

  it('real window.open creates a popup in the owning context and the backend drives that popup', async () => {
    const page = await fixture((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/popup') {
        response.end('<!doctype html><title>popup-owned</title><main>popup body</main>');
        return;
      }
      response.end('<!doctype html><title>opener</title><button id="open" onclick="window.open(\'/popup\')">open</button>');
    });
    await sessions?.close();
    sessions = createBrowserSessionManager({
      chromeProcessManager: chrome,
      proxyPolicy: { grants: [{ host: '127.0.0.1', port: page.port }] },
    });
    const backend = createServerChromeBackend({ browserSessionManager: sessions, chromeProcessManager: chrome });
    const opener = await backend.execute({ directory: '/popup' }, 'browser.open', { url: `http://127.0.0.1:${page.port}/` });
    const controlSession = sessions.getSession({ directory: '/popup', openCodeSessionId: 'server-chrome-control' });
    const openerTargetId = opener.tabId.slice(3);
    const popupTarget = await sessions.runReadOnlyOperation(controlSession.id, {
      targetId: openerTargetId,
      requireTargetOwnership: true,
      operation: async ({ cdp, browserContextId }) => {
        await cdp.sendTarget(openerTargetId, 'Runtime.evaluate', {
          expression: `setTimeout(() => window.open('/popup'), 0); true`,
          userGesture: true,
          returnByValue: true,
        });
        return waitFor(() => cdp.getTargets().find((target) => (
          target.type === 'page'
          && target.browserContextId === browserContextId
          && target.openerId === openerTargetId
        )), 10_000);
      },
    });
    expect(popupTarget).toMatchObject({
      type: 'page',
      browserContextId: controlSession.browserContextId,
      openerId: openerTargetId,
    });
    const driven = await sessions.runReadOnlyOperation(controlSession.id, {
      targetId: popupTarget.targetId,
      requireTargetOwnership: true,
      operation: async ({ cdp, browserContextId }) => {
        const popupSessionId = await cdp.attach(popupTarget.targetId);
        const result = await cdp.sendSession(popupSessionId, 'Runtime.evaluate', {
          expression: `document.title = 'popup-owned'; document.body.innerHTML = '<main>popup body</main>'; ({ title: document.title, text: document.body.innerText })`,
          returnByValue: true,
        });
        return { browserContextId, popupSessionId, value: result.result?.value };
      },
    });
    expect(driven).toMatchObject({
      browserContextId: controlSession.browserContextId,
      popupSessionId: expect.any(String),
      value: { title: 'popup-owned', text: 'popup body' },
    });
  }, 30_000);

  it('real Chromium blocks metadata and link-local page fetches before forbidden connections', async () => {
    const metadata = await fixture();
    const metadataResult = await runBlockedRequest({
      directory: '/policy/metadata',
      targetUrl: `http://metadata.google.internal:${metadata.port}/latest/meta-data`,
    });
    expect(metadataResult).toBe(true);
    expect(metadata.connections).toBe(0);

    const linkLocal = await fixture();
    const linkLocalResult = await runBlockedRequest({
      directory: '/policy/link-local',
      targetUrl: `http://169.254.169.254:${linkLocal.port}/blocked`,
    });
    expect(linkLocalResult).toBe(true);
    expect(linkLocal.connections).toBe(0);
  }, 30_000);

  it('real Chromium follows a granted redirect only until the private second hop', async () => {
    const forbidden = await fixture();
    const publicServer = await fixture((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: `http://127.0.0.1:${forbidden.port}/private` }).end();
        return;
      }
      response.end('public');
    });
    const result = await runInRealPage({
      directory: '/policy/redirect',
      policy: { grants: [{ host: '127.0.0.1', port: publicServer.port }] },
      pageUrl: `http://127.0.0.1:${publicServer.port}/`,
      expression: blockedFetch(`http://127.0.0.1:${publicServer.port}/redirect`),
    });
    expect(result).toBe(true);
    expect(publicServer.requests.some((request) => request.url === '/redirect')).toBe(true);
    expect(forbidden.connections).toBe(0);
  }, 30_000);

  it('real Chromium denies ws literals and hostnames before WebSocket fixture upgrades', async () => {
    const literal = await webSocketFixture();
    expect(await runBlockedRequest({
      directory: '/policy/ws-literal',
      targetUrl: `ws://127.0.0.1:${literal.port}/hmr`,
      expression: blockedWebSocket(`ws://127.0.0.1:${literal.port}/hmr`),
    })).toBe(false);
    expect(literal.connections).toBe(0);
    expect(literal.upgrades).toBe(0);

    const hostname = await webSocketFixture();
    const hostnameUrl = `ws://denied.invalid:${hostname.port}/hmr`;
    expect(await runBlockedRequest({
      directory: '/policy/ws-hostname',
      targetUrl: hostnameUrl,
      expression: blockedWebSocket(hostnameUrl),
      policy: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
    })).toBe(false);
    expect(hostname.connections).toBe(0);
    expect(hostname.upgrades).toBe(0);
  }, 30_000);

  it('real Chromium sends ungranted loopback to the session proxy and creates zero upstream connections', async () => {
    const forbidden = await fixture();
    expect(await runBlockedRequest({
      directory: '/policy/ungranted-loopback',
      targetUrl: `http://127.0.0.1:${forbidden.port}/blocked`,
    })).toBe(true);
    expect(forbidden.connections).toBe(0);
  }, 30_000);

  it('real Chromium pins the validated DNS answer instead of resolving again during connect', async () => {
    const target = await fixture((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<link rel="icon" href="data:,"><img src="/second">ok');
    });
    let lookups = 0;
    const targetUrl = `http://flip.example:${target.port}/value`;
    const result = await runInRealPage({
      directory: '/policy/dns-flip',
      pageUrl: targetUrl,
      expression: 'document.body.innerText',
      policy: {
        grants: [
          { host: 'flip.example', port: target.port },
          { host: '127.0.0.1', port: target.port },
        ],
        lookup: async (hostname) => {
          if (hostname !== 'flip.example') return [{ address: '169.254.169.254', family: 4 }];
          lookups += 1;
          return lookups === 1
            ? [{ address: '127.0.0.1', family: 4 }]
            : [{ address: '169.254.169.254', family: 4 }];
        },
      },
    });
    expect(result).toBe('ok');
    expect(target.requests).toHaveLength(1);
    expect(lookups).toBe(2);
  }, 30_000);

  it('real Chromium hairpins HTTP tunnel hostnames but dials the original HTTPS endpoint', async () => {
    const hairpin = await fixture();
    const original = await tcpFixture();
    const httpUrl = 'http://preview.example/hairpin';
    const httpsUrl = `https://preview.example:${original.port}/original`;
    const result = await runBlockedRequest({
      directory: '/policy/tunnel-hostname',
      targetUrl: httpUrl,
      expression: `Promise.all([${blockedFetch(httpUrl)}, ${blockedFetch(httpsUrl)}])`,
      policy: {
        grants: [{ host: 'preview.example', port: original.port }],
        discoverTunnelHosts: async () => [{ hostname: 'preview.example', port: hairpin.port }],
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      },
    });
    expect(result[0]).toBe(true);
    expect(hairpin.requests.some((request) => request.url === '/hairpin')).toBe(true);
    expect(original.connections).toBeGreaterThan(0);
  }, 30_000);

  it('granted HTTP and ws/HMR traverse the real Chromium session policy proxy', async () => {
    const page = await fixture((_request, response) => response.end('<!doctype html><title>hmr</title>'));
    const hmr = await webSocketFixture();
    const result = await runInRealPage({
      directory: '/policy/granted-hmr',
      policy: { grants: [
        { host: '127.0.0.1', port: page.port },
        { host: '127.0.0.1', port: hmr.port },
      ] },
      pageUrl: `http://127.0.0.1:${page.port}/`,
      expression: `new Promise((resolve,reject)=>{const s=new WebSocket('ws://127.0.0.1:${hmr.port}/hmr');s.onopen=()=>s.send('client-hmr');s.onmessage=e=>resolve(e.data);s.onerror=()=>reject(new Error('ws failed'))})`,
    });
    expect(result).toBe('hmr-ok');
    expect(page.requests.length).toBeGreaterThan(0);
    expect(hmr.upgrades).toBe(1);
    expect(hmr.messages).toEqual(['client-hmr']);
  }, 30_000);

  it('a proven cross-site OOPIF renderer executes the forbidden fetch through its owning proxy', async () => {
    const top = await fixture();
    const forbidden = await fixture();
    const frame = await fixture((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<script>addEventListener('message',()=>fetch('http://127.0.0.1:${forbidden.port}/blocked',{mode:'no-cors'}).finally(()=>parent.postMessage('attempted','*')))</script>`);
    });
    const topUrl = `http://top.example:${top.port}/`;
    const frameUrl = `http://frame.example:${frame.port}/frame`;
    const evidence = await runInRealPage({
      directory: '/policy/oopif',
      policy: {
        grants: [
          { host: 'top.example', port: top.port },
          { host: 'frame.example', port: frame.port },
        ],
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      },
      pageUrl: topUrl,
      expression: `new Promise(r=>{addEventListener('message',e=>r(e.data),{once:true});document.querySelector('iframe').contentWindow.postMessage('fetch','*');setTimeout(()=>r('timeout'),1500)})`,
      beforeEvaluate: async ({ cdp, sid }) => {
        await cdp.sendSession(sid, 'Runtime.evaluate', {
          expression: `new Promise(r=>{const f=document.createElement('iframe');f.src=${JSON.stringify(frameUrl)};f.onload=()=>r(true);document.body.append(f)})`,
          awaitPromise: true,
        });
        const target = await waitFor(() => cdp.getTargets().find((entry) => entry.type === 'iframe' && entry.url.startsWith(frameUrl)));
        return { target };
      },
      inspect: async ({ cdp, sid, value, prepared }) => {
        const frameTree = await cdp.sendSession(sid, 'Page.getFrameTree');
        const frames = [];
        const collect = (node) => {
          if (!node) return;
          frames.push(node.frame);
          for (const child of node.childFrames ?? []) collect(child);
        };
        collect(frameTree.frameTree);
        return { value, target: prepared.target, frames };
      },
    });
    expect(evidence.value).toBe('attempted');
    expect(evidence.target).toMatchObject({ type: 'iframe', browserContextId: expect.any(String) });
    expect(evidence.target.targetId).not.toBe(evidence.frames[0]?.id);
    expect(forbidden.connections).toBe(0);
  }, 30_000);

  it.each([
    ['dedicated worker', 'denied WebSocket'],
    ['shared worker', 'denied WebSocket'],
    ['service worker', 'metadata fetch'],
  ])(
    '%s %s stays behind the real session proxy with zero forbidden connections',
    async (name) => {
    await sessions?.close();
    const forbidden = name === 'service worker' ? await fixture() : await webSocketFixture();
    let workerScript = '';
    const allowed = await fixture((request, response) => {
      if (request.url === '/worker.js') {
        response.setHeader('content-type', 'text/javascript');
        response.end(workerScript);
        return;
      }
      if (request.url === '/sw.js') {
        response.setHeader('content-type', 'text/javascript');
        response.end(`self.onmessage=e=>fetch('http://metadata.google.internal:${forbidden.port}/latest/meta-data',{mode:'no-cors'}).then(()=>e.source.postMessage(true)).catch(()=>e.source.postMessage(false))`);
        return;
      }
      response.end('<!doctype html><title>policy</title>');
    });
    sessions = createBrowserSessionManager({
      chromeProcessManager: chrome,
      proxyPolicy: { grants: [{ host: '127.0.0.1', port: allowed.port }] },
    });
    const session = await sessions.createSession({ directory: `/policy/${name}`, openCodeSessionId: name });
    const tab = await sessions.createTab(session.id);
    const targetUrl = `ws://127.0.0.1:${forbidden.port}/blocked`;
    if (name === 'dedicated worker') {
      workerScript = `const s=new WebSocket('${targetUrl}');s.onopen=()=>postMessage(true);s.onerror=()=>postMessage(false)`;
    } else if (name === 'shared worker') {
      workerScript = `onconnect=e=>{const s=new WebSocket('${targetUrl}');s.onopen=()=>e.ports[0].postMessage(true);s.onerror=()=>e.ports[0].postMessage(false)}`;
    }
    const result = await sessions.runReadOnlyOperation(session.id, {
      targetId: tab.targetId,
      operation: async ({ cdp }) => {
        const sid = await cdp.attach(tab.targetId);
        await cdp.sendSession(sid, 'Page.enable');
        await cdp.sendSession(sid, 'Page.navigate', { url: `http://127.0.0.1:${allowed.port}/` });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const expression = name === 'dedicated worker'
          ? `new Promise(r=>{const w=new Worker('/worker.js');w.onmessage=e=>r(e.data);w.onerror=()=>r(false)})`
          : name === 'shared worker'
            ? `new Promise(r=>{const w=new SharedWorker('/worker.js');w.port.onmessage=e=>r(e.data);w.port.start()})`
            : `new Promise(async r=>{const registration=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;navigator.serviceWorker.onmessage=e=>r(e.data);(registration.active||registration.waiting).postMessage('fetch')})`;
        const response = await cdp.sendSession(sid, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        return response.result?.value;
      },
    });
    expect(result).toBe(name === 'service worker' ? true : false);
    expect(forbidden.connections).toBe(0);
    if (name !== 'service worker') expect(forbidden.upgrades).toBe(0);
  }, 30_000);
});

if (!hasChrome) console.warn(`CLEAN-SKIP real Chromium scenarios: ${CHROME} is unavailable`);
