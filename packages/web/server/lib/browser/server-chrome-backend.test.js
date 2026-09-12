import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { connectCdp } from './cdp.js';
import { createBrowserSessionManager } from './session-manager.js';
import { createChromeProcessManager } from './chrome-process.js';
import { createServerChromeBackend } from './server-chrome-backend.js';
import { getBrowserViewportManager } from './viewport.js';

const handleExpectedPeerTeardownError = (error) => {
  if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') throw error;
};

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test condition');
};

class FakeCdpServer {
  constructor() {
    this.targets = new Map();
    this.contexts = new Set();
    this.sessions = new Map();
    this.targetForSession = new Map();
    this.calls = [];
    this.sockets = new Set();
    this.nextContext = 1;
    this.nextTarget = 1;
    this.nextSession = 1;
    this.navigateErrorText = null;
    this.evaluateException = null;
    this.evaluateDelayMs = 0;
    this.commandHolds = new Map();
    this.viewports = new Map();
    this.emitHistoryLoad = true;
  }

  async start() {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', handleExpectedPeerTeardownError);
      socket.on('message', (raw) => this.#onCommand(socket, JSON.parse(raw.toString())));
    });
    await new Promise((resolve) => this.server.once('listening', resolve));
    const address = this.server.address();
    this.url = `ws://127.0.0.1:${address.port}`;
    return this;
  }

  #reply(socket, message, result = {}) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        id: message.id,
        result,
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      }));
    }
  }

  #fail(socket, message, error) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        id: message.id,
        error: { message: error },
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      }));
    }
  }

  emit(method, params = {}, sessionId) {
    const frame = JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) });
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    }
  }

  #onCommand(socket, message) {
    this.calls.push(message);
    const hold = this.commandHolds.get(message.method);
    if (hold) {
      this.commandHolds.delete(message.method);
      hold.promise.then(() => this.#handleCommand(socket, message));
      return;
    }
    this.#handleCommand(socket, message);
  }

  #handleCommand(socket, message) {
    switch (message.method) {
      case 'Target.setDiscoverTargets':
      case 'Target.setAutoAttach':
      case 'Runtime.enable':
      case 'Page.enable':
      case 'Network.enable':
        this.#reply(socket, message);
        return;
      case 'Emulation.clearDeviceMetricsOverride':
        this.viewports.delete(this.sessions.get(message.sessionId));
        this.#reply(socket, message);
        return;
      case 'Target.disposeBrowserContext':
        this.contexts.delete(message.params.browserContextId);
        this.#reply(socket, message);
        return;
      case 'Page.navigateToHistoryEntry':
        this.#reply(socket, message);
        if (this.emitHistoryLoad) setTimeout(() => this.emit('Page.loadEventFired', {}, message.sessionId), 5);
        return;
      case 'Target.getTargets':
        this.#reply(socket, message, { targetInfos: [...this.targets.values()] });
        return;
      case 'Target.createBrowserContext': {
        const browserContextId = `context-${this.nextContext++}`;
        this.contexts.add(browserContextId);
        this.#reply(socket, message, { browserContextId });
        return;
      }
      case 'Target.createTarget': {
        const target = {
          targetId: `target-${this.nextTarget++}`,
          type: 'page',
          title: '',
          url: message.params.url ?? 'about:blank',
          browserContextId: message.params.browserContextId,
        };
        this.targets.set(target.targetId, target);
        this.emit('Target.targetCreated', { targetInfo: target });
        this.#reply(socket, message, { targetId: target.targetId });
        return;
      }
      case 'Target.attachToTarget': {
        const sessionId = `session-${this.nextSession++}`;
        this.sessions.set(sessionId, message.params.targetId);
        this.targetForSession.set(message.params.targetId, sessionId);
        this.#reply(socket, message, { sessionId });
        return;
      }
      case 'Target.detachFromTarget': {
        const sessionId = message.params.sessionId;
        const targetId = this.sessions.get(sessionId);
        this.sessions.delete(sessionId);
        if (targetId) this.targetForSession.delete(targetId);
        this.#reply(socket, message);
        return;
      }
      case 'Page.navigate': {
        const result = { frameId: `frame-${this.nextTarget}` };
        if (this.navigateErrorText) {
          result.errorText = this.navigateErrorText;
        }
        this.#reply(socket, message, result);
        if (!this.navigateErrorText) {
          setTimeout(() => this.emit('Page.loadEventFired', { frameId: result.frameId }, this.targetForSession.get(this.sessions.get(message.sessionId))), 5);
        }
        return;
      }
      case 'Page.getNavigationHistory':
        this.#reply(socket, message, {
          currentIndex: 1,
          entries: [
            { id: 'entry-0', url: 'http://example.com/prev', title: 'Previous' },
            { id: 'entry-1', url: 'http://example.com/curr', title: 'Current' },
            { id: 'entry-2', url: 'http://example.com/next', title: 'Next' },
          ],
        });
        return;
      case 'Page.captureScreenshot':
        this.#reply(socket, message, { data: 'iVBORw0KGgo=' });
        return;
      case 'Page.getLayoutMetrics': {
        const viewport = this.viewports.get(this.sessions.get(message.sessionId)) ?? { width: 1280, height: 720 };
        this.#reply(socket, message, {
          layoutViewport: { clientWidth: viewport.width, clientHeight: viewport.height },
          cssLayoutViewport: { clientWidth: viewport.width, clientHeight: viewport.height },
          cssVisualViewport: { clientWidth: viewport.width, clientHeight: viewport.height, scale: 1 },
        });
        return;
      }
      case 'Emulation.setDeviceMetricsOverride':
        this.lastDeviceMetrics = message.params;
        this.viewports.set(this.sessions.get(message.sessionId), message.params);
        this.#reply(socket, message);
        return;
      case 'Runtime.evaluate': {
        const { expression } = message.params;
        if (!message.params.returnByValue || !message.params.awaitPromise) {
          this.#fail(socket, message, 'Runtime.evaluate must use returnByValue and awaitPromise');
          return;
        }
        if (this.evaluateDelayMs > 0) {
          const delayMs = this.evaluateDelayMs;
          this.evaluateDelayMs = 0;
          setTimeout(() => this.#onCommand(socket, message), delayMs);
          return;
        }
        if (this.evaluateException) {
          this.#reply(socket, message, {
            exceptionDetails: {
              text: this.evaluateException,
              exception: { description: this.evaluateException },
            },
          });
          return;
        }
        if (expression.includes('var scopeSelector')) {
          this.#reply(socket, message, { result: { type: 'object', value: {
            ok: true, url: 'http://example.com', title: 'Example', scope: 'document', scrollY: 0, maxScrollY: 0, text: 'Hello', elements: [],
          } } });
          return;
        }
        if (expression.includes('target.click()')) {
          this.#reply(socket, message, { result: { type: 'object', value: {
            ok: true, clicked: 'button', label: 'Click me', url: 'http://example.com',
          } } });
          return;
        }
        if (expression.includes("new Event('input'")) {
          this.#reply(socket, message, { result: { type: 'object', value: {
            ok: true, selector: 'input', url: 'http://example.com',
          } } });
          return;
        }
        if (expression.includes('var settle = function')) {
          this.#reply(socket, message, { result: { type: 'object', value: {
            ok: true, scrollY: 42, maxScrollY: 100, atTop: false, atBottom: false, direction: 'down',
          } } });
          return;
        }
        if (expression.includes('var props =')) {
          this.#reply(socket, message, { result: { type: 'object', value: {
            ok: true, selector: 'div', tag: 'div', label: '', bounds: { x: 0, y: 0, width: 1, height: 1 }, inViewport: true, styles: {},
          } } });
          return;
        }
        if (expression.includes('String(location.href)')) {
          this.#reply(socket, message, { result: { type: 'object', value: {
            url: 'http://example.com/navigated', title: 'Navigated',
          } } });
          return;
        }
        this.#reply(socket, message, { result: { type: 'undefined' } });
        return;
      }
      default:
        this.#reply(socket, message);
    }
  }

  waitForCall(method, count = 1) {
    return waitFor(() => {
      const matches = this.calls.filter((call) => call.method === method);
      return matches.length >= count ? matches[count - 1] : null;
    });
  }

  async close() {
    await Promise.all([...this.sockets].map((socket) => new Promise((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once('close', resolve);
      socket.terminate();
    })));
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }
}

