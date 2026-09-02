import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const supportedCapability = { supported: true, manager: 'opencode', reason: null };

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

  it('names the latest release as the upgrade target when the caller sends none', async () => {
    const requests = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).includes('registry.npmjs.org')) {
        return jsonResponse({ version: '1.18.23' });
      }
      if (String(url).includes('api.github.com')) {
        return jsonResponse({ tag_name: 'v1.18.23' });
      }
      return jsonResponse({ success: true, version: '1.18.23' });
    });
    const { app } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });

    await request(app)
      .post('/api/opencode/upgrade')
      .send({})
      .expect(200, { success: true, version: '1.18.23', restarted: true });

    const upgradeRequest = requests.find((entry) => entry.url.includes('/global/upgrade'));
    expect(upgradeRequest?.body).toEqual({ target: '1.18.23' });
  });

  it('keeps an explicitly requested target instead of resolving the latest release', async () => {
    const requests = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return jsonResponse({ success: true, version: '1.18.20' });
    });
    const { app } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });

    await request(app)
      .post('/api/opencode/upgrade')
      .send({ target: '1.18.20' })
      .expect(200);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('/global/upgrade');
    expect(requests[0].body).toEqual({ target: '1.18.20' });
  });

  it('fails without calling the updater when the latest release cannot be resolved', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/global/upgrade')) {
        throw new Error('the updater must not be called without a target');
      }
      return new Response('nope', { status: 503 });
    });
    const { app, dependencies } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });

    const response = await request(app)
      .post('/api/opencode/upgrade')
      .send({})
      .expect(502);

    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('OPENCODE_UPGRADE_TARGET_UNRESOLVED');
    expect(response.body.error).toContain('Could not determine which OpenCode version to install');
    expect(dependencies.refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
  });

  it('surfaces the rejection OpenCode reported instead of the bare HTTP status', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/global/upgrade')) {
        return jsonResponse(
          { name: 'BadRequest', data: { message: 'Expected a semantic version', kind: 'Payload' } },
          400,
        );
      }
      return jsonResponse({ version: '1.18.23' });
    });
    const { app } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });

    await request(app)
      .post('/api/opencode/upgrade')
      .send({})
      .expect(400, { success: false, error: 'Expected a semantic version' });
  });

  it('serializes supported upgrades and preserves the in-flight lock', async () => {
    let releaseUpgrade;
    const upstreamResponse = new Promise((resolve) => {
      releaseUpgrade = () => resolve(jsonResponse({ success: true, version: '1.18.9' }));
    });
    const upgradeCalls = vi.fn();
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('/global/upgrade')) {
        upgradeCalls();
        return upstreamResponse;
      }
      return Promise.resolve(jsonResponse({ version: '1.18.9' }));
    });
    const { app, dependencies } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });

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
      expect(upgradeCalls).toHaveBeenCalledTimes(1);
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
