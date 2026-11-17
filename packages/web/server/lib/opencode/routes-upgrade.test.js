import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { OPENCODE_INFO_MAX_BYTES, OPENCODE_LATEST_VERSION_MAX_BYTES, registerOpenCodeRoutes, setOpenCodeInfoDeadlineForTest } from './routes.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setOpenCodeInfoDeadlineForTest();
});

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const oversizedInfoResponse = () => {
  let cancelled = false;
  let pulls = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(pulls === 1 ? OPENCODE_INFO_MAX_BYTES : 1).fill(32));
    },
    cancel() {
      cancelled = true;
    },
  }), { headers: { 'Content-Type': 'application/json' } });
  return { response, wasCancelled: () => cancelled };
};

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
  it('uses the configured registry for the v2 package version without exposing URL credentials', async () => {
    const previousRegistry = process.env.npm_config_registry;
    const previousUserConfig = process.env.npm_config_userconfig;
    process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
    process.env.npm_config_registry = 'https://user:p%40ss@mirror.example.com/npm/';
    globalThis.fetch = vi.fn(async (input) => jsonResponse({ version: String(input).endsWith('/api/info') ? '2.0.21' : '2.0.22' }));
    const { app } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });
    try {
      const response = await request(app).get('/api/opencode/upgrade-status').expect(200);
      expect(response.body).toMatchObject({ available: true, currentVersion: '2.0.21', latestVersion: '2.0.22' });
      const call = globalThis.fetch.mock.calls.find(([url]) => String(url).includes('mirror.example.com'));
      expect(String(call[0])).toBe('https://mirror.example.com/npm/@opencode%2Fcli/latest');
      expect(new Headers(call[1].headers).get('Authorization')).toBe(`Basic ${Buffer.from('user:p@ss').toString('base64')}`);
    } finally {
      if (previousRegistry === undefined) delete process.env.npm_config_registry;
      else process.env.npm_config_registry = previousRegistry;
      if (previousUserConfig === undefined) delete process.env.npm_config_userconfig;
      else process.env.npm_config_userconfig = previousUserConfig;
    }
  });

  it('pins the registry /latest byte cap at 1 MiB', () => {
    expect(OPENCODE_LATEST_VERSION_MAX_BYTES).toBe(1024 * 1024);
  });

  it('rejects an over-cap chunked registry /latest body without parsing it', async () => {
    let cancelled = false;
    let pulledBytes = 0;
    const chunk = new Uint8Array(64 * 1024).fill(120);
    const stream = new ReadableStream({
      pull(controller) {
        pulledBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = vi.fn(async (input) => (String(input).endsWith('/api/info')
      ? jsonResponse({ version: '2.0.21' })
      : new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const { app } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });

    const response = await request(app).get('/api/opencode/upgrade-status').expect(500);

    expect(response.body).toEqual({
      available: null,
      error: `OpenCode npm registry latest document exceeds ${OPENCODE_LATEST_VERSION_MAX_BYTES} bytes`,
    });
    expect(cancelled).toBe(true);
    // The reader may pull ahead of the cancelling read by a chunk or two;
    // what matters is that consumption stops near the cap, not at 32 MiB.
    expect(pulledBytes).toBeLessThanOrEqual(OPENCODE_LATEST_VERSION_MAX_BYTES + 2 * chunk.byteLength);
  });

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
    const previousRegistry = process.env.npm_config_registry;
    const previousUserConfig = process.env.npm_config_userconfig;
    process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
    process.env.npm_config_registry = 'https://registry.npmjs.org';
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('registry.npmjs.org')) return jsonResponse({ version: '2.0.3' });
      if (String(url).includes('api.github.com')) return jsonResponse({ tag_name: 'v2.0.3' });
      return jsonResponse({ version: '1.18.8', pid: 1, urls: [], paths: { tmp: '/tmp' } });
    });
    const { app } = createApp();
    try {
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
    } finally {
      if (previousRegistry === undefined) delete process.env.npm_config_registry;
      else process.env.npm_config_registry = previousRegistry;
      if (previousUserConfig === undefined) delete process.env.npm_config_userconfig;
      else process.env.npm_config_userconfig = previousUserConfig;
    }
  });

  it('never claims an upgrade for a malformed version on either side', async () => {
    const availableFor = async (currentVersion, latestVersion) => {
      globalThis.fetch = vi.fn(async (input) => jsonResponse({ version: String(input).endsWith('/api/info') ? currentVersion : latestVersion }));
      const { app } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });
      const response = await request(app).get('/api/opencode/upgrade-status').expect(200);
      return response.body.available;
    };

    // Trailing junk: parseInt('1junk') is 1, so this read as 2.1 > 2.0.9.
    expect(await availableFor('2.0.9', '2.1junk')).toBe(false);
    // Empty part: parseInt('') fell back to 0, so the installed '2..1' read as 2.0.1 < 2.0.2.
    expect(await availableFor('2..1', '2.0.2')).toBe(false);
    // Non-numeric part: read as 0, so '2.0.x' silently equalled a real 2.0.0.
    expect(await availableFor('2.0.0', '2.0.x')).toBe(false);
    // Parseable versions still compare normally, prerelease included.
    expect(await availableFor('2.0.1', '2.0.2')).toBe(true);
    expect(await availableFor('2.0.2', '2.0.2-beta.1')).toBe(false);
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

