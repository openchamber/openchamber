import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';

const createApp = (getProviderSources) => {
  const app = express();
  app.use(express.json());
  registerOpenCodeRoutes(app, {
    resolveProjectDirectory: vi.fn(async () => ({ directory: '/projects/app' })),
    getProviderSources,
  });
  return app;
};

describe('GET /api/provider/:providerId/source', () => {
  it('returns the stored config entry next to the layer sources', async () => {
    const stored = {
      name: 'Stored',
      package: 'aisdk:@ai-sdk/openai-compatible',
      env: ['STORED_KEY'],
      settings: { baseURL: 'https://stored.example.com/v1' },
      models: { m: { modelID: 'm', name: 'M' } },
    };
    const getProviderSources = vi.fn(() => ({
      sources: {
        auth: { exists: false },
        user: { exists: false, path: '/user.json' },
        project: { exists: true, path: '/projects/app/opencode.json' },
        custom: { exists: false, path: null },
      },
      config: stored,
    }));

    const response = await request(createApp(getProviderSources))
      .get('/api/provider/stored-llm/source?directory=/projects/app')
      .expect(200);

    expect(getProviderSources).toHaveBeenCalledWith('stored-llm', '/projects/app');
    expect(response.body.config).toEqual(stored);
    expect(response.body.sources.project.exists).toBe(true);
  });

  it('returns null config when no layer defines the provider', async () => {
    const response = await request(createApp(() => ({
      sources: {
        auth: { exists: false },
        user: { exists: false, path: '/user.json' },
        project: { exists: false, path: null },
        custom: { exists: false, path: null },
      },
      config: null,
    })))
      .get('/api/provider/other/source')
      .expect(200);

    expect(response.body.config).toBeNull();
  });
});
