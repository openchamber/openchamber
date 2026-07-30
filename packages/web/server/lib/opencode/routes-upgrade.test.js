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

  it('checks authenticated registry metadata without exposing credentials', async () => {
    const previousLower = process.env.npm_config_registry;
    const previous = process.env.NPM_CONFIG_REGISTRY;
    process.env.npm_config_registry = '';
    process.env.NPM_CONFIG_REGISTRY = 'https://test-user:test-password@mirror.example.com/npm/';
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/global/health')) return new Response(JSON.stringify({ version: '1.18.8' }));
      if (url.includes('mirror.example.com')) return new Response(JSON.stringify({ version: '1.18.9' }));
      return new Response(JSON.stringify({ tag_name: 'v1.18.9' }));
    });
    const { app } = createApp({
      getOpenCodeUpgradeCapability: () => ({ supported: true, manager: 'opencode', reason: null }),
    });

    try {
      await request(app).get('/api/opencode/upgrade-status').expect(200);
      const npmCall = globalThis.fetch.mock.calls.find(([input]) => String(input).includes('mirror.example.com'));

      expect(npmCall[0]).toBe('https://mirror.example.com/npm/opencode-ai/latest');
      expect(npmCall[0]).not.toContain('test-password');
      expect(npmCall[1].headers.Authorization).toBe(`Basic ${Buffer.from('test-user:test-password').toString('base64')}`);
    } finally {
      if (previousLower === undefined) delete process.env.npm_config_registry;
      else process.env.npm_config_registry = previousLower;
      if (previous === undefined) delete process.env.NPM_CONFIG_REGISTRY;
      else process.env.NPM_CONFIG_REGISTRY = previous;
    }
  });

  it('serializes supported upgrades and preserves the in-flight lock', async () => {
    let releaseUpgrade;
    let signalUpgradeStarted;
    const upgradeStarted = new Promise((resolve) => {
      signalUpgradeStarted = resolve;
    });
    const upstreamResponse = new Promise((resolve) => {
      releaseUpgrade = () => resolve(new Response(JSON.stringify({ success: true, version: '1.18.9' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    globalThis.fetch = vi.fn(() => {
      signalUpgradeStarted();
      return upstreamResponse;
    });
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
    await upgradeStarted;
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

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