describe('OpenCode version route probe deadlines (#796)', () => {
  const stalledInfoFetch = (input, init) => {
    if (String(input).endsWith('/api/info')) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }
    return Promise.resolve(jsonResponse({ version: '2.0.22' }));
  };

  it('settles /api/opencode/version with its error shape when /api/info never answers', async () => {
    setOpenCodeInfoDeadlineForTest(50);
    globalThis.fetch = vi.fn(stalledInfoFetch);
    const { app } = createApp();
    const started = Date.now();
    const response = await request(app).get('/api/opencode/version').expect(500);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(response.body.version).toBeNull();
    expect(String(response.body.error ?? '').length).toBeGreaterThan(0);
    const infoCall = globalThis.fetch.mock.calls.find(([url]) => String(url).endsWith('/api/info'));
    expect(infoCall[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('reads the /api/info body before the registry settles, so a slow registry cannot abort a prompt answer', async () => {
    setOpenCodeInfoDeadlineForTest(50);
    globalThis.fetch = vi.fn(async (input, init) => {
      if (String(input).endsWith('/api/info')) {
        const body = JSON.stringify({ version: '2.0.21', pid: 1, urls: [], paths: { tmp: '/tmp' } });
        const stream = new ReadableStream({
          pull(controller) {
            if (init?.signal?.aborted) {
              controller.error(new DOMException('The operation was aborted.', 'AbortError'));
              return;
            }
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'application/json' } });
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      return jsonResponse({ version: '2.0.22' });
    });
    const { app } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });

    const response = await request(app).get('/api/opencode/upgrade-status').expect(200);

    expect(response.body).toMatchObject({ available: true, currentVersion: '2.0.21', latestVersion: '2.0.22' });
  });

  it('settles /api/opencode/upgrade-status with its error shape when /api/info never answers', async () => {
    setOpenCodeInfoDeadlineForTest(50);
    globalThis.fetch = vi.fn(stalledInfoFetch);
    const { app } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });
    const started = Date.now();
    const response = await request(app).get('/api/opencode/upgrade-status').expect(500);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(response.body.available).toBeNull();
    expect(String(response.body.error ?? '').length).toBeGreaterThan(0);
  });

  it('answers /api/opencode/version on the healthy path', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ version: '2.0.21' }));
    const { app } = createApp();
    const response = await request(app).get('/api/opencode/version').expect(200);
    expect(response.body).toEqual({ version: '2.0.21' });
  });

  it('does not treat an oversized /api/info body as a version answer', async () => {
    const oversized = oversizedInfoResponse();
    globalThis.fetch = vi.fn(async () => oversized.response);
    const { app } = createApp();

    const response = await request(app).get('/api/opencode/version').expect(200);

    expect(response.body).toEqual({ version: null });
    expect(oversized.wasCancelled()).toBe(true);
  });

  it('does not treat an oversized /api/info body as a healthy probe', async () => {
    const oversized = oversizedInfoResponse();
    globalThis.fetch = vi.fn(async () => oversized.response);
    const { app } = createApp();

    const response = await request(app).get('/api/opencode/health').expect(200);

    expect(response.body).toEqual({ healthy: false });
    expect(oversized.wasCancelled()).toBe(true);
  });
});
