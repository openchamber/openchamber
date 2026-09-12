import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { connectCdp } from './cdp.js';

const EXACT_AUTO_ATTACH = {
  autoAttach: true,
  flatten: true,
  waitForDebuggerOnStart: false,
  filter: [{ type: 'page' }],
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

export class FakeCdpServer {
  constructor({ targets = [] } = {}) {
    this.targets = new Map(targets.map((target) => [target.targetId, target]));
    this.calls = [];
    this.sockets = new Set();
    this.nextSession = 1;
  }

  async start() {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('message', (raw) => this.#onCommand(socket, JSON.parse(raw.toString())));
    });
    await new Promise((resolve) => this.server.once('listening', resolve));
    const address = this.server.address();
    this.url = `ws://127.0.0.1:${address.port}`;
    return this;
  }

  #reply(socket, message, result = {}) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
    }
  }

  #onCommand(socket, message) {
    this.calls.push(message);
    if (message.method === 'Test.hold') return;
    if (message.method === 'Test.echo') {
      setTimeout(() => this.#reply(socket, message, { value: message.params.value }), message.params.delay ?? 0);
      return;
    }
    if (message.method === 'Target.getTargets') {
      this.#reply(socket, message, { targetInfos: [...this.targets.values()] });
      return;
    }
    if (message.method === 'Target.attachToTarget') {
      this.#reply(socket, message, { sessionId: `session-${this.nextSession++}` });
      return;
    }
    if (message.method === 'Runtime.evaluate') {
      this.#reply(socket, message, { result: { type: 'string', value: message.params.expression } });
      return;
    }
    this.#reply(socket, message);
  }

  emit(method, params = {}, sessionId) {
    const frame = JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) });
    for (const socket of this.sockets) if (socket.readyState === WebSocket.OPEN) socket.send(frame);
  }

  createTarget(targetInfo) {
    this.targets.set(targetInfo.targetId, targetInfo);
    this.emit('Target.targetCreated', { targetInfo });
    if (targetInfo.type === 'page') {
      this.emit('Target.attachedToTarget', {
        sessionId: `auto-${this.nextSession++}`,
        targetInfo,
        waitingForDebugger: false,
      });
    }
  }

  destroyTarget(targetId) {
    this.targets.delete(targetId);
    this.emit('Target.targetDestroyed', { targetId });
  }

  malformed(frame = '{not json') {
    for (const socket of this.sockets) if (socket.readyState === WebSocket.OPEN) socket.send(frame);
  }

  terminateConnections() {
    for (const socket of this.sockets) socket.terminate();
  }

  async waitForCall(method, count = 1) {
    return waitFor(() => {
      const matches = this.calls.filter((call) => call.method === method);
      return matches.length >= count ? matches[count - 1] : null;
    });
  }

  async close() {
    for (const socket of this.sockets) socket.terminate();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }
}

const clients = [];
const servers = [];
const chromeProcesses = [];
const tempDirs = [];

const fake = async (options) => {
  const server = await new FakeCdpServer(options).start();
  servers.push(server);
  return server;
};

const connect = async (url, options) => {
  const client = await connectCdp(url, options);
  clients.push(client);
  return client;
};

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close();
  for (const child of chromeProcesses.splice(0)) child.kill('SIGKILL');
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('raw CDP transport', () => {
  it('correlates out-of-order responses, bounds timeouts, and rejects root page commands', async () => {
    const server = await fake();
    const client = await connect(server.url, { commandTimeoutMs: 50 });

    const slow = client.send('Test.echo', { value: 'slow', delay: 20 });
    const fast = client.send('Test.echo', { value: 'fast', delay: 0 });
    await expect(fast).resolves.toEqual({ value: 'fast' });
    await expect(slow).resolves.toEqual({ value: 'slow' });
    await expect(client.send('Test.hold')).rejects.toThrow('timed out after 50ms');
    await expect(client.send('Page.navigate')).rejects.toThrow('page commands require a target session');
  });

  it('rejects every pending command and emits disconnect when the socket dies', async () => {
    const server = await fake();
    const client = await connect(server.url);
    const registryEvents = [];
    client.onRegistry((event) => registryEvents.push(event));

    const first = client.send('Test.hold');
    const second = client.send('Test.hold');
    await server.waitForCall('Test.hold', 2);
    server.terminateConnections();

    await expect(first).rejects.toThrow('CDP command Test.hold failed: connection closed');
    await expect(second).rejects.toThrow('CDP command Test.hold failed: connection closed');
    await waitFor(() => registryEvents.some((event) => event.type === 'disconnect'));
    expect(client.getTargets()).toEqual([]);
  });

  it('ignores malformed event frames without crashing', async () => {
    const server = await fake();
    const warnings = [];
    const client = await connect(server.url, { logger: { warn: (message) => warnings.push(message), info() {} } });

    server.malformed();
    await expect(client.send('Test.echo', { value: 'alive' })).resolves.toEqual({ value: 'alive' });
    expect(warnings).toContain('[browser-cdp] ignored malformed protocol frame');
  });
});

