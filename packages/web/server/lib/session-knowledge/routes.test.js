import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { registerSessionKnowledgeRoutes } from './routes.js';

const summary = { notes: [], plans: [], memory: { global: 0, project: 0 } };
const createApp = (overrides = {}) => {
  const app = express();
  registerSessionKnowledgeRoutes(app, {
    sessionKnowledgeRuntime: {
      sync: async () => true,
      collectSummary: async () => summary,
      collectSummaryForSession: async () => summary,
      setPin: async () => ({ notes: [], plans: [] }),
      ...overrides,
    },
  });
  return app;
};

describe('session knowledge routes', () => {
  test('trims sync inputs and preserves optional, null and invalid styles', async () => {
    const calls = [];
    const app = createApp({ sync: async (...args) => { calls.push(args); return false; } });
    for (const style of [undefined, null, ' custom ', { text: 'invalid' }]) {
      const response = await request(app).post('/api/session-knowledge/sync').send({
        sessionId: ' session ', directory: ' /project ', responseStyleInstruction: style,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ synced: false });
    }
    expect(calls).toEqual([
      ['session', '/project', undefined],
      ['session', '/project', null],
      ['session', '/project', ' custom '],
      ['session', '/project', undefined],
    ]);
  });

  test('rejects non-string and blank sync inputs', async () => {
    for (const sessionId of [null, 1, {}, [], ' ']) {
      const response = await request(createApp()).post('/api/session-knowledge/sync')
        .send({ sessionId, directory: '/project' });
      expect(response.status).toBe(400);
    }
  });

  test('selects the summary reader and keeps read failures empty', async () => {
    const calls = [];
    const app = createApp({
      collectSummary: async (...args) => { calls.push(args); return summary; },
      collectSummaryForSession: async (...args) => { calls.push(args); throw new Error('unreadable'); },
    });
    expect((await request(app).get('/api/session-knowledge/summary')).body).toEqual(summary);
    expect((await request(app).get('/api/session-knowledge/summary').query({ directory: ' /project ' })).body).toEqual(summary);
    expect((await request(app).get('/api/session-knowledge/summary').query({ directory: '/project', sessionId: ' session ' })).body).toEqual(summary);
    expect(calls).toEqual([['/project'], ['session', '/project']]);
  });

  test('requires a boolean pin and preserves unchecked failure messages', async () => {
    const pin = { sessionId: ' session ', directory: ' /project ', id: ' constructor ', kind: 'note' };
    const calls = [];
    const app = createApp({ setPin: async (...args) => { calls.push(args); return { notes: ['constructor'], plans: [] }; } });
    expect((await request(app).post('/api/session-knowledge/pin').send({ ...pin, pinned: 'true' })).status).toBe(400);
    expect((await request(app).post('/api/session-knowledge/pin').send({ ...pin, pinned: false })).body)
      .toEqual({ pins: { notes: ['constructor'], plans: [] } });
    expect(calls).toEqual([['session', '/project', 'note', 'constructor', false]]);
    for (const failure of [null, 'failure', { message: 17 }, { message: '' }, new Error('failed')]) {
      const response = await request(createApp({ setPin: async () => { throw failure; } }))
        .post('/api/session-knowledge/pin').send({ ...pin, pinned: true });
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: failure?.message ?? 'Unable to update pin' });
    }
  });
});
