import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { BrowserControlError } from '../browser-control/broker.js';
import { OpenChamberControlError } from './error.js';
import { registerOpenChamberControlRoutes } from './routes.js';

const createApp = (execute, answerPage = vi.fn()) => {
  const app = express();
  registerOpenChamberControlRoutes(app, { controlService: { execute, answerPage } });
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

  it('keeps the status of a browser refusal instead of reporting 500', async () => {
    const execute = vi.fn(async () => {
      throw new BrowserControlError('The user is interacting with this page in the panel right now.', 409);
    });
    const response = await request(createApp(execute))
      .post('/api/openchamber/control')
      .send({ action: 'browser.click', input: {} })
      .expect(409);
    expect(response.body).toEqual({ error: 'The user is interacting with this page in the panel right now.' });
  });
});

describe('page answer route', () => {
  it('hands the answer to the waiting call', async () => {
    const answerPage = vi.fn(() => ({ answered: true }));
    const body = { sessionId: 'ses_1', callId: 'call_1', summary: 'Layout B', data: { layout: 'b' } };
    const response = await request(createApp(vi.fn(), answerPage))
      .post('/api/openchamber/render/answer')
      .send(body)
      .expect(200);
    expect(response.body).toEqual({ answered: true });
    expect(answerPage).toHaveBeenCalledWith(body);
  });

  it('reports a page that no longer waits as an error, never as success', async () => {
    const answerPage = vi.fn(() => {
      throw new OpenChamberControlError('This page is no longer waiting for an answer', 404);
    });
    const response = await request(createApp(vi.fn(), answerPage))
      .post('/api/openchamber/render/answer')
      .send({ sessionId: 'ses_1', callId: 'call_1', summary: 'B' })
      .expect(404);
    expect(response.body).toEqual({ error: 'This page is no longer waiting for an answer' });
  });
});
