import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { GUEST_SCROLLBAR_CSS } from '@openchamber/sdk';
import { GUEST_ASSET_MAX_BYTES } from './catalog.js';
import * as catalog from './catalog.js';
import { writeExtensionStore } from './persist.js';

const roots = [];
afterEach(async () => { serveStatIsStale = false; await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

// Regression harness for #1436: when serveStatIsStale is set, the resolver
// reports the size the file had while it was still small — a file grown
// after the resolver's stat. The serve handler must judge the cap from
// the read itself, not from this number.
let serveStatIsStale = false;
mock.module('./catalog.js', () => ({
  ...catalog,
  resolveGuestServedFile: async (...args) => {
    const served = await catalog.resolveGuestServedFile(...args);
    return served && serveStatIsStale ? { ...served, size: 100 } : served;
  },
}));

const { registerGuestRoutes } = await import('./routes.js');

const makeGuest = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-cap-')); roots.push(root);
  const packageRoot = path.join(root, 'guest'); await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, 'index.html'), '<!doctype html><html><head></head><body><script src="main.js"></script></body></html>');
  await fs.writeFile(path.join(packageRoot, 'main.js'), 'console.log("small");');
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'guest', version: '1.0.0', openchamber: { apiVersion: 1, contributes: { panel: { id: 'cap-guest', name: 'Cap', icon: 'apps', entry: 'index.html' } } } }));
  await writeExtensionStore(path.join(root, 'extensions.json'), { paths: [packageRoot], sources: { [packageRoot]: 'path' } });
  const app = express(); registerGuestRoutes(app, { openchamberDataDir: root });
  return { root, packageRoot, app };
};

describe('guest asset serve byte cap (#1116)', () => {
  test('refuses an over-cap asset with 413 before reading it whole', async () => {
    const { packageRoot, app } = await makeGuest();
    await fs.writeFile(path.join(packageRoot, 'big.js'), 'x'.repeat(GUEST_ASSET_MAX_BYTES + 1));
    await fs.writeFile(path.join(packageRoot, 'big.html'), 'y'.repeat(GUEST_ASSET_MAX_BYTES + 1));
    const js = await request(app).get('/api/guests/cap-guest/big.js').set('Host', 'oc.test');
    expect(js.status).toBe(413);
    expect(js.body).toEqual({ error: 'file-too-large' });
    expect(js.text).not.toContain('xxxxxxxxxx');
    const html = await request(app).get('/api/guests/cap-guest/big.html').set('Host', 'oc.test');
    expect(html.status).toBe(413);
    expect(html.body).toEqual({ error: 'file-too-large' });
  });

  test('refuses an asset grown after the resolver stat with 413 (#1436)', async () => {
    const { packageRoot, app } = await makeGuest();
    await fs.writeFile(path.join(packageRoot, 'grown.js'), 'x'.repeat(GUEST_ASSET_MAX_BYTES + 500_000));
    serveStatIsStale = true;
    const response = await request(app).get('/api/guests/cap-guest/grown.js').set('Host', 'oc.test');
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'file-too-large' });
    expect(response.text).not.toContain('xxxxxxxxxx');
  });

  test('serves a file at exactly the cap byte-identically', async () => {
    const { packageRoot, app } = await makeGuest();
    const atCap = 'a'.repeat(GUEST_ASSET_MAX_BYTES);
    await fs.writeFile(path.join(packageRoot, 'at-cap.js'), atCap);
    const response = await request(app).get('/api/guests/cap-guest/at-cap.js').set('Host', 'oc.test').expect(200);
    expect(response.text).toBe(atCap);
  });

  test('serves in-cap HTML with token propagation and style injection', async () => {
    const { app } = await makeGuest();
    const response = await request(app).get('/api/guests/cap-guest/index.html?oc_url_token=tok123').set('Host', 'oc.test').expect(200);
    expect(response.text).toContain('main.js?oc_url_token=tok123');
    expect(response.text).toContain(GUEST_SCROLLBAR_CSS);
  });

  test('keeps 404 for missing files and tools-only frame content', async () => {
    const { root, packageRoot, app } = await makeGuest();
    await request(app).get('/api/guests/cap-guest/missing.js').set('Host', 'oc.test').expect(404);
    // A tools-only guest (no panel/background/status/file-editor entry) still
    // serves its icon but never HTML or JS.
    const toolsRoot = path.join(root, 'tools-guest'); await fs.mkdir(toolsRoot);
    await fs.writeFile(path.join(toolsRoot, 'icon.svg'), '<svg></svg>');
    await fs.writeFile(path.join(toolsRoot, 'page.html'), '<html></html>');
    await fs.writeFile(path.join(toolsRoot, 'package.json'), JSON.stringify({ name: 'tools', version: '1.0.0', openchamber: { apiVersion: 1, contributes: { panel: { id: 'tools-guest', name: 'Tools', icon: 'icon.svg' } } } }));
    await writeExtensionStore(path.join(root, 'extensions.json'), { paths: [packageRoot, toolsRoot], sources: { [packageRoot]: 'path', [toolsRoot]: 'path' } });
    const toolsApp = express(); registerGuestRoutes(toolsApp, { openchamberDataDir: root });
    await request(toolsApp).get('/api/guests/tools-guest/icon.svg').set('Host', 'oc.test').expect(200);
    await request(toolsApp).get('/api/guests/tools-guest/page.html').set('Host', 'oc.test').expect(404);
  });
});
