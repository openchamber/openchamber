import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createGuestFrameGrants } from './frame-grants.js';
import { registerGuestRoutes } from './routes.js';

describe('extension frame grants', () => {
  test('a grant names one extension and lapses only after a long idle stretch', () => {
    let at = 0;
    const grants = createGuestFrameGrants({ now: () => at });
    const { grant } = grants.mint('resource-monitor');
    expect(grants.use(grant)).toBe('resource-monitor');

    // Each use keeps it alive.
    at += 11 * 60 * 60 * 1000;
    expect(grants.use(grant)).toBe('resource-monitor');
    at += 11 * 60 * 60 * 1000;
    expect(grants.use(grant)).toBe('resource-monitor');

    at += 13 * 60 * 60 * 1000;
    expect(grants.use(grant)).toBeNull();
  });

  test('anything but a minted grant opens nothing', () => {
    const grants = createGuestFrameGrants();
    grants.mint('resource-monitor');
    expect(grants.use('resource-monitor')).toBeNull();
    expect(grants.use('x'.repeat(32))).toBeNull();
    expect(grants.use('../../etc')).toBeNull();
    expect(grants.use(undefined)).toBeNull();
  });
});

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

const installedPanel = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-frame-grant-')); roots.push(root);
  const packageRoot = path.join(root, 'package');
  await fs.mkdir(path.join(packageRoot, 'data'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'frame-test', version: '1.0.0', openchamber: {
    apiVersion: 1, contributes: { panel: { id: 'frame-test', name: 'Frame Test', icon: 'apps', entry: 'index.html' } },
  } }));
  await fs.writeFile(path.join(packageRoot, 'index.html'), '<script src="main.js"></script>');
  await fs.writeFile(path.join(packageRoot, 'main.js'), "fetch('data/items.json');");
  await fs.writeFile(path.join(packageRoot, 'data', 'items.json'), '[]');
  await fs.writeFile(path.join(root, 'secret.txt'), 'outside');
  const app = express();
  registerGuestRoutes(app, { openchamberDataDir: root, resolveGitBinaryForSpawn: () => 'git' });
  await request(app).post('/api/guests').send({ path: packageRoot }).expect(201);
  return { app };
};

describe('extension files by grant', () => {
  test('a grant opens the package, files the page fetches itself included, and keeps the page on its own path', async () => {
    const { app } = await installedPanel();
    const { grant } = (await request(app).post('/api/guests/frame-test/frame-grant').expect(200)).body;

    const html = await request(app).get(`/api/guest-files/${grant}/index.html`).set('Host', 'oc.example.com').expect(200);
    expect(html.headers['content-security-policy']).toMatch(/^sandbox allow-scripts; default-src 'none';/);
    expect(html.headers['content-security-policy']).toContain(`connect-src oc.example.com/api/guest-files/${grant}/`);
    expect(html.headers['access-control-allow-origin']).toBe('null');
    // Nothing is appended: relative URLs resolve under the grant on their own.
    expect(html.text).toContain('src="main.js"');
    expect(html.text).not.toContain('oc_url_token');

    expect((await request(app).get(`/api/guest-files/${grant}/main.js`).expect(200)).text).toBe("fetch('data/items.json');");
    expect((await request(app).get(`/api/guest-files/${grant}/data/items.json`).expect(200)).text).toBe('[]');
  });

  test('a wrong grant or a path out of the package opens nothing', async () => {
    const { app } = await installedPanel();
    const { grant } = (await request(app).post('/api/guests/frame-test/frame-grant').expect(200)).body;

    await request(app).get(`/api/guest-files/${'a'.repeat(32)}/index.html`).expect(403);
    await request(app).get('/api/guest-files/frame-test/index.html').expect(403);
    await request(app).get(`/api/guest-files/${grant}/..%2Fsecret.txt`).expect(404);
    await request(app).get(`/api/guest-files/${grant}/../secret.txt`).expect(404);
  });

  test('only an installed extension with a page gets a grant, and removing it closes the grant', async () => {
    const { app } = await installedPanel();
    await request(app).post('/api/guests/not-installed/frame-grant').expect(404);
    const { grant } = (await request(app).post('/api/guests/frame-test/frame-grant').expect(200)).body;

    await request(app).delete('/api/guests/frame-test').expect(204);
    await request(app).get(`/api/guest-files/${grant}/index.html`).expect(404);
  });
});
