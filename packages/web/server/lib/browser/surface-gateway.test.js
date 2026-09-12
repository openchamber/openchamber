import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { createBrowserSurfaceGateway, SURFACE_WS_PATH } from './surface-gateway.js';

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for test condition');
};

const messageReaders = new WeakMap();

const trackMessages = (socket) => {
  const reader = { queue: [], waiter: null, navigation: [] };
  messageReaders.set(socket, reader);
  socket.on('message', (data, isBinary) => {
    const message = { data: isBinary ? Buffer.from(data) : data.toString('utf8'), isBinary };
    if (!isBinary && JSON.parse(message.data).type === 'navigation') {
      reader.navigation.push(JSON.parse(message.data));
      return;
    }
    if (reader.waiter) {
      const waiter = reader.waiter;
      reader.waiter = null;
      waiter(message);
    } else {
      reader.queue.push(message);
    }
  });
};

const nextMessage = (socket, timeoutMs = 2_000) => {
  const reader = messageReaders.get(socket);
  if (!reader) throw new Error('Socket messages are not tracked');
  if (reader.queue.length) return Promise.resolve(reader.queue.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reader.waiter = null;
      reject(new Error('Timed out waiting for message'));
    }, timeoutMs);
    reader.waiter = (message) => {
      clearTimeout(timer);
      resolve(message);
    };
  });
};

const nextJson = async (socket, timeoutMs = 2_000) => {
  const { data } = await nextMessage(socket, timeoutMs);
  return JSON.parse(data);
};
const nextJsonMatching = async (socket, predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await nextJson(socket, Math.max(1, deadline - Date.now()));
    if (predicate(message)) return message;
  }
  throw new Error('Timed out waiting for matching JSON message');
};
class FakeBrowserSessionManager {
  constructor() {
    this.sessions = new Map();
    this.nextTarget = 1;
    this.nextSession = 1;
    this.leases = new Map();
    this.controlGenerations = new Map();
    this.controlListeners = new Set();
    this.lifecycleListeners = new Set();
    this.viewports = new Map();
    this.subscribers = [];
    this.registrySubscribers = [];
    this.commands = [];
    this.targetSessions = new Map();
    this.histories = new Map();
    this.autoCreateTab = true;
    this.commandHooks = new Map();
    this.selectionResult = { result: { value: { text: 'selected text' } } };
    this.viewerEvents = [];
  }

  keyOf({ directory, openCodeSessionId }) {
    return `${directory}\0${openCodeSessionId ?? 'user'}`;
  }

  async createSession({ directory, openCodeSessionId = null }) {
    const id = this.keyOf({ directory, openCodeSessionId });
    const session = {
      id,
      directory,
      openCodeSessionId,
      persistence: openCodeSessionId ? 'ephemeral' : 'project',
      tabs: [],
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  listSessions() {
    return [...this.sessions.values()];
  }

  async listTabs(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('session not found');
    if (!session.tabs?.length && this.autoCreateTab) {
      const targetId = `target-${this.nextTarget++}`;
      session.tabs = [{
        id: `sc:${targetId}`,
        targetId,
        title: 'New Tab',
        url: 'about:blank',
      }];
    }
    return session.tabs.slice();
  }

  async runReadOnlyOperation(sessionId, { targetId, operation, requireTargetOwnership }) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('session not found');
    if (requireTargetOwnership && !session.tabs.some((tab) => tab.targetId === targetId)) {
      throw new Error('target does not belong to this session');
    }
    if (!this.targetSessions.has(targetId)) this.targetSessions.set(targetId, `cdp-${this.nextSession++}`);
    const cdpSessionId = this.targetSessions.get(targetId);
    const fakeCdp = {
      send: async (method, params) => {
        this.commands.push({ method, params });
        const createdTarget = `target-${this.nextTarget++}`;
        session.tabs.push({ id: `sc:${createdTarget}`, targetId: createdTarget, title: '', url: params.url });
        return { targetId: createdTarget };
      },
      attach: async () => cdpSessionId,
      detach: async () => {},
      sendSession: async (sid, method, params) => {
        this.commands.push({ sid, method, params });
        await this.commandHooks.get(method)?.(params);
        const tab = session.tabs.find((candidate) => candidate.targetId === targetId);
        let history = this.histories.get(targetId);
        if (!history && tab) {
          history = { currentIndex: 0, entries: [{ id: 1, url: tab.url, title: tab.title }] };
          this.histories.set(targetId, history);
        }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `frame-${targetId}` } } };
        if (method === 'Page.getLayoutMetrics') {
          const size = this.viewports.get(targetId) ?? { width: 800, height: 600 };
          return { cssLayoutViewport: { clientWidth: size.width, clientHeight: size.height },
            cssVisualViewport: { clientWidth: size.width, clientHeight: size.height, scale: 1 } };
        }
        if (method === 'Emulation.setDeviceMetricsOverride') this.viewports.set(targetId, params);
        if (method === 'Emulation.clearDeviceMetricsOverride') this.viewports.delete(targetId);
        if (method === 'Runtime.evaluate') {
          return params.expression === 'document.readyState !== "complete"'
            ? { result: { value: false } } : this.selectionResult;
        }
        if (method === 'Page.getNavigationHistory') return structuredClone(history);
        if (method === 'Page.navigate') {
          history.entries.splice(history.currentIndex + 1);
          history.entries.push({ id: history.entries.length + 1, url: params.url, title: 'Navigated' });
          history.currentIndex += 1;
        }
        if (method === 'Page.navigateToHistoryEntry') {
          history.currentIndex = history.entries.findIndex((entry) => entry.id === params.entryId);
        }
        if (method === 'Page.startScreencast') {
          this.startScreencastParams = params;
        }
        if (method === 'Page.screencastFrameAck') {
          this.ackCalls = (this.ackCalls ?? 0) + 1;
        }
        return {};
      },
      onEvent: (listener) => {
        const sub = { sessionId, listener };
        this.subscribers.push(sub);
        return () => {
          this.subscribers = this.subscribers.filter((s) => s !== sub);
        };
      },
      onRegistry: (listener) => {
        this.registrySubscribers.push(listener);
        return () => { this.registrySubscribers = this.registrySubscribers.filter((current) => current !== listener); };
      },
      getTabs: () => session.tabs.map((tab) => ({ ...tab, type: 'page', browserContextId: 'ctx-1' })),
      getSessionId: () => cdpSessionId,
    };
    return operation({ cdp: fakeCdp, browserContextId: 'ctx-1' }) ?? {};
  }

  viewerTakeover(sessionId, viewerId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const current = this.leases.get(sessionId);
    if (current?.viewerId === viewerId) return current;
    const generation = (this.controlGenerations.get(sessionId) ?? 0) + 1;
    this.controlGenerations.set(sessionId, generation);
    const lease = {
      actor: 'user',
      viewerId,
      openCodeSessionId: null,
      generation,
      acquiredAt: Date.now(),
      expiresAt: null,
    };
    this.leases.set(sessionId, lease);
    for (const listener of this.controlListeners) listener({ sessionId, generation, lease });
    return lease;
  }

  viewerConnect(sessionId, viewerId) {
    this.viewerEvents.push({ type: 'connect', sessionId, viewerId });
    return true;
  }

  viewerDisconnect(sessionId, viewerId) {
    this.viewerEvents.push({ type: 'disconnect', sessionId, viewerId });
    if (this.leases.get(sessionId)?.viewerId !== viewerId) return false;
    this.leases.delete(sessionId);
    const generation = (this.controlGenerations.get(sessionId) ?? 0) + 1;
    this.controlGenerations.set(sessionId, generation);
    for (const listener of this.controlListeners) listener({ sessionId, generation, lease: null });
    return true;
  }

  getControlState(sessionId) {
    return { generation: this.controlGenerations.get(sessionId) ?? 0, lease: this.getLease(sessionId) };
  }

  onControlChange(listener) {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  onLifecycle(listener) {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  getLease(sessionId) {
    return this.leases.get(sessionId) ?? null;
  }

  emitScreencastFrame(sessionId, data, metadata = {}, targetId = 'target-1') {
    for (const sub of this.subscribers) {
      if (sub.sessionId !== sessionId && sub.sessionId !== '*') continue;
      sub.listener({
        method: 'Page.screencastFrame',
        sessionId: this.targetSessions.get(targetId),
        params: {
          sessionId: this.nextFrameSessionId = (this.nextFrameSessionId ?? 0) + 1,
          data,
          metadata: {
            deviceWidth: metadata.width ?? 800,
            deviceHeight: metadata.height ?? 600,
            deviceScaleFactor: metadata.scale ?? 1,
          },
        },
      });
    }
  }

  emitEvent(sessionId, targetId, method, params) {
    for (const sub of this.subscribers) {
      if (sub.sessionId === sessionId) sub.listener({ method, params, sessionId: this.targetSessions.get(targetId) });
    }
  }

  emitRegistry(event) {
    for (const listener of this.registrySubscribers) listener(event);
  }
}

const createServer = async (options = {}) => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const requestSecurity = {
    isRequestOriginAllowed: async (req) => {
      const origin = req.headers?.origin || '';
      if (options.allowOrigin) return origin === options.allowOrigin;
      return origin.startsWith('http://127.0.0.1:') || origin.startsWith('http://localhost:');
    },
    rejectWebSocketUpgrade: (socket, code, reason) => {
      const body = Buffer.from(String(reason), 'utf8');
      try {
        socket.write(
          `HTTP/1.1 ${code} ${reason}\r\n` +
          'Connection: close\r\n' +
          'Content-Type: text/plain\r\n' +
          `Content-Length: ${body.length}\r\n\r\n`
        );
        socket.write(body);
      } catch {}
      try { socket.destroy(); } catch {}
    },
  };

  const uiAuth = {
    enabled: options.uiAuthEnabled ?? false,
    resolveAuthContext: async (req) => {
      const cookie = req.headers?.cookie || '';
      if (cookie.includes('oc_ui_session=')) return { type: 'session', token: 'ui-session' };
      if (req.headers?.authorization === 'Bearer client-token') return { type: 'client', token: 'client:device-1' };
      return null;
    },
    ensureSessionToken: async (req) => {
      const cookie = req.headers?.cookie || '';
      return cookie.includes('oc_ui_session=') ? 'ui-session' : null;
    },
    authenticateClientRequest: async (req) => {
      const auth = req.headers?.authorization || '';
      if (auth === 'Bearer client-token') return { type: 'client', token: 'client:device-1' };
      return null;
    },
  };

  const browserSessionManager = options.browserSessionManager ?? new FakeBrowserSessionManager();
  const warnings = [];

  const gateway = createBrowserSurfaceGateway({
    server,
    uiAuthController: options.uiAuthController ?? uiAuth,
    isRequestOriginAllowed: requestSecurity.isRequestOriginAllowed,
    rejectWebSocketUpgrade: requestSecurity.rejectWebSocketUpgrade,
    browserSessionManager: options.browserSessionManager === null ? null : browserSessionManager,
    logger: options.logger ?? { warn: (...args) => warnings.push(args), info: () => {} },
  });

  return { server, port, gateway, browserSessionManager, warnings };
};

