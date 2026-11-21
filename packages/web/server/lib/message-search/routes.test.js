import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerMessageSearchRoutes } from './routes.js';

const createApp = (searchSessions) => {
  const app = express();
  registerMessageSearchRoutes(app, {
    messageSearchRuntime: {
      searchSessions,
      search: vi.fn(),
      status: vi.fn(),
      deleteIndex: vi.fn(),
    },
  });
  return app;
};

describe('message search grouped route', () => {
  it('returns grouped hits and forwards parsed filters', async () => {
    const searchSessions = vi.fn(() => ({
      status: 'ok',
      hits: [{ sessionId: 'ses_1', sessionTitle: 'Session', directory: '/repo', archived: false, messageId: 'msg_1', role: 'user', createdAt: 1, snippet: 'match', matchCount: 1 }],
      next: { createdAt: 1, sessionId: 'ses_1' },
      totals: { sessions: 1, byDirectory: { '/repo': 1 } },
      index: { backfill: { state: 'done', total: 1, done: 1 }, sessions: 1, messages: 1, lifecycleComplete: true },
    }));
    const response = await request(createApp(searchSessions)).get('/api/openchamber/message-search/sessions?q=match&exclude=ses_2');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', next: '1:ses_1', totals: { sessions: 1 } });
    expect(searchSessions).toHaveBeenCalledWith(expect.objectContaining({ query: 'match', exclude: ['ses_2'], lifecycle: 'all' }));
  });

  it('rejects oversized exclusions and malformed cursors', async () => {
    const app = createApp(vi.fn());
    const excluded = Array.from({ length: 201 }, (_, index) => `ses_${index}`);
    expect((await request(app).get('/api/openchamber/message-search/sessions?q=match').query({ exclude: excluded })).status).toBe(400);
    expect((await request(app).get('/api/openchamber/message-search/sessions?q=match&before=bad')).status).toBe(400);
  });

  it('returns unavailable and query-too-short responses', async () => {
    const off = await request(createApp(() => null)).get('/api/openchamber/message-search/sessions?q=match');
    expect(off.status).toBe(503);
    const short = await request(createApp(() => ({ status: 'query-too-short', hits: [] }))).get('/api/openchamber/message-search/sessions?q=ab');
    expect(short.status).toBe(200);
    expect(short.body).toEqual({ status: 'query-too-short', hits: [] });
  });
});
