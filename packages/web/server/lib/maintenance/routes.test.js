import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { registerDatabaseMaintenanceRoutes } from './routes.js';

const createApp = (maintenance) => {
  const app = express();
  registerDatabaseMaintenanceRoutes(app, { databaseMaintenance: maintenance });
  return app;
};

describe('database maintenance routes', () => {
  it('returns the overview as JSON', async () => {
    const overview = { exists: true, bytes: 10, reclaimableBytes: 5, compaction: null };
    const app = createApp({ getOverview: async () => overview });
    const response = await request(app).get('/api/openchamber/maintenance/database').expect(200);
    expect(response.body).toEqual(overview);
  });

  it('answers 202 with the running job', async () => {
    const job = { id: 'job-1', phase: 'stopping' };
    const app = createApp({ compactNow: async () => job });
    const response = await request(app).post('/api/openchamber/maintenance/database/compact').expect(202);
    expect(response.body).toEqual({ compaction: job });
  });

  it('passes the refusal status and code through', async () => {
    const error = Object.assign(new Error('Not enough room'), { statusCode: 507, code: 'insufficient-space' });
    const app = createApp({ compactNow: async () => { throw error; } });
    const response = await request(app).post('/api/openchamber/maintenance/database/compact').expect(507);
    expect(response.body).toEqual({ error: 'Not enough room', code: 'insufficient-space' });
  });

  it('refuses a busy compaction with 409', async () => {
    const error = Object.assign(new Error('A compaction is already running'), { code: 'busy', statusCode: 409 });
    const app = createApp({ compactNow: async () => { throw error; } });
    const response = await request(app).post('/api/openchamber/maintenance/database/compact').expect(409);
    expect(response.body).toEqual({ error: 'A compaction is already running', code: 'busy' });
  });

  it('reports a compaction failure as a server error', async () => {
    const app = createApp({ compactNow: async () => { throw new Error('driver missing'); } });
    const response = await request(app).post('/api/openchamber/maintenance/database/compact').expect(500);
    expect(response.body).toEqual({ error: 'driver missing', code: 'error' });
  });

  it('queues a compaction for the next restart', async () => {
    const scheduleForNextRestart = vi.fn(async () => {});
    const app = createApp({ scheduleForNextRestart });
    const response = await request(app)
      .post('/api/openchamber/maintenance/database/compact-on-next-restart')
      .expect(200);
    expect(response.body).toEqual({ pendingOnNextRestart: true });
    expect(scheduleForNextRestart).toHaveBeenCalledTimes(1);
  });
});