class FakeChromeProcessManager {
  constructor(url, { delayMs = 0, rejectError = null } = {}) {
    this.url = url;
    this.delayMs = delayMs;
    this.rejectError = rejectError;
    this.generation = 1;
    this.process = new EventEmitter();
    this.ensureCalls = 0;
    this.readiness = null;
  }

  async ensureProcess() {
    this.ensureCalls += 1;
    if (this.readiness) await this.readiness;
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.rejectError) throw this.rejectError;
    return { process: this.process, generation: this.generation, webSocketDebuggerUrl: this.url };
  }
}

const createBackend = async (processOptions = {}) => {
  const fakeCdp = await new FakeCdpServer().start();
  const processManager = new FakeChromeProcessManager(fakeCdp.url, processOptions);
  const sessionManager = createBrowserSessionManager({ chromeProcessManager: processManager });
  const backend = createServerChromeBackend({ browserSessionManager: sessionManager, chromeProcessManager: processManager });
  return { fakeCdp, processManager, sessionManager, backend };
};

describe('createServerChromeBackend', () => {
  const contexts = [];

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) {
      await ctx.sessionManager.close().catch(() => {});
      await ctx.fakeCdp.close().catch(() => {});
    }
  });

  const setup = async (options) => {
    const ctx = await createBackend(options);
    contexts.push(ctx);
    return ctx;
  };

  it('returns null session when no server chrome session exists', async () => {
    const { backend } = await setup();
    expect(backend.getSession({ directory: '/no/such/dir' })).toBeNull();
  });

  describe('caller cancellation', () => {
    it('disposes a context returned after cancellation without creating a page', async () => {
      const { backend, fakeCdp, sessionManager } = await setup();
      const hold = Promise.withResolvers();
      fakeCdp.commandHolds.set('Target.createBrowserContext', hold);
      const controller = new AbortController();
      const opening = backend.execute({ directory: '/project' }, 'browser.open', {
        url: 'http://example.com',
      }, { signal: controller.signal });
      const result = expect(opening).rejects.toMatchObject({ status: 499 });
      await fakeCdp.waitForCall('Target.createBrowserContext');
      controller.abort();
      hold.resolve();

      await result;
      await fakeCdp.waitForCall('Target.disposeBrowserContext');
      await waitFor(() => sessionManager.listSessions().length === 0);
      expect(fakeCdp.contexts.size).toBe(0);
      expect(fakeCdp.calls.filter((call) => call.method === 'Target.createTarget')).toEqual([]);
    });

    it('does not navigate after cancellation during tab attachment', async () => {
      const { backend, fakeCdp } = await setup();
      const hold = Promise.withResolvers();
      fakeCdp.commandHolds.set('Target.attachToTarget', hold);
      const controller = new AbortController();
      const opening = backend.execute({ directory: '/project' }, 'browser.open', {
        url: 'http://example.com',
      }, { signal: controller.signal });
      const result = expect(opening).rejects.toMatchObject({ status: 499 });
      await fakeCdp.waitForCall('Target.attachToTarget');
      controller.abort();
      hold.resolve();

      await result;
      await fakeCdp.waitForCall('Target.disposeBrowserContext');
      expect(fakeCdp.calls.filter((call) => call.method === 'Page.navigate')).toEqual([]);
    });

    it('stops later commands after viewer takeover without a caller signal', async () => {
      const { backend, fakeCdp, sessionManager } = await setup();
      const scope = { directory: '/project', openCodeSessionId: 'agent' };
      const opened = await backend.execute(scope, 'browser.open', { url: 'http://example.com' });
      const hold = Promise.withResolvers();
      fakeCdp.commandHolds.set('Page.getNavigationHistory', hold);
      const back = backend.execute({ ...scope, tabId: opened.tabId }, 'browser.back', {});
      const result = expect(back).rejects.toMatchObject({ status: 409 });
      await fakeCdp.waitForCall('Page.getNavigationHistory');
      sessionManager.viewerTakeover(scope, 'viewer');
      hold.resolve();

      await result;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fakeCdp.calls.filter((call) => call.method === 'Page.navigateToHistoryEntry')).toEqual([]);
      expect(sessionManager.getLease(scope)).toMatchObject({ actor: 'user', viewerId: 'viewer' });
    });

    it('does not launch Chrome or create a session for an already cancelled open', async () => {
      const { backend, processManager, sessionManager, fakeCdp } = await setup();
      const controller = new AbortController();
      controller.abort();

      await expect(backend.execute({ directory: '/project' }, 'browser.open', {
        url: 'http://example.com',
      }, { signal: controller.signal })).rejects.toMatchObject({ status: 499 });
      expect(processManager.ensureCalls).toBe(0);
      expect(sessionManager.listSessions()).toEqual([]);
      expect(fakeCdp.calls).toEqual([]);
    });

    it('stops a cold open before session creation when cancelled during process readiness', async () => {
      const { backend, processManager, sessionManager, fakeCdp } = await setup();
      const readiness = Promise.withResolvers();
      processManager.readiness = readiness.promise;
      const controller = new AbortController();
      const opening = backend.execute({ directory: '/project' }, 'browser.open', {
        url: 'http://example.com',
      }, { signal: controller.signal });
      const result = expect(opening).rejects.toMatchObject({ status: 499 });
      await waitFor(() => processManager.ensureCalls > 0);
      controller.abort();
      readiness.resolve();

      await result;
      expect(sessionManager.listSessions()).toEqual([]);
      expect(fakeCdp.calls).toEqual([]);
    });

    it('captures caller target and parameters before process readiness', async () => {
      const { backend, processManager, fakeCdp } = await setup();
      const readiness = Promise.withResolvers();
      processManager.readiness = readiness.promise;
      const target = { directory: '/project', openCodeSessionId: 'original' };
      const parameters = { url: 'http://example.com', viewport: 'mobile' };
      const opening = backend.execute(target, 'browser.open', parameters);
      target.directory = '/changed';
      target.openCodeSessionId = 'changed';
      parameters.viewport = 'desktop';
      readiness.resolve();

      await opening;
      expect(fakeCdp.lastDeviceMetrics).toMatchObject({ width: 390, height: 844 });
      expect(await backend.listTabs({ directory: '/project', openCodeSessionId: 'original' })).toHaveLength(1);
      expect(await backend.listTabs({ directory: '/changed', openCodeSessionId: 'changed' })).toEqual([]);
    });

    it('stops later capture commands when cancellation arrives during a CDP response', async () => {
      const { backend, fakeCdp } = await setup();
      const opened = await backend.execute({ directory: '/project' }, 'browser.open', { url: 'http://example.com' });
      const hold = Promise.withResolvers();
      fakeCdp.commandHolds.set('Page.captureScreenshot', hold);
      const controller = new AbortController();
      const capture = backend.execute({ directory: '/project', tabId: opened.tabId }, 'browser.capture', {}, {
        signal: controller.signal,
      });
      const result = expect(capture).rejects.toMatchObject({ status: 499 });
      await fakeCdp.waitForCall('Page.captureScreenshot');
      controller.abort();
      hold.resolve();

      await result;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fakeCdp.calls.filter((call) => call.method === 'Page.getLayoutMetrics')).toEqual([]);
    });

    it('does not swallow cancellation during a history navigation load wait', async () => {
      const { backend, fakeCdp } = await setup();
      const opened = await backend.execute({ directory: '/project' }, 'browser.open', { url: 'http://example.com' });
      fakeCdp.emitHistoryLoad = false;
      const controller = new AbortController();
      const back = backend.execute({ directory: '/project', tabId: opened.tabId }, 'browser.back', {}, {
        signal: controller.signal,
      });
      const result = expect(back).rejects.toMatchObject({ status: 499 });
      const navigation = await fakeCdp.waitForCall('Page.navigateToHistoryEntry');
      controller.abort();
      fakeCdp.emit('Page.loadEventFired', {}, navigation.sessionId);

      await result;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fakeCdp.calls.filter((call) => call.method === 'Runtime.evaluate')).toEqual([]);
    });
  });

  it('lists tabs with server-chrome backend ids', async () => {
    const { backend } = await setup();
    await backend.execute(
      { directory: '/project' },
      'browser.open',
      { url: 'http://example.com' },
    );
    const tabs = await backend.listTabs({ directory: '/project' });
    expect(tabs).toHaveLength(1);
    expect(tabs[0].backend).toBe('server-chrome');
    expect(tabs[0].tabId).toMatch(/^sc:target-/);
  });

  it('lists only tabs from the requested OpenCode session scope', async () => {
    const { backend } = await setup();
    const agentA = await backend.execute(
      { directory: '/project', openCodeSessionId: 'agent-a' },
      'browser.open',
      { url: 'http://agent-a.example' },
    );
    const agentB = await backend.execute(
      { directory: '/project', openCodeSessionId: 'agent-b' },
      'browser.open',
      { url: 'http://agent-b.example' },
    );

    await expect(backend.listTabs({ directory: '/project', openCodeSessionId: 'agent-a' }))
      .resolves.toEqual([expect.objectContaining({ tabId: agentA.tabId })]);
    await expect(backend.listTabs({ directory: '/project', openCodeSessionId: 'agent-b' }))
      .resolves.toEqual([expect.objectContaining({ tabId: agentB.tabId })]);
    await expect(backend.listTabs({ directory: '/project' })).resolves.toEqual([]);
  });

  it('opens a tab and returns the expected shape', async () => {
    const { backend, fakeCdp } = await setup();
    const result = await backend.execute(
      { directory: '/project' },
      'browser.open',
      { url: 'http://example.com' },
    );
    expect(result).toEqual({
      url: 'http://example.com',
      opened: true,
      tabId: expect.stringMatching(/^sc:target-/),
      richControl: true,
    });
    const navigate = await fakeCdp.waitForCall('Page.navigate');
    expect(navigate.params.url).toBe('http://example.com');
  });

  it('runs snapshot, click, type, scroll, and inspect with Electron-parity shapes', async () => {
    const { backend } = await setup();
    const openResult = await backend.execute(
      { directory: '/project' },
      'browser.open',
      { url: 'http://example.com' },
    );
    const target = { directory: '/project', tabId: openResult.tabId };

    const snapshot = await backend.execute(target, 'browser.snapshot', {});
    expect(snapshot).toEqual({
      ok: true, url: 'http://example.com', title: 'Example', scope: 'document', scrollY: 0,
      maxScrollY: 0, text: 'Hello', elements: [], viewport: { mode: 'fill', width: null, height: null },
    });

    const click = await backend.execute(target, 'browser.click', { selector: 'button' });
    expect(click).toEqual({ ok: true, clicked: 'button', label: 'Click me', url: 'http://example.com' });

    const type = await backend.execute(target, 'browser.type', { selector: 'input', value: 'hello', submit: false });
    expect(type).toEqual({ ok: true, selector: 'input', url: 'http://example.com' });

    const scroll = await backend.execute(target, 'browser.scroll', { direction: 'down' });
    expect(scroll).toEqual({
      ok: true, scrollY: 42, maxScrollY: 100, atTop: false, atBottom: false, direction: 'down',
    });

    const inspect = await backend.execute(target, 'browser.inspect', { selector: 'div' });
    expect(inspect).toEqual({
      ok: true, selector: 'div', tag: 'div', label: '',
      bounds: { x: 0, y: 0, width: 1, height: 1 }, inViewport: true, styles: {},
    });
  });

  it('asserts every Runtime.evaluate uses returnByValue and awaitPromise', async () => {
    const { backend, fakeCdp } = await setup();
    const openResult = await backend.execute(
      { directory: '/project' },
      'browser.open',
      { url: 'http://example.com' },
    );
    const target = { directory: '/project', tabId: openResult.tabId };

    await backend.execute(target, 'browser.snapshot', {});
    const evaluate = await fakeCdp.waitForCall('Runtime.evaluate');
    expect(evaluate.params.returnByValue).toBe(true);
    expect(evaluate.params.awaitPromise).toBe(true);
  });

  it('surfaces exceptionDetails as a target-named error', async () => {
    const { backend, fakeCdp } = await setup();
    const openResult = await backend.execute(
      { directory: '/project' },
      'browser.open',
      { url: 'http://example.com' },
    );
    fakeCdp.evaluateException = 'boom';
    const target = { directory: '/project', tabId: openResult.tabId };
    await expect(backend.execute(target, 'browser.snapshot', {})).rejects.toMatchObject({
      name: 'BrowserControlError',
      message: expect.stringContaining('boom'),
      status: 400,
      target: { directory: '/project', tabId: openResult.tabId },
    });
  });

  it('resolves a Promise-returning scroll action to its final value', async () => {
    const { backend } = await setup();
    const openResult = await backend.execute(
      { directory: '/project' },
      'browser.open',
      { url: 'http://example.com' },
    );
    const result = await backend.execute(
      { directory: '/project', tabId: openResult.tabId },
      'browser.scroll',
      { direction: 'down' },
    );
    expect(result).toEqual(expect.objectContaining({ ok: true, scrollY: 42, direction: 'down' }));
  });

  it('rejects a mutating op invalidated by the lease with a conflict error', async () => {
    const { backend, fakeCdp, sessionManager } = await setup();
    const openResult = await backend.execute(
      { directory: '/project', openCodeSessionId: 'agent-1' },
      'browser.open',
      { url: 'http://example.com' },
    );
    fakeCdp.evaluateDelayMs = 25;
    const target = { directory: '/project', openCodeSessionId: 'agent-1', tabId: openResult.tabId };
    const click = backend.execute(
      target,
      'browser.click',
      { selector: 'button' },
    );
    await fakeCdp.waitForCall('Runtime.evaluate');
    sessionManager.viewerTakeover({ directory: '/project', openCodeSessionId: 'agent-1' }, 'viewer-1');
    await expect(click).rejects.toMatchObject({
      name: 'BrowserControlError',
      status: 409,
      target,
    });
  });

  it('rejects an op on a dead session with a scoped 503 naming the target', async () => {
    const error = new Error('Chrome generation 1 exited unexpectedly (code 1, signal SIGKILL)');
    const { backend, sessionManager, processManager } = await setup();
    const target = { directory: '/project', openCodeSessionId: 'agent-1' };
    const openResult = await backend.execute(target, 'browser.open', { url: 'http://example.com' });
    await sessionManager.handleProcessDeath(error.message);
    processManager.rejectError = error;
    await expect(backend.execute(
      { ...target, tabId: openResult.tabId },
      'browser.snapshot',
      {},
    )).rejects.toMatchObject({
      name: 'BrowserControlError',
      status: 503,
      target: { ...target, tabId: openResult.tabId },
    });
  });

  it('awaits cold process readiness within the open budget', async () => {
    const { backend } = await setup({ delayMs: 50 });
    const result = await backend.execute(
      { directory: '/project' },
      'browser.open',
      { url: 'http://example.com' },
    );
    expect(result.opened).toBe(true);
  });

  it('rejects open with the OC-06 error when the process crashes mid-start', async () => {
    const error = new Error('Chrome generation 1 exited unexpectedly (code 1, signal SIGKILL)');
    const { backend } = await setup({ rejectError: error });
    await expect(backend.execute(
      { directory: '/project' },
      'browser.open',
      { url: 'http://example.com' },
    )).rejects.toMatchObject({
      name: 'BrowserControlError',
      status: 503,
      message: expect.stringContaining('exited unexpectedly'),
      target: { directory: '/project' },
    });
  });

  it('carries the session proxyServer into every browser context creation', async () => {
    const { backend, fakeCdp } = await setup();
    await backend.execute(
      { directory: '/project' },
      'browser.open',
      { url: 'http://example.com' },
    );
    const context = await fakeCdp.waitForCall('Target.createBrowserContext');
    expect(context.params).toEqual({
      proxyServer: expect.stringMatching(/^127\.0\.0\.1:\d+$/),
      proxyBypassList: '<-loopback>',
    });
  });

  it('navigates back and forward with the Electron-parity shape', async () => {
    const { backend } = await setup();
    const openResult = await backend.execute(
      { directory: '/project' },
      'browser.open',
      { url: 'http://example.com' },
    );
    const target = { directory: '/project', tabId: openResult.tabId };
    const back = await backend.execute(target, 'browser.back', {});
    expect(back).toEqual({ url: 'http://example.com/navigated', title: 'Navigated' });

    const forward = await backend.execute(target, 'browser.forward', {});
    expect(forward).toEqual({ url: 'http://example.com/navigated', title: 'Navigated' });
  });

  it('resizes the viewport and returns the expected shape', async () => {
    const { backend, fakeCdp } = await setup();
    const openResult = await backend.execute(
      { directory: '/project' },
      'browser.open',
      { url: 'http://example.com' },
    );
    const target = { directory: '/project', tabId: openResult.tabId };
    const result = await backend.execute(target, 'browser.resize', { viewport: 'mobile' });
    expect(result).toEqual({ viewport: { mode: 'mobile', width: 390, height: 844 } });
    const metrics = await fakeCdp.waitForCall('Emulation.setDeviceMetricsOverride');
    expect(metrics.params).toMatchObject({ width: 390, height: 844, mobile: true, deviceScaleFactor: 1 });
  });

  it('leaves the existing target viewport unchanged when open has no explicit viewport', async () => {
    const { backend, fakeCdp, sessionManager } = await setup();
    const scope = { directory: '/project' };
    const opened = await backend.execute(scope, 'browser.open', { url: 'http://example.com' });
    const session = sessionManager.getSession({ ...scope, openCodeSessionId: 'server-chrome-control' });
    const core = getBrowserViewportManager(sessionManager);
    sessionManager.viewerTakeover(session.id, 'viewer');
    sessionManager.viewerDisconnect(session.id, 'viewer');
    await core.setViewer({ sessionId: session.id, targetId: opened.tabId.slice(3), viewerId: 'viewer',
      width: 700, height: 500, mode: 'auto', mobile: false, takeover: false });
    const writes = fakeCdp.calls.filter((call) => call.method.startsWith('Emulation.')).length;

    await backend.execute({ ...scope, tabId: opened.tabId }, 'browser.open', { url: 'http://example.com/next' });

    expect(fakeCdp.calls.filter((call) => call.method.startsWith('Emulation.'))).toHaveLength(writes);
    expect(core.snapshot(session.id, opened.tabId.slice(3), 'viewer')).toMatchObject({
      width: 700, height: 500, source: 'viewer', mode: 'auto',
    });
  });

  it('keeps agent viewport summaries scoped to the target within one browser session', async () => {
    const { backend } = await setup();
    const scope = { directory: '/project' };
    const mobile = await backend.execute(scope, 'browser.open', { url: 'http://example.com/mobile', viewport: 'mobile' });
    const desktop = await backend.execute(scope, 'browser.open', { url: 'http://example.com/desktop', viewport: 'desktop' });

    const first = await backend.execute({ ...scope, tabId: mobile.tabId }, 'browser.snapshot', {});
    const second = await backend.execute({ ...scope, tabId: desktop.tabId }, 'browser.capture', {});
    expect(first.viewport).toEqual({ mode: 'mobile', width: 390, height: 844 });
    expect(second.viewport).toEqual({ mode: 'desktop', width: 1440, height: 900 });
  });

  it('publishes agent resize authority through the same viewport coordinator as viewers', async () => {
    const { backend, sessionManager } = await setup();
    const scope = { directory: '/project' };
    const opened = await backend.execute(scope, 'browser.open', { url: 'http://example.com' });
    const session = sessionManager.getSession({ ...scope, openCodeSessionId: 'server-chrome-control' });

    await backend.execute({ ...scope, tabId: opened.tabId }, 'browser.resize', { viewport: 'tablet' });
    sessionManager.viewerTakeover(session.id, 'viewer');
    sessionManager.viewerDisconnect(session.id, 'viewer');

    expect(getBrowserViewportManager(sessionManager).snapshot(session.id, opened.tabId.slice(3), 'viewer')).toMatchObject({
      width: 768, height: 1024, source: 'agent', mode: 'fixed', mobile: false, deviceScaleFactor: 1, autoAllowed: false,
    });
  });

  it('waits for an invalidated agent metrics command before applying the viewer takeover', async () => {
    const { backend, fakeCdp, sessionManager } = await setup();
    const scope = { directory: '/project' };
    const opened = await backend.execute(scope, 'browser.open', { url: 'http://example.com' });
    const session = sessionManager.getSession({ ...scope, openCodeSessionId: 'server-chrome-control' });
    const rawWrite = Promise.withResolvers();
    fakeCdp.commandHolds.set('Emulation.setDeviceMetricsOverride', rawWrite);
    const agentResize = backend.execute({ ...scope, tabId: opened.tabId }, 'browser.resize', { viewport: 'mobile' });
    const rejectedAgent = expect(agentResize).rejects.toMatchObject({ status: 409 });
    await fakeCdp.waitForCall('Emulation.setDeviceMetricsOverride');
    const viewerResize = getBrowserViewportManager(sessionManager).setViewer({ sessionId: session.id,
      targetId: opened.tabId.slice(3), viewerId: 'viewer', width: 700, height: 500,
      mode: 'auto', mobile: false, takeover: true });
    await rejectedAgent;
    expect(fakeCdp.calls.filter((call) => call.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(1);
    rawWrite.resolve();

    await expect(viewerResize).resolves.toMatchObject({ status: 'applied', viewport: { width: 700, height: 500 } });
    expect(fakeCdp.calls.filter((call) => call.method.startsWith('Emulation.')
      || call.method === 'Page.getLayoutMetrics').map((call) => call.method)).toEqual([
      'Emulation.setDeviceMetricsOverride', 'Emulation.setDeviceMetricsOverride', 'Page.getLayoutMetrics',
    ]);
  });

  it('captures the page with the expected shape', async () => {
    const { backend } = await setup();
    const openResult = await backend.execute(
      { directory: '/project' },
      'browser.open',
      { url: 'http://example.com' },
    );
    const target = { directory: '/project', tabId: openResult.tabId };
    const result = await backend.execute(target, 'browser.capture', {});
    expect(result).toEqual({
      mime: 'image/png',
      base64: 'iVBORw0KGgo=',
      width: 1280,
      height: 720,
      url: 'http://example.com/navigated',
      title: 'Navigated',
      viewport: { mode: 'fill', width: null, height: null },
    });
  });

  it('surfaces a policy-denied navigation as a target-named error', async () => {
    const { backend, fakeCdp } = await setup();
    fakeCdp.navigateErrorText = 'blocked by policy';
    await expect(backend.execute(
      { directory: '/project' },
      'browser.open',
      { url: 'http://denied.example.com' },
    )).rejects.toMatchObject({
      name: 'BrowserControlError',
      message: expect.stringContaining('blocked by policy'),
      target: { directory: '/project' },
    });
  });
});

