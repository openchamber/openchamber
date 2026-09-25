// Sessions and events of a real space on a real Docker daemon. Runs only with
// OPENCHAMBER_TEST_DOCKER=1. The host of `host.js` is mounted the way `server/index.js` mounts
// it: the dispatcher and the socket forwarder in front of an Express app, the real OpenCode
// proxy with a stand-in for the host's own OpenCode, and the real event hub.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGlobalMessageStreamHub } from '../../event-stream/global-hub.js';
import { registerOpenCodeProxy } from '../../opencode/proxy.js';
import { runCommand } from '../run-command.js';
import { createSpacesHost } from '../host.js';
import { ROLE_SPACE, createSpaceId, hashProjectDirectory, spaceResourceName } from '../labels.js';
import { LIVE_DOCKER_ENABLED, createLiveDockerPlace } from './docker-live-support.js';

const CREATE_TIMEOUT_MS = 25 * 60_000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const until = async (check, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await sleep(50);
  return check();
};
const listen = (app) => new Promise((resolve) => {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const frame = (payload) => Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(payload), 'utf8')]);

describe.skipIf(!LIVE_DOCKER_ENABLED)('sessions and events of a real space: docker (live)', () => {
  const spec = {
    id: createSpaceId(),
    name: 'Sessions live',
    project: hashProjectDirectory('/sessions/live/project'),
    created: new Date().toISOString(),
    memoryBytes: 2 * 1024 * 1024 * 1024,
  };
  const repo = `/spaces/${spec.id}/repo`;
  const hostSession = { id: 'ses_host_1', location: { directory: '/home/me/project' }, title: 'Host session' };
  let place;
  let dispose = async () => {};
  let dataDir;
  let host;
  let hub;
  let upstream;
  let server;
  let hostRouteRuns = 0;
  const received = [];
  const url = (suffix) => `http://127.0.0.1:${server.address().port}${suffix}`;
  const wsUrl = (suffix) => `ws://127.0.0.1:${server.address().port}${suffix}`;
  const shell = async (script) => {
    const result = await place.exec(spec.id, ['sh', '-c', script]);
    expect(result.code, `${script}: ${result.stderr}`).toBe(0);
    return result.stdout;
  };

  beforeAll(async () => {
    ({ place, dispose } = createLiveDockerPlace());
    await place.create(spec);
    await shell(`mkdir -p ${repo} && cd ${repo} && git init -q . && git -c user.email=space@example.invalid -c user.name=Space commit -q --allow-empty -m init`);
    dataDir = temporary('openchamber-sessions-live-');
    host = createSpacesHost({ dataDir, place, logger: { warn: () => {} } });

    // The host's own OpenCode: one session, an event stream that stays open.
    const upstreamApp = express();
    upstreamApp.get('/api/session', (_req, res) => res.json({ data: [hostSession], cursor: {} }));
    upstreamApp.get('/api/event', (_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({ id: 'host-e1', type: 'server.connected', data: {} })}\n\n`);
    });
    upstream = await listen(upstreamApp);
    const upstreamPort = upstream.address().port;
    hub = createGlobalMessageStreamHub({ buildOpenCodeUrl: (p) => `http://127.0.0.1:${upstreamPort}${p}`, getOpenCodeAuthHeaders: () => ({}), deltaCoalesceWindowMs: 0 });
    hub.subscribeEvent((event) => received.push(event), { spaces: true });

    const app = express();
    app.use(host.middleware);
    app.all('/api/git/status', (req, res) => { hostRouteRuns += 1; res.json({ ranOnHost: true, directory: req.query.directory ?? null }); });
    registerOpenCodeProxy(app, {
      fs: {}, os: {}, path, OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({ openCodePort: upstreamPort, isOpenCodeReady: true, openCodeNotReadySince: 0, isRestartingOpenCode: false }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (p) => `http://127.0.0.1:${upstreamPort}${p}`,
      ensureOpenCodeApiPrefix: () => {},
      mergeSpaceSessionList: (payload) => host.mergeSessionList(payload),
      spaceEventHub: hub,
    });
    server = await listen(app);
    host.prepareUpgrades({ uiAuthController: { enabled: false }, isRequestOriginAllowed: async () => true });
    server.on('upgrade', host.upgradeHandler);
    await host.startEvents(hub);
  }, CREATE_TIMEOUT_MS);

  afterAll(async () => {
    host?.close();
    hub?.stop();
    for (const running of [server, upstream]) {
      await new Promise((resolve) => { if (running) { running.closeAllConnections?.(); running.close(() => resolve()); } else resolve(); });
    }
    await dispose();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('runs a command inside as uid 1000 over the terminal socket under the prefix', async () => {
    const created = await fetch(url(`/api/spaces/${spec.id}/terminal/create`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: repo, cols: 80, rows: 24 }) });
    expect(created.status, await created.clone().text()).toBe(200);
    const { sessionId } = await created.json();
    const socket = new WebSocket(wsUrl(`/api/spaces/${spec.id}/terminal/ws`), { headers: { origin: 'http://app.test' } });
    let output = '';
    let backend = null;
    const done = new Promise((resolve, reject) => {
      socket.on('error', reject);
      socket.on('open', () => socket.send(frame({ t: 'attach', v: 3, s: sessionId })));
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.subarray(1).toString('utf8'));
        if (message.t === 'snapshot') {
          backend = message.ptyBackend;
          socket.send(frame({ t: 'write', v: 3, s: sessionId, d: 'echo space-$((40+2)); id -u\r' }));
        }
        if (message.t === 'output') output += message.d;
        if (/space-42[\s\S]*\n1000\r?\n/.test(output)) resolve();
      });
      setTimeout(() => reject(new Error(`no answer from the terminal in time; output so far: ${output}`)), 30_000).unref();
    });
    await done;
    expect(backend).toBe('node-pty');
    expect(output).toMatch(/space-42\r?\n1000\r?\n/);
    socket.close();
    expect((await fetch(url(`/api/spaces/${spec.id}/terminal/${sessionId}`), { method: 'DELETE' })).status).toBe(200);
  }, 90_000);

  it('lists a session of the space in the merged list with its directory, and carries its events to the host\'s streams', async () => {
    const controller = new AbortController();
    const sse = await fetch(url('/api/global/event'), { headers: { accept: 'text/event-stream' }, signal: controller.signal });
    expect(sse.status).toBe(200);
    const reader = sse.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readInBackground = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    })().catch(() => {});
    expect(await until(() => text.includes('host-e1'))).toBe(true);
    // The space's stream is connected before its events can be trusted to arrive.
    expect(await until(() => received.some((event) => event.payload.type === 'openchamber:space-stream' && event.payload.properties.status === 'connected'), 30_000)).toBe(true);

    const created = await fetch(url(`/api/spaces/${spec.id}/session`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ location: { directory: repo }, title: 'Inside the space' }) });
    expect(created.status, await created.clone().text()).toBe(200);
    const session = (await created.json()).data;
    expect(session.location.directory).toBe(repo);

    const merged = await (await fetch(url('/api/session'))).json();
    const ids = merged.data.map((entry) => entry.id);
    expect(ids).toContain(hostSession.id);
    expect(ids).toContain(session.id);
    expect(merged.data.find((entry) => entry.id === session.id).location.directory).toBe(repo);
    expect(merged.spaces).toEqual([{ id: spec.id, state: 'complete', sessions: expect.any(Number) }]);

    expect(await until(() => received.some((event) => event.spaceId === spec.id && event.payload.type === 'session.created' && event.payload.data?.sessionID === session.id), 30_000)).toBe(true);
    expect(await until(() => text.includes(session.id), 30_000)).toBe(true);
    controller.abort();
    await readInBackground;
  }, 120_000);

  it('keeps a stopped space\'s last list as stale, and the host\'s list whole', async () => {
    await place.stop(spec.id);
    // The last accepted list is served for two seconds without asking; after that the space is asked and does not answer.
    await sleep(2_100);
    const merged = await (await fetch(url('/api/session'))).json();
    expect(merged.data.map((entry) => entry.id)).toContain(hostSession.id);
    expect(merged.spaces).toEqual([{ id: spec.id, state: 'stale', sessions: expect.any(Number) }]);
    expect(merged.spaces[0].sessions).toBeGreaterThan(0);
    const socket = await new Promise((resolve) => {
      const attempt = new WebSocket(wsUrl(`/api/spaces/${spec.id}/terminal/ws`), { headers: { origin: 'http://app.test' } });
      attempt.on('unexpected-response', (_request, response) => resolve({ status: response.statusCode }));
      attempt.on('error', () => {});
    });
    expect(socket.status).toBe(503);

    await place.start(spec.id);
    expect(await until(async () => (await (await fetch(url('/api/session'))).json()).spaces[0].state === 'complete', 60_000)).toBe(true);
  }, 5 * 60_000);

  // The check of the 4b row in STAGES.md: the space killed in the middle of its work.
  it('leaves the host\'s sessions and routes untouched when the space is killed under an open socket', async () => {
    const created = await fetch(url(`/api/spaces/${spec.id}/terminal/create`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: repo, cols: 80, rows: 24 }) });
    expect(created.status).toBe(200);
    const { sessionId } = await created.json();
    const socket = new WebSocket(wsUrl(`/api/spaces/${spec.id}/terminal/ws`), { headers: { origin: 'http://app.test' } });
    await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject); });
    socket.send(frame({ t: 'attach', v: 3, s: sessionId }));
    socket.send(frame({ t: 'write', v: 3, s: sessionId, d: 'sleep 600\r' }));
    const closed = new Promise((resolve) => socket.on('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') })));

    const kill = await runCommand('docker', ['kill', spaceResourceName(spec.id, ROLE_SPACE)]);
    expect(kill.code, kill.stderr).toBe(0);
    expect(await closed).toMatchObject({ code: expect.any(Number) });
    await sleep(2_100);

    const merged = await (await fetch(url('/api/session'))).json();
    expect(merged.data.map((entry) => entry.id)).toContain(hostSession.id);
    expect(merged.spaces[0]).toMatchObject({ id: spec.id, state: 'stale' });
    const ordinary = await fetch(url('/api/git/status?directory=/tmp'));
    expect(ordinary.status).toBe(200);
    expect(hostRouteRuns).toBe(1);
    // The host's own stream is still the host's: no space event of the dead space is invented.
    expect(received.filter((event) => event.spaceId === spec.id && event.payload.type === 'openchamber:space-stream').at(-1).payload.properties.status).toBe('disconnected');
  }, 120_000);
});

const temporary = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
