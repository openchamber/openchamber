import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_CENTER_LIMIT,
  NOTIFICATION_CENTER_TTL_MS,
  createAppVersionMarker,
  createNotificationCenterPersistence,
  createNotificationCenterRuntime,
} from './center.js';
import { registerNotificationCenterRoutes } from './center-routes.js';

const ready = (overrides = {}) => ({
  kind: 'ready',
  priority: 'normal',
  delivery: 'delivered',
  title: 'Build agent is ready',
  body: 'Done',
  sessionId: 'ses_1',
  directory: '/repo',
  sessionName: 'Fix the header',
  ...overrides,
});

const memoryPersistence = (initial = []) => {
  const saved = [];
  return { saved, load: vi.fn(async () => initial), save: vi.fn(async (entries) => { saved.push(entries); }) };
};

const makeCenter = ({ initial, time = 1_000 } = {}) => {
  const persistence = memoryPersistence(initial);
  const broadcast = vi.fn();
  let clock = time;
  let id = 0;
  const center = createNotificationCenterRuntime({
    persistence,
    broadcast,
    now: () => clock,
    createId: () => `n${(id += 1)}`,
    saveDelayMs: 0,
  });
  return { center, persistence, broadcast, advance: (ms) => { clock += ms; } };
};

const tempDirs = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('notification center runtime', () => {
  it('records unread entries, lists them newest first and broadcasts each one', async () => {
    const { center, broadcast, advance } = makeCenter();

    await center.record(ready({ title: 'first' }));
    advance(10);
    const second = await center.record(ready({ kind: 'permission', priority: 'high', title: 'second', sessionName: '' }));

    expect(second).toMatchObject({ id: 'n2', readAt: null, verdict: null, sessionName: null, createdAt: 1_010 });
    expect((await center.list()).map((entry) => entry.title)).toEqual(['second', 'first']);
    expect(broadcast).toHaveBeenLastCalledWith({
      type: 'openchamber:notification-center.changed',
      properties: { change: 'added', entry: second },
    });
  });

  it('marks read by ids, by session or all, and reports only what changed', async () => {
    const { center, broadcast } = makeCenter();
    await center.record(ready());
    await center.record(ready({ sessionId: 'ses_2' }));
    await center.record(ready({ sessionId: 'ses_2' }));

    expect((await center.markRead({ ids: ['n1'] })).ids).toEqual(['n1']);
    expect((await center.markRead({ sessionId: 'ses_2' })).ids).toEqual(['n2', 'n3']);
    broadcast.mockClear();
    expect((await center.markRead({ all: true })).ids).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
    expect((await center.list()).every((entry) => entry.readAt !== null)).toBe(true);
  });

  it('keeps at most the limit and drops entries past the retention', async () => {
    const old = { ...ready(), id: 'old', createdAt: 0, verdict: null, readAt: null };
    const { center } = makeCenter({ initial: [old], time: NOTIFICATION_CENTER_TTL_MS + 1 });
    expect(await center.list()).toEqual([]);

    for (let index = 0; index < NOTIFICATION_CENTER_LIMIT + 5; index += 1) await center.record(ready());
    const entries = await center.list();
    expect(entries).toHaveLength(NOTIFICATION_CENTER_LIMIT);
    expect(entries.at(-1).id).toBe('n6');
  });

  it('clears everything and tells every client', async () => {
    const { center, broadcast } = makeCenter();
    await center.record(ready());
    await center.clear();
    expect(await center.list()).toEqual([]);
    expect(broadcast).toHaveBeenLastCalledWith({ type: 'openchamber:notification-center.changed', properties: { change: 'cleared' } });
  });

  it('keeps the request id and the click action through a save and a load', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-center-'));
    tempDirs.push(dataDir);
    const persistence = createNotificationCenterPersistence({ dataDir });
    const center = createNotificationCenterRuntime({ persistence, saveDelayMs: 0, createId: () => 'n1', now: () => 7 });
    const action = { type: 'sessions', sessions: [{ sessionId: 'ses_1', directory: '/repo', title: 'One' }, { sessionId: 'ses_2', directory: null, title: null }] };
    await center.record(ready({ kind: 'restart', priority: 'high', sessionId: null, directory: null, requestId: 'req_1', action }));
    await center.stop();
    const [loaded] = await persistence.load();
    expect(loaded).toMatchObject({ kind: 'restart', requestId: 'req_1', action });
  });

  it('drops a malformed action but keeps the entry', async () => {
    const { center } = makeCenter();
    const entry = await center.record(ready({ action: { type: 'sessions', sessions: [] } }));
    expect(entry.action).toBeNull();
  });

  it('lists the kinds older clients cannot parse only to clients that ask for them', async () => {
    const { center } = makeCenter();
    await center.record(ready());
    await center.record(ready({ kind: 'update', sessionId: null, requestId: '2.5.0' }));
    expect((await center.list()).map((entry) => entry.kind)).toEqual(['ready']);
    expect((await center.list({ allKinds: true })).map((entry) => entry.kind)).toEqual(['update', 'ready']);
  });

  it('records once per kind and request id', async () => {
    const { center } = makeCenter();
    expect(await center.recordOnce(ready({ kind: 'update', requestId: '2.5.0' }))).not.toBeNull();
    expect(await center.recordOnce(ready({ kind: 'update', requestId: '2.5.0' }))).toBeNull();
    expect(await center.recordOnce(ready({ kind: 'opencode-update', requestId: '2.5.0' }))).not.toBeNull();
    expect(await center.list({ allKinds: true })).toHaveLength(2);
  });

  it('moves a finished turn to the history once it is read; other kinds stay', async () => {
    const { center, broadcast } = makeCenter();
    await center.record(ready());
    await center.record(ready({ kind: 'error', priority: 'high' }));

    await center.markRead({ sessionId: 'ses_1' });

    const [error, turn] = await center.list({ allKinds: true });
    expect(turn).toMatchObject({ kind: 'ready', readAt: 1_000, resolvedAt: 1_000 });
    expect(error).toMatchObject({ kind: 'error', readAt: 1_000, resolvedAt: null });
    expect(broadcast).toHaveBeenLastCalledWith({
      type: 'openchamber:notification-center.changed',
      properties: { change: 'resolved', ids: ['n1'], resolvedAt: 1_000 },
    });
    // Clients before v2 have no history: resolved entries are left out for them.
    expect((await center.list()).map((entry) => entry.kind)).toEqual(['error']);
  });

  it('resolves one session\'s entries of some kinds, narrowed to a request, and marks them read', async () => {
    const { center, broadcast } = makeCenter();
    await center.record(ready({ kind: 'question', requestId: 'frm_1' }));
    await center.record(ready({ kind: 'question', requestId: 'frm_2' }));
    await center.record(ready({ kind: 'question', sessionId: 'ses_2', requestId: 'frm_1' }));

    expect(await center.resolve({ sessionId: 'ses_1', kinds: ['question'], requestId: 'frm_1' })).toEqual(['n1']);
    expect(broadcast.mock.calls.slice(-2).map(([event]) => event.properties.change)).toEqual(['read', 'resolved']);
    expect(await center.resolve({ sessionId: 'ses_1', kinds: ['question'], requestId: 'frm_1' })).toEqual([]);
    expect(await center.resolve({ sessionId: 'ses_1', kinds: ['ready'] })).toEqual([]);

    const byId = new Map((await center.list({ allKinds: true })).map((entry) => [entry.id, entry]));
    expect(byId.get('n1')).toMatchObject({ readAt: 1_000, resolvedAt: 1_000 });
    expect(byId.get('n2').resolvedAt).toBeNull();
    expect(byId.get('n3').resolvedAt).toBeNull();
  });

  it('removes single entries and tells every client', async () => {
    const { center, broadcast } = makeCenter();
    await center.record(ready());
    await center.record(ready());
    expect(await center.remove(['n1', 'missing'])).toEqual(['n1']);
    expect((await center.list()).map((entry) => entry.id)).toEqual(['n2']);
    expect(broadcast).toHaveBeenLastCalledWith({ type: 'openchamber:notification-center.changed', properties: { change: 'removed', ids: ['n1'] } });
    broadcast.mockClear();
    expect(await center.remove(['n1'])).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('resolves a finished turn that was read before resolution existed', async () => {
    const old = { ...ready(), id: 'old', createdAt: 900, verdict: null, readAt: 950, requestId: null, action: null, resolvedAt: null };
    const unread = { ...old, id: 'unread', readAt: null };
    const { center } = makeCenter({ initial: [old, unread] });
    const byId = new Map((await center.list({ allKinds: true })).map((entry) => [entry.id, entry]));
    expect(byId.get('old').resolvedAt).toBe(950);
    expect(byId.get('unread').resolvedAt).toBeNull();
  });

  it('starts empty when the saved file cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const center = createNotificationCenterRuntime({
      persistence: { load: async () => { throw new Error('EACCES'); }, save: async () => {} },
    });
    expect(await center.list()).toEqual([]);
  });
});

