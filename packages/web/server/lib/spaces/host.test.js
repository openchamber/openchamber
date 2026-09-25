// The host of the feature: what `server/index.js` builds when the switch is on.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createSpacesHost, readOrCreateOwner } from './host.js';
import { hashProjectDirectory } from './labels.js';
import { createMemoryPlace } from './places/memory-place.js';

const folders = [];
const servers = [];
const hosts = [];
const temporary = () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-spaces-host-test-'));
  folders.push(folder);
  return folder;
};

afterEach(async () => {
  for (const host of hosts.splice(0)) host.close();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(() => resolve()));
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

describe('readOrCreateOwner', () => {
  it('makes a random owner once, readable by the user only, and keeps it', () => {
    const dataDir = temporary();
    const owner = readOrCreateOwner(dataDir);
    expect(owner).toMatch(/^[0-9a-f]{24}$/);
    expect(readOrCreateOwner(dataDir)).toBe(owner);
    const file = path.join(dataDir, 'spaces', 'owner');
    expect(fs.readFileSync(file, 'utf8')).toBe(`${owner}\n`);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('replaces a file that does not hold an owner', () => {
    const dataDir = temporary();
    fs.mkdirSync(path.join(dataDir, 'spaces'));
    fs.writeFileSync(path.join(dataDir, 'spaces', 'owner'), 'not an owner\n');
    expect(readOrCreateOwner(dataDir)).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe('createSpacesHost', () => {
  it('starts no process of its own when it is made, and answers through the place it was given', async () => {
    let started = 0;
    const place = createMemoryPlace();
    const host = createSpacesHost({
      dataDir: temporary(),
      place,
      runCommand: async () => { started += 1; throw new Error('no process here'); },
      openCommandStream: () => { started += 1; throw new Error('no process here'); },
      logger: { warn: () => {} },
    });
    hosts.push(host);
    const { id } = await host.manager.createSpace({ placeId: 'memory', projectDirectory: '/home/me/project', name: 'Host test' });

    const app = express();
    host.registerRoutes(app);
    app.get('/api/host', (req, res) => res.json({ directory: req.query.directory ?? null }));
    const server = http.createServer(app);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = (suffix) => `http://127.0.0.1:${server.address().port}${suffix}`;

    // The memory place has no token file to read, so the login step stops there: what this
    // shows is the wiring, from the prefix through the manager's list to the space's channel.
    const forwarded = await fetch(url(`/api/spaces/${id}/health`));
    expect(forwarded.status).toBe(502);
    expect(await forwarded.json()).toMatchObject({ code: 'space_setup_failed' });
    const unknown = await fetch(url('/api/spaces/0f0f0f0f0f0f/health'));
    expect(unknown.status).toBe(404);
    const guarded = await fetch(url(`/api/host?directory=/spaces/${id}/repo`));
    expect(guarded.status).toBe(400);
    expect((await fetch(url('/api/host?directory=/home/me'))).status).toBe(200);

    expect(host.skipsBodyParsing({ path: `/api/spaces/${id}/fs/raw` })).toBe(true);
    expect(host.skipsBodyParsing({ path: '/api/fs/raw' })).toBe(false);
    expect(host.refuseDirectory(`/spaces/${id}/repo`)).toMatch(/isolated space/);
    expect(host.refuseDirectory('/home/me/spaces')).toBeNull();
    expect(started).toBe(0);
    await place.remove(id);
  });
});

// A stand-in place whose spaces are Express apps with the host's real UI auth: the merged
// session list, the event connections and the socket forwarding, wired the way `index.js` wires them.
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import { SpaceError } from './errors.js';
import { IMAGE_CAT } from './layout.js';

const TOKEN = 'tok_' + 'a'.repeat(40);
const ID = 'a1b2c3d4e5f6';
const OTHER = '0f0f0f0f0f0f';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const until = async (check, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await sleep(10);
  return check();
};

/** One space's server: the sessions it lists, in pages of two, an event stream, and an echo socket. */
const startSpaceServer = async ({ sessions, status = {} }) => {
  const { createUiAuth } = await import('../ui-auth/ui-auth.js');
  const auth = createUiAuth({ password: TOKEN, readSettingsFromDiskMigrated: async () => ({}) });
  const state = { eventStreams: [], sessions, listRequests: 0 };
  const app = express();
  app.post('/auth/session', express.json(), auth.handleSessionCreate);
  app.use('/api', auth.requireAuth);
  app.get('/api/session', (req, res) => {
    state.listRequests += 1;
    const start = Number.parseInt(req.query.cursor ?? '0', 10);
    const page = state.sessions.slice(start, start + 2);
    res.json({ data: page, cursor: { next: start + 2 < state.sessions.length ? String(start + 2) : undefined } });
  });
  app.get('/api/sessions/status', (_req, res) => res.json({ sessions: status }));
  app.get('/api/event', (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.flushHeaders();
    res.write(':ready\n\n');
    state.eventStreams.push(res);
    req.on('close', () => { state.eventStreams.splice(state.eventStreams.indexOf(res), 1); });
  });
  const server = http.createServer(app);
  const wsServer = new WebSocketServer({ noServer: true });
  wsServer.on('connection', (socket) => { socket.on('message', (data) => socket.send(`echo:${data}`)); });
  server.on('upgrade', (req, socket, head) => {
    void auth.ensureSessionToken(req, null).then((token) => {
      if (!token || new URL(req.headers.origin ?? 'http://x').host !== req.headers.host) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); socket.destroy(); return; }
      wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { port: server.address().port, state, wsServer, server };
};

const fakePlace = (spaces) => ({
  id: 'fake',
  check: async () => ({ available: true }),
  create: async () => {},
  list: async () => Array.from(spaces.entries(), ([id, space]) => ({ id, name: id, project: space.project ?? 'p', created: '', state: space.running ? 'running' : 'exited', orphans: [], damaged: false, missing: [] })),
  exec: async (_spaceId, argv) => (argv[0] === IMAGE_CAT ? { code: 0, stdout: `${TOKEN}\n`, stderr: '' } : { code: 127, stdout: '', stderr: 'not found' }),
  execArgv: async () => [],
  connect: async (spaceId) => {
    const space = spaces.get(spaceId);
    if (!space) throw new SpaceError('space_not_found', 'gone');
    if (!space.running) throw new SpaceError('space_not_running', `Space ${spaceId} is stopped`);
    return net.connect({ host: '127.0.0.1', port: space.port });
  },
  stop: async (spaceId) => { spaces.get(spaceId).running = false; },
  start: async (spaceId) => { spaces.get(spaceId).running = true; },
  remove: async (spaceId) => { spaces.delete(spaceId); return { removed: [], failed: [] }; },
  verify: async () => [],
});

describe('createSpacesHost: sessions and events', () => {
  const logs = [];
  const logger = { warn: (line) => logs.push(line) };
  afterEach(() => { logs.length = 0; });

  it('merges every reachable space\'s sessions after the host\'s, drops what a space may not claim, and keeps a stopped space\'s last list as stale', async () => {
    const first = await startSpaceServer({ sessions: [
      { id: 'a1', location: { directory: `/spaces/${ID}/repo` }, title: 'one', permissions: { x: 1 } },
      { id: 'a2', location: { directory: `/spaces/${ID}/repo/sub` }, title: 'two' },
      { id: 'a3', location: { directory: `/spaces/${ID}` }, title: 'three' },
      { id: 'host-1', location: { directory: `/spaces/${ID}/repo` }, title: 'a host session, claimed' },
      { id: 'a4', location: { directory: '/home/me/project' }, title: 'outside' },
    ] });
    // Two spaces that list the same id are read at the same time, so which one keeps it is not
    // fixed; that rule is proved in `space-sessions.test.js`, and here the two lists are apart.
    const second = await startSpaceServer({ sessions: [{ id: 'b1', location: { directory: `/spaces/${OTHER}/repo` } }] });
    // The first space was made for a registered project, the second for one this host no longer has.
    const spaces = new Map([[ID, { port: first.port, running: true, project: hashProjectDirectory('/home/me/project') }], [OTHER, { port: second.port, running: true }]]);
    const host = createSpacesHost({ dataDir: temporary(), place: fakePlace(spaces), logger, setTimer: () => null, clearTimer: () => {}, listProjectDirectories: async () => ['/home/me/project', '/home/me/other'] });
    hosts.push(host);
    const hostList = { data: [{ id: 'host-1', location: { directory: '/home/me' } }], cursor: {} };
    const first_mark = { id: ID, name: ID, state: 'complete', sessions: 3, projectDirectory: '/home/me/project', directory: `/spaces/${ID}/project` };
    const other_mark = (state, sessions) => ({ id: OTHER, name: OTHER, state, sessions, projectDirectory: null, directory: null });

    const merged = await host.mergeSessionList(hostList);
    expect(merged.data.map((item) => item.id)).toEqual(['host-1', 'a1', 'a2', 'a3', 'b1']);
    // Within two seconds a second merge serves the accepted lists without asking the spaces again.
    const pagesRead = first.state.listRequests;
    expect(pagesRead).toBe(3);
    expect((await host.mergeSessionList(hostList)).data.map((item) => item.id)).toEqual(['host-1', 'a1', 'a2', 'a3', 'b1']);
    expect(first.state.listRequests).toBe(pagesRead);
    await sleep(2_100);
    expect(merged.data[1]).not.toHaveProperty('permissions');
    expect(merged.spaces).toEqual([first_mark, other_mark('complete', 1)]);
    expect(logs.join('\n')).toContain('space_session_host_id');
    expect(logs.join('\n')).toContain('space_session_outside_root');
    expect(logs.join('\n')).not.toContain('a host session, claimed');

    // A stopped space takes the pooled streams with it: the stand-in drops its connections too.
    await host.manager.stopSpace({ placeId: 'fake', spaceId: OTHER });
    second.server.closeAllConnections();
    second.state.sessions.length = 0;
    const stale = await host.mergeSessionList(hostList);
    expect(stale.data.map((item) => item.id)).toEqual(['host-1', 'a1', 'a2', 'a3', 'b1']);
    expect(stale.spaces).toEqual([first_mark, other_mark('stale', 1)]);
    expect(logs.join('\n')).toContain(`the session list of space ${OTHER} did not come`);

    // Back, and empty: an empty answer is an answer.
    await host.manager.startSpace({ placeId: 'fake', spaceId: OTHER });
    const empty = await host.mergeSessionList(hostList);
    expect(empty.spaces[1]).toEqual(other_mark('complete', 0));

    // A space that is gone is not listed; a host without spaces answers with the very same object.
    spaces.clear();
    await sleep(2_100);
    expect(await host.mergeSessionList(hostList)).toBe(hostList);
  }, 10_000);

  it('follows the spaces into the hub: their events arrive marked, the host\'s ids are learned from the hub, and sockets are forwarded', async () => {
    const space = await startSpaceServer({ sessions: [], status: { busy1: { status: 'busy' } } });
    const spaces = new Map([[ID, { port: space.port, running: true }]]);
    const host = createSpacesHost({ dataDir: temporary(), place: fakePlace(spaces), logger, setTimer: () => null, clearTimer: () => {} });
    hosts.push(host);
    const hub = createGlobalMessageStreamHub({ buildOpenCodeUrl: (p) => `http://127.0.0.1:1${p}`, getOpenCodeAuthHeaders: () => ({}), deltaCoalesceWindowMs: 0, fetchImpl: async () => { throw new Error('no host upstream here'); } });
    const received = [];
    hub.subscribeEvent((event) => received.push(event), { spaces: true });
    await host.startEvents(hub);
    expect(await until(() => space.state.eventStreams.length === 1)).toBe(true);
    expect(await until(() => received.some((event) => event.payload.type === 'session.status' && event.payload.data.sessionID === 'busy1'))).toBe(true);

    hub.injectEvent({ payload: { type: 'session.created', data: { sessionID: 'host-new' } }, directory: '/home/me', spaceId: null });
    space.state.eventStreams[0].write(`data: ${JSON.stringify({ id: 'e1', type: 'session.execution.started', data: { sessionID: 'host-new' } })}\n\n`);
    space.state.eventStreams[0].write(`data: ${JSON.stringify({ id: 'e2', type: 'session.execution.started', data: { sessionID: 'mine' }, location: { directory: `/spaces/${ID}/repo` } })}\n\n`);
    expect(await until(() => received.some((event) => event.payload.id === 'e2'))).toBe(true);
    expect(received.find((event) => event.payload.id === 'e2')).toMatchObject({ spaceId: ID, directory: `/spaces/${ID}/repo` });
    expect(received.some((event) => event.payload.id === 'e1')).toBe(false);
    expect(logs.join('\n')).toContain('space_event_host_session');

    const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
    servers.push(server);
    host.attachUpgrades(server, { uiAuthController: { enabled: false }, isRequestOriginAllowed: async () => true });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/spaces/${ID}/terminal/ws`, { headers: { origin: 'http://app.test' } });
    const echoed = await new Promise((resolve, reject) => {
      socket.on('open', () => socket.send('hi'));
      socket.on('message', (data) => resolve(data.toString('utf8')));
      socket.on('error', reject);
    });
    expect(echoed).toBe('echo:hi');
    socket.close();
    host.close();
    expect(await until(() => space.state.eventStreams.length === 0)).toBe(true);
    space.wsServer.close();
  });
});
