import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const createApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const dependencies = {
    getOpenCodeUpgradeCapability: () => ({
      supported: false,
      manager: 'openchamber',
      reason: 'bundled',
    }),
    buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    refreshOpenCodeAfterConfigChange: vi.fn(async () => {}),
    ...overrides,
  };
  registerOpenCodeRoutes(app, dependencies);
  return { app, dependencies };
};

describe('OpenCode upgrade routes', () => {
  it('fails closed without contacting the bundled OpenCode updater', async () => {
    globalThis.fetch = vi.fn();
    const { app } = createApp();

    await request(app)
      .post('/api/opencode/upgrade')
      .send({})
      .expect(409, {
        success: false,
        code: 'OPENCODE_UPGRADE_MANAGED_BY_OPENCHAMBER',
        error: 'OpenCode is bundled with OpenChamber Desktop and updates with the app.',
      });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reports bundled update ownership through the capability contract', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ healthy: true, version: '1.18.8' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const { app } = createApp();

    const response = await request(app)
      .get('/api/opencode/upgrade-status')
      .expect(200);

    expect(response.body).toEqual({
      available: false,
      currentVersion: '1.18.8',
      latestVersion: null,
      upgrade: {
        supported: false,
        manager: 'openchamber',
        reason: 'bundled',
      },
    });
  });

  it('serializes supported upgrades and preserves the in-flight lock', async () => {
    let releaseUpgrade;
    const upstreamResponse = new Promise((resolve) => {
      releaseUpgrade = () => resolve(new Response(JSON.stringify({ success: true, version: '1.18.9' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    globalThis.fetch = vi.fn(() => upstreamResponse);
    const { app, dependencies } = createApp({
      getOpenCodeUpgradeCapability: () => ({
        supported: true,
        manager: 'opencode',
        reason: null,
      }),
    });

    const first = request(app)
      .post('/api/opencode/upgrade')
      .send({})
      .expect(200, {
        success: true,
        version: '1.18.9',
        restarted: true,
      })
      .then((response) => response);
    await vi.waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    await request(app)
      .post('/api/opencode/upgrade')
      .send({})
      .expect(409, {
        success: false,
        code: 'OPENCODE_UPGRADE_IN_PROGRESS',
        error: 'An OpenCode upgrade is already in progress.',
      });

    releaseUpgrade();
    await first;
    expect(dependencies.refreshOpenCodeAfterConfigChange).toHaveBeenCalledTimes(1);
  });
});