describe('notification center persistence', () => {
  it('round-trips entries, drops broken ones and distinguishes missing from unsupported files', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-center-'));
    tempDirs.push(dataDir);
    const persistence = createNotificationCenterPersistence({ dataDir });
    expect(await persistence.load()).toEqual([]);

    // Written before `requestId` and `action` existed: both load as null.
    const entry = { ...ready(), id: 'n1', createdAt: 5, verdict: 'review', readAt: null };
    await persistence.save([entry, { id: 'broken' }]);
    expect(await persistence.load()).toEqual([{ ...entry, requestId: null, action: null, resolvedAt: null }]);
    expect((await fs.stat(path.join(dataDir, 'notification-center.json'))).mode & 0o777).toBe(0o600);

    await fs.writeFile(path.join(dataDir, 'notification-center.json'), JSON.stringify({ version: 99, entries: [entry] }));
    await expect(persistence.load()).rejects.toThrow('Invalid notification center snapshot');
  });
});

describe('app version marker', () => {
  it('records nothing on the first start, then answers the previous version once per change', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-center-'));
    tempDirs.push(dataDir);
    const marker = createAppVersionMarker({ dataDir });
    expect(await marker.noteVersion('2.4.2')).toBeNull();
    expect(await marker.noteVersion('2.4.2')).toBeNull();
    expect(await marker.noteVersion('2.5.0')).toBe('2.4.2');
    expect(await marker.noteVersion('2.5.0')).toBeNull();
  });
});