describe('target registry and flat sessions', () => {
  it('reconciles external create/change/destroy events and re-syncs from a reconnect snapshot', async () => {
    const initial = { targetId: 'page-1', type: 'page', title: 'one', url: 'about:blank', browserContextId: 'external' };
    const server = await fake({ targets: [initial] });
    const client = await connect(server.url);
    const protocolEvents = [];
    client.onEvent((event) => protocolEvents.push(event));

    const worker = { targetId: 'worker-1', type: 'worker', title: 'worker', url: 'worker.js', browserContextId: 'external' };
    server.createTarget(worker);
    await waitFor(() => client.getTargets().some((target) => target.targetId === worker.targetId));
    expect(client.getTabs().map((target) => target.targetId)).toEqual(['page-1']);
    expect(protocolEvents.some((event) => event.method === 'Target.targetCreated')).toBe(true);

    server.emit('Target.targetInfoChanged', { targetInfo: { ...initial, targetId: 'unknown', title: 'ignored' } });
    server.destroyTarget('page-1');
    server.destroyTarget('page-1');
    await waitFor(() => !client.getTargets().some((target) => target.targetId === 'page-1'));
    expect(client.getTargets()).toHaveLength(1);

    client.close();
    server.targets.clear();
    server.targets.set('page-2', { ...initial, targetId: 'page-2', title: 'snapshot' });
    const reconnected = await connect(server.url);
    expect(reconnected.getTargets().map((target) => target.targetId)).toEqual(['page-2']);
  });

  it('uses flattened target sessions and never sends page commands on root', async () => {
    const page = { targetId: 'owned-page', type: 'page', title: '', url: 'about:blank', browserContextId: 'managed' };
    const server = await fake({ targets: [page] });
    const client = await connect(server.url, { managedContextIds: ['managed'] });

    const attach = await server.waitForCall('Target.attachToTarget');
    expect(attach.params).toEqual({ targetId: 'owned-page', flatten: true });
    expect(client.getSessionId('owned-page')).toBe('session-1');
    expect(client.getTargetId('session-1')).toBe('owned-page');
    await client.sendTarget('owned-page', 'Runtime.evaluate', { expression: '42' });
    const evaluate = await server.waitForCall('Runtime.evaluate');
    expect(evaluate.sessionId).toBe('session-1');

    server.emit('Target.detachedFromTarget', { sessionId: 'session-1', targetId: 'owned-page' });
    await waitFor(() => client.getSessionId('owned-page') === null);
  });

  it('auto-attaches only managed page targets and records all target types', async () => {
    const server = await fake();
    const client = await connect(server.url, { managedContextIds: ['managed'] });
    const setAutoAttach = await server.waitForCall('Target.setAutoAttach');
    expect(setAutoAttach.params).toEqual(EXACT_AUTO_ATTACH);

    server.createTarget({ targetId: 'owned', type: 'page', title: '', url: 'about:blank', browserContextId: 'managed' });
    server.createTarget({ targetId: 'worker', type: 'worker', title: '', url: 'worker.js', browserContextId: 'managed' });
    server.createTarget({ targetId: 'iframe', type: 'iframe', title: '', url: 'about:blank', browserContextId: 'managed' });
    server.createTarget({ targetId: 'foreign', type: 'page', title: '', url: 'about:blank', browserContextId: 'foreign' });

    await waitFor(() => client.getSessionId('owned'));
    await server.waitForCall('Target.detachFromTarget');
    expect(client.getTargets().map((target) => target.type).sort()).toEqual(['iframe', 'page', 'page', 'worker']);
    expect(client.getTabs('managed').map((target) => target.targetId)).toEqual(['owned']);
    expect(client.getSessionId('worker')).toBeNull();
    expect(client.getSessionId('iframe')).toBeNull();
    expect(client.getSessionId('foreign')).toBeNull();
    await expect(client.attach('worker')).rejects.toThrow('is not an owned page');
    expect(server.calls.filter((call) => call.method === 'Target.attachToTarget')).toEqual([]);
  });

  it('emits only redacted audit summaries and never changes network behavior', async () => {
    const server = await fake();
    const logs = [];
    const client = await connect(server.url, {
      managedContextIds: ['managed'],
      logger: { info: (...args) => logs.push(args), warn() {} },
    });
    const audit = [];
    client.onAudit((entry) => audit.push(entry));
    server.createTarget({ targetId: 'owned', type: 'page', title: '', url: 'about:blank', browserContextId: 'managed' });
    await server.waitForCall('Network.enable');
    const sessionId = client.getSessionId('owned');

    server.emit('Network.requestWillBeSent', {
      requestId: 'request-1',
      type: 'Document',
      request: {
        method: 'POST',
        url: 'https://user:password@example.test:8443/private?token=secret#fragment',
        headers: { authorization: 'Bearer secret' },
        postData: 'secret-body',
      },
    }, sessionId);
    server.emit('Network.loadingFailed', {
      requestId: 'request-1',
      type: 'Document',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT secret',
      blockedReason: 'inspector',
    }, sessionId);

    await waitFor(() => audit.length === 2);
    expect(audit).toEqual([
      {
        eventType: 'Network.requestWillBeSent',
        requestId: 'request-1',
        method: 'POST',
        origin: 'https://example.test:8443',
        resourceType: 'Document',
      },
      {
        eventType: 'Network.loadingFailed',
        requestId: 'request-1',
        resourceType: 'Document',
        failureCategory: 'blocked',
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain('secret');
    expect(server.calls.some((call) => call.method === 'Fetch.enable' || call.method === 'Network.setBlockedURLs')).toBe(false);
    await expect(client.sendTarget('owned', 'Runtime.evaluate', { expression: 'still-drivable' })).resolves.toBeTruthy();
  });
});

const CHROME_PATH = '/usr/sbin/chromium';
if (!fs.existsSync(CHROME_PATH)) console.info(`[real-chrome] skipped: ${CHROME_PATH} is absent`);

describe('real Chrome', () => {
  it.skipIf(!fs.existsSync(CHROME_PATH))('attaches and drives a popup in a managed context', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cdp-'));
    tempDirs.push(userDataDir);
    const chrome = spawn(CHROME_PATH, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-popup-blocking',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    chromeProcesses.push(chrome);

    const debuggerUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chromium did not publish its DevTools URL')), 15_000);
      chrome.stderr.on('data', (chunk) => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/\S+)/);
        if (!match) return;
        clearTimeout(timeout);
        resolve(match[1]);
      });
      chrome.once('exit', (code) => reject(new Error(`Chromium exited before startup (${code})`)));
    });
    console.info(`[real-chrome] mode=headless=new binary=${CHROME_PATH}`);

    const client = await connect(debuggerUrl, { commandTimeoutMs: 5_000 });
    const { browserContextId } = await client.send('Target.createBrowserContext');
    await client.manageContext(browserContextId);
    const { targetId: openerId } = await client.send('Target.createTarget', { url: 'about:blank', browserContextId });
    await waitFor(() => client.getSessionId(openerId), 10_000);
    await client.sendTarget(openerId, 'Runtime.evaluate', {
      expression: `setTimeout(() => window.open('about:blank'), 0); true`,
      userGesture: true,
      returnByValue: true,
    });

    const popup = await waitFor(() => client.getTabs(browserContextId)
      .find((target) => target.targetId !== openerId && client.getSessionId(target.targetId)), 10_000);
    const result = await client.sendTarget(popup.targetId, 'Runtime.evaluate', {
      expression: `document.body.textContent = 'drivable'; document.body.textContent`,
      returnByValue: true,
    });
    expect(result.result.value).toBe('drivable');
  }, 30_000);
});
