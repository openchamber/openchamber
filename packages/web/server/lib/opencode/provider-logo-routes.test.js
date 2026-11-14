import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';

import { PROVIDER_LOGO_MAX_BYTES, registerProviderLogoRoutes } from './provider-logo-routes.js';

// `persist`: 'ok', 'fails' (a full disk), or 'drops' (preferences.json unreadable: the save resolves without profile keys).
const createHarness = (dataDir, { persist = 'ok', unlinkFails = false } = {}) => {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'put', 'delete'].map((method) => [
    method,
    (routePath, handler) => routes.set(`${method.toUpperCase()} ${routePath}`, handler),
  ]));
  let settings = {};

  const unlink = async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  registerProviderLogoRoutes(app, {
    fsPromises: unlinkFails ? { ...fsPromises, unlink } : fsPromises,
    path,
    crypto,
    openchamberDataDir: dataDir,
    readSettingsFromDiskMigrated: async () => settings,
    persistResolvedSettings: async (resolve) => {
      if (persist === 'fails') throw new Error('disk full');
      const changes = resolve(settings);
      if (persist === 'drops') return settings;
      // Let a concurrent request run between the read and the write, as a real disk would.
      await new Promise((done) => setTimeout(done, 5));
      settings = { ...settings, ...changes };
      return settings;
    },
  });

  const call = async (method, { providerId = 'acme', body, query = {} } = {}) => {
    const headers = new Map();
    const res = {
      statusCode: 200,
      body: undefined,
      setHeader(name, value) { headers.set(name.toLowerCase(), value); },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
      send(payload) { this.body = payload; return this; },
      header: (name) => headers.get(name.toLowerCase()),
    };
    await routes.get(`${method} /api/provider/:providerId/logo`)({ params: { providerId }, body, query }, res);
    return res;
  };

  return {
    call,
    get settings() { return settings; },
    set settings(next) { settings = next; },
  };
};

const dataUrl = (mime, content) => `data:${mime};base64,${Buffer.from(content).toString('base64')}`;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="M0 0h16v16H0z"/></svg>';

