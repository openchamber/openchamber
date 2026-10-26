import { describe, expect, it } from 'bun:test';
import { createTunnelRoutesRuntime } from './routes.js';

describe('public tunnel password requirement', () => {
  const createRuntime = (hasUiPassword) => {
    let starts = 0;
    const runtime = createTunnelRoutesRuntime({
      hasUiPassword,
      tunnelService: {
        start: async () => {
          starts += 1;
          return { provider: 'cloudflare', publicUrl: 'https://example.com', activeMode: 'quick' };
        },
      },
      TUNNEL_PROVIDER_CLOUDFLARE: 'cloudflare',
      TUNNEL_MODE_MANAGED_REMOTE: 'managed-remote',
    });
    return { runtime, getStarts: () => starts };
  };

  it('rejects an unauthenticated runtime before starting any provider', async () => {
    const { runtime, getStarts } = createRuntime(false);
    await expect(runtime.startTunnelWithNormalizedRequest({ provider: 'cloudflare', mode: 'quick' }))
      .rejects.toThrow('A UI password is required');
    expect(getStarts()).toBe(0);
  });

  it('rejects the HTTP start route without disturbing an existing tunnel', async () => {
    const { runtime, getStarts } = createRuntime(false);
    const routes = new Map();
    const app = {
      get: (path, handler) => routes.set(`GET ${path}`, handler),
      post: (path, handler) => routes.set(`POST ${path}`, handler),
      put: (path, handler) => routes.set(`PUT ${path}`, handler),
    };
    runtime.registerRoutes(app);
    let status = 200;
    let body;
    const response = {
      status(code) { status = code; return this; },
      json(payload) { body = payload; return this; },
    };
    await routes.get('POST /api/openchamber/tunnel/start')({ body: {} }, response);
    expect(status).toBe(403);
    expect(body.code).toBe('ui_password_required');
    expect(getStarts()).toBe(0);
  });

  it('refuses every tunnel in enterprise mode, password or not', async () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      const { runtime, getStarts } = createRuntime(true);
      await expect(runtime.startTunnelWithNormalizedRequest({ provider: 'cloudflare', mode: 'quick' }))
        .rejects.toThrow('enterprise mode');
      const routes = new Map();
      runtime.registerRoutes({
        get: (path, handler) => routes.set(`GET ${path}`, handler),
        post: (path, handler) => routes.set(`POST ${path}`, handler),
        put: (path, handler) => routes.set(`PUT ${path}`, handler),
      });
      let status = 200;
      let body;
      await routes.get('POST /api/openchamber/tunnel/start')({ body: {} }, {
        status(code) { status = code; return this; },
        json(payload) { body = payload; return this; },
      });
      expect(status).toBe(403);
      expect(body.code).toBe('enterprise_mode');
      expect(getStarts()).toBe(0);
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });

  it('allows a password-protected runtime to start a tunnel', async () => {
    const { runtime, getStarts } = createRuntime(true);
    const result = await runtime.startTunnelWithNormalizedRequest({ provider: 'cloudflare', mode: 'quick' });
    expect(result.publicUrl).toBe('https://example.com');
    expect(getStarts()).toBe(1);
  });
});
