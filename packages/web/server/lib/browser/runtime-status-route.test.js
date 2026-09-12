import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerBrowserRuntimeStatusRoute } from './runtime-status-route.js';
import { registerOpenCodeRoutes } from '../opencode/routes.js';

const createApp = ({ enabled = true, context = { type: 'session' } } = {}) => {
  const app = express();
  const status = { configuredPort: 0, running: false, activePort: null, restartRequired: false };
  const lifecycle = { getRuntimeStatus: vi.fn(async () => status) };
  const uiAuthController = { enabled, resolveAuthContext: vi.fn(async () => context) };
  registerBrowserRuntimeStatusRoute(app, { lifecycle, uiAuthController });
  return { app, lifecycle, uiAuthController, status };
};

describe('browser runtime status route', () => {
  it('returns only runtime metadata for an authenticated session without starting Chrome', async () => {
    const { app, lifecycle, uiAuthController, status } = createApp();
    const response = await request(app).get('/api/browser/runtime-status');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(status);
    expect(lifecycle.getRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(uiAuthController.resolveAuthContext.mock.calls[0][2]).toEqual({ allowUrlToken: false });
  });

  it.each([
    { enabled: true, context: null },
    { enabled: false, context: { type: 'session' } },
    { enabled: false, context: null },
  ])('rejects unauthenticated and password-free cookie access: %j', async (auth) => {
    const { app, lifecycle, uiAuthController } = createApp(auth);
    expect((await request(app).get('/api/browser/runtime-status').set('Cookie', 'session=untrusted')).status).toBe(401);
    expect(lifecycle.getRuntimeStatus).not.toHaveBeenCalled();
    if (!auth.enabled) expect(uiAuthController.resolveAuthContext.mock.calls[0][0].headers.cookie).toBe('');
  });

  it('accepts paired-client authentication when the UI password is disabled', async () => {
    const { app } = createApp({ enabled: false, context: { type: 'client' } });
    expect((await request(app).get('/api/browser/runtime-status')).status).toBe(200);
  });

  it('reports a failed authoritative status read as an error', async () => {
    const { app, lifecycle } = createApp();
    lifecycle.getRuntimeStatus.mockRejectedValueOnce(new Error('composition failed'));
    const response = await request(app).get('/api/browser/runtime-status');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Browser runtime status is unavailable' });
  });
});

describe('debug port settings route', () => {
  const settingsApp = () => {
    const app = express();
    app.use(express.json());
    const persistSettings = vi.fn(async (body) => body);
    const onServerBrowserDebugPortChanged = vi.fn();
    const onServerBrowserEnabledChanged = vi.fn();
    registerOpenCodeRoutes(app, { persistSettings, onServerBrowserDebugPortChanged, onServerBrowserEnabledChanged });
    return { app, persistSettings, onServerBrowserDebugPortChanged, onServerBrowserEnabledChanged };
  };

  it.each([-1, 65536, 1.5, '9222', null])('rejects invalid port %s before writing settings', async (port) => {
    const { app, persistSettings } = settingsApp();
    expect((await request(app).put('/api/config/settings').send({ serverBrowserDebugPort: port })).status).toBe(400);
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it.each([0, 9222, 65535])('saves port %s without toggling or restarting Chrome', async (port) => {
    const { app, onServerBrowserDebugPortChanged, onServerBrowserEnabledChanged } = settingsApp();
    const response = await request(app).put('/api/config/settings').send({ serverBrowserDebugPort: port });
    expect(response.status).toBe(200);
    expect(response.body.serverBrowserDebugPort).toBe(port);
    expect(onServerBrowserDebugPortChanged).toHaveBeenCalledWith(port);
    expect(onServerBrowserEnabledChanged).not.toHaveBeenCalled();
  });

  it('does not apply a failed settings write to the running lifecycle', async () => {
    const { app, persistSettings, onServerBrowserDebugPortChanged } = settingsApp();
    persistSettings.mockRejectedValueOnce(new Error('write failed'));
    expect((await request(app).put('/api/config/settings').send({ serverBrowserDebugPort: 9222 })).status).toBe(500);
    expect(onServerBrowserDebugPortChanged).not.toHaveBeenCalled();
  });
});
