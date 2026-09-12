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

  it('forwards the OpenCode session id from the request body', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    await request(createApp(execute))
      .post('/api/openchamber/control')
      .send({ action: 'projects.list', input: {}, contextDirectory: '/repo', openCodeSessionId: 'ses_9' })
      .expect(200);
    expect(execute).toHaveBeenCalledWith('projects.list', {}, '/repo', expect.objectContaining({
      signal: expect.any(AbortSignal),
      openCodeSessionId: 'ses_9',
    }));
  });

  it('keeps the broker-style status and target on a converted browser failure', async () => {
    // BrowserControlError carries `status`, not `statusCode`; the conversion
    // must not flatten a scoped 503 into a bare 500.
    const execute = vi.fn(async () => {
      throw Object.assign(new Error('No connected window can serve /repo'), {
        status: 503,
        target: { directory: '/repo' },
      });
    });
    const response = await request(createApp(execute))
      .post('/api/openchamber/control')
      .send({ action: 'browser.snapshot', input: {} })
      .expect(503);
    expect(response.body.error).toBe('No connected window can serve /repo');
    expect(response.body.target).toEqual({ directory: '/repo' });
  });
});
