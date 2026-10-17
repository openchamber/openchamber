// The event connection of a space against a stand-in for the server inside, and the real hub.

import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import { SpaceError } from './errors.js';
import { RECONNECT_CAP_MS, createSpaceEventSources, reconnectDelayAfter } from './space-events.js';
import { createSpaceSessionIndex } from './space-sessions.js';

const ID = 'a1b2c3d4e5f6';
const OTHER = '0f0f0f0f0f0f';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const until = async (check, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await sleep(10);
  return check();
};

/** A response of the server inside: an SSE stream that the test writes to, or a JSON answer. */
const sseResponse = () => {
  const stream = new PassThrough();
  stream.statusCode = 200;
  stream.headers = { 'content-type': 'text/event-stream' };
  return stream;
};
const jsonResponse = (status, body) => {
  const stream = new PassThrough();
  stream.statusCode = status;
  stream.headers = { 'content-type': 'application/json' };
  stream.end(JSON.stringify(body));
  return stream;
};

const makeHub = () => createGlobalMessageStreamHub({
  buildOpenCodeUrl: (path) => `http://127.0.0.1:1${path}`,
  getOpenCodeAuthHeaders: () => ({}),
  deltaCoalesceWindowMs: 0,
  fetchImpl: async () => { throw new Error('the host upstream is not part of this test'); },
});

describe('reconnectDelayAfter', () => {
  it('doubles from one second and stops at a minute', () => {
    expect([0, 1, 2, 3, 4].map(reconnectDelayAfter)).toEqual([1_000, 1_000, 2_000, 4_000, 8_000]);
    expect(reconnectDelayAfter(20)).toBe(RECONNECT_CAP_MS);
  });
});

