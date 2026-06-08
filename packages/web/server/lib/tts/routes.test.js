import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

import { registerTtsRoutes } from './routes.js';

const createApp = () => {
  const app = express();
  app.use(express.json());
  registerTtsRoutes(app, {
    resolveZenModel: async () => 'gpt-5-nano',
    sayTTSCapability: null,
  });
  return app;
};

describe('tts routes', () => {
  it('returns local note fallback while model summarization is retired', async () => {
    const response = await request(createApp())
      .post('/api/text/summarize')
      .send({
        text: 'First sentence. Second sentence with the useful insight.',
        threshold: 0,
        maxLength: 100,
        mode: 'note',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      summary: 'First sentence.',
      summarized: false,
      reason: 'Model summarization provider unavailable',
    });
  });

  it('keeps notification fallback behavior without calling zen', async () => {
    const response = await request(createApp())
      .post('/api/text/summarize')
      .send({
        text: 'Notification text that should fall back cleanly.',
        threshold: 0,
        maxLength: 100,
        mode: 'notification',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      summary: 'Notification text that should fall back cleanly.',
      summarized: false,
      reason: 'Model summarization provider unavailable',
    });
  });
});