describe('notification center routes', () => {
  const appWith = (center) => {
    const app = express();
    registerNotificationCenterRoutes(app, { notificationCenter: center });
    return app;
  };

  it('lists, marks read and clears', async () => {
    const { center } = makeCenter();
    await center.record(ready());
    const app = appWith(center);

    await center.record(ready({ kind: 'restack', requestId: 'run_1' }));
    const listed = await request(app).get('/api/notification-center').expect(200);
    expect(listed.body.entries).toHaveLength(1);
    const listedV2 = await request(app).get('/api/notification-center?version=2').expect(200);
    expect(listedV2.body.entries.map((entry) => entry.kind)).toEqual(['restack', 'ready']);
    const read = await request(app).post('/api/notification-center/read').send({ sessionId: 'ses_1' }).expect(200);
    expect(read.body.ids).toEqual(['n1', 'n2']);
    const removed = await request(app).post('/api/notification-center/remove').send({ ids: ['n2'] }).expect(200);
    expect(removed.body.ids).toEqual(['n2']);
    await request(app).post('/api/notification-center/remove').send({ ids: [] }).expect(400);
    await request(app).delete('/api/notification-center').expect(200);
    expect((await request(app).get('/api/notification-center')).body.entries).toEqual([]);
  });

  it('rejects a read with no target or more than one', async () => {
    const app = appWith(makeCenter().center);
    await request(app).post('/api/notification-center/read').send({}).expect(400);
    await request(app).post('/api/notification-center/read').send({ all: true, sessionId: 'ses_1' }).expect(400);
    await request(app).post('/api/notification-center/read').send({ ids: [] }).expect(400);
  });
});
