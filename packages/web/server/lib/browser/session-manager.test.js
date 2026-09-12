import { EventEmitter } from 'node:events';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { connectCdp } from './cdp.js';
import { createBrowserSessionManager } from './session-manager.js';

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for test condition');
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

class FakeCdpServer {
  constructor() {
    this.calls = [];
    this.contexts = new Set();
    this.contextCookies = new Map();
    this.targets = new Map();
    this.sessions = new Map();
    this.sockets = new Set();
    this.nextContext = 1;
    this.nextTarget = 1;
    this.nextSession = 1;
    this.commandGates = new Map();
  }

  async start() {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('message', (raw) => this.onCommand(socket, JSON.parse(raw.toString())));
    });
    await new Promise((resolve) => this.server.once('listening', resolve));
    const address = this.server.address();
    this.url = `ws://127.0.0.1:${address.port}`;
    return this;
  }

  reply(socket, message, result = {}) {
    socket.send(JSON.stringify({
      id: message.id,
      result,
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    }));
  }

  fail(socket, message, error) {
    socket.send(JSON.stringify({
      id: message.id,
      error: { message: error },
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    }));
  }

  emit(method, params = {}, sessionId) {
    const frame = JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) });
    for (const socket of this.sockets) if (socket.readyState === WebSocket.OPEN) socket.send(frame);
  }

  addTarget({ type = 'page', browserContextId, targetId = `${type}-${this.nextTarget++}` } = {}) {
    const target = { targetId, type, title: '', url: 'about:blank', browserContextId };
    this.targets.set(targetId, target);
    this.emit('Target.targetCreated', { targetInfo: target });
    if (type === 'page') {
      const sessionId = `auto-${this.nextSession++}`;
      this.sessions.set(sessionId, targetId);
      this.emit('Target.attachedToTarget', { sessionId, targetInfo: target, waitingForDebugger: false });
    }
    return target;
  }

  deferNextCommand(method) {
    const received = deferred();
    const released = deferred();
    this.commandGates.set(method, { received, released });
    cleanups.push(released.resolve);
    return { received: received.promise, release: released.resolve };
  }

  async onCommand(socket, message) {
    this.calls.push(message);
    const gate = this.commandGates.get(message.method);
    if (gate) {
      this.commandGates.delete(message.method);
      gate.received.resolve();
      await gate.released.promise;
    }
    switch (message.method) {
      case 'Target.getTargets':
        this.reply(socket, message, { targetInfos: [...this.targets.values()] });
        return;
      case 'Target.createBrowserContext': {
        const browserContextId = `context-${this.nextContext++}`;
        this.contexts.add(browserContextId);
        this.contextCookies.set(browserContextId, '');
        this.reply(socket, message, { browserContextId });
        return;
      }
      case 'Target.disposeBrowserContext':
        if (!this.contexts.delete(message.params.browserContextId)) {
          this.fail(socket, message, 'Browser context does not exist');
          return;
        }
        for (const [targetId, target] of this.targets) {
          if (target.browserContextId === message.params.browserContextId) this.targets.delete(targetId);
        }
        this.reply(socket, message);
        return;
      case 'Target.createTarget': {
        const target = this.addTarget({ browserContextId: message.params.browserContextId });
        this.reply(socket, message, { targetId: target.targetId });
        return;
      }
      case 'Target.attachToTarget': {
        const sessionId = `session-${this.nextSession++}`;
        this.sessions.set(sessionId, message.params.targetId);
        this.reply(socket, message, { sessionId });
        return;
      }
      case 'Runtime.evaluate': {
        const target = this.targets.get(this.sessions.get(message.sessionId));
        const contextId = target?.browserContextId;
        const assignment = message.params.expression.match(/^document\.cookie='([^']*)'$/);
        if (assignment) this.contextCookies.set(contextId, assignment[1]);
        const value = assignment ? assignment[1] : this.contextCookies.get(contextId) ?? '';
        this.reply(socket, message, { result: { type: 'string', value } });
        return;
      }
      default:
        this.reply(socket, message);
    }
  }

  terminateConnections() {
    for (const socket of this.sockets) socket.terminate();
  }

  async close() {
    this.terminateConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

class FakeChromeProcessManager {
  constructor(url) {
    this.url = url;
    this.generation = 0;
    this.process = new EventEmitter();
    this.readiness = null;
    this.ensureCalls = 0;
  }

  async ensureProcess() {
    this.ensureCalls += 1;
    if (this.readiness) await this.readiness;
    return {
      process: this.process,
      generation: this.generation,
      webSocketDebuggerUrl: this.url,
    };
  }

  get webSocketDebuggerUrl() { return this.url; }
}

class ManualClock {
  now = 1_000;
  timers = new Map();
  nextId = 1;

  setTimer = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, at: this.now + delay });
    return id;
  };

  clearTimer = (id) => this.timers.delete(id);

  advance(ms) {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at > this.now) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

const cleanups = [];

