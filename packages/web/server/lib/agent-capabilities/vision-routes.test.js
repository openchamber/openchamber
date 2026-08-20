import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_VISION_PROMPT, sanitizeVisionConfig } from '../opencode/settings-helpers.js';
import { registerVisionRoutes } from './vision-routes.js';

const createApp = (overrides = {}) => {
  const app = express();
  registerVisionRoutes(app, {
    readSettingsFromDiskMigrated: vi.fn(async () => ({})),
    persistSettings: vi.fn(async (changes) => changes),
    ...overrides,
  });
  return app;
};

describe('vision settings routes', () => {
  it('returns null config and the default prompt when nothing is configured', async () => {
    const response = await request(createApp()).get('/api/openchamber/vision').expect(200);

    expect(response.body).toEqual({ config: null, defaultPrompt: DEFAULT_VISION_PROMPT });
  });

  it('returns the configured model and prompt', async () => {
    const readSettingsFromDiskMigrated = vi.fn(async () => ({
      vision: { model: 'anthropic/claude-sonnet-4', prompt: 'Describe briefly.' },
    }));
    const response = await request(createApp({ readSettingsFromDiskMigrated }))
      .get('/api/openchamber/vision')
      .expect(200);

    expect(response.body.config).toEqual({ model: 'anthropic/claude-sonnet-4', prompt: 'Describe briefly.' });
  });

  it('persists a valid config through sanitizeVisionConfig', async () => {
    const persistSettings = vi.fn(async (changes) => changes);
    const response = await request(createApp({ persistSettings }))
      .put('/api/openchamber/vision')
      .send({ model: 'anthropic/claude-sonnet-4', prompt: 'Describe briefly.' })
      .expect(200);

    expect(response.body.config).toEqual({ model: 'anthropic/claude-sonnet-4', prompt: 'Describe briefly.' });
    expect(persistSettings).toHaveBeenCalledWith({
      vision: sanitizeVisionConfig({ model: 'anthropic/claude-sonnet-4', prompt: 'Describe briefly.' }),
    });
  });

  it('drops an empty prompt so the server default applies at call time', async () => {
    const persistSettings = vi.fn(async (changes) => changes);
    const response = await request(createApp({ persistSettings }))
      .put('/api/openchamber/vision')
      .send({ model: 'anthropic/claude-sonnet-4', prompt: '  ' })
      .expect(200);

    expect(response.body.config).toEqual({ model: 'anthropic/claude-sonnet-4' });
  });

  it('rejects a malformed model before anything is persisted', async () => {
    const persistSettings = vi.fn();
    const response = await request(createApp({ persistSettings }))
      .put('/api/openchamber/vision')
      .send({ model: 'no-slash-here' })
      .expect(400);

    expect(response.body.error).toContain('provider/model format');
    expect(persistSettings).not.toHaveBeenCalled();
  });
});
