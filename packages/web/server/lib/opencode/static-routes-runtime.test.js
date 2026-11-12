import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createStaticRoutesRuntime } from './static-routes-runtime.js';

const createRuntime = () => createStaticRoutesRuntime({
  fs: { existsSync: () => false },
  path: { join: (...parts) => parts.join('/'), resolve: (value) => value, sep: '/' },
  process: { env: {} },
  __dirname: '/server',
  express,
  resolveProjectDirectory: () => '',
  buildOpenCodeUrl: () => '',
  getOpenCodeAuthHeaders: () => ({}),
  readSettingsFromDiskMigrated: async () => ({}),
  normalizePwaAppName: (value) => value,
  normalizePwaOrientation: (value) => value,
});

const createServingRuntime = (distPath) => createStaticRoutesRuntime({
  fs,
  path,
  process: { env: { OPENCHAMBER_DIST_DIR: distPath } },
  __dirname: '/server',
  express,
  resolveProjectDirectory: () => '',
  buildOpenCodeUrl: () => '',
  getOpenCodeAuthHeaders: () => ({}),
  readSettingsFromDiskMigrated: async () => ({}),
  normalizePwaAppName: (value) => value,
  normalizePwaOrientation: (value) => value,
});

describe('static file caching', () => {
  let distPath;

  beforeAll(() => {
    distPath = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-static-routes-'));
    fs.mkdirSync(path.join(distPath, 'assets'));
    fs.writeFileSync(path.join(distPath, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(distPath, 'sw.js'), '');
    fs.writeFileSync(path.join(distPath, 'favicon.png'), '');
    fs.writeFileSync(path.join(distPath, 'assets', 'SettingsView-DkrERrCE.js'), 'export {}');
  });

  afterAll(() => {
    fs.rmSync(distPath, { recursive: true, force: true });
  });

  const serve = () => {
    const app = express();
    createServingRuntime(distPath).registerStaticRoutes(app);
    return app;
  };

  it('caches content-hashed assets as immutable', async () => {
    const response = await request(serve()).get('/assets/SettingsView-DkrERrCE.js');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('keeps unhashed files revalidated and the service worker uncached', async () => {
    const app = serve();

    const favicon = await request(app).get('/favicon.png');
    const serviceWorker = await request(app).get('/sw.js');

    expect(favicon.headers['cache-control']).toBe('public, max-age=0');
    expect(serviceWorker.headers['cache-control']).toBe('no-store');
  });
});

describe('static routes runtime', () => {
  it('returns API-only HTML fallback for browser UI routes', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const response = await request(app).get('/sessions/abc').set('Accept', 'text/html');

    expect(response.status).toBe(200);
    expect(response.text).toContain('OpenChamber is running in headless mode');
    expect(response.text).toContain('Open it from the OpenChamber desktop or mobile app');
    expect(response.text).toContain('openchamber connect-url --help');
    expect(response.text).toContain('Copy command');
  });

  it('returns API-only info JSON for JSON clients', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const response = await request(app).get('/sessions/abc').set('Accept', 'application/json');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      mode: 'api-only',
      message: 'OpenChamber is running in API-only mode',
    });
  });

  it('does not intercept API, auth, or health routes in API-only mode', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const api = await request(app).get('/api/version');
    const auth = await request(app).get('/auth/session');
    const health = await request(app).get('/health');

    expect(api.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber is running in API-only mode' });
    expect(auth.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber is running in API-only mode' });
    expect(health.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber is running in API-only mode' });
  });
});
