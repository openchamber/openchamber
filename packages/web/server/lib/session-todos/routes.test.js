import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSessionTodosRoutes } from './routes.js';

afterEach(() => vi.restoreAllMocks());

const makeRoute = () => {
  const app = express();
  const read = vi.fn();
  registerSessionTodosRoutes(app, { sessionTodosRuntime: { read } });
  return { app, read };
};

describe('session todo routes', () => {
  it('validates the session and directory before reading', async () => {
    const { app, read } = makeRoute();
    await request(app).get('/api/session-todos/x').query({ directory: '/repo' }).expect(400);
    await request(app).get('/api/session-todos/ses_todo_1').expect(400);
    await request(app).get('/api/session-todos/ses_todo_1').query({ directory: ' ' }).expect(400);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { revision: 1, state: 'off' },
    { revision: 2, state: 'ready', todos: [{ content: 'Ship it', status: 'pending' }] },
  ])('returns the runtime response unchanged for $state', async (result) => {
    const { app, read } = makeRoute();
    read.mockResolvedValue(result);
    const response = await request(app)
      .get('/api/session-todos/ses_todo_1')
      .query({ directory: ' /repo ' })
      .expect(200);
    expect(read).toHaveBeenCalledWith('ses_todo_1', '/repo');
    expect(response.body).toEqual(result);
  });

  it.each([
    new Error('unavailable'),
    { message: 'unavailable' },
    { message: 0 },
    { message: null },
    Object.assign(() => {}, { message: 'unavailable' }),
    'unavailable',
    null,
    undefined,
  ])('keeps arbitrary runtime failures as a 502', async (error) => {
    const { app, read } = makeRoute();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    read.mockRejectedValue(error);
    const response = await request(app)
      .get('/api/session-todos/ses_todo_1')
      .query({ directory: '/repo' })
      .expect(502);
    expect(response.body).toEqual({ error: 'OpenCode did not answer' });
    expect(warn).toHaveBeenCalledWith('[session-todos] failed to read:', error?.message ?? error);
  });
});