describe('createServerChromeBackend with real Chrome', () => {
  it('opens a data: URL page, scrolls, and returns the final scroll value', async () => {
    const chromePath = process.env.OPENCHAMBER_CHROME_PATH || '/usr/sbin/chromium';
    try {
      await import('node:fs').then((fs) => fs.promises.access(chromePath, fs.constants.X_OK));
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`Skipping real Chrome test: ${chromePath} is not executable`);
      return;
    }

    const processManager = createChromeProcessManager({ env: { ...process.env, OPENCHAMBER_CHROME_PATH: chromePath } });
    const sessionManager = createBrowserSessionManager({ chromeProcessManager: processManager });
    const backend = createServerChromeBackend({ browserSessionManager: sessionManager, chromeProcessManager: processManager });

    try {
      const openResult = await backend.execute(
        { directory: '/real-test', openCodeSessionId: 'real-agent' },
        'browser.open',
        { url: 'data:text/html,<html><body style="height:2000px"></body></html>' },
      );
      expect(openResult.opened).toBe(true);

      const scroll = await backend.execute(
        { directory: '/real-test', openCodeSessionId: 'real-agent', tabId: openResult.tabId },
        'browser.scroll',
        { direction: 'down' },
      );
      expect(scroll.ok).toBe(true);
      expect(typeof scroll.scrollY).toBe('number');
      expect(scroll.scrollY).toBeGreaterThan(0);
    } finally {
      await sessionManager.close().catch(() => {});
      await processManager.kill();
    }
  }, 60_000);
});