const setup = async (options = {}) => {
  const server = await new FakeCdpServer().start();
  const processManager = new FakeChromeProcessManager(server.url);
  const manager = createBrowserSessionManager({
    chromeProcessManager: processManager,
    connectCdp,
    ...options,
  });
  cleanups.push(() => server.close(), () => manager.close());
  return { server, processManager, manager };
};

const startUpstream = async () => {
  const server = http.createServer((_request, response) => response.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
};

const proxyRequest = (proxyServer, target, agent) => new Promise((resolve, reject) => {
  const [host, port] = proxyServer.split(':');
  const request = http.request({ host, port, path: target, agent }, (response) => {
    response.resume();
    response.once('end', () => resolve(response.statusCode));
  });
  request.once('error', reject);
  request.end();
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

describe('browser session resources', () => {
  it('disposes a failed initialization context even when detaching it fails', async () => {
    const { manager, server } = await setup({
      connectCdp: async (url) => {
        const client = await connectCdp(url);
        return {
          ...client,
          manageContext: async () => { throw new Error('context initialization failed'); },
          unmanageContext: async () => { throw new Error('context detach failed'); },
        };
      },
    });
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });

    await expect(manager.createTab(session.id)).rejects.toThrow('context initialization failed');
    expect(server.contexts.size).toBe(0);
    expect(server.calls.filter((call) => call.method === 'Target.disposeBrowserContext')).toHaveLength(1);
  });

  it('keeps the viewer lease when an agent is cancelled during resource readiness', async () => {
    const { manager, processManager } = await setup();
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    const ready = deferred();
    processManager.readiness = ready.promise;
    const controller = new AbortController();
    let actions = 0;
    const pending = manager.runMutatingOperation(session.id, {
      targetId: 'new tab', openCodeSessionId: 'agent', abortSignal: controller.signal,
      operation: () => { actions += 1; },
    });
    const result = expect(pending).rejects.toThrow('operation aborted');
    await waitFor(() => processManager.ensureCalls > 0);
    const viewerLease = manager.viewerTakeover(session.id, 'viewer');
    controller.abort();
    ready.resolve();

    await result;
    expect(manager.getLease(session.id)).toEqual(viewerLease);
    expect(manager.listSessions()).toHaveLength(1);
    expect(actions).toBe(0);
  });

  it('cancels during readiness without creating late resources or touching another session', async () => {
    const { manager, processManager, server } = await setup();
    const other = await manager.createSession({ directory: '/other', openCodeSessionId: 'other' });
    await manager.createTab(other.id);
    const otherContext = manager.getSession(other.id).browserContextId;
    const session = await manager.createSession({ directory: '/cancel', openCodeSessionId: 'cancel' });
    const ready = deferred();
    processManager.readiness = ready.promise;
    const previousCalls = processManager.ensureCalls;
    const controller = new AbortController();
    let actions = 0;
    const action = manager.runMutatingOperation(session.id, {
      targetId: 'new tab', openCodeSessionId: 'cancel', abortSignal: controller.signal,
      operation: () => { actions += 1; },
    });
    const result = expect(action).rejects.toThrow('operation aborted');
    await waitFor(() => processManager.ensureCalls > previousCalls);
    controller.abort();
    ready.resolve();

    await result;
    await waitFor(() => !manager.getSession(session.id));
    expect(actions).toBe(0);
    expect([...server.contexts]).toEqual([otherContext]);
    expect(manager.getSession(other.id).browserContextId).toBe(otherContext);
  });

  it('rejects a cancelled read before launching Chrome', async () => {
    const { manager, processManager } = await setup();
    const session = await manager.createSession({ directory: '/cancel', openCodeSessionId: 'cancel' });
    const controller = new AbortController();
    controller.abort();
    await expect(manager.runReadOnlyOperation(session.id, {
      targetId: 'tab', abortSignal: controller.signal, operation: () => 'late result',
    })).rejects.toThrow('operation aborted');
    expect(processManager.ensureCalls).toBe(0);
  });

  it('rejects a running read on abort even when its result arrives later', async () => {
    const { manager } = await setup();
    const session = await manager.createSession({ directory: '/cancel', openCodeSessionId: 'cancel' });
    await manager.createTab(session.id);
    const started = deferred();
    const finished = deferred();
    const controller = new AbortController();
    const reading = manager.runReadOnlyOperation(session.id, {
      targetId: 'tab', abortSignal: controller.signal,
      operation: () => { started.resolve(); return finished.promise; },
    });
    const result = expect(reading).rejects.toThrow('operation aborted');
    await started.promise;
    controller.abort();
    finished.resolve('late result');

    await result;
    await waitFor(() => !manager.getSession(session.id));
  });

  it('isolates contexts, cookies, and real proxy listeners', async () => {
    const upstreamPort = await startUpstream();
    const { manager, server } = await setup({
      proxyPolicy: { grants: [{ host: '127.0.0.1', port: upstreamPort }] },
    });
    const first = await manager.createSession({ directory: '/one', openCodeSessionId: 'agent-1' });
    const second = await manager.createSession({ directory: '/two', openCodeSessionId: 'agent-2' });
    const firstTab = await manager.createTab(first.id);
    const secondTab = await manager.createTab(second.id);

    await waitFor(async () => (await manager.listTabs(first.id)).length === 1);
    await manager.runReadOnlyOperation(first.id, {
      targetId: firstTab.targetId,
      operation: async ({ cdp }) => {
        await waitFor(() => cdp.getSessionId(firstTab.targetId));
        return cdp.sendTarget(firstTab.targetId, 'Runtime.evaluate', { expression: "document.cookie='session=one'" });
      },
    });
    const secondCookie = await manager.runReadOnlyOperation(second.id, {
      targetId: secondTab.targetId,
      operation: async ({ cdp }) => {
        await waitFor(() => cdp.getSessionId(secondTab.targetId));
        return cdp.sendTarget(secondTab.targetId, 'Runtime.evaluate', { expression: 'document.cookie' });
      },
    });

    expect(secondCookie.result.value).toBe('');
    expect(first.browserContextId).toBeNull();
    const contexts = server.calls.filter((call) => call.method === 'Target.createBrowserContext');
    expect(contexts).toHaveLength(2);
    expect(contexts.map((call) => call.params)).toEqual([
      expect.objectContaining({ proxyServer: expect.stringMatching(/^127\.0\.0\.1:\d+$/), proxyBypassList: '<-loopback>' }),
      expect.objectContaining({ proxyServer: expect.stringMatching(/^127\.0\.0\.1:\d+$/), proxyBypassList: '<-loopback>' }),
    ]);
    const firstState = manager.getSession(first.id);
    const secondState = manager.getSession(second.id);
    expect(firstState.proxyServer).not.toBe(secondState.proxyServer);

    const firstAgent = new http.Agent({ keepAlive: true });
    const secondAgent = new http.Agent({ keepAlive: true });
    await proxyRequest(firstState.proxyServer, `http://127.0.0.1:${upstreamPort}/`, firstAgent);
    await proxyRequest(secondState.proxyServer, `http://127.0.0.1:${upstreamPort}/`, secondAgent);
    const firstSocket = Object.values(firstAgent.freeSockets)[0][0];
    await manager.endSession(first.id);
    await waitFor(() => firstSocket.destroyed);
    await expect(proxyRequest(secondState.proxyServer, `http://127.0.0.1:${upstreamPort}/`, secondAgent)).resolves.toBe(200);
    firstAgent.destroy();
    secondAgent.destroy();
  });

  it('ends ephemeral resources, reuses project sessions, and double-dispose is a no-op', async () => {
    const { manager, server } = await setup();
    const ephemeral = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    await manager.createTab(ephemeral.id);
    const proxyServer = manager.getSession(ephemeral.id).proxyServer;
    await expect(manager.endSession(ephemeral.id)).resolves.toBe(true);
    await expect(manager.endSession(ephemeral.id)).resolves.toBe(false);
    expect(server.calls.filter((call) => call.method === 'Target.disposeBrowserContext')).toHaveLength(1);
    await expect(fetch(`http://${proxyServer}`)).rejects.toThrow();

    const first = await manager.createSession({ directory: '/project' });
    const second = await manager.createSession({ directory: '/project' });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('lists only namespaced page targets from its own context', async () => {
    const { manager, server } = await setup();
    const first = await manager.createSession({ directory: '/one' });
    const second = await manager.createSession({ directory: '/two' });
    const page = await manager.createTab(first.id);
    await manager.createTab(second.id);
    const contextId = manager.getSession(first.id).browserContextId;
    server.addTarget({ type: 'worker', browserContextId: contextId, targetId: 'worker-owned' });
    await waitFor(async () => (await manager.listTabs(first.id)).length === 1);
    expect(await manager.listTabs(first.id)).toEqual([
      expect.objectContaining({ id: `sc:${page.targetId}`, targetId: page.targetId }),
    ]);
  });
});

describe('internal page connection', () => {
  it('returns the owned page connection without repeating process readiness', async () => {
    const { manager, processManager } = await setup();
    const session = await manager.createSession({ directory: '/project' });
    const page = await manager.createTab(session.id);
    const ensureCalls = processManager.ensureCalls;

    await expect(manager.getPageConnection(session.id, page.targetId)).resolves.toEqual({
      browserContextId: manager.getSession(session.id).browserContextId,
      targetId: page.targetId,
      webSocketDebuggerUrl: processManager.webSocketDebuggerUrl,
    });
    expect(processManager.ensureCalls).toBe(ensureCalls);
  });

  it('initializes once and rejects unknown sessions, foreign pages, and owned workers', async () => {
    const { manager, processManager, server } = await setup();
    await expect(manager.getPageConnection('missing', 'target')).rejects.toThrow('target: session was not found');
    expect(processManager.ensureCalls).toBe(0);
    const first = await manager.createSession({ directory: '/first' });
    const second = await manager.createSession({ directory: '/second' });
    const page = await manager.createTab(first.id);
    await expect(manager.getPageConnection(second.id, page.targetId)).rejects.toThrow('target does not belong');
    expect(processManager.ensureCalls).toBe(2);
    server.addTarget({ type: 'worker', browserContextId: manager.getSession(first.id).browserContextId, targetId: 'owned-worker' });
    await manager.runReadOnlyOperation(first.id, {
      targetId: page.targetId,
      operation: ({ cdp }) => waitFor(() => cdp.getTargets().some((target) => target.targetId === 'owned-worker')),
    });
    await expect(manager.getPageConnection(first.id, 'owned-worker')).rejects.toThrow('target does not belong');
  });

  it('reports a fixed scoped error when the debugger endpoint is unavailable', async () => {
    const { manager, processManager } = await setup();
    const session = await manager.createSession({ directory: '/project' });
    const page = await manager.createTab(session.id);
    processManager.url = null;
    await expect(manager.getPageConnection(session.id, page.targetId)).rejects.toThrow(
      `Browser target ${page.targetId}: browser debugger endpoint is unavailable`,
    );
    processManager.url = '   ';
    await expect(manager.getPageConnection(session.id, page.targetId)).rejects.toThrow('browser debugger endpoint is unavailable');
  });
});

describe('browser-wide tracing admission', () => {
  it('requires a live owned context, blocks other creation, and permits owner reuse', async () => {
    const { manager, processManager, server } = await setup();
    const first = await manager.createSession({ directory: '/first' });
    const second = await manager.createSession({ directory: '/second' });
    expect(() => manager.acquireExclusiveBrowserContext('missing')).toThrow('session was not found');
    expect(() => manager.acquireExclusiveBrowserContext(first.id)).toThrow('no live browser context');
    await manager.createTab(first.id);
    const release = manager.acquireExclusiveBrowserContext(first.id);
    const ensureCalls = processManager.ensureCalls;
    await expect(manager.createTab(second.id)).rejects.toThrow('browser-wide tracing is active for another session');
    await expect(manager.listTabs(second.id)).rejects.toThrow('browser-wide tracing is active for another session');
    expect(processManager.ensureCalls).toBe(ensureCalls);
    await expect(manager.createTab(first.id)).resolves.toHaveProperty('targetId');
    expect(server.calls.filter((call) => call.method === 'Target.createBrowserContext')).toHaveLength(1);
    expect(() => manager.acquireExclusiveBrowserContext(first.id)).toThrow('tracing is already active');
    release();
    await expect(manager.createTab(second.id)).resolves.toHaveProperty('targetId');
    expect(() => manager.acquireExclusiveBrowserContext(first.id)).toThrow('requires an exclusive browser context');
  });

  it('makes release idempotent and prevents an old release from clearing a later acquisition', async () => {
    const { manager } = await setup();
    const first = await manager.createSession({ directory: '/first' });
    const second = await manager.createSession({ directory: '/second' });
    await manager.createTab(first.id);
    const releaseFirst = manager.acquireExclusiveBrowserContext(first.id);
    releaseFirst();
    releaseFirst();
    const releaseSecond = manager.acquireExclusiveBrowserContext(first.id);
    releaseFirst();
    await expect(manager.createTab(second.id)).rejects.toThrow('tracing is active for another session');
    releaseSecond();
    await expect(manager.createTab(second.id)).resolves.toHaveProperty('targetId');
  });

  it('rejects admission while another session waits for process readiness', async () => {
    const { manager, processManager, server } = await setup();
    const first = await manager.createSession({ directory: '/first' });
    const second = await manager.createSession({ directory: '/second' });
    await manager.createTab(first.id);
    const ready = deferred();
    cleanups.push(ready.resolve);
    processManager.readiness = ready.promise;
    const pending = manager.createTab(second.id);
    expect(() => manager.acquireExclusiveBrowserContext(first.id)).toThrow('requires an exclusive browser context');
    expect(server.calls.filter((call) => call.method === 'Target.createBrowserContext')).toHaveLength(1);
    ready.resolve();
    await pending;
  });

  it('rejects admission while Chrome is creating another context', async () => {
    const { manager, server } = await setup();
    const first = await manager.createSession({ directory: '/first' });
    const second = await manager.createSession({ directory: '/second' });
    await manager.createTab(first.id);
    const gate = server.deferNextCommand('Target.createBrowserContext');
    const pending = manager.createTab(second.id);
    await gate.received;
    expect(() => manager.acquireExclusiveBrowserContext(first.id)).toThrow('requires an exclusive browser context');
    gate.release();
    await pending;
  });

  it('counts a closing context until Chrome confirms disposal', async () => {
    const { manager, server } = await setup();
    const first = await manager.createSession({ directory: '/first' });
    const second = await manager.createSession({ directory: '/second' });
    await manager.createTab(first.id);
    await manager.createTab(second.id);
    const gate = server.deferNextCommand('Target.disposeBrowserContext');
    const closing = manager.endSession(second.id);
    await gate.received;
    expect(manager.getSession(second.id).browserContextId).toBeNull();
    expect(() => manager.acquireExclusiveBrowserContext(first.id)).toThrow('requires an exclusive browser context');
    gate.release();
    await closing;
    manager.acquireExclusiveBrowserContext(first.id)();
  });

  it('releases failed initialization admission after its context is disposed', async () => {
    let failContext = false;
    const { manager, server } = await setup({
      connectCdp: async (url) => {
        const client = await connectCdp(url);
        return {
          ...client,
          manageContext: async (contextId) => {
            if (failContext) throw new Error('context setup failed');
            return client.manageContext(contextId);
          },
        };
      },
    });
    const first = await manager.createSession({ directory: '/first' });
    const second = await manager.createSession({ directory: '/second' });
    await manager.createTab(first.id);
    failContext = true;
    const gate = server.deferNextCommand('Target.disposeBrowserContext');
    const rejected = expect(manager.createTab(second.id)).rejects.toThrow('context setup failed');
    await gate.received;
    expect(() => manager.acquireExclusiveBrowserContext(first.id)).toThrow('requires an exclusive browser context');
    gate.release();
    await rejected;
    manager.acquireExclusiveBrowserContext(first.id)();
  });

  it('releases admission after owner session end and after process death', async () => {
    const { manager } = await setup();
    const first = await manager.createSession({ directory: '/first' });
    const second = await manager.createSession({ directory: '/second' });
    await manager.createTab(first.id);
    const releaseFirst = manager.acquireExclusiveBrowserContext(first.id);
    await manager.endSession(first.id);
    await manager.createTab(second.id);
    const releaseSecond = manager.acquireExclusiveBrowserContext(second.id);
    releaseFirst();
    const third = await manager.createSession({ directory: '/third' });
    await expect(manager.createTab(third.id)).rejects.toThrow('tracing is active for another session');
    await manager.handleProcessDeath();
    await manager.createTab(third.id);
    const releaseThird = manager.acquireExclusiveBrowserContext(third.id);
    releaseSecond();
    await expect(manager.createTab(second.id)).rejects.toThrow('tracing is active for another session');
    releaseThird();
    await expect(manager.createTab(second.id)).resolves.toHaveProperty('targetId');
  });

  it('keeps a failed context disposal excluded from tracing until process death', async () => {
    let failedContextId = null;
    const { manager } = await setup({
      connectCdp: async (url) => {
        const client = await connectCdp(url);
        return {
          ...client,
          get isOpen() { return client.isOpen; },
          send: async (method, params) => {
            if (method === 'Target.disposeBrowserContext' && params.browserContextId === failedContextId) {
              throw new Error('context disposal failed');
            }
            return client.send(method, params);
          },
        };
      },
    });
    const first = await manager.createSession({ directory: '/first' });
    const second = await manager.createSession({ directory: '/second' });
    await manager.createTab(first.id);
    await manager.createTab(second.id);
    failedContextId = manager.getSession(second.id).browserContextId;
    await expect(manager.endSession(second.id)).rejects.toThrow('context disposal failed');
    expect(manager.getSession(second.id)).toBeUndefined();
    expect(() => manager.acquireExclusiveBrowserContext(first.id)).toThrow('requires an exclusive browser context');
    await manager.handleProcessDeath();
    await manager.createTab(first.id);
    manager.acquireExclusiveBrowserContext(first.id)();
  });

  it('cleans a proxy that becomes ready after process death without creating a context', async () => {
    const entered = deferred();
    const ready = deferred();
    let closed = false;
    const { manager, server } = await setup({
      createPolicyProxy: () => ({
        proxyServer: '127.0.0.1:1',
        listen: async () => { entered.resolve(); await ready.promise; return '127.0.0.1:1'; },
        close: async () => { closed = true; },
      }),
    });
    cleanups.push(ready.resolve);
    const session = await manager.createSession({ directory: '/pending' });
    const rejected = expect(manager.createTab(session.id)).rejects.toThrow('Chrome process died');
    await entered.promise;
    await manager.handleProcessDeath();
    ready.resolve();
    await rejected;
    expect(closed).toBe(true);
    expect(server.calls.filter((call) => call.method === 'Target.createBrowserContext')).toHaveLength(0);
    expect(manager.getSession(session.id).dead).toBe(true);
  });

  it('never commits resources that finish readiness after process death', async () => {
    const { manager, processManager, server } = await setup();
    const session = await manager.createSession({ directory: '/pending' });
    const ready = deferred();
    cleanups.push(ready.resolve);
    processManager.readiness = ready.promise;
    const rejected = expect(manager.createTab(session.id)).rejects.toThrow('Chrome process died');
    await manager.handleProcessDeath();
    ready.resolve();
    await rejected;
    expect(server.calls.filter((call) => call.method === 'Target.createBrowserContext')).toHaveLength(0);
    expect(manager.getSession(session.id).dead).toBe(true);
    await manager.createTab(session.id);
    manager.acquireExclusiveBrowserContext(session.id)();
  });
});

describe('control state notifications', () => {
  it('publishes copied generations for acquisition, takeover, disconnect, and no-op ownership', async () => {
    const { manager } = await setup();
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    const changes = [];
    expect(manager.getControlState(session.id)).toEqual({ generation: 0, lease: null });
    expect(() => manager.getControlState('missing')).toThrow('control: session was not found');
    const unsubscribeBroken = manager.onControlChange((event) => {
      event.generation = -1;
      if (event.lease) event.lease.actor = 'modified';
      throw new Error('listener failed');
    });
    const unsubscribe = manager.onControlChange((event) => changes.push(event));
    await manager.runMutatingOperation(session.id, {
      targetId: 'page', openCodeSessionId: 'agent',
      operation: () => expect(changes[0].lease.actor).toBe('agent'),
    });
    const snapshot = manager.getControlState(session.id);
    snapshot.lease.actor = 'modified';
    expect(manager.getLease(session.id).actor).toBe('agent');
    manager.viewerTakeover(session.id, 'viewer');
    manager.viewerTakeover(session.id, 'viewer');
    manager.viewerDisconnect(session.id, 'observer');
    manager.viewerDisconnect(session.id, 'viewer');
    expect(changes.map((event) => [event.sessionId, event.generation, event.lease?.actor ?? null])).toEqual([
      [session.id, 1, 'agent'],
      [session.id, 2, null],
      [session.id, 2, 'user'],
      [session.id, 3, null],
    ]);
    expect(manager.getControlState(session.id)).toEqual({ generation: 3, lease: null });
    unsubscribe();
    unsubscribe();
    unsubscribeBroken();
    manager.viewerTakeover(session.id, 'viewer');
    expect(changes).toHaveLength(4);
  });

  it('publishes authoritative invalidation on lease expiry, Chrome death, and session end', async () => {
    const clock = new ManualClock();
    const { manager } = await setup({
      now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, leaseTtlMs: 50,
    });
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    const changes = [];
    manager.onControlChange((event) => changes.push(event));
    await manager.runMutatingOperation(session.id, {
      targetId: 'page', openCodeSessionId: 'agent', operation: async () => 'finished',
    });
    clock.advance(51);
    expect(changes.at(-1)).toEqual({ sessionId: session.id, generation: 2, lease: null });
    await manager.handleProcessDeath();
    expect(changes.at(-1)).toEqual({ sessionId: session.id, generation: 3, lease: null });
    await manager.endSession(session.id);
    expect(changes.at(-1)).toEqual({ sessionId: session.id, generation: 4, lease: null });
    expect(() => manager.getControlState(session.id)).toThrow('session was not found');
  });
});

describe('control lease', () => {
  it('serializes mutations and rejects a second agent without the lease', async () => {
    const { manager } = await setup();
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent-1' });
    const firstGate = deferred();
    const order = [];
    const first = manager.runMutatingOperation(session.id, {
      targetId: 'tab-1', openCodeSessionId: 'agent-1',
      operation: async () => { order.push('first-start'); await firstGate.promise; order.push('first-end'); },
    });
    const second = manager.runMutatingOperation(session.id, {
      targetId: 'tab-2', openCodeSessionId: 'agent-1',
      operation: async () => { order.push('second'); },
    });
    await waitFor(() => order.length === 1);
    await expect(manager.runMutatingOperation(session.id, {
      targetId: 'tab-other', openCodeSessionId: 'agent-2', operation: async () => {},
    })).rejects.toThrow(/tab-other.*does not hold/i);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('viewer takeover drops queued work and invalidates in-flight work', async () => {
    const { manager } = await setup();
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    const gate = deferred();
    const first = manager.runMutatingOperation(session.id, {
      targetId: 'running-tab', openCodeSessionId: 'agent', operation: () => gate.promise,
    });
    const queued = manager.runMutatingOperation(session.id, {
      targetId: 'queued-tab', openCodeSessionId: 'agent', operation: async () => 'never',
    });
    await waitFor(() => manager.getLease(session.id));
    const lease = manager.viewerTakeover(session.id, 'viewer-1');
    expect(lease.actor).toBe('user');
    await expect(first).rejects.toThrow(/running-tab.*viewer took control/i);
    await expect(queued).rejects.toThrow(/queued-tab.*viewer took control/i);
    gate.resolve('stale');
  });

  it('runs read-only work while a mutation is in flight without changing the lease', async () => {
    const { manager } = await setup();
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    const gate = deferred();
    const mutation = manager.runMutatingOperation(session.id, {
      targetId: 'mutating-tab', openCodeSessionId: 'agent', operation: () => gate.promise,
    });
    await waitFor(() => manager.getLease(session.id));
    const before = manager.getLease(session.id);
    await expect(manager.runReadOnlyOperation(session.id, {
      targetId: 'read-tab', operation: async () => 'snapshot',
    })).resolves.toBe('snapshot');
    expect(manager.getLease(session.id)).toEqual(before);
    gate.resolve('done');
    await mutation;
  });

  it('releases on explicit agent abort', async () => {
    const { manager } = await setup();
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    const pending = manager.runMutatingOperation(session.id, {
      targetId: 'abort-tab', openCodeSessionId: 'agent', operation: () => new Promise(() => {}),
    });
    await waitFor(() => manager.getLease(session.id));
    const rejected = expect(pending).rejects.toThrow(/abort-tab.*aborted/i);
    await manager.abortSession(session.id);
    await rejected;
    expect(manager.getLease(session.id)).toBeNull();
  });

  it('propagates the named AbortSignal, releases, and ends ephemeral state', async () => {
    const { manager } = await setup();
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    const controller = new AbortController();
    let receivedSignal;
    const pending = manager.runMutatingOperation(session.id, {
      targetId: 'signal-tab', openCodeSessionId: 'agent', abortSignal: controller.signal,
      operation: ({ abortSignal }) => { receivedSignal = abortSignal; return new Promise(() => {}); },
    });
    await waitFor(() => receivedSignal);
    controller.abort();
    await expect(pending).rejects.toThrow(/signal-tab.*aborted/i);
    expect(receivedSignal.aborted).toBe(true);
    await waitFor(() => !manager.getSession(session.id));
  });

  it('releases the user lease on viewer disconnect', async () => {
    const { manager } = await setup();
    const session = await manager.createSession({ directory: '/project' });
    manager.viewerTakeover(session.id, 'viewer-1');
    expect(manager.viewerDisconnect(session.id, 'viewer-1')).toBe(true);
    expect(manager.getLease(session.id)).toBeNull();
  });

  it('preserves the controlling viewer when an observer or superseded viewer disconnects', async () => {
    const { manager } = await setup();
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    const first = manager.viewerTakeover(session.id, 'viewer-1');
    expect(first.viewerId).toBe('viewer-1');
    expect(manager.viewerDisconnect(session.id, 'observer')).toBe(false);
    expect(manager.getLease(session.id)).toEqual(first);

    const second = manager.viewerTakeover(session.id, 'viewer-2');
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(manager.viewerDisconnect(session.id, 'viewer-1')).toBe(false);
    expect(manager.getLease(session.id)).toEqual(second);
    await expect(manager.runMutatingOperation(session.id, {
      targetId: 'agent-tab', openCodeSessionId: 'agent', operation: async () => 'blocked',
    })).rejects.toThrow(/does not hold this session lease/);

    expect(manager.viewerDisconnect(session.id, 'viewer-2')).toBe(true);
    expect(manager.viewerDisconnect(session.id, 'viewer-2')).toBe(false);
    await expect(manager.runMutatingOperation(session.id, {
      targetId: 'agent-tab', openCodeSessionId: 'agent', operation: async () => 'agent resumed',
    })).resolves.toBe('agent resumed');
    const agentLease = manager.getLease(session.id);
    expect(agentLease.generation).toBeGreaterThan(second.generation);
    expect(manager.viewerDisconnect(session.id, 'viewer-2')).toBe(false);
    expect(manager.getLease(session.id)).toEqual(agentLease);
    expect(manager.getSession(session.id).dead).toBe(false);
  });

  it('keeps a viewer generation for repeated input and requires a viewer identity', async () => {
    const { manager } = await setup();
    const session = await manager.createSession({ directory: '/project' });
    expect(() => manager.viewerTakeover(session.id)).toThrow(/viewer identity/);
    const lease = manager.viewerTakeover(session.id, 'viewer-1');
    expect(manager.viewerTakeover(session.id, 'viewer-1')).toEqual(lease);
    expect(manager.viewerDisconnect(session.id)).toBe(false);
    expect(manager.getLease(session.id)).toEqual(lease);
  });

  it('lets the agent resume after owner disconnect without waiting for invalidated work', async () => {
    const { manager } = await setup();
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    const gate = deferred();
    const original = manager.runMutatingOperation(session.id, {
      targetId: 'pending-tab', openCodeSessionId: 'agent', operation: () => gate.promise,
    });
    await waitFor(() => manager.getLease(session.id));
    const rejected = expect(original).rejects.toThrow(/viewer took control/);
    manager.viewerTakeover(session.id, 'viewer-1');
    await rejected;
    manager.viewerDisconnect(session.id, 'viewer-1');
    let resumed = false;
    const next = manager.runMutatingOperation(session.id, {
      targetId: 'next-tab', openCodeSessionId: 'agent',
      operation: async () => { resumed = true; return 'resumed'; },
    });
    try {
      await waitFor(() => resumed, 250);
      await expect(next).resolves.toBe('resumed');
    } finally {
      gate.resolve('stale completion');
      await next.catch(() => {});
    }
  });

  it('releases on idle expiry and closes only ephemeral sessions', async () => {
    const clock = new ManualClock();
    const { manager } = await setup({
      now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      idleTtlMs: 100,
    });
    const agent = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    const user = await manager.createSession({ directory: '/project' });
    manager.viewerTakeover(user.id, 'viewer-1');
    clock.advance(101);
    await manager.expireIdleSessions();
    expect(manager.getSession(agent.id)).toBeUndefined();
    expect(manager.getSession(user.id).dead).toBe(false);
    expect(manager.getLease(user.id)).toBeNull();
  });

  it('automatically expires idle ephemeral sessions without overlapping sweeps', async () => {
    const clock = new ManualClock();
    const { manager, server } = await setup({
      now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      idleTtlMs: 100,
    });
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    await manager.createTab(session.id);
    const disposal = server.deferNextCommand('Target.disposeBrowserContext');

    clock.advance(60_000);
    await disposal.received;
    expect(server.calls.filter((call) => call.method === 'Target.disposeBrowserContext')).toHaveLength(1);
    expect(clock.timers.size).toBe(0);

    clock.advance(60_000);
    expect(server.calls.filter((call) => call.method === 'Target.disposeBrowserContext')).toHaveLength(1);

    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    disposal.release();
    await closing;
    expect(clock.timers.size).toBe(0);
  });

  it('does not expire an ephemeral session while a viewer or operation is active', async () => {
    const clock = new ManualClock();
    const { manager } = await setup({
      now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      idleTtlMs: 100,
    });
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    expect(manager.viewerConnect(session.id, 'viewer-1')).toBe(true);
    expect(manager.viewerConnect(session.id, 'viewer-1')).toBe(false);
    clock.advance(101);
    await manager.expireIdleSessions();
    expect(manager.getSession(session.id)).toBeDefined();

    expect(manager.viewerDisconnect(session.id, 'viewer-1')).toBe(false);
    await manager.expireIdleSessions();
    expect(manager.getSession(session.id)).toBeDefined();
    const operation = deferred();
    const started = deferred();
    const pending = manager.runReadOnlyOperation(session.id, {
      targetId: 'active-operation',
      operation: async () => { started.resolve(); return operation.promise; },
    });
    await started.promise;
    clock.advance(101);
    await manager.expireIdleSessions();
    expect(manager.getSession(session.id)).toBeDefined();

    operation.resolve('done');
    await expect(pending).resolves.toBe('done');
    clock.advance(101);
    await manager.expireIdleSessions();
    expect(manager.getSession(session.id)).toBeUndefined();
  });

  it('releases and rejects queued work on session close', async () => {
    const { manager } = await setup();
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    const pending = manager.runMutatingOperation(session.id, {
      targetId: 'close-tab', openCodeSessionId: 'agent', operation: () => new Promise(() => {}),
    });
    await waitFor(() => manager.getLease(session.id));
    const rejected = expect(pending).rejects.toThrow(/close-tab.*closed/i);
    await manager.endSession(session.id);
    await rejected;
    expect(manager.getLease(session.id)).toBeNull();
  });

  it('invalidates an operation when its lease expires mid-flight', async () => {
    const clock = new ManualClock();
    const { manager } = await setup({
      now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, leaseTtlMs: 50,
    });
    const session = await manager.createSession({ directory: '/project', openCodeSessionId: 'agent' });
    const pending = manager.runMutatingOperation(session.id, {
      targetId: 'expiry-tab', openCodeSessionId: 'agent', operation: () => new Promise(() => {}),
    });
    await waitFor(() => manager.getLease(session.id));
    clock.advance(51);
    await expect(pending).rejects.toThrow(/expiry-tab.*lease expired/i);
    expect(manager.getLease(session.id)).toBeNull();
  });
});

describe('Chrome death', () => {
  it('marks sessions dead, closes proxies, releases leases, and rejects pending ops by target', async () => {
    const { manager, processManager } = await setup();
    const first = await manager.createSession({ directory: '/one', openCodeSessionId: 'agent-1' });
    const second = await manager.createSession({ directory: '/two', openCodeSessionId: 'agent-2' });
    await manager.createTab(second.id);
    const secondProxy = manager.getSession(second.id).proxyServer;
    const pending = manager.runMutatingOperation(first.id, {
      targetId: 'killed-tab', openCodeSessionId: 'agent-1', operation: () => new Promise(() => {}),
    });
    const queued = manager.runMutatingOperation(first.id, {
      targetId: 'pending-tab', openCodeSessionId: 'agent-1', operation: async () => {},
    });
    await waitFor(() => manager.getLease(first.id));
    processManager.process.emit('exit', 9, null);
    await expect(pending).rejects.toThrow(/killed-tab.*Chrome process died/i);
    await expect(queued).rejects.toThrow(/pending-tab.*Chrome process died/i);
    await waitFor(() => manager.getSession(first.id).dead && manager.getSession(second.id).dead);
    expect(manager.getLease(first.id)).toBeNull();
    await expect(fetch(`http://${secondProxy}`)).rejects.toThrow();
  });

  it('recovers a dead session with a fresh context on the next ensure', async () => {
    const { manager, server } = await setup();
    const session = await manager.createSession({ directory: '/project' });
    await manager.createTab(session.id);
    const oldContext = manager.getSession(session.id).browserContextId;
    await manager.handleProcessDeath('test process death');
    await manager.createTab(session.id);
    expect(manager.getSession(session.id).dead).toBe(false);
    expect(manager.getSession(session.id).browserContextId).not.toBe(oldContext);
    expect(server.calls.filter((call) => call.method === 'Target.createBrowserContext')).toHaveLength(2);
  });
});