describe('createSpaceEventSources', () => {
  const streams = { [ID]: [], [OTHER]: [] };
  const requests = [];
  let status = { sessions: {} };
  let refuse = null;
  const requestInside = async (spaceId, request) => {
    requests.push({ spaceId, path: request.path, headers: request.headers });
    if (refuse) throw refuse;
    if (request.path === '/api/sessions/status') return jsonResponse(200, status);
    const stream = sseResponse();
    streams[spaceId].push(stream);
    return stream;
  };
  const logs = [];
  const logger = { warn: (line) => logs.push(line) };
  let hub;
  let index;
  let sources;
  let received;

  const start = () => {
    hub = makeHub();
    index = createSpaceSessionIndex({ logger });
    received = [];
    hub.subscribeEvent((event) => received.push(event), { spaces: true });
    sources = createSpaceEventSources({ requestInside, index, hub, logger, stallTimeoutMs: 0 });
  };

  afterEach(() => {
    sources?.close();
    streams[ID].length = 0;
    streams[OTHER].length = 0;
    requests.length = 0;
    logs.length = 0;
    status = { sessions: {} };
    refuse = null;
  });

  it('opens one connection per space, announces it, seeds the live status, and enters the events with the space id', async () => {
    start();
    status = { sessions: { busy1: { status: 'busy' }, idle1: { status: 'idle' }, odd: { status: 'retry' } } };
    sources.sync([ID]);
    expect(await until(() => streams[ID].length === 1)).toBe(true);
    expect(requests[0]).toMatchObject({ spaceId: ID, path: '/api/event', headers: expect.objectContaining({ Accept: 'text/event-stream' }) });
    expect(await until(() => received.length >= 3)).toBe(true);
    expect(received[0].payload).toMatchObject({ type: 'openchamber:space-stream', properties: { spaceId: ID, status: 'connected', wasReady: false } });
    expect(received.slice(1).map((event) => [event.payload.type, event.payload.data.sessionID, event.payload.data.status.type])).toEqual([
      ['session.status', 'busy1', 'busy'],
      ['session.status', 'idle1', 'idle'],
    ]);

    streams[ID][0].write(`data: ${JSON.stringify({ id: 'e1', type: 'session.execution.started', data: { sessionID: 's1' }, location: { directory: `/spaces/${ID}/repo` } })}\n\n`);
    expect(await until(() => received.length === 4)).toBe(true);
    expect(received[3]).toMatchObject({ spaceId: ID, directory: `/spaces/${ID}/repo`, payload: { id: 'e1' } });
    expect(received[3].translated()).toEqual([expect.objectContaining({ type: 'session.status', properties: expect.objectContaining({ sessionID: 's1', directory: `/spaces/${ID}/repo` }) })]);
    expect(sources.has(ID)).toBe(true);
  });

  it('drops an event that claims a directory outside the space or a session of the host', async () => {
    start();
    index.observeHostRecords([{ id: 'host-1' }]);
    sources.sync([ID]);
    expect(await until(() => streams[ID].length === 1)).toBe(true);
    const stream = streams[ID][0];
    const write = (payload) => stream.write(`data: ${JSON.stringify(payload)}\n\n`);
    write({ id: 'bad1', type: 'session.execution.started', data: { sessionID: 's1' }, location: { directory: '/home/me/project' } });
    write({ id: 'bad2', type: 'session.created', data: { sessionID: 's2', location: { directory: `/spaces/${OTHER}/repo` } }, location: { directory: `/spaces/${ID}/repo` } });
    write({ id: 'bad3', type: 'session.execution.started', data: { sessionID: 'host-1' } });
    write({ id: 'good', type: 'session.execution.started', data: { sessionID: 's1' } });
    expect(await until(() => received.some((event) => event.payload.id === 'good'))).toBe(true);
    expect(received.map((event) => event.payload.id).filter((id) => id?.startsWith('bad'))).toEqual([]);
    expect(logs.filter((line) => line.includes('dropped an event'))).toHaveLength(3);
    expect(logs.join('\n')).not.toContain('/home/me/project');
  });

  it('reconnects with backoff after the stream inside ends, announces the gap, and stops for a space that is gone', async () => {
    start();
    sources.sync([ID, OTHER]);
    expect(await until(() => streams[ID].length === 1 && streams[OTHER].length === 1)).toBe(true);
    expect(await until(() => received.filter((event) => event.payload.type === 'openchamber:space-stream').length === 2)).toBe(true);
    streams[ID][0].end();
    expect(await until(() => received.some((event) => event.payload.properties?.status === 'disconnected' && event.payload.properties?.spaceId === ID))).toBe(true);
    // The first attempt after the gap waits a second, so it is not there at once.
    await sleep(300);
    expect(streams[ID]).toHaveLength(1);
    expect(await until(() => streams[ID].length === 2, 3_000)).toBe(true);
    expect(received.filter((event) => event.payload.properties?.spaceId === ID && event.payload.properties?.status === 'connected').at(-1).payload.properties.wasReady).toBe(true);
    // A second drop in a row waits two seconds, not four: one failure is counted once.
    const secondDropAt = Date.now();
    streams[ID][1].end();
    expect(await until(() => streams[ID].length === 3, 3_500)).toBe(true);
    expect(Date.now() - secondDropAt).toBeLessThan(3_000);

    index.acceptSpaceList(OTHER, [{ id: 'o1', location: { directory: `/spaces/${OTHER}/repo` } }], { complete: true });
    sources.sync([ID]);
    expect(sources.has(OTHER)).toBe(false);
    expect(index.snapshot().map((entry) => entry.spaceId)).toEqual([]);
    expect(streams[OTHER][0].destroyed).toBe(true);
  }, 15_000);

  it('keeps a paused space with its index and makes no connection to it until it is let go again', async () => {
    start();
    index.acceptSpaceList(ID, [{ id: 'p1', location: { directory: `/spaces/${ID}/repo` } }], { complete: true });
    sources.sync([ID], { paused: new Set([ID]) });
    await sleep(300);
    expect(requests).toEqual([]);
    expect(sources.has(ID)).toBe(false);
    expect(index.snapshot().map((entry) => entry.spaceId)).toEqual([ID]);
    // Connected, then paused: the connection goes and the index stays.
    sources.sync([ID]);
    expect(await until(() => streams[ID]?.length === 1)).toBe(true);
    sources.sync([ID], { paused: new Set([ID]) });
    expect(await until(() => streams[ID][0].destroyed)).toBe(true);
    expect(sources.has(ID)).toBe(false);
    expect(index.snapshot().map((entry) => entry.spaceId)).toEqual([ID]);
  });

  it('keeps trying, quietly, while the space refuses the connection', async () => {
    start();
    refuse = new SpaceError('space_not_running', 'stopped');
    sources.sync([ID]);
    expect(await until(() => requests.length >= 1)).toBe(true);
    await sleep(200);
    expect(received).toEqual([]);
    expect(requests.length).toBeLessThanOrEqual(2);
    expect(logs.some((line) => line.includes(`event stream of space ${ID}`))).toBe(true);
  });
});

