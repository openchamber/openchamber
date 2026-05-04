import { afterEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries note summarization with notification mode before failing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'unavailable' }),
    })));

    const response = await request(createApp())
      .post('/api/text/summarize')
      .send({
        text: 'First sentence. Second sentence with the useful insight.',
        threshold: 0,
        maxLength: 100,
        mode: 'note',
      });

    expect(response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(response.body).toEqual({
      error: 'Note summarization failed',
      reason: 'zen API returned 503',
    });
  });

  it('uses notification summarizer result when note mode falls back', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: 'unavailable' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: [{
            type: 'message',
            content: [{ type: 'output_text', text: '**Keep provider state stable** during streaming.' }],
          }],
        }),
      }));

    const response = await request(createApp())
      .post('/api/text/summarize')
      .send({
        text: 'First sentence. Preserve provider state references during streaming to avoid wide rerenders.',
        threshold: 0,
        maxLength: 100,
        mode: 'note',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      summary: 'Keep provider state stable during streaming.',
      summarized: true,
    });
  });

  it('keeps notification fallback behavior', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'unavailable' }),
    })));

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
      reason: 'zen API returned 503',
    });
  });
});
