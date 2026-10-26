import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSessionWarmingRoutes } from './routes.js';
import { createSessionWarmingRuntime } from './runtime.js';

describe('session warming routes', () => {
  let root;
  let runtime;
  let setGlobalWarming;
  let setGlobalWarmingDuration;
  let app;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-session-warming-routes-'));
    runtime = createSessionWarmingRuntime({
      dataDir: root,
      buildOpenCodeUrl: (route) => `http://127.0.0.1:1${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      // The session is busy in these tests, so nothing pings.
      fetchImpl: vi.fn(async () => new Response('{}')),
    });
    runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_1234', status: { type: 'busy' } } });
    setGlobalWarming = vi.fn();
    setGlobalWarmingDuration = vi.fn();
    app = express();
    app.use(express.json());
    registerSessionWarmingRoutes(app, { sessionWarmingRuntime: runtime, setGlobalWarming, setGlobalWarmingDuration });
  });

  afterEach(async () => {
    await runtime.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('switches between OpenCode warming every session and per-session warming', async () => {
    const all = await request(app).put('/api/session-warming/mode').send({ mode: 'all' });
    expect(all.body).toMatchObject({ enabled: false });
    expect(setGlobalWarming).toHaveBeenLastCalledWith(true);

    const perSession = await request(app).put('/api/session-warming/mode').send({ mode: 'session' });
    expect(perSession.body).toMatchObject({ enabled: true });
    expect(setGlobalWarming).toHaveBeenLastCalledWith(false);

    await request(app).put('/api/session-warming/mode').send({ mode: 'off' });
    expect((await request(app).get('/api/session-warming')).body).toMatchObject({ enabled: false, sessions: [] });
  });

  it('leaves per-session warming as it was when the OpenCode config cannot be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setGlobalWarming.mockImplementation(() => { throw new Error('read-only config'); });
    const response = await request(app).put('/api/session-warming/mode').send({ mode: 'session' });
    expect(response.status).toBe(500);
    expect(runtime.snapshot().enabled).toBe(false);
  });

  it('toggles one session and refuses while per-session warming is off', async () => {
    const refused = await request(app).put('/api/session-warming/sessions/ses_1234').send({ directory: '/repo', warm: true });
    expect(refused.status).toBe(409);

    await request(app).put('/api/session-warming/mode').send({ mode: 'session' });
    const on = await request(app).put('/api/session-warming/sessions/ses_1234').send({ directory: '/repo', warm: true });
    expect(on.body.sessions).toEqual([{ sessionId: 'ses_1234', warmUntil: null }]);
    const off = await request(app).put('/api/session-warming/sessions/ses_1234').send({ directory: '/repo', warm: false });
    expect(off.body.sessions).toEqual([]);
  });

  it('sets the warm duration for OpenCode\'s warming or for the chosen sessions', async () => {
    const all = await request(app).put('/api/session-warming/duration').send({ scope: 'all', minutes: 120 });
    expect(all.status).toBe(200);
    expect(setGlobalWarmingDuration).toHaveBeenCalledWith(120);
    expect(all.body.minutes).toBe(60);

    const perSession = await request(app).put('/api/session-warming/duration').send({ scope: 'session', minutes: 180 });
    expect(perSession.body.minutes).toBe(180);
    expect((await request(app).put('/api/session-warming/duration').send({ scope: 'session', minutes: 45 })).status).toBe(400);
  });

  it('answers 400 for malformed input and for a session in an isolated space', async () => {
    await request(app).put('/api/session-warming/mode').send({ mode: 'session' });
    expect((await request(app).put('/api/session-warming/mode').send({ mode: 'sometimes' })).status).toBe(400);
    expect((await request(app).put('/api/session-warming/sessions/ses_1234').send({ warm: true })).status).toBe(400);
    expect((await request(app).put('/api/session-warming/sessions/x').send({ directory: '/repo', warm: true })).status).toBe(400);
    const space = await request(app).put('/api/session-warming/sessions/ses_1234').send({ directory: '/spaces/0123456789ab/repo', warm: true });
    expect(space.status).toBe(400);
  });
});
