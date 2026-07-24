import { EventEmitter } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import express from 'express';
import { WebSocket } from 'ws';

import { createTerminalRuntime } from './runtime.js';
import { createTerminalWsControlFrame, readTerminalWsControlFrame } from './terminal-ws-protocol.js';

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function createRuntime(server, overrides = {}) {
  const app = overrides.app ?? {
    post() {},
    get() {},
    delete() {},
  };

  return createTerminalRuntime({
    app,
    server,
    express: { text: () => (_req, _res, next) => next?.() },
    fs,
    path,
    uiAuthController: null,
    buildAugmentedPath: () => process.env.PATH || '',
    searchPathFor: () => null,
    isExecutable: () => false,
    isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade() {},
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000,
    TERMINAL_INPUT_WS_REBIND_WINDOW_MS: 1_000,
    TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: 3,
    ...overrides,
  });
}

describe('terminal runtime', () => {
  const createHarness = (overrides = {}) => {
    const routes = { get: new Map(), post: new Map(), delete: new Map() };
    const processes = [];
    const app = {
      post(route, handler) { routes.post.set(route, handler); },
      get(route, handler) { routes.get.set(route, handler); },
      delete(route, handler) { routes.delete.set(route, handler); },
    };
    const loadPtyProvider = async () => ({
      backend: 'fake-pty',
      spawn: (shell, args, options) => {
        const dataHandlers = new Set();
        const exitHandlers = new Set();
        const process = {
          pid: 123 + processes.length,
          shell,
          args,
          options,
          writes: [],
          resizes: [],
          killed: false,
          kills: [],
          write(data) { this.writes.push(data); },
          resize(cols, rows) { this.resizes.push([cols, rows]); },
          kill(signal) { this.killed = true; this.kills.push(signal ?? 'SIGTERM'); },
          onData(handler) { dataHandlers.add(handler); return { dispose: () => dataHandlers.delete(handler) }; },
          onExit(handler) { exitHandlers.add(handler); return { dispose: () => exitHandlers.delete(handler) }; },
          emitData(data) { for (const handler of dataHandlers) handler(data); },
          emitExit(exitCode = 0, signal = 0) { for (const handler of exitHandlers) handler({ exitCode, signal }); },
        };
        processes.push(process);
        return process;
      },
    });
    const server = new EventEmitter();
    const runtime = createRuntime(server, {
      app,
      loadPtyProvider,
      terminalTerminationGraceMs: 10,
      fs: { promises: { stat: async () => ({ isDirectory: () => true }) } },
      searchPathFor: () => '/bin/sh',
      isExecutable: () => true,
      ...overrides,
    });
    return { routes, processes, runtime };
  };

  it('rejects regular files as terminal working directories', async () => {
    const postRoutes = new Map();
    const app = {
      post(route, ...handlers) {
        postRoutes.set(route, handlers.at(-1));
      },
      get() {},
      delete() {},
    };
    const server = new EventEmitter();
    const runtime = createRuntime(server, {
      app,
      fs: {
        promises: {
          stat: async () => ({ isDirectory: () => false }),
        },
      },
      uiAuthController: { enabled: false },
      buildAugmentedPath: () => '',
      TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 1000,
      TERMINAL_INPUT_WS_REBIND_WINDOW_MS: 1000,
    });

    try {
      const createRoute = postRoutes.get('/api/terminal/create');
      const res = createResponse();

      await createRoute({ body: { cwd: '/tmp/not-a-directory' } }, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid working directory' });
    } finally {
      await runtime.shutdown();
    }
  });

  it('removes its websocket upgrade listener on shutdown', async () => {
    const server = new EventEmitter();
    const runtime = createRuntime(server);

    expect(server.listenerCount('upgrade')).toBe(1);

    await runtime.shutdown();

    expect(server.listenerCount('upgrade')).toBe(0);
  });

  it('creates client-identified sessions and forwards bounded resize operations', async () => {
    const harness = createHarness();
    try {
      const response = createResponse();
      await harness.routes.post.get('/api/terminal/create')({ body: { sessionId: 'term-1', cwd: '/repo', cols: 120, rows: 40, themeMode: 'light', terminalBackground: '#faf8f0', terminalForeground: '#1b1b1b' } }, response);
      expect(response.body).toEqual({ sessionId: 'term-1', cols: 120, rows: 40, status: 'running' });
      expect(harness.processes[0].options.cwd).toBe('/repo');
      expect(harness.processes[0].options.env.COLORFGBG).toBe('0;15');
      expect(harness.processes[0].options.env.NODE_CHANNEL_FD).toBe('');
      harness.processes[0].emitData('\u001b[?2031h\u001b]10;?\u0007\u001b]11;?\u0007');
      expect(harness.processes[0].writes).toEqual(['\u001b]10;rgb:1b1b/1b1b/1b1b\u001b\\', '\u001b]11;rgb:fafa/f8f8/f0f0\u001b\\']);

      const appearance = createResponse();
      harness.routes.post.get('/api/terminal/:sessionId/appearance')({ params: { sessionId: 'term-1' }, body: { themeMode: 'dark' } }, appearance);
      expect(appearance.body).toEqual({ success: true });
      expect(harness.processes[0].writes.at(-1)).toBe('\u001b[?997;1n');

      const resize = createResponse();
      harness.routes.post.get('/api/terminal/:sessionId/resize')({ params: { sessionId: 'term-1' }, body: { cols: 200, rows: 60 } }, resize);
      expect(resize.statusCode).toBe(200);
      expect(harness.processes[0].resizes).toEqual([[200, 60]]);

      const invalid = createResponse();
      harness.routes.post.get('/api/terminal/:sessionId/resize')({ params: { sessionId: 'term-1' }, body: { cols: 1001, rows: 60 } }, invalid);
      expect(invalid.statusCode).toBe(400);
    } finally { await harness.runtime.shutdown(); }
  });

  it('lists available shells and uses the selected shell for create and restart', async () => {
    const executables = new Set(['/bin/zsh', '/bin/bash', '/bin/sh']);
    const harness = createHarness({
      fs: {
        promises: {
          stat: async () => ({ isDirectory: () => true }),
          readFile: async () => '/bin/zsh\n/bin/bash\n/bin/false\n',
        },
      },
      searchPathFor: (name) => executables.has(`/bin/${name}`) ? `/bin/${name}` : null,
      isExecutable: (candidate) => executables.has(candidate),
    });
    try {
      const listed = createResponse();
      await harness.routes.get.get('/api/terminal/shells')({}, listed);
      expect(listed.body).toEqual(expect.arrayContaining([
        { id: 'auto', name: 'Auto', supportsLogin: true },
        { id: 'zsh', name: 'zsh', supportsLogin: true },
        { id: 'bash', name: 'bash', supportsLogin: true },
        { id: 'sh', name: 'sh', supportsLogin: false },
      ]));

      const created = createResponse();
      await harness.routes.post.get('/api/terminal/create')({ body: { sessionId: 'term-shell', cwd: '/repo', shell: 'zsh', loginShell: true } }, created);
      expect(created.statusCode).toBe(200);
      expect(harness.processes[0].shell).toBe('/bin/zsh');
      expect(harness.processes[0].args).toEqual(['-l']);

      const restarted = createResponse();
      await harness.routes.post.get('/api/terminal/:sessionId/restart')({ params: { sessionId: 'term-shell' }, body: { shell: 'bash', loginShell: true } }, restarted);
      expect(restarted.statusCode).toBe(200);
      expect(harness.processes[1].shell).toBe('/bin/bash');
      expect(harness.processes[1].args).toEqual(['-l']);
    } finally { await harness.runtime.shutdown(); }
  });

  it('rejects invalid and unavailable explicit shells', async () => {
    const harness = createHarness({
      fs: {
        promises: {
          stat: async () => ({ isDirectory: () => true }),
          readFile: async () => '/bin/sh\n',
        },
      },
      searchPathFor: (name) => name === 'sh' ? '/bin/sh' : null,
      isExecutable: (candidate) => candidate === '/bin/sh',
    });
    try {
      for (const [shell, error] of [
        ['zsh -c whoami', 'Invalid terminal shell'],
        ['fish', 'Terminal shell "fish" is not available'],
      ]) {
        const response = createResponse();
        await harness.routes.post.get('/api/terminal/create')({ body: { cwd: '/repo', shell } }, response);
        expect(response.statusCode).toBe(400);
        expect(response.body).toEqual({ error });
      }
      expect(harness.processes).toHaveLength(0);
    } finally { await harness.runtime.shutdown(); }
  });

  it('rejects invalid and unsupported login modes', async () => {
    const harness = createHarness({
      fs: {
        promises: {
          stat: async () => ({ isDirectory: () => true }),
          readFile: async () => '/bin/sh\n',
        },
      },
      searchPathFor: (name) => name === 'sh' ? '/bin/sh' : null,
      isExecutable: (candidate) => candidate === '/bin/sh',
    });
    try {
      for (const [loginShell, error] of [
        ['true', 'Invalid terminal login mode'],
        [true, 'Terminal shell "sh" does not support login mode'],
      ]) {
        const response = createResponse();
        await harness.routes.post.get('/api/terminal/create')({ body: { cwd: '/repo', shell: 'sh', loginShell } }, response);
        expect(response.statusCode).toBe(400);
        expect(response.body).toEqual({ error });
      }
      expect(harness.processes).toHaveLength(0);
    } finally { await harness.runtime.shutdown(); }
  });

  it('preserves the running process when a replacement shell is unavailable', async () => {
    const harness = createHarness({
      fs: {
        promises: {
          stat: async () => ({ isDirectory: () => true }),
          readFile: async () => '/bin/sh\n',
        },
      },
      searchPathFor: (name) => name === 'sh' ? '/bin/sh' : null,
      isExecutable: (candidate) => candidate === '/bin/sh',
    });
    try {
      await harness.routes.post.get('/api/terminal/create')({ body: { sessionId: 'term-1', cwd: '/repo', shell: 'sh' } }, createResponse());
      const restarted = createResponse();

      await harness.routes.post.get('/api/terminal/:sessionId/restart')({ params: { sessionId: 'term-1' }, body: { shell: 'fish' } }, restarted);

      expect(restarted.statusCode).toBe(400);
      expect(restarted.body.error).toBe('Terminal shell "fish" is not available');
      expect(harness.processes).toHaveLength(1);
      expect(harness.processes[0].killed).toBe(false);
    } finally { await harness.runtime.shutdown(); }
  });

  it('deduplicates concurrent creates and rejects cross-directory id reuse', async () => {
    const harness = createHarness();
    try {
      const create = harness.routes.post.get('/api/terminal/create');
      const first = createResponse();
      const second = createResponse();
      await Promise.all([
        create({ body: { sessionId: 'term-shared', cwd: '/repo' } }, first),
        create({ body: { sessionId: 'term-shared', cwd: '/repo' } }, second),
      ]);
      expect(harness.processes).toHaveLength(1);
      expect(first.body.sessionId).toBe('term-shared');
      expect(second.body.sessionId).toBe('term-shared');

      const conflicting = createResponse();
      await create({ body: { sessionId: 'term-shared', cwd: '/other' } }, conflicting);
      expect(conflicting.statusCode).toBe(400);
      expect(conflicting.body.error).toBe('Terminal session belongs to a different working directory');
      expect(harness.processes).toHaveLength(1);
    } finally { await harness.runtime.shutdown(); }
  });

  it('rejects concurrent creates with conflicting shell preferences', async () => {
    const harness = createHarness();
    try {
      const create = harness.routes.post.get('/api/terminal/create');
      const first = createResponse();
      const conflicting = createResponse();
      await Promise.all([
        create({ body: { sessionId: 'term-shared', cwd: '/repo', shell: 'auto' } }, first),
        create({ body: { sessionId: 'term-shared', cwd: '/repo', shell: 'zsh' } }, conflicting),
      ]);

      expect(first.statusCode).toBe(200);
      expect(conflicting.statusCode).toBe(400);
      expect(conflicting.body.error).toBe('Terminal session is already being created with a different shell');
      expect(harness.processes).toHaveLength(1);
    } finally { await harness.runtime.shutdown(); }
  });

  it('rejects concurrent creates with conflicting login modes', async () => {
    const harness = createHarness();
    try {
      const create = harness.routes.post.get('/api/terminal/create');
      const first = createResponse();
      const conflicting = createResponse();
      await Promise.all([
        create({ body: { sessionId: 'term-shared', cwd: '/repo', shell: 'auto', loginShell: false } }, first),
        create({ body: { sessionId: 'term-shared', cwd: '/repo', shell: 'auto', loginShell: true } }, conflicting),
      ]);

      expect(first.statusCode).toBe(200);
      expect(conflicting.statusCode).toBe(400);
      expect(conflicting.body.error).toBe('Terminal session is already being created with a different login mode');
      expect(harness.processes).toHaveLength(1);
    } finally { await harness.runtime.shutdown(); }
  });

  it('restarts atomically with the same identity and closes the previous process', async () => {
    const harness = createHarness();
    try {
      await harness.routes.post.get('/api/terminal/create')({ body: { sessionId: 'term-1', cwd: '/repo' } }, createResponse());
      const restarted = createResponse();
      await harness.routes.post.get('/api/terminal/:sessionId/restart')({ params: { sessionId: 'term-1' }, body: { cwd: '/other', cols: 90, rows: 30 } }, restarted);
      expect(restarted.body).toEqual({ sessionId: 'term-1', cols: 90, rows: 30, status: 'running' });
      expect(harness.processes).toHaveLength(2);
      expect(harness.processes[0].killed).toBe(true);
      expect(harness.processes[1].options.cwd).toBe('/other');
    } finally { await harness.runtime.shutdown(); }
  });

  it('serializes concurrent restarts without orphaning replacement processes', async () => {
    const harness = createHarness();
    try {
      const create = harness.routes.post.get('/api/terminal/create');
      const restart = harness.routes.post.get('/api/terminal/:sessionId/restart');
      await create({ body: { sessionId: 'term-1', cwd: '/repo' } }, createResponse());
      const first = createResponse();
      const second = createResponse();

      await Promise.all([
        restart({ params: { sessionId: 'term-1' }, body: { cwd: '/first' } }, first),
        restart({ params: { sessionId: 'term-1' }, body: { cwd: '/second' } }, second),
      ]);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(harness.processes).toHaveLength(3);
      expect(harness.processes[0].killed).toBe(true);
      expect(harness.processes[1].killed).toBe(true);
      expect(harness.processes[2].killed).toBe(false);
      expect(harness.processes[2].options.cwd).toBe('/second');
    } finally { await harness.runtime.shutdown(); }
  });

  it('retains exited sessions until explicit close', async () => {
    const harness = createHarness();
    try {
      await harness.routes.post.get('/api/terminal/create')({ body: { sessionId: 'term-1', cwd: '/repo' } }, createResponse());
      harness.processes[0].emitData('last output');
      harness.processes[0].emitExit(7, 0);
      const resize = createResponse();
      harness.routes.post.get('/api/terminal/:sessionId/resize')({ params: { sessionId: 'term-1' }, body: { cols: 80, rows: 24 } }, resize);
      expect(resize.statusCode).toBe(200);
      const closed = createResponse();
      await harness.routes.delete.get('/api/terminal/:sessionId')({ params: { sessionId: 'term-1' } }, closed);
      expect(closed.body).toEqual({ success: true });
    } finally { await harness.runtime.shutdown(); }
  });

  it('escalates close to SIGKILL when a running process ignores SIGTERM', async () => {
    const harness = createHarness();
    try {
      await harness.routes.post.get('/api/terminal/create')({ body: { sessionId: 'term-1', cwd: '/repo' } }, createResponse());
      await harness.routes.delete.get('/api/terminal/:sessionId')({ params: { sessionId: 'term-1' } }, createResponse());
      expect(harness.processes[0].kills).toEqual(['SIGTERM', 'SIGKILL']);
    } finally { await harness.runtime.shutdown(); }
  });

  it('runs snapshot-first attach, scoped I/O, replay, reconnect, and close over a real websocket', async () => {
    const app = express();
    app.use(express.json());
    const server = http.createServer(app);
    const processes = [];
    const loadPtyProvider = async () => ({
      backend: 'fake-pty',
      spawn: () => {
        const data = new Set();
        const exits = new Set();
        const process = {
          pid: 99123,
          killed: false,
          writes: [],
          write(value) { this.writes.push(value); }, resize() {}, kill() { this.killed = true; },
          onData(handler) { data.add(handler); return { dispose: () => data.delete(handler) }; },
          onExit(handler) { exits.add(handler); return { dispose: () => exits.delete(handler) }; },
          emitData(value) { for (const handler of data) handler(value); },
          emitExit(exitCode) { for (const handler of exits) handler({ exitCode, signal: 0 }); },
        };
        processes.push(process);
        return process;
      },
    });
    const runtime = createRuntime(server, {
      app, loadPtyProvider,
      terminalTerminationGraceMs: 10,
      fs: { promises: { stat: async () => ({ isDirectory: () => true }) } },
      searchPathFor: () => '/bin/sh', isExecutable: () => true,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const socketUrl = `ws://127.0.0.1:${address.port}/api/terminal/ws`;
    const sockets = [];

    const open = async () => {
      const socket = new WebSocket(socketUrl);
      sockets.push(socket);
      const messages = [];
      socket.on('message', (raw) => messages.push(readTerminalWsControlFrame(raw)));
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const next = async (type, sessionId) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const index = messages.findIndex((message) => message?.t === type && (!sessionId || message.s === sessionId));
          if (index >= 0) return messages.splice(index, 1)[0];
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        throw new Error(`Timed out waiting for ${type}`);
      };
      await next('hello');
      return { socket, next, messages };
    };

    try {
      const created = await fetch(`${base}/api/terminal/create`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'term-live', cwd: '/repo', cols: 80, rows: 24 }),
      });
      expect(created.status).toBe(200);
      const secondCreated = await fetch(`${base}/api/terminal/create`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'term-second', cwd: '/other', cols: 80, rows: 24 }),
      });
      expect(secondCreated.status).toBe(200);

      const first = await open();
      first.socket.send(createTerminalWsControlFrame({ t: 'attach', v: 3, s: 'term-live' }));
      first.socket.send(createTerminalWsControlFrame({ t: 'attach', v: 3, s: 'term-second' }));
      expect(await first.next('snapshot', 'term-live')).toMatchObject({ s: 'term-live', q: 0, history: '', status: 'running' });
      expect(await first.next('snapshot', 'term-second')).toMatchObject({ s: 'term-second', q: 0, history: '', status: 'running' });
      first.socket.send(createTerminalWsControlFrame({ t: 'write', v: 3, s: 'term-live', d: 'echo ok\r' }));
      first.socket.send(createTerminalWsControlFrame({ t: 'write', v: 3, s: 'term-second', d: 'pwd\r' }));
      first.socket.send(createTerminalWsControlFrame({ t: 'write', v: 3, s: 'term-live', d: 'echo next\r' }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(processes[0].writes).toEqual(['echo ok\r', 'echo next\r']);
      expect(processes[1].writes).toEqual(['pwd\r']);

      processes[1].emitData('/other\r\n');
      expect(await first.next('output', 'term-second')).toMatchObject({ s: 'term-second', q: 1, d: '/other\r\n' });
      first.socket.send(createTerminalWsControlFrame({ t: 'detach', v: 3, s: 'term-second' }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      processes[1].emitData('detached\r\n');
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(first.messages.some((message) => message?.t === 'output' && message.s === 'term-second')).toBe(false);

      processes[0].emitData('ok\r\n');
      expect(await first.next('output', 'term-live')).toMatchObject({ s: 'term-live', q: 1, d: 'ok\r\n' });
      processes[0].emitData('\u001b[6n');
      expect(await first.next('output', 'term-live')).toMatchObject({ s: 'term-live', q: 2, d: '\u001b[6n', r: '' });
      const secondClosed = await fetch(`${base}/api/terminal/term-second`, { method: 'DELETE' });
      expect(secondClosed.status).toBe(200);
      first.socket.close();

      const second = await open();
      second.socket.send(createTerminalWsControlFrame({ t: 'attach', v: 3, s: 'term-live' }));
      expect(await second.next('snapshot')).toMatchObject({ s: 'term-live', q: 2, history: 'ok\r\n', status: 'running' });
      processes[0].emitExit(7);
      expect(await second.next('exit')).toMatchObject({ s: 'term-live', q: 3, exitCode: 7 });

      const closed = await fetch(`${base}/api/terminal/term-live`, { method: 'DELETE' });
      expect(closed.status).toBe(200);
      expect(await second.next('error')).toMatchObject({ s: 'term-live', code: 'CLOSED', fatal: true });

      await fetch(`${base}/api/terminal/create`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'term-kill', cwd: '/repo' }),
      });
      second.socket.send(createTerminalWsControlFrame({ t: 'attach', v: 3, s: 'term-kill' }));
      await second.next('snapshot');
      const killed = await fetch(`${base}/api/terminal/force-kill`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/repo' }),
      });
      expect(await killed.json()).toEqual({ success: true, killedCount: 1, killedSessionIds: ['term-kill'] });
      expect(await second.next('error')).toMatchObject({ s: 'term-kill', code: 'KILLED', fatal: true });
      expect(processes[2].killed).toBe(true);
    } finally {
      for (const socket of sockets) socket.terminate();
      await runtime.shutdown();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 15_000);
});
