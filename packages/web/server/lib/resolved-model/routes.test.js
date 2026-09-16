import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { registerResolvedModelRoutes } from './routes.js';

const mount = (runtime) => {
  const app = express();
  registerResolvedModelRoutes(app, { resolvedModelRuntime: runtime });
  return app;
};

describe('resolved model snapshot route', () => {
  it('returns the tracked sessions with server time', async () => {
    const entries = [{ sessionId: 'ses_1', model: 'deepseek-ai/DeepSeek-V4.1-Flash', updatedAt: 1 }];
    const response = await request(mount({ getSnapshot: () => entries })).get('/api/resolved-model');

    expect(response.status).toBe(200);
    expect(response.body.sessions).toEqual(entries);
    expect(typeof response.body.serverTime).toBe('number');
  });

  it('answers unavailable when the runtime is absent', async () => {
    const response = await request(mount(null)).get('/api/resolved-model');
    expect(response.status).toBe(503);
  });
});