describe('createSpaceEventSources: the queue connection', () => {
  const streams = [];
  const requestInside = async (spaceId, request) => {
    if (request.path === '/api/sessions/status') return jsonResponse(200, { sessions: {} });
    const stream = sseResponse();
    streams.push({ spaceId, path: request.path, stream });
    return stream;
  };
  const logs = [];
  const logger = { warn: (line) => logs.push(line) };
  let index;
  let sources;
  let broadcast;

  const start = () => {
    index = createSpaceSessionIndex({ logger });
    broadcast = [];
    sources = createSpaceEventSources({ requestInside, index, hub: makeHub(), broadcastUiEvent: (event) => broadcast.push(event), logger, stallTimeoutMs: 0 });
  };
  const controlStream = () => streams.find((entry) => entry.spaceId === ID && entry.path === '/api/openchamber/events')?.stream;
  const queueUpdate = (sessionId, directory, extra = {}) => ({
    type: 'openchamber:message-queue.updated',
    properties: { revision: 3, session: { sessionId, directory, items: [{ id: 'q1', content: 'next' }], sendingId: null, ...extra } },
  });

  afterEach(() => {
    sources?.close();
    streams.length = 0;
    logs.length = 0;
  });

  it('announces the connection and forwards a queue change of the space, marked with its id', async () => {
    start();
    sources.sync([ID]);
    expect(await until(() => Boolean(controlStream()))).toBe(true);
    expect(await until(() => broadcast.length === 1)).toBe(true);
    expect(broadcast[0]).toEqual({ type: 'openchamber:space-queue-stream', properties: { spaceId: ID, status: 'connected' } });

    controlStream().write(`data: ${JSON.stringify(queueUpdate('s1', `/spaces/${ID}/repo`, { injected: 'x' }))}\n\n`);
    expect(await until(() => broadcast.length === 2)).toBe(true);
    expect(broadcast[1]).toEqual({
      type: 'openchamber:message-queue.updated',
      properties: { revision: 3, session: { sessionId: 's1', directory: `/spaces/${ID}/repo`, items: [{ id: 'q1', content: 'next' }], sendingId: null }, spaceId: ID },
    });
  });

  it('drops a change for a directory outside the space, a session of the host or of another space, and every other event', async () => {
    start();
    index.observeHostRecords([{ id: 'host-1' }]);
    index.acceptSpaceList(OTHER, [{ id: 'other-1', location: { directory: `/spaces/${OTHER}/repo` } }], { complete: true });
    sources.sync([ID]);
    expect(await until(() => Boolean(controlStream()))).toBe(true);
    const write = (payload) => controlStream().write(`data: ${JSON.stringify(payload)}\n\n`);
    write(queueUpdate('s1', '/home/me/project'));
    write(queueUpdate('s2', `/spaces/${OTHER}/repo`));
    write(queueUpdate('host-1', `/spaces/${ID}/repo`));
    write(queueUpdate('other-1', `/spaces/${ID}/repo`));
    write({ type: 'openchamber:notification', properties: { title: 'from inside' } });
    write(queueUpdate('good', `/spaces/${ID}/repo`));
    expect(await until(() => broadcast.some((event) => event.properties.session?.sessionId === 'good'))).toBe(true);
    expect(broadcast.map((event) => event.type === 'openchamber:message-queue.updated' ? event.properties.session.sessionId : event.type))
      .toEqual(['openchamber:space-queue-stream', 'good']);
    expect(logs.filter((line) => line.includes('dropped a queue update'))).toHaveLength(4);
    expect(logs.join('\n')).not.toContain('/home/me/project');
  });

  it('keeps a quiet connection that hears the heartbeat, and remakes one that falls silent past its timeout', async () => {
    index = createSpaceSessionIndex({ logger });
    broadcast = [];
    sources = createSpaceEventSources({ requestInside, index, hub: makeHub(), broadcastUiEvent: (event) => broadcast.push(event), logger, stallTimeoutMs: 0, stateStallTimeoutMs: 400 });
    sources.sync([ID]);
    expect(await until(() => Boolean(controlStream()))).toBe(true);
    const first = controlStream();
    for (let beat = 0; beat < 8; beat += 1) {
      first.write(`data: ${JSON.stringify({ type: 'openchamber:heartbeat', properties: { timestamp: beat } })}\n\n`);
      await sleep(150);
    }
    const controlCount = () => streams.filter((entry) => entry.path === '/api/openchamber/events').length;
    expect(controlCount()).toBe(1);
    expect(broadcast.filter((event) => event.type === 'openchamber:space-queue-stream')).toHaveLength(1);
    // Silent past the timeout: the reader gives up and, after its first backoff of a second, connects again.
    expect(await until(() => controlCount() === 2, 3_000)).toBe(true);
  });

  it('makes no queue connection without the control stream, and ends it with the space', async () => {
    index = createSpaceSessionIndex({ logger });
    sources = createSpaceEventSources({ requestInside, index, hub: makeHub(), logger, stallTimeoutMs: 0 });
    sources.sync([ID]);
    expect(await until(() => streams.length === 1)).toBe(true);
    await sleep(100);
    expect(streams.map((entry) => entry.path)).toEqual(['/api/event']);
    sources.close();

    start();
    sources.sync([ID]);
    expect(await until(() => Boolean(controlStream()))).toBe(true);
    sources.sync([]);
    expect(await until(() => controlStream().destroyed)).toBe(true);
  });
});