const connect = async (port, { directory = '/project', sessionId = '', urlToken = '', origin = 'http://127.0.0.1:3000', headers = {} } = {}) => {
  const url = `ws://127.0.0.1:${port}${SURFACE_WS_PATH}?directory=${encodeURIComponent(directory)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}${urlToken ? `&oc_url_token=${encodeURIComponent(urlToken)}` : ''}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin, headers });
    socket.binaryType = 'arraybuffer';
    trackMessages(socket);
    const onOpen = () => {
      socket.off('error', reject);
      socket.off('close', onCloseWhileConnecting);
      resolve(socket);
    };
    const onCloseWhileConnecting = (code, reason) => {
      if (code !== 1005 && code !== 1000) reject(new Error(`WS closed ${code}: ${reason}`));
    };
    socket.once('open', onOpen);
    socket.once('error', reject);
    socket.once('close', onCloseWhileConnecting);
  });
};

const closeSocket = (socket) => new Promise((resolve) => {
  if (socket.readyState === WebSocket.CLOSED) return resolve();
  socket.once('close', resolve);
  socket.close();
});

describe('surface gateway auth floor', () => {
  let ctx;
  afterEach(async () => {
    if (!ctx) return;
    const s = ctx;
    ctx = null;
    s.gateway.dispose();
    s.server.closeAllConnections?.();
    await new Promise((resolve) => s.server.close(resolve));
  }, 5_000);

  it('rejects bad origin in both uiAuth enabled and disabled modes', async () => {
    ctx = await createServer({ uiAuthEnabled: false });
    await expect(connect(ctx.port, { origin: 'http://evil.com', headers: { authorization: 'Bearer client-token' } }))
      .rejects.toThrow();
  });

  it('rejects uiAuth-disabled + no client token even with valid origin', async () => {
    ctx = await createServer({ uiAuthEnabled: false });
    await expect(connect(ctx.port, { origin: 'http://127.0.0.1:3000' }))
      .rejects.toThrow();
  });

  it('accepts client token when uiAuth is disabled', async () => {
    ctx = await createServer({ uiAuthEnabled: false });
    const socket = await connect(ctx.port, { origin: 'http://127.0.0.1:3000', headers: { authorization: 'Bearer client-token' } });
    const hello = await nextJson(socket);
    expect(hello.type).toBe('hello');
    await closeSocket(socket);
  });

  it('accepts UI session cookie when uiAuth is enabled', async () => {
    ctx = await createServer({ uiAuthEnabled: true });
    const socket = await connect(ctx.port, { origin: 'http://127.0.0.1:3000', headers: { cookie: 'oc_ui_session=abc' } });
    const hello = await nextJson(socket);
    expect(hello.type).toBe('hello');
    await closeSocket(socket);
  });

  it('uses the production password-free auth controller for paired clients and rejects arbitrary cookies', async () => {
    const { createUiAuth } = await import('../ui-auth/ui-auth.js');
    const auth = createUiAuth({ clientAuthController: {
      authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
    } });
    ctx = await createServer({ uiAuthController: auth });
    await expect(connect(ctx.port, { headers: { cookie: 'oc_ui_session=arbitrary' } }))
      .rejects.toThrow('Unexpected server response: 401');
    await expect(connect(ctx.port)).rejects.toThrow('Unexpected server response: 401');
    await expect(connect(ctx.port, { headers: { authorization: 'Bearer invalid' } }))
      .rejects.toThrow('Unexpected server response: 401');
    await expect(connect(ctx.port, { urlToken: 'invalid' }))
      .rejects.toThrow('Unexpected server response: 401');
    const socket = await connect(ctx.port, { headers: {
      authorization: 'Bearer client-token', cookie: 'oc_ui_session=arbitrary',
    } });
    expect((await nextJson(socket)).type).toBe('hello');
    await closeSocket(socket);

    let issuedUrlToken = '';
    await auth.handleUrlAuthToken(
      { method: 'POST', path: '/auth/url-token', headers: { authorization: 'Bearer client-token' } },
      {
        setHeader: () => undefined,
        json: (body) => { issuedUrlToken = body.token; },
      },
    );
    const urlSocket = await connect(ctx.port, { urlToken: issuedUrlToken });
    expect((await nextJson(urlSocket)).type).toBe('hello');
    await closeSocket(urlSocket);
    auth.dispose?.();
  });
});

describe('surface gateway handshake and frames', () => {
  let ctx;

  beforeEach(async () => { ctx = await createServer({ uiAuthEnabled: false }); });

  const attachSocket = async (sessionId, tabId) => {
    const socket = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(socket);
    socket.send(JSON.stringify(sessionId ? { type: 'attach', sessionId } : { type: 'create' }));
    const attached = await nextJson(socket);
    const activeTabId = tabId ?? attached.tabs[0]?.id;
    if (activeTabId) {
      socket.send(JSON.stringify({ type: 'attachTab', tabId: activeTabId }));
      expect((await nextJson(socket)).type).toBe('state');
    }
    return { socket, sessionId: attached.session.id, tabId: activeTabId };
  };

  it('registers an attached viewer until its socket disconnects', async () => {
    const { socket, sessionId } = await attachSocket();
    expect(ctx.browserSessionManager.viewerEvents).toEqual([
      { type: 'connect', sessionId, viewerId: expect.any(String) },
    ]);

    await closeSocket(socket);
    await waitFor(() => ctx.browserSessionManager.viewerEvents.length === 2);

    expect(ctx.browserSessionManager.viewerEvents).toEqual([
      { type: 'connect', sessionId, viewerId: expect.any(String) },
      { type: 'disconnect', sessionId, viewerId: expect.any(String) },
    ]);
    expect(ctx.browserSessionManager.viewerEvents[1].viewerId)
      .toBe(ctx.browserSessionManager.viewerEvents[0].viewerId);
  });
  afterEach(async () => {
    if (!ctx) return;
    const s = ctx;
    ctx = null;
    s.gateway.dispose();
    s.server.closeAllConnections?.();
    await new Promise((resolve) => s.server.close(resolve));
  }, 5_000);

  it('create returns session identity + sc: target ids', async () => {
    const socket = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'create' }));
    const created = await nextJson(socket);
    expect(created.type).toBe('created');
    expect(created.session.directory).toBe('/project');
    expect(created.tabs.every((t) => t.id.startsWith('sc:'))).toBe(true);
    await closeSocket(socket);
  });

  it('list returns sessions for directory', async () => {
    await ctx.browserSessionManager.createSession({ directory: '/project' });
    const socket = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'list' }));
    const list = await nextJson(socket);
    expect(list.type).toBe('list');
    expect(list.sessions.length).toBeGreaterThan(0);
    expect(list.sessions[0].directory).toBe('/project');
    await closeSocket(socket);
  });

  it('attach returns existing session identity + sc: target ids', async () => {
    const session = await ctx.browserSessionManager.createSession({ directory: '/project' });
    const socket = await connect(ctx.port, { sessionId: session.id, headers: { authorization: 'Bearer client-token' } });
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'attach', sessionId: session.id }));
    const attached = await nextJson(socket);
    expect(attached.type).toBe('attached');
    expect(attached.session.id).toBe(session.id);
    expect(attached.tabs.every((t) => t.id.startsWith('sc:'))).toBe(true);
    await closeSocket(socket);
  });

  it('confirms only a completed tab attachment with its request identity', async () => {
    const { socket, tabId } = await attachSocket();
    socket.send(JSON.stringify({ type: 'attachTab', tabId, requestId: 'attach-current' }));
    expect(await nextJson(socket)).toMatchObject({ type: 'state', tabId, attachmentRequestId: 'attach-current' });
    expect(await nextJson(socket)).toMatchObject({ type: 'viewportState', tabId, attachmentRequestId: 'attach-current' });
    socket.send(JSON.stringify({ type: 'text', tabId, text: 'take control' }));
    expect(await nextJson(socket)).toMatchObject({ type: 'viewportState', tabId, attachmentRequestId: 'attach-current' });
    const leaseState = await nextJson(socket);
    expect(leaseState).toMatchObject({ type: 'state', tabId });
    expect(leaseState).not.toHaveProperty('attachmentRequestId');
    await closeSocket(socket);
  });

  it.each(['', 'x'.repeat(129), 7])('rejects an invalid provided tab attachment request identity', async (requestId) => {
    const { socket, tabId } = await attachSocket();
    socket.send(JSON.stringify({ type: 'attachTab', tabId, requestId }));
    expect(await nextJson(socket)).toMatchObject({ type: 'error', code: 'BAD_REQUEST_ID' });
    await closeSocket(socket);
  });

  it('applies passive Auto through the authenticated socket without taking the user lease', async () => {
    const { socket, tabId, sessionId } = await attachSocket();
    socket.send(JSON.stringify({ type: 'attachTab', tabId, requestId: 'viewport-attachment' }));
    expect(await nextJson(socket)).toMatchObject({ type: 'state', attachmentRequestId: 'viewport-attachment' });
    expect(await nextJson(socket)).toMatchObject({ type: 'viewportState' });
    socket.send(JSON.stringify({ type: 'viewportSet', requestId: 'viewport-request', tabId,
      attachmentRequestId: 'viewport-attachment', width: 720, height: 480,
      mode: 'auto', mobile: false, takeover: false }));

    const updates = [await nextJson(socket), await nextJson(socket), await nextJson(socket)];
    expect(updates.at(-1)).toMatchObject({ type: 'viewportResult', requestId: 'viewport-request',
      tabId, attachmentRequestId: 'viewport-attachment', status: 'applied',
      viewport: { width: 720, height: 480, mode: 'auto', source: 'viewer', mobile: false, deviceScaleFactor: 1 } });
    expect(ctx.browserSessionManager.getLease(sessionId)).toBeNull();
    await closeSocket(socket);
  });

  it('restarts the owning screencast once when an applied viewer viewport changes physical configuration', async () => {
    const { socket, tabId, sessionId } = await attachSocket();
    const manager = ctx.browserSessionManager;
    socket.send(JSON.stringify({ type: 'attachTab', tabId, requestId: 'viewport-attachment' }));
    await nextJsonMatching(socket, (message) => message.type === 'state' && message.attachmentRequestId === 'viewport-attachment');
    await nextJsonMatching(socket, (message) => message.type === 'viewportState');
    socket.send(JSON.stringify({ type: 'viewportSet', requestId: 'mobile-layout', tabId,
      attachmentRequestId: 'viewport-attachment', width: 390, height: 844,
      mode: 'auto', mobile: true, takeover: false }));
    expect(await nextJsonMatching(socket, (message) => message.type === 'viewportResult'
      && message.requestId === 'mobile-layout')).toMatchObject({ status: 'applied',
      viewport: { width: 390, height: 844, mobile: true } });
    await waitFor(() => manager.commands.filter((command) => command.method === 'Page.stopScreencast').length === 1
      && manager.commands.filter((command) => command.method === 'Page.startScreencast').length === 2);
    const screencastCommands = manager.commands.filter((command) => ['Page.startScreencast', 'Page.stopScreencast'].includes(command.method));
    expect(screencastCommands.map((command) => command.method)).toEqual([
      'Page.startScreencast', 'Page.stopScreencast', 'Page.startScreencast',
    ]);
    expect(screencastCommands[2]).toEqual({ sid: screencastCommands[0].sid, method: 'Page.startScreencast', params: {
      format: 'jpeg', quality: 80, maxWidth: 0, maxHeight: 0, everyNthFrame: 1,
    } });

    socket.send(JSON.stringify({ type: 'viewportSet', requestId: 'mode-only', tabId,
      attachmentRequestId: 'viewport-attachment', width: 390, height: 844,
      mode: 'fixed', mobile: true, takeover: true }));
    expect(await nextJsonMatching(socket, (message) => message.type === 'viewportResult'
      && message.requestId === 'mode-only')).toMatchObject({ status: 'applied' });
    manager.emitEvent(sessionId, tabId.slice(3), 'Page.frameResized', {});
    manager.emitEvent(sessionId, tabId.slice(3), 'Page.frameResized', {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.commands.filter((command) => command.method === 'Page.stopScreencast')).toHaveLength(1);
    await closeSocket(socket);
  });

  it('does not restart a stale stream after its target attachment changes', async () => {
    const { socket, tabId, sessionId } = await attachSocket();
    const manager = ctx.browserSessionManager;
    socket.send(JSON.stringify({ type: 'attachTab', tabId, requestId: 'viewport-attachment' }));
    await nextJsonMatching(socket, (message) => message.type === 'state' && message.attachmentRequestId === 'viewport-attachment');
    await nextJsonMatching(socket, (message) => message.type === 'viewportState');
    const initialStart = manager.commands.find((command) => command.method === 'Page.startScreencast');
    const stopGate = Promise.withResolvers();
    let heldFirstStop = false;
    manager.commandHooks.set('Page.stopScreencast', async () => {
      if (heldFirstStop) return;
      heldFirstStop = true;
      await stopGate.promise;
    });

    socket.send(JSON.stringify({ type: 'viewportSet', requestId: 'resize-before-switch', tabId,
      attachmentRequestId: 'viewport-attachment', width: 720, height: 480,
      mode: 'auto', mobile: false, takeover: false }));
    await nextJsonMatching(socket, (message) => message.type === 'viewportResult'
      && message.requestId === 'resize-before-switch');
    await waitFor(() => heldFirstStop);
    manager.getSession(sessionId).tabs.push({ id: 'sc:second', targetId: 'second', title: '', url: 'about:blank' });
    socket.send(JSON.stringify({ type: 'attachTab', tabId: 'sc:second', requestId: 'second-attachment' }));
    await waitFor(() => manager.commands.some((command) => command.method === 'Page.startScreencast' && command.sid !== initialStart.sid));
    stopGate.resolve();
    await nextJsonMatching(socket, (message) => message.type === 'state' && message.attachmentRequestId === 'second-attachment');
    await waitFor(() => manager.commands.filter((command) => command.method === 'Page.stopScreencast'
      && command.sid === initialStart.sid).length === 2);
    expect(manager.commands.filter((command) => command.method === 'Page.startScreencast'
      && command.sid === initialStart.sid)).toHaveLength(1);
    await closeSocket(socket);
  });

  it('does not let a superseded tab attachment report an error after the newest attachment succeeds', async () => {
    const { socket, tabId, sessionId } = await attachSocket();
    const manager = ctx.browserSessionManager;
    manager.getSession(sessionId).tabs.push({ id: 'sc:second', targetId: 'second', title: '', url: 'about:blank' });
    let resumeList;
    let notifyList;
    const listStarted = new Promise((resolve) => { notifyList = resolve; });
    const listGate = new Promise((resolve) => { resumeList = resolve; });
    const listTabs = manager.listTabs.bind(manager);
    let paused = false;
    manager.listTabs = async (requestedSessionId) => {
      const tabs = await listTabs(requestedSessionId);
      if (!paused) {
        paused = true;
        notifyList();
        await listGate;
      }
      return tabs;
    };
    socket.send(JSON.stringify({ type: 'attachTab', tabId: 'sc:second', requestId: 'attach-superseded' }));
    await listStarted;
    socket.send(JSON.stringify({ type: 'attachTab', tabId, requestId: 'attach-latest' }));
    expect(await nextJson(socket)).toMatchObject({ type: 'state', tabId, attachmentRequestId: 'attach-latest' });
    expect(await nextJson(socket)).toMatchObject({ type: 'viewportState', tabId, attachmentRequestId: 'attach-latest' });
    resumeList();
    await expect(nextMessage(socket, 120)).rejects.toThrow('Timed out');
    await closeSocket(socket);
  });

  it('frames carry frameSeq and streamGen plus binary JPEG', async () => {
    const socket = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'create' }));
    const created = await nextJson(socket);
    const tabId = created.tabs[0].id;
    socket.send(JSON.stringify({ type: 'attachTab', tabId }));

    await waitFor(() => ctx.browserSessionManager.subscribers.length > 0);
    await nextJson(socket); // discard state

    const jpeg = Buffer.from('fake-jpeg');
    ctx.browserSessionManager.emitScreencastFrame(created.session.id, jpeg.toString('base64'), { width: 100, height: 200, scale: 2 });

    const meta = await nextJson(socket);
    expect(meta.type).toBe('frame');
    expect(meta.frameSeq).toEqual(expect.any(Number));
    expect(meta.streamGen).toEqual(expect.any(Number));
    expect(meta.tabId).toBe(tabId);
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(200);
    expect(meta.scale).toBe(2);

    const binary = await nextMessage(socket);
    expect(binary.isBinary).toBe(true);
    expect(Buffer.from(binary.data).toString()).toBe('fake-jpeg');

    expect(ctx.browserSessionManager.ackCalls).toBeGreaterThan(0);
    await closeSocket(socket);
  });

  it('late joiner receives cached latest frame first', async () => {
    const socket1 = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(socket1);
    socket1.send(JSON.stringify({ type: 'create' }));
    const created = await nextJson(socket1);
    const tabId = created.tabs[0].id;
    socket1.send(JSON.stringify({ type: 'attachTab', tabId }));
    await waitFor(() => ctx.browserSessionManager.subscribers.length > 0);
    await nextJson(socket1); // discard state
    ctx.browserSessionManager.emitScreencastFrame(created.session.id, Buffer.from('frame1').toString('base64'));
    await nextJson(socket1);
    await nextMessage(socket1);
    await closeSocket(socket1);

    const socket2 = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(socket2);
    socket2.send(JSON.stringify({ type: 'attach', sessionId: created.session.id }));
    await nextJson(socket2);
    socket2.send(JSON.stringify({ type: 'attachTab', tabId }));
    const meta = await nextJson(socket2);
    expect(meta.type).toBe('frame');
    expect((await nextMessage(socket2)).isBinary).toBe(true);
    expect((await nextJson(socket2)).type).toBe('state');
    await closeSocket(socket2);
  });

  it('slow viewer latest-frame-wins with unacked bound enforced', async () => {
    const slow = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(slow);
    slow.send(JSON.stringify({ type: 'create' }));
    const created = await nextJson(slow);
    const tabId = created.tabs[0].id;
    slow.send(JSON.stringify({ type: 'attachTab', tabId }));
    await waitFor(() => ctx.browserSessionManager.subscribers.length > 0);
    await nextJson(slow);

    const fast = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(fast);
    fast.send(JSON.stringify({ type: 'attach', sessionId: created.session.id }));
    await nextJson(fast);
    fast.send(JSON.stringify({ type: 'attachTab', tabId }));
    await nextJson(fast);

    for (let i = 0; i < 10; i += 1) {
      ctx.browserSessionManager.emitScreencastFrame(created.session.id, Buffer.from(`frame-${i}`).toString('base64'));
      const meta = await nextJson(fast);
      expect(meta.type).toBe('frame');
      expect((await nextMessage(fast)).isBinary).toBe(true);
      fast.send(JSON.stringify({ type: 'frameAck', frameSeq: meta.frameSeq }));
      fast.send(JSON.stringify({ type: 'list' }));
      expect((await nextJson(fast)).type).toBe('list');
    }

    const slowFrames = [];
    for (let i = 0; i < 3; i += 1) {
      const meta = await nextJson(slow);
      slowFrames.push(meta.frameSeq);
      expect((await nextMessage(slow)).isBinary).toBe(true);
    }
    await expect(nextMessage(slow, 50)).rejects.toThrow('Timed out');

    slow.send(JSON.stringify({ type: 'frameAck', frameSeq: slowFrames.at(-1) }));
    const latest = await nextJson(slow);
    expect(latest.frameSeq).toBeGreaterThan(slowFrames.at(-1));
    expect(Buffer.from((await nextMessage(slow)).data).toString()).toBe('frame-9');
    await closeSocket(fast);
    await closeSocket(slow);
  });

  it('input dispatches matching CDP Input commands without coordinate conversion', async () => {
    const socket = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'create' }));
    const created = await nextJson(socket);
    const tabId = created.tabs[0].id;
    socket.send(JSON.stringify({ type: 'attachTab', tabId }));
    await waitFor(() => ctx.browserSessionManager.subscribers.length > 0);
    await nextJson(socket); // discard state

    socket.send(JSON.stringify({ type: 'pointer', tabId, eventType: 'down', x: 123, y: 456, button: 0 }));
    socket.send(JSON.stringify({ type: 'key', tabId, eventType: 'keydown', key: 'a', modifiers: ['Shift'] }));
    socket.send(JSON.stringify({ type: 'text', tabId, text: 'hello' }));

    await waitFor(() => ctx.browserSessionManager.getLease(created.session.id)?.actor === 'user');
    await waitFor(() => ctx.browserSessionManager.commands.filter((command) => command.method.startsWith('Input.')).length === 3);
    expect(ctx.browserSessionManager.commands.filter((command) => command.method.startsWith('Input.'))).toEqual([
      expect.objectContaining({ method: 'Input.dispatchMouseEvent', params: expect.objectContaining({ x: 123, y: 456 }) }),
      expect.objectContaining({ method: 'Input.dispatchKeyEvent', params: expect.objectContaining({ key: 'a', modifiers: 8 }) }),
      expect.objectContaining({ method: 'Input.insertText', params: { text: 'hello' } }),
    ]);
    await closeSocket(socket);
    await waitFor(() => ctx.browserSessionManager.getLease(created.session.id) === null);
  });

  it('copies only the attached target selection with a correlated response', async () => {
    const { socket, tabId } = await attachSocket();
    socket.send(JSON.stringify({ type: 'copy', tabId, requestId: 'copy-1' }));
    expect((await nextJson(socket)).controlling).toBe(true);
    expect(await nextJson(socket)).toEqual({ type: 'copyResult', requestId: 'copy-1', tabId, ok: true, text: 'selected text' });
    const evaluation = ctx.browserSessionManager.commands.at(-1);
    expect(evaluation).toMatchObject({ method: 'Runtime.evaluate', params: { returnByValue: true } });
    await closeSocket(socket);
  });

  it('routes an attachment-scoped context request through one right-click pair with a correlated conservative result', async () => {
    const { socket, tabId } = await attachSocket();
    socket.send(JSON.stringify({ type: 'attachTab', tabId, requestId: 'context-attachment' }));
    expect((await nextJson(socket)).attachmentRequestId).toBe('context-attachment');
    const request = { type: 'contextMenu', tabId, attachmentRequestId: 'context-attachment', requestId: 'menu-1', x: 10, y: 20 };
    socket.send(JSON.stringify(request));
    expect(await nextJsonMatching(socket, (message) => message.type === 'contextMenuResult')).toEqual({
      type: 'contextMenuResult', tabId, attachmentRequestId: 'context-attachment', requestId: 'menu-1', status: 'unavailable',
    });
    expect(ctx.browserSessionManager.commands.filter((command) => command.method === 'Input.dispatchMouseEvent')
      .map((command) => command.params)).toEqual([
      { type: 'mousePressed', x: 10, y: 20, button: 'right', clickCount: 1 },
      { type: 'mouseReleased', x: 10, y: 20, button: 'right', clickCount: 1 },
    ]);
    await closeSocket(socket);
  });

  it('rejects invalid context identities and coordinates before taking control', async () => {
    const { socket, tabId, sessionId } = await attachSocket();
    socket.send(JSON.stringify({ type: 'attachTab', tabId, requestId: 'context-attachment' }));
    await nextJsonMatching(socket, (message) => message.type === 'viewportState');
    const request = { type: 'contextMenu', tabId, attachmentRequestId: 'context-attachment', requestId: 'menu-1', x: 10, y: 20 };
    const manager = ctx.browserSessionManager;
    manager.commands.length = 0;
    for (const field of ['tabId', 'attachmentRequestId', 'requestId']) {
      for (const value of ['', 42, 'x'.repeat(129)]) socket.send(JSON.stringify({ ...request, [field]: value }));
    }
    socket.send(JSON.stringify({ type: 'list' }));
    expect((await nextJson(socket)).type).toBe('list');
    for (const invalid of [{ x: null }, { y: '20' }, { x: -1 }, { tabId: 'sc:foreign' }, { attachmentRequestId: 'old' }]) {
      socket.send(JSON.stringify({ ...request, ...invalid }));
      expect(await nextJson(socket)).toMatchObject({ type: 'contextMenuResult', status: 'unavailable' });
    }
    expect(manager.getLease(sessionId)).toBeNull();
    expect(manager.commands).toEqual([]);
    await closeSocket(socket);
  });

  it.each(['tab switch', 'takeover', 'disconnect', 'target removal', 'wheel'])('drops context requests after %s during target focus', async (invalidation) => {
    const { socket, tabId, sessionId } = await attachSocket();
    socket.send(JSON.stringify({ type: 'attachTab', tabId, requestId: 'context-attachment' }));
    await nextJsonMatching(socket, (message) => message.type === 'viewportState');
    const results = [];
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString());
      if (message.type === 'contextMenuResult') results.push(message);
    });
    const manager = ctx.browserSessionManager;
    let release;
    let completed = false;
    const blocked = new Promise((resolve) => { release = resolve; });
    manager.commandHooks.set('Page.bringToFront', async () => { await blocked; completed = true; });
    manager.commands.length = 0;
    socket.send(JSON.stringify({ type: 'contextMenu', tabId, attachmentRequestId: 'context-attachment', requestId: 'stale-menu', x: 10, y: 20 }));
    await nextJson(socket);
    await waitFor(() => manager.commands.some((command) => command.method === 'Page.bringToFront'));
    if (invalidation === 'disconnect') {
      await closeSocket(socket);
      await waitFor(() => manager.getLease(sessionId) === null);
    } else if (invalidation === 'takeover') {
      manager.viewerTakeover(sessionId, 'replacement-viewer');
    } else if (invalidation === 'target removal') {
      manager.getSession(sessionId).tabs = [];
      manager.emitRegistry({ type: 'destroy', targetId: tabId.slice(3) });
      await nextJson(socket);
    } else if (invalidation === 'wheel') {
      socket.send(JSON.stringify({ type: 'wheel', tabId, x: 10, y: 20, deltaX: 0, deltaY: 100 }));
      await waitFor(() => manager.commands.filter((command) => command.method === 'Page.bringToFront').length === 2);
    } else {
      socket.send(JSON.stringify({ type: 'attachTab', tabId, requestId: 'replacement-attachment' }));
      await nextJsonMatching(socket, (message) => message.type === 'state' && message.attachmentRequestId === 'replacement-attachment');
    }
    release();
    await waitFor(() => completed);
    if (invalidation !== 'disconnect') {
      socket.send(JSON.stringify({ type: 'list' }));
      await nextJsonMatching(socket, (message) => message.type === 'list');
      await closeSocket(socket);
    }
    expect(manager.commands.filter((command) => command.method === 'Input.dispatchMouseEvent'
      && ['mousePressed', 'mouseReleased'].includes(command.params.type))).toEqual([]);
    expect(results).toEqual([]);
  });

  it('starts the inspector passively and routes evaluation through viewer control', async () => {
    const { socket, tabId, sessionId } = await attachSocket();
    const manager = ctx.browserSessionManager;
    manager.commands.length = 0;
    socket.send(JSON.stringify({ type: 'inspectorStart', tabId, requestId: 'start-inspector' }));
    const started = await nextJson(socket);
    expect(started).toMatchObject({ type: 'inspectorStarted', tabId, requestId: 'start-inspector' });
    expect(manager.getLease(sessionId)).toBeNull();
    expect(manager.commands.map((command) => command.method)).toEqual(['Page.getFrameTree', 'Runtime.enable']);
    manager.emitEvent(sessionId, tabId.slice(3), 'Runtime.consoleAPICalled', {
      type: 'log', timestamp: Date.now(), args: [{ type: 'string', value: 'inspector visible' }],
    });
    const batch = await nextJson(socket);
    expect(batch).toMatchObject({ type: 'inspectorEvents', captureId: started.captureId });
    expect(batch.console[0].text).toBe('inspector visible');
    manager.selectionResult = { result: { type: 'number', value: 42 } };
    socket.send(JSON.stringify({ type: 'inspectorEvaluate', tabId, requestId: 'eval-inspector', captureId: started.captureId, expression: '21 * 2' }));
    expect((await nextJson(socket)).controlling).toBe(true);
    expect(await nextJson(socket)).toMatchObject({ type: 'inspectorEvaluated', text: '42', isError: false });
    expect(manager.commands.some((command) => command.method === 'Page.bringToFront')).toBe(true);
    await closeSocket(socket);
    await waitFor(() => manager.commands.some((command) => command.method === 'Runtime.disable'));
    expect(manager.commands.some((command) => command.method === 'Network.disable')).toBe(false);
  });

  it('drops pending inspector events when its viewer switches tabs', async () => {
    const { socket, tabId, sessionId } = await attachSocket();
    const manager = ctx.browserSessionManager;
    socket.send(JSON.stringify({ type: 'inspectorStart', tabId, requestId: 'start-inspector' }));
    const started = await nextJson(socket);
    manager.emitEvent(sessionId, tabId.slice(3), 'Runtime.consoleAPICalled', {
      type: 'log', timestamp: Date.now(), args: [{ type: 'string', value: 'stale inspector text' }],
    });
    manager.getSession(sessionId).tabs.push({ id: 'sc:second', targetId: 'second', title: '', url: 'about:blank' });
    socket.send(JSON.stringify({ type: 'attachTab', tabId: 'sc:second' }));
    expect((await nextJson(socket)).type).toBe('state');
    await expect(nextMessage(socket, 120)).rejects.toThrow('Timed out');
    socket.send(JSON.stringify({ type: 'inspectorEvaluate', tabId: 'sc:second', requestId: 'old-capture', captureId: started.captureId, expression: '42' }));
    expect(await nextJson(socket)).toMatchObject({ type: 'inspectorError', code: 'CAPTURE_GONE' });
    await closeSocket(socket);
  });

  it.each([
    [{ result: { value: { text: '' } } }, 'NO_SELECTION'],
    [{ result: { value: { text: '\\'.repeat(33 * 1024) } } }, 'COPY_TOO_LARGE'],
    [{ result: { value: { text: '🦊'.repeat(17 * 1024) } } }, 'COPY_TOO_LARGE'],
    [{ result: { value: { code: 'COPY_TOO_LARGE' } } }, 'COPY_TOO_LARGE'],
    [{ result: { value: { code: 'COPY_FAILED' } } }, 'COPY_FAILED'],
    [{ result: { value: { text: 17 } } }, 'COPY_FAILED'],
    [{ exceptionDetails: { text: 'private error data' } }, 'COPY_FAILED'],
  ])('returns a bounded copy failure without selected text or protocol exception data', async (result, code) => {
    const { socket, tabId } = await attachSocket();
    ctx.browserSessionManager.selectionResult = result;
    socket.send(JSON.stringify({ type: 'copy', tabId, requestId: 'failed-copy' }));
    await nextJson(socket);
    const response = await nextJson(socket);
    expect(response).toEqual({ type: 'copyResult', requestId: 'failed-copy', tabId, ok: false, code, message: expect.any(String) });
    expect(JSON.stringify(response)).not.toContain('private error data');
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(64 * 1024);
    await closeSocket(socket);
  });

  it('rejects wrong-tab and unattached copy before taking control or evaluating', async () => {
    const { socket, sessionId } = await attachSocket();
    ctx.browserSessionManager.commands.length = 0;
    socket.send(JSON.stringify({ type: 'copy', tabId: 'sc:foreign', requestId: 'wrong-tab' }));
    expect(await nextJson(socket)).toMatchObject({ type: 'copyResult', requestId: 'wrong-tab', ok: false, code: 'COPY_FAILED' });
    expect(ctx.browserSessionManager.getLease(sessionId)).toBeNull();
    expect(ctx.browserSessionManager.commands).toHaveLength(0);
    const observer = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(observer);
    observer.send(JSON.stringify({ type: 'copy', tabId: 'sc:target-1', requestId: 'unattached' }));
    expect(await nextJson(observer)).toMatchObject({ type: 'copyResult', requestId: 'unattached', ok: false, code: 'COPY_FAILED' });
    expect(ctx.browserSessionManager.commands).toHaveLength(0);
    await closeSocket(observer);
    await closeSocket(socket);
  });

  it('ignores invalid copy identities before taking control or evaluating', async () => {
    const { socket, tabId, sessionId } = await attachSocket();
    ctx.browserSessionManager.commands.length = 0;
    for (const requestId of ['', 42, 'x'.repeat(129)]) socket.send(JSON.stringify({ type: 'copy', tabId, requestId }));
    socket.send(JSON.stringify({ type: 'list' }));
    expect((await nextJson(socket)).type).toBe('list');
    expect(ctx.browserSessionManager.getLease(sessionId)).toBeNull();
    expect(ctx.browserSessionManager.commands).toHaveLength(0);
    await closeSocket(socket);
  });

  it('bounds the complete encoded copy response without truncating valid text', async () => {
    const { socket, tabId } = await attachSocket();
    const response = { type: 'copyResult', tabId, requestId: 'boundary', ok: true, text: '' };
    const text = 'x'.repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(response)));
    for (const [selection, ok] of [[text, true], [text + 'x', false]]) {
      ctx.browserSessionManager.selectionResult = { result: { value: { text: selection } } };
      socket.send(JSON.stringify({ type: 'copy', tabId, requestId: 'boundary' }));
      await nextJson(socket);
      const reply = await nextJson(socket);
      expect(reply.ok).toBe(ok);
      if (ok) {
        expect(reply.text).toBe(text);
        expect(Buffer.byteLength(JSON.stringify(reply))).toBe(64 * 1024);
      } else {
        expect(reply.code).toBe('COPY_TOO_LARGE');
        expect(reply).not.toHaveProperty('text');
      }
    }
    await closeSocket(socket);
  });

  it.each(['Page.bringToFront', 'Runtime.evaluate'])('sanitizes %s copy failures', async (method) => {
    const { socket, tabId } = await attachSocket();
    ctx.browserSessionManager.commandHooks.set(method, () => { throw new Error('private protocol error and selected text'); });
    socket.send(JSON.stringify({ type: 'copy', tabId, requestId: 'failed-command' }));
    await nextJson(socket);
    expect(await nextJson(socket)).toEqual({ type: 'copyResult', tabId, requestId: 'failed-command', ok: false,
      code: 'COPY_FAILED', message: 'Could not read the selected text from the remote page' });
    expect(ctx.warnings).toEqual([]);
    await closeSocket(socket);
  });

  it.each(['tab switch', 'takeover', 'disconnect', 'target removal'].flatMap((invalidation) => [
    { invalidation, failed: false }, { invalidation, failed: true },
  ]))('drops copy completion after $invalidation, failed=$failed', async ({ invalidation, failed }) => {
    const { socket, tabId, sessionId } = await attachSocket();
    const manager = ctx.browserSessionManager;
    let release;
    let started = false;
    let completed = false;
    const gate = new Promise((resolve) => { release = resolve; });
    manager.commandHooks.set('Runtime.evaluate', async (params) => {
      if (params.expression === 'document.readyState !== "complete"') return;
      started = true;
      await gate;
      completed = true;
      if (failed) throw new Error('private stale copy error');
    });
    socket.send(JSON.stringify({ type: 'copy', tabId, requestId: 'stale-copy' }));
    await nextJson(socket);
    await waitFor(() => started);
    if (invalidation === 'disconnect') {
      await closeSocket(socket);
      await waitFor(() => manager.getLease(sessionId) === null);
    } else if (invalidation === 'takeover') {
      manager.viewerTakeover(sessionId, 'replacement-viewer');
    } else if (invalidation === 'target removal') {
      manager.getSession(sessionId).tabs = [];
      manager.emitRegistry({ type: 'destroy', targetId: tabId.slice(3) });
      expect((await nextJson(socket)).type).toBe('tabs');
    } else {
      manager.getSession(sessionId).tabs.push({ id: 'sc:second', targetId: 'second', title: '', url: 'about:blank' });
      socket.send(JSON.stringify({ type: 'attachTab', tabId: 'sc:second' }));
      expect((await nextJson(socket)).type).toBe('state');
    }
    release();
    await waitFor(() => completed);
    if (invalidation !== 'disconnect') {
      socket.send(JSON.stringify({ type: 'list' }));
      expect((await nextJson(socket)).type).toBe('list');
      await expect(nextMessage(socket, 30)).rejects.toThrow('Timed out');
      await closeSocket(socket);
    }
    expect(messageReaders.get(socket).queue.some((message) => !message.isBinary && JSON.parse(message.data).type === 'copyResult')).toBe(false);
    expect(ctx.warnings).toEqual([]);
  });

  it('does not evaluate copy after disconnecting during target focus', async () => {
    const { socket, tabId, sessionId } = await attachSocket();
    const manager = ctx.browserSessionManager;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    manager.commandHooks.set('Page.bringToFront', () => gate);
    manager.commands.length = 0;
    socket.send(JSON.stringify({ type: 'copy', tabId, requestId: 'cancel-before-read' }));
    await nextJson(socket);
    await waitFor(() => manager.commands.some((command) => command.method === 'Page.bringToFront'));
    await closeSocket(socket);
    await waitFor(() => manager.getLease(sessionId) === null);
    release();
    const current = await attachSocket(sessionId, tabId);
    expect(manager.commands.some((command) => command.method === 'Runtime.evaluate'
      && command.params.expression !== 'document.readyState !== "complete"')).toBe(false);
    await closeSocket(current.socket);
  });

  it.each(['Control', 'Meta'])('adds the selectAll editing command only for %s+A keydown', async (modifier) => {
    const { socket, tabId } = await attachSocket();
    const manager = ctx.browserSessionManager;
    for (const input of [
      { eventType: 'keydown', key: 'a', modifiers: [modifier] },
      { eventType: 'keyup', key: 'a', modifiers: [modifier] },
      { eventType: 'keydown', key: 'a', modifiers: [modifier, 'Shift'] },
      { eventType: 'keydown', key: 'a', modifiers: [modifier, 'Alt'] },
      { eventType: 'keydown', key: 'b', modifiers: [modifier] },
    ]) socket.send(JSON.stringify({ type: 'key', tabId, ...input }));
    await waitFor(() => manager.commands.filter((command) => command.method === 'Input.dispatchKeyEvent').length === 5);
    const keys = manager.commands.filter((command) => command.method === 'Input.dispatchKeyEvent');
    expect(keys[0].params.commands).toEqual(['selectAll']);
    expect(keys.slice(1).every((command) => !Object.hasOwn(command.params, 'commands'))).toBe(true);
    await closeSocket(socket);
  });

  it.each([
    ['Backspace', 8], ['Tab', 9], ['Enter', 13], ['Escape', 27],
    ['PageUp', 33], ['PageDown', 34], ['End', 35], ['Home', 36],
    ['ArrowLeft', 37], ['ArrowUp', 38], ['ArrowRight', 39], ['ArrowDown', 40],
    ['Insert', 45], ['Delete', 46],
  ])('preserves the native editing identity of %s on keydown and keyup', async (key, windowsVirtualKeyCode) => {
    const { socket, tabId } = await attachSocket();
    const manager = ctx.browserSessionManager;

    for (const eventType of ['keydown', 'keyup']) {
      socket.send(JSON.stringify({ type: 'key', tabId, eventType, key, modifiers: ['Control', 'Shift'] }));
    }

    await waitFor(() => manager.commands.filter((command) => command.method === 'Input.dispatchKeyEvent').length === 2);
    const keys = manager.commands.filter((command) => command.method === 'Input.dispatchKeyEvent');
    expect(keys.map((command) => command.params)).toEqual([
      expect.objectContaining({ type: 'keyDown', key, code: key, windowsVirtualKeyCode, modifiers: 10 }),
      expect.objectContaining({ type: 'keyUp', key, code: key, windowsVirtualKeyCode, modifiers: 10 }),
    ]);
    await closeSocket(socket);
  });

  it.each([
    { modifiers: [] }, { modifiers: ['Shift'] }, { modifiers: ['Control'] },
    { modifiers: ['Alt'] }, { modifiers: ['Meta'] },
  ])('sends Enter text only for typing modifiers $modifiers', async ({ modifiers }) => {
    const { socket, tabId } = await attachSocket();
    const manager = ctx.browserSessionManager;

    for (const eventType of ['keydown', 'keyup']) {
      socket.send(JSON.stringify({ type: 'key', tabId, eventType, key: 'Enter', modifiers }));
    }

    await waitFor(() => manager.commands.filter((command) => command.method === 'Input.dispatchKeyEvent').length === 2);
    const keys = manager.commands.filter((command) => command.method === 'Input.dispatchKeyEvent');
    expect(keys[0].params.text).toBe(modifiers.some((modifier) => modifier !== 'Shift') ? undefined : '\r');
    expect(keys[1].params.text).toBeUndefined();
    await closeSocket(socket);
  });

  it('reports the controlling socket and ignores observer or superseded-owner disconnects', async () => {
    const owner = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(owner);
    owner.send(JSON.stringify({ type: 'create' }));
    const created = await nextJson(owner);
    const tabId = created.tabs[0].id;
    owner.send(JSON.stringify({ type: 'attachTab', tabId }));
    await nextJson(owner);
    owner.send(JSON.stringify({ type: 'text', tabId, text: 'first owner' }));
    expect((await nextJson(owner)).controlling).toBe(true);
    const firstLease = ctx.browserSessionManager.getLease(created.session.id);

    const observer = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(observer);
    observer.send(JSON.stringify({ type: 'attach', sessionId: created.session.id }));
    await nextJson(observer);
    observer.send(JSON.stringify({ type: 'attachTab', tabId }));
    expect((await nextJson(observer)).controlling).toBe(false);
    await closeSocket(observer);
    expect(ctx.browserSessionManager.getLease(created.session.id)).toEqual(firstLease);

    const replacement = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(replacement);
    replacement.send(JSON.stringify({ type: 'attach', sessionId: created.session.id }));
    await nextJson(replacement);
    replacement.send(JSON.stringify({ type: 'attachTab', tabId }));
    expect((await nextJson(replacement)).controlling).toBe(false);
    replacement.send(JSON.stringify({ type: 'text', tabId, text: 'new owner' }));
    expect((await nextJson(replacement)).controlling).toBe(true);
    expect((await nextJson(owner)).controlling).toBe(false);
    const secondLease = ctx.browserSessionManager.getLease(created.session.id);
    expect(secondLease.viewerId).not.toBe(firstLease.viewerId);
    await closeSocket(owner);
    expect(ctx.browserSessionManager.getLease(created.session.id)).toEqual(secondLease);
    expect(ctx.browserSessionManager.commands.some((command) => command.method === 'Page.stopScreencast')).toBe(false);
    await closeSocket(replacement);
    await waitFor(() => ctx.browserSessionManager.getLease(created.session.id) === null);
    ctx.gateway.dispose();
    expect(ctx.browserSessionManager.getLease(created.session.id)).toBeNull();
    expect(ctx.browserSessionManager.getSession(created.session.id)).toBeDefined();
  });

  it('releases the previous session lease when the same socket attaches to another session', async () => {
    const first = await ctx.browserSessionManager.createSession({ directory: '/project', openCodeSessionId: 'agent-1' });
    const second = await ctx.browserSessionManager.createSession({ directory: '/project', openCodeSessionId: 'agent-2' });
    const socket = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'attach', sessionId: first.id }));
    const attached = await nextJson(socket);
    socket.send(JSON.stringify({ type: 'attachTab', tabId: attached.tabs[0].id }));
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'text', tabId: attached.tabs[0].id, text: 'control first' }));
    expect((await nextJson(socket)).controlling).toBe(true);
    socket.send(JSON.stringify({ type: 'attach', sessionId: second.id }));
    expect((await nextJson(socket)).type).toBe('attached');
    expect(ctx.browserSessionManager.getLease(first.id)).toBeNull();
    await closeSocket(socket);
    expect(ctx.browserSessionManager.getSession(first.id)).toBeDefined();
    expect(ctx.browserSessionManager.getSession(second.id)).toBeDefined();
  });

  it('notifies the remaining observer when the controlling socket disconnects', async () => {
    const session = await ctx.browserSessionManager.createSession({ directory: '/project' });
    const owner = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(owner);
    owner.send(JSON.stringify({ type: 'attach', sessionId: session.id }));
    const attached = await nextJson(owner);
    const tabId = attached.tabs[0].id;
    owner.send(JSON.stringify({ type: 'attachTab', tabId }));
    await nextJson(owner);
    owner.send(JSON.stringify({ type: 'text', tabId, text: 'owner' }));
    await nextJson(owner);
    const observer = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(observer);
    observer.send(JSON.stringify({ type: 'attach', sessionId: session.id }));
    await nextJson(observer);
    observer.send(JSON.stringify({ type: 'attachTab', tabId }));
    expect((await nextJson(observer)).controlling).toBe(false);

    await closeSocket(owner);
    expect(await nextJson(observer)).toEqual({ type: 'state', tabId, lease: null, controlling: false });
    expect(ctx.browserSessionManager.subscribers).toHaveLength(1);
    expect(ctx.browserSessionManager.commands.some((command) => command.method === 'Page.stopScreencast')).toBe(false);
    await closeSocket(observer);
  });

  it('does not register a closed socket when its session attachment finishes late', async () => {
    let resumeListing;
    let notifyListing;
    const listingStarted = new Promise((resolve) => { notifyListing = resolve; });
    const listingGate = new Promise((resolve) => { resumeListing = resolve; });
    class PausedSessionManager extends FakeBrowserSessionManager {
      holdListing = true;

      async listTabs(sessionId) {
        if (this.holdListing) {
          this.holdListing = false;
          notifyListing();
          await listingGate;
        }
        return super.listTabs(sessionId);
      }
    }
    ctx.gateway.dispose();
    await new Promise((resolve) => ctx.server.close(resolve));
    ctx = await createServer({ browserSessionManager: new PausedSessionManager() });
    const session = await ctx.browserSessionManager.createSession({ directory: '/project' });
    const stale = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(stale);
    stale.send(JSON.stringify({ type: 'attach', sessionId: session.id }));
    await listingStarted;
    await closeSocket(stale);
    resumeListing();

    const current = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(current);
    current.send(JSON.stringify({ type: 'attach', sessionId: session.id }));
    const attached = await nextJson(current);
    current.send(JSON.stringify({ type: 'attachTab', tabId: attached.tabs[0].id }));
    await nextJson(current);
    expect(ctx.browserSessionManager.subscribers).toHaveLength(1);
    await closeSocket(current);
    await waitFor(() => ctx.browserSessionManager.subscribers.length === 0);
    expect(ctx.browserSessionManager.commands.some((command) => command.method === 'Page.stopScreencast')).toBe(true);
  });

  it('drops input that reaches CDP after its controlling socket disconnected', async () => {
    let resumeInput;
    let notifyInput;
    const inputStarted = new Promise((resolve) => { notifyInput = resolve; });
    const inputGate = new Promise((resolve) => { resumeInput = resolve; });
    class PausedInputManager extends FakeBrowserSessionManager {
      inputFinished = false;

      async runReadOnlyOperation(sessionId, operation) {
        if (this.getLease(sessionId)?.actor !== 'user') return super.runReadOnlyOperation(sessionId, operation);
        notifyInput();
        await inputGate;
        try {
          return await super.runReadOnlyOperation(sessionId, operation);
        } finally {
          this.inputFinished = true;
        }
      }
    }
    ctx.gateway.dispose();
    await new Promise((resolve) => ctx.server.close(resolve));
    ctx = await createServer({ browserSessionManager: new PausedInputManager() });
    const socket = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'create' }));
    const created = await nextJson(socket);
    const tabId = created.tabs[0].id;
    socket.send(JSON.stringify({ type: 'attachTab', tabId }));
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'text', tabId, text: 'stale input' }));
    await inputStarted;
    await closeSocket(socket);
    await waitFor(() => ctx.browserSessionManager.getLease(created.session.id) === null);
    resumeInput();
    await waitFor(() => ctx.browserSessionManager.inputFinished);
    expect(ctx.browserSessionManager.commands.some((command) => command.method.startsWith('Input.'))).toBe(false);
  });

  it('stops a screencast whose tab attachment finishes after the last socket closes', async () => {
    let resumeScreencast;
    let notifyScreencast;
    const screencastStarted = new Promise((resolve) => { notifyScreencast = resolve; });
    const screencastGate = new Promise((resolve) => { resumeScreencast = resolve; });
    class PausedScreencastManager extends FakeBrowserSessionManager {
      pausedScreencast = false;

      async runReadOnlyOperation(sessionId, operation) {
        const result = await super.runReadOnlyOperation(sessionId, operation);
        if (!this.pausedScreencast && this.commands.some((command) => command.method === 'Page.startScreencast')) {
          this.pausedScreencast = true;
          notifyScreencast();
          await screencastGate;
        }
        return result;
      }
    }
    ctx.gateway.dispose();
    await new Promise((resolve) => ctx.server.close(resolve));
    ctx = await createServer({ browserSessionManager: new PausedScreencastManager() });
    const socket = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'create' }));
    const created = await nextJson(socket);
    socket.send(JSON.stringify({ type: 'attachTab', tabId: created.tabs[0].id }));
    await screencastStarted;
    await closeSocket(socket);
    resumeScreencast();
    await waitFor(() => ctx.browserSessionManager.commands.some((command) => command.method === 'Page.stopScreencast'));
    expect(ctx.browserSessionManager.subscribers).toHaveLength(0);
    expect(ctx.browserSessionManager.commands.filter((command) => command.method === 'Page.stopScreencast')).toHaveLength(1);
  });

  it('rejects input for unattached session', async () => {
    const socket = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'create' }));
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'pointer', tabId: 'sc:target-1', eventType: 'down', x: 0, y: 0 }));
    const error = await nextJson(socket);
    expect(error.type).toBe('error');
    expect(error.code).toBe('NOT_ATTACHED');
    await closeSocket(socket);
  });

  it('malformed input message is ignored with warning', async () => {
    const warnings = [];
    ctx.gateway.dispose();
    await new Promise((resolve) => ctx.server.close(resolve));
    ctx = await createServer({ uiAuthEnabled: false, logger: { warn: (...args) => warnings.push(args), info: () => {} } });
    const socket = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'create' }));
    const created = await nextJson(socket);
    socket.send(JSON.stringify({ type: 'attachTab', tabId: created.tabs[0].id }));
    await nextJson(socket);
    socket.send(JSON.stringify({ type: 'pointer', tabId: created.tabs[0].id, eventType: 'down', x: 'bad', y: 0 }));
    socket.send(JSON.stringify({ type: 'list' }));
    await nextJson(socket);
    await closeSocket(socket);
    expect(warnings.some((args) => args[0] === '[browser-surface] ignored malformed input message')).toBe(true);
    expect(ctx.browserSessionManager.commands.some((command) => command.method.startsWith('Input.'))).toBe(false);
  });

  it('forwards wheel pixels and modifiers while rejecting malformed or foreign-tab input', async () => {
    const { socket, tabId, sessionId } = await attachSocket();
    for (const message of [
      { type: 'wheel', tabId, x: 1, y: 2, deltaX: null, deltaY: 30 },
      { type: 'wheel', tabId, x: 1, y: 2, deltaX: 0, deltaY: 30, modifiers: ['Super'] },
      { type: 'wheel', tabId: 'sc:foreign', x: 1, y: 2, deltaX: 0, deltaY: 30 },
    ]) socket.send(JSON.stringify(message));
    socket.send(JSON.stringify({ type: 'list' }));
    await nextJson(socket);
    expect(ctx.browserSessionManager.getLease(sessionId)).toBeNull();
    socket.send(JSON.stringify({ type: 'wheel', tabId, x: 123.5, y: 456, deltaX: -4, deltaY: 32.5, modifiers: ['Shift', 'Control'] }));
    await waitFor(() => ctx.browserSessionManager.commands.some((command) => command.params?.type === 'mouseWheel'));
    expect(ctx.browserSessionManager.commands.find((command) => command.params?.type === 'mouseWheel').params).toEqual({
      type: 'mouseWheel', x: 123.5, y: 456, deltaX: -4, deltaY: 32.5, modifiers: 10,
    });
    const focusIndex = ctx.browserSessionManager.commands.findIndex((command) => command.method === 'Page.bringToFront');
    const wheelIndex = ctx.browserSessionManager.commands.findIndex((command) => command.params?.type === 'mouseWheel');
    expect(focusIndex).toBeGreaterThanOrEqual(0);
    expect(focusIndex).toBeLessThan(wheelIndex);
    await closeSocket(socket);
  });

  it('drops input when its viewer disconnects during the focus request', async () => {
    const { socket, tabId, sessionId } = await attachSocket();
    const manager = ctx.browserSessionManager;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    manager.commandHooks.set('Page.bringToFront', () => gate);
    socket.send(JSON.stringify({ type: 'wheel', tabId, x: 1, y: 2, deltaX: 0, deltaY: 400 }));
    await waitFor(() => manager.commands.some((command) => command.method === 'Page.bringToFront'));
    await closeSocket(socket);
    await waitFor(() => manager.getLease(sessionId) === null);
    release();
    const current = await attachSocket(sessionId, tabId);
    expect(manager.commands.some((command) => command.method.startsWith('Input.'))).toBe(false);
    await closeSocket(current.socket);
  });

  it('navigates using Chrome history and rejects unsafe addresses before taking control', async () => {
    const { socket, tabId, sessionId } = await attachSocket();
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hello', 'chrome://settings', 'example.com']) {
      socket.send(JSON.stringify({ type: 'navigate', tabId, url }));
      expect((await nextJson(socket)).code).toBe('INVALID_NAVIGATION');
    }
    socket.send(JSON.stringify({ type: 'navigate', tabId: 'sc:foreign', url: 'https://example.com/' }));
    expect((await nextJson(socket)).code).toBe('NOT_ATTACHED');
    expect(ctx.browserSessionManager.getLease(sessionId)).toBeNull();
    socket.send(JSON.stringify({ type: 'navigate', tabId, url: 'https://example.com/' }));
    await waitFor(() => messageReaders.get(socket).navigation.at(-1)?.canGoBack);
    expect(messageReaders.get(socket).navigation.at(-1)).toMatchObject({ url: 'https://example.com/', canGoForward: false });
    socket.send(JSON.stringify({ type: 'back', tabId }));
    await waitFor(() => messageReaders.get(socket).navigation.at(-1)?.canGoForward);
    expect(messageReaders.get(socket).navigation.at(-1)).toMatchObject({ url: 'about:blank', canGoBack: false });
    socket.send(JSON.stringify({ type: 'forward', tabId }));
    await waitFor(() => messageReaders.get(socket).navigation.at(-1)?.url === 'https://example.com/');
    socket.send(JSON.stringify({ type: 'reload', tabId }));
    socket.send(JSON.stringify({ type: 'stop', tabId }));
    await waitFor(() => ctx.browserSessionManager.commands.some((command) => command.method === 'Page.stopLoading'));
    expect(ctx.browserSessionManager.commands.some((command) => command.method === 'Page.reload')).toBe(true);
    await closeSocket(socket);
  });

  it('reports external navigation and loading, ignores subframes, and never reads history per frame', async () => {
    const { socket, sessionId, tabId } = await attachSocket();
    const manager = ctx.browserSessionManager;
    const targetId = tabId.slice(3);
    manager.histories.set(targetId, { currentIndex: 1, entries: [
      { id: 1, url: 'about:blank', title: '' }, { id: 2, url: 'https://example.com/link', title: 'Followed link' },
    ] });
    manager.emitEvent(sessionId, targetId, 'Page.frameStartedLoading', { frameId: `frame-${targetId}` });
    await waitFor(() => messageReaders.get(socket).navigation.at(-1)?.isLoading);
    expect(messageReaders.get(socket).navigation.at(-1)).toMatchObject({ url: 'https://example.com/link', title: 'Followed link', canGoBack: true });
    manager.emitEvent(sessionId, targetId, 'Page.frameStoppedLoading', { frameId: 'child-frame' });
    manager.emitEvent(sessionId, targetId, 'Page.frameStoppedLoading', { frameId: `frame-${targetId}` });
    await waitFor(() => messageReaders.get(socket).navigation.at(-1)?.isLoading === false);
    const reads = manager.commands.filter((command) => command.method === 'Page.getNavigationHistory').length;
    for (let i = 0; i < 20; i += 1) manager.emitScreencastFrame(sessionId, 'anBlZw==');
    await waitFor(() => manager.ackCalls === 20);
    expect(manager.commands.filter((command) => command.method === 'Page.getNavigationHistory')).toHaveLength(reads);
    await closeSocket(socket);
  });

  it('recovers navigation history during a Chrome active-page transition', async () => {
    const { socket, tabId } = await attachSocket();
    const manager = ctx.browserSessionManager;
    let reads = 0;
    manager.commandHooks.set('Page.getNavigationHistory', () => {
      reads += 1;
      if (reads === 1) throw new Error('Browser target target-1: CDP command Page.getNavigationHistory failed: Not attached to an active page');
    });
    socket.send(JSON.stringify({ type: 'navigate', tabId, url: 'https://example.com/arrived' }));
    await waitFor(() => reads >= 1);
    await waitFor(() => messageReaders.get(socket).navigation.at(-1)?.url === 'https://example.com/arrived');
    expect(messageReaders.get(socket).navigation.at(-1)).toMatchObject({ title: 'Navigated', canGoBack: true });
    expect(reads).toBe(2);
    expect(messageReaders.get(socket).queue.map((message) => JSON.parse(message.data)).filter((message) => message.type === 'error')).toEqual([]);
    await closeSocket(socket);
  });

  it.each([
    ['CDP command Page.getNavigationHistory failed: Not attached to an active page', 3],
    ['CDP command Page.getNavigationHistory failed: Connection closed', 1],
  ])('reports persistent history failure separately from the successful navigation: %s', async (failure, expectedReads) => {
    const { socket, tabId, sessionId } = await attachSocket();
    const manager = ctx.browserSessionManager;
    const confirmed = messageReaders.get(socket).navigation.at(-1);
    let reads = 0;
    manager.commandHooks.set('Page.getNavigationHistory', () => {
      reads += 1;
      throw new Error(failure);
    });
    socket.send(JSON.stringify({ type: 'navigate', tabId, url: 'https://example.com/arrived' }));
    expect((await nextJson(socket)).type).toBe('state');
    expect(await nextJson(socket)).toMatchObject({ type: 'error', code: 'NAVIGATION_STATE_FAILED', message: failure });
    expect(reads).toBe(expectedReads);
    expect(manager.histories.get(tabId.slice(3)).entries.at(-1).url).toBe('https://example.com/arrived');
    expect(messageReaders.get(socket).navigation.at(-1)).toEqual(confirmed);
    manager.commandHooks.delete('Page.getNavigationHistory');
    manager.emitEvent(sessionId, tabId.slice(3), 'Page.loadEventFired', {});
    await waitFor(() => messageReaders.get(socket).navigation.at(-1)?.url === 'https://example.com/arrived');
    await closeSocket(socket);
  });

  it('reports navigation action failures without treating them as state refresh failures', async () => {
    const { socket, tabId } = await attachSocket();
    const manager = ctx.browserSessionManager;
    const reads = manager.commands.filter((command) => command.method === 'Page.getNavigationHistory').length;
    manager.commandHooks.set('Page.navigate', () => { throw new Error('net::ERR_BLOCKED_BY_CLIENT'); });
    socket.send(JSON.stringify({ type: 'navigate', tabId, url: 'https://example.com/blocked' }));
    expect((await nextJson(socket)).type).toBe('state');
    expect(await nextJson(socket)).toMatchObject({ type: 'error', code: 'NAVIGATION_FAILED', message: 'net::ERR_BLOCKED_BY_CLIENT' });
    expect(manager.commands.filter((command) => command.method === 'Page.getNavigationHistory')).toHaveLength(reads);
    await closeSocket(socket);
  });

  it('does not retry or publish navigation history after its stream is removed', async () => {
    const { socket, tabId } = await attachSocket();
    const manager = ctx.browserSessionManager;
    let rejectHistory;
    let reads = 0;
    manager.commandHooks.set('Page.getNavigationHistory', () => {
      reads += 1;
      return new Promise((resolve, reject) => { rejectHistory = reject; });
    });
    socket.send(JSON.stringify({ type: 'navigate', tabId, url: 'https://example.com/arrived' }));
    await waitFor(() => rejectHistory);
    const published = messageReaders.get(socket).navigation.length;
    await closeSocket(socket);
    await waitFor(() => manager.subscribers.length === 0);
    rejectHistory(new Error('CDP command Page.getNavigationHistory failed: Not attached to an active page'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(reads).toBe(1);
    expect(messageReaders.get(socket).navigation).toHaveLength(published);
  });

  it('shares one stream startup between simultaneous viewers of the same tab', async () => {
    const manager = ctx.browserSessionManager;
    const session = await manager.createSession({ directory: '/project' });
    const [tab] = await manager.listTabs(session.id);
    const sockets = [];
    for (let i = 0; i < 2; i += 1) {
      const socket = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
      await nextJson(socket);
      socket.send(JSON.stringify({ type: 'attach', sessionId: session.id }));
      await nextJson(socket);
      sockets.push(socket);
    }
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    manager.commandHooks.set('Page.startScreencast', () => gate);
    for (const socket of sockets) socket.send(JSON.stringify({ type: 'attachTab', tabId: tab.id }));
    await waitFor(() => manager.commands.some((command) => command.method === 'Page.startScreencast'));
    release();
    for (const socket of sockets) expect((await nextJson(socket)).type).toBe('state');
    expect(manager.commands.filter((command) => command.method === 'Page.startScreencast')).toHaveLength(1);
    expect(manager.subscribers).toHaveLength(1);
    for (const socket of sockets) await closeSocket(socket);
  });

  it('does not install a stale registry listener after disconnect and reconnect', async () => {
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const held = new Promise((resolve) => { started = resolve; });
    class PausedRegistryManager extends FakeBrowserSessionManager {
      hasPaused = false;
      staleFinished = false;

      async runReadOnlyOperation(sessionId, operation) {
        if (operation.targetId !== 'tab list' || this.hasPaused) return super.runReadOnlyOperation(sessionId, operation);
        this.hasPaused = true;
        started();
        await gate;
        try { return await super.runReadOnlyOperation(sessionId, operation); }
        finally { this.staleFinished = true; }
      }
    }
    ctx.gateway.dispose();
    await new Promise((resolve) => ctx.server.close(resolve));
    ctx = await createServer({ browserSessionManager: new PausedRegistryManager() });
    const manager = ctx.browserSessionManager;
    const session = await manager.createSession({ directory: '/project' });
    const stale = await connect(ctx.port, { headers: { authorization: 'Bearer client-token' } });
    await nextJson(stale);
    stale.send(JSON.stringify({ type: 'attach', sessionId: session.id }));
    await held;
    await closeSocket(stale);
    const current = await attachSocket(session.id);
    release();
    await waitFor(() => manager.staleFinished);
    expect(manager.registrySubscribers).toHaveLength(1);
    expect(() => manager.emitRegistry({ type: 'disconnect', reason: 'Chrome closed' })).not.toThrow();
    await closeSocket(current.socket);
    await waitFor(() => manager.registrySubscribers.length === 0);
  });

  it('keeps frames and navigation alive for viewers on distinct tabs', async () => {
    const first = await attachSocket();
    const manager = ctx.browserSessionManager;
    const session = manager.sessions.get(first.sessionId);
    session.tabs.push({ id: 'sc:target-2', targetId: 'target-2', title: 'Second', url: 'about:blank' });
    const second = await attachSocket(first.sessionId, 'sc:target-2');
    manager.emitScreencastFrame(first.sessionId, Buffer.from('first').toString('base64'));
    manager.emitScreencastFrame(first.sessionId, Buffer.from('second').toString('base64'), {}, 'target-2');
    expect((await nextJson(first.socket)).tabId).toBe(first.tabId);
    expect((await nextMessage(first.socket)).data.toString()).toBe('first');
    expect((await nextJson(second.socket)).tabId).toBe(second.tabId);
    expect((await nextMessage(second.socket)).data.toString()).toBe('second');
    manager.histories.get('target-1').entries[0].title = 'Agent title';
    manager.emitEvent(first.sessionId, 'target-1', 'Target.targetInfoChanged', { targetInfo: { targetId: 'target-1' } });
    await waitFor(() => messageReaders.get(first.socket).navigation.at(-1)?.title === 'Agent title');
    expect(messageReaders.get(second.socket).navigation.at(-1)?.title).toBe('Second');
    await closeSocket(first.socket);
    manager.emitScreencastFrame(first.sessionId, Buffer.from('still live').toString('base64'), {}, 'target-2');
    expect((await nextJson(second.socket)).tabId).toBe(second.tabId);
    expect((await nextMessage(second.socket)).data.toString()).toBe('still live');
    await closeSocket(second.socket);
  });

  it('creates the first tab in an empty session and publishes registry additions and removals', async () => {
    const manager = ctx.browserSessionManager;
    manager.autoCreateTab = false;
    const first = await attachSocket();
    expect(first.tabId).toBeUndefined();
    first.socket.send(JSON.stringify({ type: 'createTab' }));
    expect((await nextJson(first.socket)).controlling).toBe(true);
    const created = await nextJson(first.socket);
    expect(created).toMatchObject({ type: 'tabs', activeTabId: 'sc:target-1', tabs: [{ id: 'sc:target-1', url: 'about:blank' }] });
    first.socket.send(JSON.stringify({ type: 'attachTab', tabId: created.activeTabId }));
    expect((await nextJson(first.socket)).type).toBe('state');
    const session = manager.sessions.get(first.sessionId);
    session.tabs.push({ id: 'sc:popup', targetId: 'popup', title: 'Popup', url: 'https://example.com/' });
    manager.emitRegistry({ type: 'upsert', target: { targetId: 'popup', type: 'page', browserContextId: 'ctx-1' } });
    const added = await nextJson(first.socket);
    expect(added.tabs).toHaveLength(2);
    expect(added.activeTabId).toBeUndefined();
    session.tabs = session.tabs.filter((tab) => tab.id !== created.activeTabId);
    manager.emitRegistry({ type: 'destroy', targetId: 'target-1' });
    expect((await nextJson(first.socket)).tabs.map((tab) => tab.id)).toEqual(['sc:popup']);
    first.socket.send(JSON.stringify({ type: 'navigate', tabId: created.activeTabId, url: 'https://example.com/' }));
    expect((await nextJson(first.socket)).code).toBe('NOT_ATTACHED');
    await closeSocket(first.socket);
    await waitFor(() => manager.registrySubscribers.length === 0);
  });

  it('drops a history command when takeover happens during the history read', async () => {
    const first = await attachSocket();
    const second = await attachSocket(first.sessionId, first.tabId);
    const manager = ctx.browserSessionManager;
    manager.histories.set(first.tabId.slice(3), { currentIndex: 1, entries: [
      { id: 1, url: 'about:blank', title: '' }, { id: 2, url: 'https://example.com/', title: '' },
    ] });
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const held = new Promise((resolve) => { started = resolve; });
    manager.commandHooks.set('Page.getNavigationHistory', () => { started(); return gate; });
    first.socket.send(JSON.stringify({ type: 'back', tabId: first.tabId }));
    await held;
    second.socket.send(JSON.stringify({ type: 'text', tabId: second.tabId, text: 'take control' }));
    await waitFor(() => manager.commands.some((command) => command.method === 'Input.insertText'));
    release();
    manager.commandHooks.delete('Page.getNavigationHistory');
    first.socket.send(JSON.stringify({ type: 'list' }));
    await waitFor(() => messageReaders.get(first.socket).queue.some((message) => !message.isBinary && JSON.parse(message.data).type === 'list'));
    expect(manager.commands.some((command) => command.method === 'Page.navigateToHistoryEntry')).toBe(false);
    await closeSocket(first.socket);
    await closeSocket(second.socket);
  });

  it('does not report an authoritative empty tab list when attachment listing fails', async () => {
    const { socket, sessionId } = await attachSocket();
    ctx.browserSessionManager.listTabs = async () => { throw new Error('Chrome connection failed'); };
    socket.send(JSON.stringify({ type: 'attach', sessionId }));
    expect(await nextJson(socket)).toMatchObject({ type: 'error', code: 'HANDSHAKE_FAILED' });
    await closeSocket(socket);
  });
});

describe('surface gateway relay allowlist', () => {
  it('REAL createTunnelHost accepts the surface path', async () => {
    const { createTunnelHost } = await import('../relay/tunnel-host.js');
    const loopback = http.createServer((req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('upgrade required');
    });
    await new Promise((resolve) => loopback.listen(0, '127.0.0.1', resolve));
    const port = loopback.address().port;

    const sentFrames = [];
    const host = createTunnelHost({
      connectionId: 'test-conn',
      getLocalPort: () => port,
      sendFrame: async (frame) => sentFrames.push(frame),
      getBufferedAmount: () => 0,
    });

    const { encodeTunnelFrame, encodeJsonPayload, TunnelFrameType } = await import('../relay/tunnel-codec.js');
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsOpen, 7, encodeJsonPayload({ path: SURFACE_WS_PATH, query: '' })));

    await waitFor(() => sentFrames.length > 0, 1_000);
    expect(sentFrames.length).toBeGreaterThan(0);

    await new Promise((resolve) => loopback.close(resolve));
  });
});

describe('surface gateway server composition', () => {
  it('hands the first lazy upgrade to the authenticated gateway', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    const browserSessionManager = new FakeBrowserSessionManager();
    let gateway = null;
    const createGateway = async () => {
      gateway ??= createBrowserSurfaceGateway({
        server,
        uiAuthController: {
          enabled: false,
          resolveAuthContext: async (req) => req.headers.authorization === 'Bearer client-token'
            ? { type: 'client', token: 'client:device-1' }
            : null,
        },
        isRequestOriginAllowed: async (req) => String(req.headers.origin).startsWith('http://127.0.0.1:'),
        rejectWebSocketUpgrade: (socket) => socket.destroy(),
        browserSessionManager,
        logger: { warn: () => {}, info: () => {} },
      });
      return gateway;
    };
    const lazyUpgradeHandler = (req, socket, head) => {
      if (!String(req.url).startsWith(SURFACE_WS_PATH)) return;
      void createGateway().then((created) => {
        server.off('upgrade', lazyUpgradeHandler);
        created.handleUpgrade(req, socket, head);
      });
    };
    server.on('upgrade', lazyUpgradeHandler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const socket = await connect(server.address().port, { headers: { authorization: 'Bearer client-token' } });
    expect((await nextJson(socket)).type).toBe('hello');

    await closeSocket(socket);
    gateway.dispose();
    await new Promise((resolve) => server.close(resolve));
  });
});
