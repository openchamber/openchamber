import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { OpenChamberControlError } from './error.js';
import { registerOpenChamberControlRoutes } from './routes.js';

const createApp = (execute) => {
  const app = express();
  registerOpenChamberControlRoutes(app, { controlService: { execute } });
  return app;
};

describe('OpenChamber control route', () => {
  it('is a thin adapter over the control service', async () => {
    const execute = vi.fn(async () => ({ projects: [] }));
    const response = await request(createApp(execute))
      .post('/api/openchamber/control')
      .send({ action: 'projects.list', input: {}, contextDirectory: '/repo' })
      .expect(200);
    expect(response.body).toEqual({ projects: [] });
    expect(execute).toHaveBeenCalledWith('projects.list', {}, '/repo', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('preserves service status and partial-result details', async () => {
    const execute = vi.fn(async () => {
      throw new OpenChamberControlError('dispatch failed', 500, {
        partial: true,
        partialAction: 'fork-created',
        sessionId: 'ses_fork',
        directory: '/repo',
      });
    });
    const response = await request(createApp(execute))
      .post('/api/openchamber/control')
      .send({ action: 'session.fork', input: {} })
      .expect(500);
    expect(response.body).toEqual({
      error: 'dispatch failed',
      partial: true,
      partialAction: 'fork-created',
      sessionId: 'ses_fork',
      directory: '/repo',
    });
  });
});
