import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerBrowserRoutes } from './routes.js';

const createApp = (overrides = {}) => {
  const browserRuntime = {
    state: vi.fn(() => ({ supported: true, running: false, activeTabId: null, tabs: [], recording: null })),
    executeAction: vi.fn(async () => ({ ok: true })),
    listArtifacts: vi.fn(async () => [{ id: 'a.png', kind: 'screenshot', bytes: 10, createdAt: 1 }]),
    readArtifact: vi.fn(async (id) => (id === 'a.png' ? { buffer: Buffer.from('png'), contentType: 'image/png' } : null)),
    ...overrides,
  };
  const app = express();
  registerBrowserRoutes(app, { browserRuntime });
  return { app, browserRuntime };
};

describe('registerBrowserRoutes', () => {
  it('returns state and artifact listings', async () => {
    const { app } = createApp();
    await request(app).get('/api/browser/state').expect(200, { supported: true, running: false, activeTabId: null, tabs: [], recording: null });
    const list = await request(app).get('/api/browser/artifacts').expect(200);
    expect(list.body.artifacts).toHaveLength(1);
  });

  it('serves an artifact by id and 404s unknown ids', async () => {
    const { app } = createApp();
    const found = await request(app).get('/api/browser/artifacts/a.png').expect(200);
    expect(found.headers['content-type']).toContain('image/png');
    await request(app).get('/api/browser/artifacts/missing.png').expect(404);
  });

  it('dispatches every action route through the runtime', async () => {
    const { app, browserRuntime } = createApp();
    await request(app).post('/api/browser/navigate').send({ url: 'https://example.com' }).expect(200);
    expect(browserRuntime.executeAction).toHaveBeenCalledWith('navigate', { url: 'https://example.com' });
    await request(app).post('/api/browser/screenshot').send({}).expect(200);
    expect(browserRuntime.executeAction).toHaveBeenCalledWith('screenshot', {});
  });

  it('maps runtime errors to 400 responses', async () => {
    const { app } = createApp({ executeAction: vi.fn(async () => { throw new Error('boom'); }) });
    const response = await request(app).post('/api/browser/click').send({ x: 1, y: 2 }).expect(400);
    expect(response.body.error).toBe('boom');
  });
});