describe('provider logo routes', () => {
  let dataDir;
  const logoFiles = async () => (await fsPromises.readdir(path.join(dataDir, 'provider-logos')).catch(() => [])).sort();

  beforeEach(async () => {
    dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'provider-logos-'));
  });
  afterEach(async () => {
    await fsPromises.rm(dataDir, { recursive: true, force: true });
  });

  it('refuses a type it does not serve and an image over the size limit, writing nothing', async () => {
    const harness = createHarness(dataDir);

    const gif = await harness.call('PUT', { body: { dataUrl: dataUrl('image/gif', 'GIF89a') } });
    expect(gif.statusCode).toBe(400);
    expect(gif.body.error).toBe('Logo must be PNG, JPEG, WebP or SVG');

    const large = await harness.call('PUT', { body: { dataUrl: dataUrl('image/png', Buffer.alloc(PROVIDER_LOGO_MAX_BYTES + 1)) } });
    expect(large.statusCode).toBe(400);
    expect(large.body.error).toBe('Logo exceeds size limit (1 MB)');

    const notDataUrl = await harness.call('PUT', { body: { dataUrl: 'https://example.com/logo.png' } });
    expect(notDataUrl.statusCode).toBe(400);

    // A name every object has must not pass for a supported type.
    const prototypeKey = await harness.call('PUT', { body: { dataUrl: dataUrl('constructor', 'x') } });
    expect(prototypeKey.statusCode).toBe(400);

    expect(await logoFiles()).toEqual([]);
    expect(harness.settings).toEqual({});
  });

  it('stores an upload, serves it inert, and replaces the previous format', async () => {
    const harness = createHarness(dataDir);

    const png = await harness.call('PUT', { body: { dataUrl: dataUrl('image/png', 'png-bytes') } });
    expect(png.statusCode).toBe(200);
    expect(png.body.logo).toEqual({ mime: 'image/png', updatedAt: expect.any(Number) });
    expect(harness.settings.customProviderLogos.acme).toEqual(png.body.logo);

    const served = await harness.call('GET', { query: { v: String(png.body.logo.updatedAt) } });
    expect(served.statusCode).toBe(200);
    expect(served.header('Content-Type')).toBe('image/png');
    expect(Buffer.from(served.body).toString()).toBe('png-bytes');
    // An upload opened as a page must not run scripts on the app's origin.
    expect(served.header('Content-Security-Policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(served.header('X-Content-Type-Options')).toBe('nosniff');
    expect(served.header('Cache-Control')).toContain('immutable');

    await harness.call('PUT', { body: { dataUrl: dataUrl('image/svg+xml', SVG) } });
    expect(harness.settings.customProviderLogos.acme.mime).toBe('image/svg+xml');
    expect((await logoFiles()).map((name) => path.extname(name))).toEqual(['.svg']);
  });

  it('colours an SVG for the requested theme and serves it untouched otherwise', async () => {
    const harness = createHarness(dataDir);
    await harness.call('PUT', { providerId: 'campus-llm', body: { dataUrl: dataUrl('image/svg+xml', SVG) } });

    const dark = await harness.call('GET', { providerId: 'campus-llm', query: { theme: 'dark' } });
    expect(dark.header('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    expect(dark.body).toContain(':root{color:#f5f5f5!important;}');
    expect(dark.header('Content-Security-Policy')).toContain('sandbox');

    for (const theme of ['sepia', 'constructor']) {
      const plain = await harness.call('GET', { providerId: 'campus-llm', query: { theme } });
      expect(Buffer.from(plain.body).toString()).toBe(SVG);
    }
  });

  it('answers 404 when no logo is stored, its file is gone, or the stored entry cannot name a file', async () => {
    const harness = createHarness(dataDir);
    expect((await harness.call('GET')).statusCode).toBe(404);

    harness.settings = { customProviderLogos: { acme: { mime: 'image/png', updatedAt: 1 } } };
    expect((await harness.call('GET')).statusCode).toBe(404);

    harness.settings = { customProviderLogos: { acme: { mime: 'image/png', updatedAt: '1/../../x' } } };
    expect((await harness.call('GET')).statusCode).toBe(404);
  });

  it('reports a saved change as saved when an old file cannot be removed', async () => {
    const harness = createHarness(dataDir);
    await harness.call('PUT', { body: { dataUrl: dataUrl('image/png', 'old') } });

    const busy = createHarness(dataDir, { unlinkFails: true });
    busy.settings = harness.settings;
    const replaced = await busy.call('PUT', { body: { dataUrl: dataUrl('image/png', 'new') } });
    expect(replaced.statusCode).toBe(200);
    expect(Buffer.from((await busy.call('GET')).body).toString()).toBe('new');

    const removed = await busy.call('DELETE');
    expect(removed.statusCode).toBe(200);
    expect(busy.settings.customProviderLogos).toEqual({});
  });

  it('removes the setting and the file, and a second delete is a no-op', async () => {
    const harness = createHarness(dataDir);
    await harness.call('PUT', { body: { dataUrl: dataUrl('image/webp', 'webp-bytes') } });
    await harness.call('PUT', { providerId: 'other', body: { dataUrl: dataUrl('image/png', 'png-bytes') } });

    const removed = await harness.call('DELETE');
    expect(removed.statusCode).toBe(200);
    expect(removed.body).toEqual({ logo: null });
    expect(Object.keys(harness.settings.customProviderLogos)).toEqual(['other']);
    expect(await logoFiles()).toHaveLength(1);
    expect((await harness.call('GET')).statusCode).toBe(404);

    expect((await harness.call('DELETE')).statusCode).toBe(200);
  });

  it.each(['fails', 'drops'])('keeps serving the previous logo when the new one cannot be recorded (%s)', async (persist) => {
    const harness = createHarness(dataDir);
    await harness.call('PUT', { body: { dataUrl: dataUrl('image/png', 'old') } });
    const before = await logoFiles();

    const failing = createHarness(dataDir, { persist });
    failing.settings = harness.settings;
    // The same format as the stored logo: its file must not be rewritten.
    const response = await failing.call('PUT', { body: { dataUrl: dataUrl('image/png', 'new') } });
    expect(response.statusCode).toBe(500);

    const served = await harness.call('GET');
    expect(served.statusCode).toBe(200);
    expect(Buffer.from(served.body).toString()).toBe('old');
    expect(await logoFiles()).toEqual(before);
  });

  it('ends with one served logo when two uploads race', async () => {
    const harness = createHarness(dataDir);
    const [png, svg] = await Promise.all([
      harness.call('PUT', { body: { dataUrl: dataUrl('image/png', 'png-bytes') } }),
      harness.call('PUT', { body: { dataUrl: dataUrl('image/svg+xml', SVG) } }),
    ]);
    expect([png.statusCode, svg.statusCode]).toEqual([200, 200]);
    expect(harness.settings.customProviderLogos.acme).toEqual(svg.body.logo);
    expect(svg.body.logo.updatedAt).toBeGreaterThan(png.body.logo.updatedAt);
    expect(await logoFiles()).toHaveLength(1);
    expect((await harness.call('GET')).statusCode).toBe(200);
  });

  it('refuses a provider ID it would not keep in settings', async () => {
    const harness = createHarness(dataDir);
    expect((await harness.call('PUT', { providerId: '   ', body: { dataUrl: dataUrl('image/png', 'x') } })).statusCode).toBe(400);
    expect((await harness.call('GET', { providerId: 'x'.repeat(129) })).statusCode).toBe(400);
  });
});
