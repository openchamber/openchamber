import fs from 'fs';
import os from 'os';
import path from 'path';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LINEAR_TRACKER_DESCRIPTOR } from '../linear/tracker.js';
import { createTrackerRegistry } from './registry.js';
import { registerTrackerRoutes } from './routes.js';

const descriptorFor = (id, capabilities = {}) => {
  const descriptor = structuredClone(LINEAR_TRACKER_DESCRIPTOR);
  return { ...descriptor, id, name: id, capabilities: { ...descriptor.capabilities, ...capabilities } };
};

const item = { provider: 'fake', id: 'u-1', identifier: 'ENG-12', title: 'Broken login', url: 'https://fake.test/ENG-12', state: null };

const fakeTracker = () => ({
  auth: {
    status: vi.fn(async () => ({ connected: true, account: null, accounts: [] })),
    start: vi.fn(async () => ({ authorizationUrl: 'https://fake.test/authorize', expiresIn: 600 })),
    disconnect: vi.fn(async () => ({ removed: true })),
    activate: vi.fn(async (accountId) => (accountId === 'known' ? { connected: true, accounts: [] } : null)),
  },
  list: vi.fn(async () => ({ connected: true, items: [item], cursor: null, hasMore: false })),
  get: vi.fn(async () => ({ connected: true, item })),
  states: vi.fn(async () => ({ connected: true, states: [] })),
  updateState: vi.fn(async () => ({ connected: true, item })),
  liveSummaries: vi.fn(),
  matchUrl: () => null,
  mapping: {
    get: vi.fn(async () => ({ connected: true, defaultProjectPath: null, containers: [] })),
    set: vi.fn(async (input) => ({ connected: true, defaultProjectPath: input.defaultProjectPath, containers: [] })),
  },
  preferences: {
    get: vi.fn(async () => ({ sessionComments: false })),
    set: vi.fn(async ({ sessionComments }) => ({ sessionComments })),
  },
  sessionStatus: {
    post: vi.fn(async () => ({ connected: true, posted: true })),
    createRuntime: vi.fn(),
  },
});

const createApp = (entries) => {
  const app = express();
  registerTrackerRoutes(app, { registry: createTrackerRegistry(entries, { foreignIds: [] }) });
  // Stands in for the generic OpenCode proxy registered after these routes.
  app.use((_req, res) => res.status(599).end());
  return app;
};

