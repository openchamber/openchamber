import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { inspectGuestPackage, toPublicGuest } from './catalog.js';
import { registerGuestRoutes } from './routes.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-background-')); roots.push(root);
  const packageRoot = path.join(root, 'package');
  await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'background-test', version: '1.0.0', openchamber: {
    apiVersion: 1, contributes: {
      panel: { id: 'background-test', name: 'Background Test', icon: 'apps' },
      background: { entry: 'index.html' },
      capabilities: ['files'], commands: [{ name: 'test-background' }],
      actions: [{ id: 'count', label: 'Count', where: 'message', mode: 'background' }],
    },
  } }));
  return { root, packageRoot };
};

test('background-only packages validate HTML and built scripts and expose a separate catalog entry', async () => {
  const { packageRoot } = await fixture();
  expect(await inspectGuestPackage(packageRoot)).toMatchObject({ ok: false, code: 'invalid-manifest' });
  await fs.writeFile(path.join(packageRoot, 'index.html'), '<script src="main.js"></script>');
  await fs.writeFile(path.join(packageRoot, 'main.ts'), 'export {};');
  expect(await inspectGuestPackage(packageRoot)).toMatchObject({ ok: false, code: 'missing-build' });
  await fs.writeFile(path.join(packageRoot, 'main.js'), 'void 0;');
  const result = await inspectGuestPackage(packageRoot);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  const row = toPublicGuest(result.guest);
  expect(row.entry).toBeUndefined();
  expect(row.backgroundEntry).toBe('index.html');
  expect(row.attach).toBeUndefined();
  expect(row.actions).toHaveLength(1);
  expect(row.commands).toHaveLength(1);
  expect(row.capabilities).toEqual({ requested: ['files'], granted: [] });
});

test('background entry and its scripts cannot escape the installed package through symlinks', async () => {
  const { root, packageRoot } = await fixture();
  const outside = path.join(root, 'outside.html');
  await fs.writeFile(outside, '<p>Outside</p>');
  await fs.symlink(outside, path.join(packageRoot, 'index.html'));
  expect(await inspectGuestPackage(packageRoot)).toMatchObject({ ok: false, code: 'invalid-manifest' });
  await fs.unlink(path.join(packageRoot, 'index.html'));
  await fs.writeFile(path.join(packageRoot, 'index.html'), '<script src="main.js"></script>');
  await fs.writeFile(path.join(root, 'outside.js'), 'void 0;');
  await fs.symlink(path.join(root, 'outside.js'), path.join(packageRoot, 'main.js'));
  expect(await inspectGuestPackage(packageRoot)).toMatchObject({ ok: false, code: 'missing-build' });
});

test('background install serves sandboxed assets and storage obeys approval and enabled state', async () => {
  const { root, packageRoot } = await fixture();
  await fs.writeFile(path.join(packageRoot, 'index.html'), '<script src="main.js"></script>');
  await fs.writeFile(path.join(packageRoot, 'main.js'), 'void 0;');
  const app = express(); registerGuestRoutes(app, { openchamberDataDir: root, resolveGitBinaryForSpawn: () => 'git' });
  const installed = await request(app).post('/api/guests').send({ path: packageRoot }).expect(201);
  expect(installed.body.guest.backgroundEntry).toBe('index.html');
  expect(installed.body.guest.entry).toBeUndefined();
  const catalog = await request(app).get('/api/guests').expect(200);
  expect(catalog.body.guests[0].backgroundEntry).toBe('index.html');
  const html = await request(app).get('/api/guests/background-test/index.html?oc_url_token=test-scope').expect(200);
  expect(html.headers['content-security-policy']).toBe('sandbox allow-scripts');
  expect(html.text).toContain('main.js?oc_url_token=test-scope');
  expect((await request(app).get('/api/guests/background-test/main.js').expect(200)).text).toBe('void 0;');
  await request(app).post('/api/guests/background-test/storage').send({ op: 'set', key: 'count', value: 1 }).expect(400);
  await request(app).put('/api/guests/background-test/capabilities').send({ granted: ['files'] }).expect(200);
  await request(app).post('/api/guests/background-test/storage').send({ op: 'set', key: 'count', value: 1 }).expect(200);
  expect((await request(app).post('/api/guests/background-test/storage').send({ op: 'get', key: 'count' }).expect(200)).body).toMatchObject({ found: true, value: 1 });
  await request(app).put('/api/guests/background-test/enabled').send({ enabled: false }).expect(200);
  await request(app).post('/api/guests/background-test/storage').send({ op: 'set', key: 'count', value: 2 }).expect(400);
  await request(app).put('/api/guests/background-test/enabled').send({ enabled: true }).expect(200);
  expect((await request(app).post('/api/guests/background-test/storage').send({ op: 'get', key: 'count' }).expect(200)).body).toMatchObject({ value: 1 });
  await request(app).put('/api/guests/background-test/capabilities').send({ granted: [] }).expect(200);
  await request(app).post('/api/guests/background-test/storage').send({ op: 'get', key: 'count' }).expect(400);
});
