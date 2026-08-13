import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerAgentCapabilityRoutes } from './routes.js';

const createApp = (overrides = {}) => {
  const settings = { fusionPresets: [{ name: 'deep-dive', models: ['a/b', 'c/d'] }] };
  const readSettingsFromDiskMigrated = vi.fn(async () => settings);
  const persistSettings = vi.fn(async (changes) => {
    Object.assign(settings, changes);
  });
  const app = express();
  registerAgentCapabilityRoutes(app, {
    readSettingsFromDiskMigrated,
    persistSettings,
    ...overrides,
  });
  return { app, readSettingsFromDiskMigrated, persistSettings };
};

describe('agent capability routes', () => {
  it('lists fusion presets from settings', async () => {
    const { app } = createApp();
    const listed = await request(app).get('/api/openchamber/fusion/presets').expect(200);
    expect(listed.body.presets).toEqual([{ name: 'deep-dive', models: ['a/b', 'c/d'] }]);
  });

  it('saves a new preset and persists it', async () => {
    const { app, persistSettings } = createApp();
    const response = await request(app)
      .post('/api/openchamber/fusion/presets/panel-x')
      .send({ description: 'Panel X', models: ['e/f', 'g/h'] })
      .expect(200);
    expect(response.body.preset).toEqual({ name: 'panel-x', description: 'Panel X', models: ['e/f', 'g/h'] });
    expect(persistSettings).toHaveBeenCalledWith({
      fusionPresets: [
        { name: 'deep-dive', models: ['a/b', 'c/d'] },
        { name: 'panel-x', description: 'Panel X', models: ['e/f', 'g/h'] },
      ],
    });
  });

  it('replaces an existing preset with the same name', async () => {
    const { app, persistSettings } = createApp();
    await request(app)
      .post('/api/openchamber/fusion/presets/deep-dive')
      .send({ models: ['e/f', 'g/h'] })
      .expect(200);
    expect(persistSettings).toHaveBeenCalledWith({
      fusionPresets: [{ name: 'deep-dive', models: ['e/f', 'g/h'] }],
    });
  });

  it('rejects invalid preset names before any write', async () => {
    const { app, persistSettings } = createApp();
    const response = await request(app)
      .post('/api/openchamber/fusion/presets/has%20space')
      .send({ models: ['e/f', 'g/h'] })
      .expect(400);
    expect(response.body.error).toContain('Preset name');
    await request(app)
      .post('/api/openchamber/fusion/presets/-leading-dash')
      .send({ models: ['e/f', 'g/h'] })
      .expect(400);
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('keeps the existing preset untouched when an edit becomes invalid', async () => {
    const { app, persistSettings, readSettingsFromDiskMigrated } = createApp();
    const response = await request(app)
      .post('/api/openchamber/fusion/presets/deep-dive')
      .send({ models: ['e/f'] })
      .expect(400);
    expect(response.body.error).toContain('2-4 provider/model');
    expect(persistSettings).not.toHaveBeenCalled();
    const settings = await readSettingsFromDiskMigrated();
    expect(settings.fusionPresets).toEqual([{ name: 'deep-dive', models: ['a/b', 'c/d'] }]);
  });

  it('rejects model lists with invalid provider/model shapes', async () => {
    const { app, persistSettings } = createApp();
    await request(app)
      .post('/api/openchamber/fusion/presets/bad-models')
      .send({ models: ['nope', 'alsonope'] })
      .expect(400);
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('removes a preset', async () => {
    const { app, persistSettings } = createApp();
    const response = await request(app).delete('/api/openchamber/fusion/presets/deep-dive').expect(200);
    expect(response.body.removed).toBe(true);
    expect(persistSettings).toHaveBeenCalledWith({ fusionPresets: [] });
    const missing = await request(app).delete('/api/openchamber/fusion/presets/deep-dive').expect(200);
    expect(missing.body.removed).toBe(false);
  });

  it('maps preset list errors to status codes', async () => {
    const { app } = createApp({
      readSettingsFromDiskMigrated: vi.fn(async () => {
        throw Object.assign(new Error('settings unavailable'), { statusCode: 503 });
      }),
    });
    const response = await request(app).get('/api/openchamber/fusion/presets').expect(503);
    expect(response.body).toEqual({ error: 'settings unavailable' });
  });
});