describe('createSpaceEventSources: the permission connection', () => {
  const streams = [];
  const requestInside = async (spaceId, request) => {
    if (request.path === '/api/sessions/status') return jsonResponse(200, { sessions: {} });
    const stream = sseResponse();
    streams.push({ spaceId, path: request.path, stream });
    return stream;
  };
  const logs = [];
  const logger = { warn: (line) => logs.push(line) };
  let index;
  let sources;
  let broadcast;

  const start = () => {
    index = createSpaceSessionIndex({ logger });
    broadcast = [];
    sources = createSpaceEventSources({ requestInside, index, hub: makeHub(), broadcastGlobalUiEvent: (event) => broadcast.push(event), logger, stallTimeoutMs: 0 });
  };
  const notificationStream = () => streams.find((entry) => entry.spaceId === ID && entry.path === '/api/notifications/stream')?.stream;
  const write = (payload) => notificationStream().write(`data: ${JSON.stringify(payload)}\n\n`);

  afterEach(() => {
    sources?.close();
    streams.length = 0;
    logs.length = 0;
  });

  it('announces itself and forwards the space\'s modes for its own sessions only, marked with its id', async () => {
    start();
    index.observeHostRecords([{ id: 'host-1' }]);
    index.acceptSpaceList(OTHER, [{ id: 'other-1', location: { directory: `/spaces/${OTHER}/repo` } }], { complete: true });
    sources.sync([ID]);
    expect(await until(() => Boolean(notificationStream()))).toBe(true);
    expect(streams.map((entry) => entry.path)).not.toContain('/api/openchamber/events');
    expect(await until(() => broadcast.length === 1)).toBe(true);
    expect(broadcast[0]).toEqual({ type: 'openchamber:space-permission-stream', properties: { spaceId: ID, status: 'connected' } });

    // The stream inside opens with its own session token: it is never passed on.
    write({ type: 'openchamber:notification-stream-ready', properties: { uiToken: 'inside-token' } });
    write({
      type: 'openchamber:permission-auto-accept.updated',
      properties: { sessions: { mine: true, 'host-1': true, 'other-1': true, quiet: false }, modes: { mine: 'auto', 'host-1': 'auto', 'other-1': 'auto', quiet: 'ask' }, revision: 7 },
    });
    expect(await until(() => broadcast.length === 2)).toBe(true);
    expect(broadcast[1]).toEqual({
      type: 'openchamber:permission-auto-accept.updated',
      properties: { sessions: { mine: true, quiet: false }, modes: { mine: 'auto', quiet: 'ask' }, revision: 7, spaceId: ID },
    });
    expect(logs.filter((line) => line.includes('dropped a permission mode'))).toHaveLength(2);
    expect(JSON.stringify(broadcast)).not.toContain('inside-token');
  });

  it('forwards a request the space left for the user, and drops one for a folder outside it or a session of the host', async () => {
    start();
    index.observeHostRecords([{ id: 'host-1' }]);
    sources.sync([ID]);
    expect(await until(() => Boolean(notificationStream()))).toBe(true);
    const leftForUser = (permissionId, sessionId, directory) => ({ type: 'openchamber:permission-auto-accept.left-for-user', properties: { permissionId, sessionId, directory } });
    write(leftForUser('p1', 'mine', '/home/me/project'));
    write(leftForUser('p2', 'host-1', `/spaces/${ID}/repo`));
    write(leftForUser('p3', 'mine', `/spaces/${ID}/repo`));
    write(leftForUser('p4', 'mine', null));
    expect(await until(() => broadcast.length === 3)).toBe(true);
    expect(broadcast.slice(1)).toEqual([
      { type: 'openchamber:permission-auto-accept.left-for-user', properties: { permissionId: 'p3', sessionId: 'mine', directory: `/spaces/${ID}/repo`, spaceId: ID } },
      { type: 'openchamber:permission-auto-accept.left-for-user', properties: { permissionId: 'p4', sessionId: 'mine', directory: null, spaceId: ID } },
    ]);
    expect(logs.join('\n')).not.toContain('/home/me/project');
  });
});
