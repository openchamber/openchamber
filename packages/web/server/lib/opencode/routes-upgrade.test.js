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
    upgradeOpenCodeCli: vi.fn(async () => {}),
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

  it('never announces a newer version for a bundled binary: it updates with the desktop app', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('registry.npmjs.org')) return jsonResponse({ version: '2.0.3' });
      if (String(url).includes('api.github.com')) return jsonResponse({ tag_name: 'v2.0.3' });
      return jsonResponse({ version: '1.18.8', pid: 1, urls: [], paths: { tmp: '/tmp' } });
    });
    const { app } = createApp();

    const response = await request(app)
      .get('/api/opencode/upgrade-status')
      .expect(200);

    expect(response.body).toEqual({
      available: false,
      currentVersion: '1.18.8',
      latestVersion: '2.0.3',
      upgrade: {
        supported: false,
        manager: 'openchamber',
        reason: 'bundled',
      },
    });
  });

  it('runs the managed CLI and leaves restart to the existing Reload action', async () => {
    globalThis.fetch = vi.fn();
    const { app, dependencies } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });
    await request(app).post('/api/opencode/upgrade').send({ target: 'ignored', binary: 'ignored' })
      .expect(200, { success: true });
    expect(dependencies.upgradeOpenCodeCli).toHaveBeenCalledExactlyOnceWith();
    expect(dependencies.refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(['external', 'unavailable'])('rejects %s on the server', async (reason) => {
    const { app, dependencies } = createApp({ getOpenCodeUpgradeCapability: () => ({ supported: false, reason }) });
    await request(app).post('/api/opencode/upgrade').send({}).expect(409);
    expect(dependencies.upgradeOpenCodeCli).not.toHaveBeenCalled();
  });

  it('shares an installation between concurrent requests and allows retry after failure', async () => {
    let fail;
    let started;
    const began = new Promise((resolve) => { started = resolve; });
    const upgradeOpenCodeCli = vi.fn(() => { started(); return new Promise((_resolve, reject) => { fail = reject; }); });
    let arrived;
    let requests = 0;
    const bothArrived = new Promise((resolve) => { arrived = resolve; });
    const { app } = createApp({ getOpenCodeUpgradeCapability: () => {
      requests += 1;
      if (requests === 2) arrived();
      return supportedCapability;
    }, upgradeOpenCodeCli });
    const first = request(app).post('/api/opencode/upgrade').send({}).then((response) => response);
    await began;
    const second = request(app).post('/api/opencode/upgrade').send({}).then((response) => response);
    await bothArrived;
    fail(new Error('Installation failed'));
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([500, 500]);
    expect(upgradeOpenCodeCli).toHaveBeenCalledTimes(1);
    upgradeOpenCodeCli.mockResolvedValueOnce();
    await request(app).post('/api/opencode/upgrade').send({}).expect(200);
    expect(upgradeOpenCodeCli).toHaveBeenCalledTimes(2);
  });
});

describe('OpenCode v1 migration routes', () => {
  it('rejects external, bundled and unsupported runtimes before running an installer', async () => {
    for (const installation of ['external', 'bundled', 'managed']) {
      const installOpenCodeV2 = vi.fn();
      const { app } = createApp({
        getOpenCodeCompatibility: async () => ({ state: 'incompatible', version: '1.18.30', installation, canInstall: false }),
        installOpenCodeV2,
      });
      await request(app).post('/api/opencode/install-v2').send({ binary: '/untrusted', command: 'untrusted' }).expect(409);
      expect(installOpenCodeV2).not.toHaveBeenCalled();
    }
  });

  it('shares installation and restart across concurrent requests and permits retry after failure', async () => {
    let finish;
    const installOpenCodeV2 = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { app } = createApp({
      getOpenCodeCompatibility: async () => ({ state: 'incompatible', version: '1.18.30', installation: 'managed', canInstall: true }),
      installOpenCodeV2,
    });
    const first = request(app).post('/api/opencode/install-v2').then(response => response);
    const second = request(app).post('/api/opencode/install-v2').then(response => response);
    await vi.waitFor(() => expect(installOpenCodeV2).toHaveBeenCalledTimes(1));
    finish();
    const replies = await Promise.all([first, second]);
    expect(replies.map(reply => reply.status)).toEqual([200, 200]);
    installOpenCodeV2.mockRejectedValueOnce(new Error('private installer output'));
    const failed = await request(app).post('/api/opencode/install-v2').expect(500);
    expect(JSON.stringify(failed.body)).not.toContain('private installer output');
    installOpenCodeV2.mockResolvedValueOnce(undefined);
    await request(app).post('/api/opencode/install-v2').expect(200);
  });
});