describe('tracker routes', () => {
  let tracker;
  let app;

  beforeEach(() => {
    tracker = fakeTracker();
    app = createApp([{ descriptor: descriptorFor('fake'), load: async () => tracker }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists provider descriptors as plain JSON', async () => {
    const response = await request(app).get('/api/tracker/providers').expect(200);
    expect(response.body).toEqual({ providers: [descriptorFor('fake')] });
  });

  it('answers 404 UNKNOWN_TRACKER for an unknown provider on every route', async () => {
    const calls = [
      request(app).get('/api/tracker/nope/auth/status'),
      request(app).post('/api/tracker/nope/auth/start').send({}),
      request(app).post('/api/tracker/nope/auth/activate').send({ accountId: 'known' }),
      request(app).delete('/api/tracker/nope/auth'),
      request(app).get('/api/tracker/nope/items/list'),
      request(app).get('/api/tracker/nope/items/get?id=ENG-12'),
      request(app).post('/api/tracker/nope/items/update').send({ id: 'ENG-12', stateId: 's' }),
      request(app).get('/api/tracker/nope/states?containerId=t'),
      request(app).get('/api/tracker/nope/mapping'),
      request(app).put('/api/tracker/nope/mapping').send({}),
      request(app).get('/api/tracker/nope/preferences'),
      request(app).put('/api/tracker/nope/preferences').send({ sessionComments: true }),
      request(app).post('/api/tracker/nope/session-status').send({ kind: 'started', sessionId: 's' }),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('UNKNOWN_TRACKER');
    }
  });

  it('keeps unregistered tracker paths away from the OpenCode proxy', async () => {
    const response = await request(app).get('/api/tracker/fake/whatever').expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('serves auth status, start, activate and disconnect', async () => {
    expect((await request(app).get('/api/tracker/fake/auth/status').expect(200)).body).toEqual({ connected: true, account: null, accounts: [] });

    const start = await request(app).post('/api/tracker/fake/auth/start').send({ origin: 'desktop' }).expect(200);
    expect(start.body).toEqual({ authorizationUrl: 'https://fake.test/authorize', expiresIn: 600 });
    expect(tracker.auth.start).toHaveBeenCalledWith({ origin: 'desktop' });
    await request(app).post('/api/tracker/fake/auth/start').send({ origin: 'elsewhere' }).expect(200);
    expect(tracker.auth.start).toHaveBeenLastCalledWith({ origin: 'web' });

    await request(app).post('/api/tracker/fake/auth/activate').send({}).expect(400);
    const missing = await request(app).post('/api/tracker/fake/auth/activate').send({ accountId: 'other' }).expect(404);
    expect(missing.body.code).toBe('ACCOUNT_NOT_FOUND');
    await request(app).post('/api/tracker/fake/auth/activate').send({ accountId: 'known' }).expect(200);

    expect((await request(app).delete('/api/tracker/fake/auth').expect(200)).body).toEqual({ removed: true });
  });

  it('turns a provider user error into 400 and anything else into 500', async () => {
    tracker.auth.start.mockRejectedValueOnce(Object.assign(new Error('Client id missing'), { userError: true }));
    const user = await request(app).post('/api/tracker/fake/auth/start').send({}).expect(400);
    expect(user.body).toEqual({ error: 'Client id missing', code: 'INVALID' });

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tracker.get.mockRejectedValueOnce(new Error('upstream down'));
    const failure = await request(app).get('/api/tracker/fake/items/get?id=ENG-12').expect(500);
    expect(failure.body.error).toBe('upstream down');
  });

  it('lists items with defaults and checks filters against the descriptor', async () => {
    await request(app).get('/api/tracker/fake/items/list').expect(200);
    expect(tracker.list).toHaveBeenLastCalledWith({
      query: undefined, cursor: undefined, state: 'open', people: 'any', priority: 'all', containerId: null,
    });

    await request(app)
      .get('/api/tracker/fake/items/list')
      .query({ query: 'login', cursor: 'c1', state: 'inReview', people: 'me', priority: 'high', containerId: 'team-1' })
      .expect(200);
    expect(tracker.list).toHaveBeenLastCalledWith({
      query: 'login', cursor: 'c1', state: 'inReview', people: 'me', priority: 'high', containerId: 'team-1',
    });

    for (const query of [{ state: 'started' }, { people: 'someone' }, { priority: 'p1' }]) {
      const response = await request(app).get('/api/tracker/fake/items/list').query(query).expect(400);
      expect(response.body.code).toBe('INVALID');
    }
  });

  it('refuses filters the tracker does not have', async () => {
    const plain = createApp([{
      descriptor: descriptorFor('plain', { filters: { people: false, priority: false } }),
      load: async () => tracker,
    }]);
    await request(plain).get('/api/tracker/plain/items/list').expect(200);
    await request(plain).get('/api/tracker/plain/items/list?people=me').expect(400);
    await request(plain).get('/api/tracker/plain/items/list?priority=high').expect(400);
  });

  it('answers 200 { connected: false } when disconnected', async () => {
    tracker.list.mockResolvedValueOnce({ connected: false });
    tracker.get.mockResolvedValueOnce({ connected: false });
    tracker.states.mockResolvedValueOnce({ connected: false });
    tracker.updateState.mockResolvedValueOnce({ connected: false });
    tracker.mapping.get.mockResolvedValueOnce({ connected: false });
    tracker.mapping.set.mockResolvedValueOnce({ connected: false });
    tracker.sessionStatus.post.mockResolvedValueOnce({ connected: false });
    tracker.auth.status.mockResolvedValueOnce({ connected: false });
    const responses = await Promise.all([
      request(app).get('/api/tracker/fake/auth/status'),
      request(app).get('/api/tracker/fake/items/list'),
      request(app).get('/api/tracker/fake/items/get?id=ENG-12'),
      request(app).get('/api/tracker/fake/states?containerId=team-1'),
      request(app).post('/api/tracker/fake/items/update').send({ id: 'ENG-12', stateId: 's-1' }),
      request(app).get('/api/tracker/fake/mapping'),
      request(app).put('/api/tracker/fake/mapping').send({ defaultProjectPath: '/p' }),
      request(app).post('/api/tracker/fake/session-status').send({ kind: 'completed', sessionId: 's' }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ connected: false });
    }
  });

  it('gets, reads states for and updates an item', async () => {
    await request(app).get('/api/tracker/fake/items/get').expect(400);
    await request(app).get('/api/tracker/fake/items/get?id=ENG-12').expect(200);
    expect(tracker.get).toHaveBeenCalledWith('ENG-12');

    await request(app).get('/api/tracker/fake/states').expect(400);
    await request(app).get('/api/tracker/fake/states?containerId=team-1').expect(200);
    expect(tracker.states).toHaveBeenCalledWith('team-1');

    await request(app).post('/api/tracker/fake/items/update').send({ id: 'ENG-12' }).expect(400);
    await request(app).post('/api/tracker/fake/items/update').send({ stateId: 's-1' }).expect(400);
    const updated = await request(app).post('/api/tracker/fake/items/update').send({ id: 'ENG-12', stateId: 's-1' }).expect(200);
    expect(updated.body).toEqual({ connected: true, item });
    expect(tracker.updateState).toHaveBeenCalledWith({ id: 'ENG-12', stateId: 's-1' });
  });

  it('reads and writes mapping, preferences and session status', async () => {
    await request(app).get('/api/tracker/fake/mapping').expect(200);
    await request(app).put('/api/tracker/fake/mapping').send([1]).expect(400);
    await request(app)
      .put('/api/tracker/fake/mapping')
      .send({ defaultProjectPath: '/p', containerProjectPaths: { 'team-1': '/q' } })
      .expect(200);
    expect(tracker.mapping.set).toHaveBeenLastCalledWith({ defaultProjectPath: '/p', containerProjectPaths: { 'team-1': '/q' } });

    expect((await request(app).get('/api/tracker/fake/preferences').expect(200)).body).toEqual({ sessionComments: false });
    await request(app).put('/api/tracker/fake/preferences').send({ sessionComments: 'yes' }).expect(400);
    expect((await request(app).put('/api/tracker/fake/preferences').send({ sessionComments: true }).expect(200)).body).toEqual({ sessionComments: true });

    await request(app).post('/api/tracker/fake/session-status').send({ kind: 'other', sessionId: 's' }).expect(400);
    await request(app).post('/api/tracker/fake/session-status').send({ kind: 'started' }).expect(400);
    await request(app)
      .post('/api/tracker/fake/session-status')
      .send({ kind: 'started', sessionId: 's', identifier: 'ENG-12', sessionOrigin: 'https://chamber.example.com' })
      .expect(200);
    expect(tracker.sessionStatus.post).toHaveBeenLastCalledWith({
      kind: 'started', sessionId: 's', identifier: 'ENG-12', sessionOrigin: 'https://chamber.example.com',
    });
    await request(app).post('/api/tracker/fake/session-status').send({ kind: 'completed', sessionId: 's' }).expect(200);
    expect(tracker.sessionStatus.post).toHaveBeenLastCalledWith({ kind: 'completed', sessionId: 's' });
  });

  it('answers 404 UNSUPPORTED for actions the capabilities leave out', async () => {
    const bare = {
      ...fakeTracker(),
      mapping: undefined,
      preferences: undefined,
      sessionStatus: undefined,
    };
    const limited = createApp([
      {
        descriptor: descriptorFor('limited', { multipleAccounts: false, stateUpdate: false, projectMapping: false, sessionComments: false }),
        load: async () => tracker,
      },
      // Capabilities claim more than the implementation carries.
      { descriptor: descriptorFor('bare'), load: async () => bare },
    ]);
    const calls = [
      request(limited).post('/api/tracker/limited/auth/activate').send({ accountId: 'known' }),
      request(limited).post('/api/tracker/limited/items/update').send({ id: 'ENG-12', stateId: 's' }),
      request(limited).get('/api/tracker/limited/states?containerId=t'),
      request(limited).get('/api/tracker/limited/mapping'),
      request(limited).put('/api/tracker/limited/mapping').send({}),
      request(limited).get('/api/tracker/limited/preferences'),
      request(limited).put('/api/tracker/limited/preferences').send({ sessionComments: true }),
      request(limited).post('/api/tracker/limited/session-status').send({ kind: 'started', sessionId: 's' }),
      request(limited).get('/api/tracker/bare/mapping'),
      request(limited).get('/api/tracker/bare/preferences'),
      request(limited).post('/api/tracker/bare/session-status').send({ kind: 'started', sessionId: 's' }),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('UNSUPPORTED');
    }
    expect(tracker.updateState).not.toHaveBeenCalled();
    expect(tracker.mapping.set).not.toHaveBeenCalled();
  });

  it('caps JSON bodies at 16kb', async () => {
    const big = 'x'.repeat(17 * 1024);
    await request(app).post('/api/tracker/fake/items/update').send({ id: 'ENG-12', stateId: big }).expect(413);
    await request(app).put('/api/tracker/fake/mapping').send({ defaultProjectPath: big }).expect(413);
    await request(app).post('/api/tracker/fake/session-status').send({ kind: 'started', sessionId: big }).expect(413);
    expect(tracker.updateState).not.toHaveBeenCalled();
    await request(app).post('/api/tracker/fake/items/update').send({ id: 'ENG-12', stateId: 'x'.repeat(8 * 1024) }).expect(200);
  });
});

describe('tracker routes over the built-in Linear tracker', () => {
  let dataDir;
  let previousDataDir;

  beforeEach(() => {
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-tracker-routes-'));
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers disconnected without a stored Linear workspace', async () => {
    const app = express();
    registerTrackerRoutes(app, { registry: createTrackerRegistry() });
    const providers = await request(app).get('/api/tracker/providers').expect(200);
    expect(providers.body.providers.map((descriptor) => descriptor.id)).toEqual(['linear']);
    expect((await request(app).get('/api/tracker/linear/items/list').expect(200)).body).toEqual({ connected: false });
    expect((await request(app).get('/api/tracker/linear/items/get?id=ENG-12').expect(200)).body).toEqual({ connected: false });
    expect((await request(app).get('/api/tracker/linear/mapping').expect(200)).body).toEqual({ connected: false });
    expect((await request(app).get('/api/tracker/linear/preferences').expect(200)).body).toEqual({ sessionComments: false });
    expect((await request(app).post('/api/tracker/linear/auth/activate').send({ accountId: 'org-1' }).expect(404)).body.code).toBe('ACCOUNT_NOT_FOUND');
  });
});
