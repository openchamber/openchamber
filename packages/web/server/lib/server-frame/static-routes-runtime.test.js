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

describe('html document revalidation across builds', () => {
  const builds = [];

  // Nix stamps every build output with the same mtime, and two builds' documents can have the same size.
  const serveBuild = (assetName) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-static-build-'));
    builds.push(dir);
    const html = `<!doctype html><script type="module" src="/assets/${assetName}"></script>`;
    for (const name of ['index.html', 'mobile.html']) {
      fs.writeFileSync(path.join(dir, name), html);
      fs.utimesSync(path.join(dir, name), 1, 1);
    }
    const app = express();
    createServingRuntime(dir).registerStaticRoutes(app);
    return app;
  };

  afterAll(() => {
    for (const dir of builds) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers a validator from an older same-size build with the new document', async () => {
    const oldBuild = serveBuild('index-AAAAAAAA.js');
    const newBuild = serveBuild('index-BBBBBBBB.js');

    for (const url of ['/', '/sessions/abc', '/mobile.html']) {
      const cached = await request(oldBuild).get(url);
      const byETag = await request(newBuild).get(url).set('If-None-Match', cached.headers.etag);
      const byDate = await request(newBuild).get(url).set('If-Modified-Since', new Date(1000).toUTCString());

      expect(byETag.status).toBe(200);
      expect(byETag.text).toContain('index-BBBBBBBB.js');
      expect(byETag.headers['cache-control']).toBe('no-cache');
      expect(byDate.status).toBe(200);
    }
  });

  it('treats an encoded spelling of a document like the document itself', async () => {
    const oldBuild = serveBuild('index-DDDDDDDD.js');
    const newBuild = serveBuild('index-EEEEEEEE.js');

    for (const url of ['/inde%78.html', '/mobile%2Ehtml', '/%2Fmobile.html', '//mobile.html', '/.%2Fmobile.html']) {
      const cached = await request(oldBuild).get(url);
      const byETag = await request(newBuild).get(url).set('If-None-Match', cached.headers.etag);
      const byDate = await request(newBuild).get(url).set('If-Modified-Since', new Date(1000).toUTCString());
      const current = await request(newBuild).get(url).set('If-None-Match', byETag.headers.etag);

      expect(cached.status).toBe(200);
      expect(cached.headers['last-modified']).toBeUndefined();
      expect(byETag.status).toBe(200);
      expect(byETag.text).toContain('index-EEEEEEEE.js');
      expect(byDate.status).toBe(200);
      expect(byDate.text).toContain('index-EEEEEEEE.js');
      expect(current.status).toBe(304);
    }
  });

  it('keeps encoded names that leave the dist root out of the document route', async () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-static-outer-'));
    builds.push(outer);
    const dist = path.join(outer, 'dist');
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html>inside');
    fs.writeFileSync(path.join(outer, 'outside.html'), '<!doctype html>outside');
    const app = express();
    createServingRuntime(dist).registerStaticRoutes(app);

    const traversal = await request(app).get('/..%2Foutside.html');
    const backslash = await request(app).get('/..%5Coutside.html');
    const malformed = await request(app).get('/%E0%A4%A.html');

    expect(traversal.text).not.toContain('outside');
    expect(backslash.text).not.toContain('outside');
    expect(malformed.status).toBeLessThan(500);
  });

  it('answers an unchanged document with 304', async () => {
    const build = serveBuild('index-CCCCCCCC.js');

    const first = await request(build).get('/');
    const again = await request(build).get('/').set('If-None-Match', first.headers.etag);

    expect(again.status).toBe(304);
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
