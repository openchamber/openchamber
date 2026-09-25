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
