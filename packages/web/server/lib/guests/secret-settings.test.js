import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { getGuestAuth, guestAuthPersistPath } from './auth-store.js';
import { registerGuestRoutes } from './routes.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const installed = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-secret-settings-'));
  roots.push(root);
  const packageRoot = path.join(root, 'package');
  await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'secret-test', version: '1.0.0', openchamber: {
    apiVersion: 1,
    contributes: {
      panel: { id: 'secret-test', name: 'Secret Test', icon: 'apps', entry: 'index.html' },
      integration: {
        name: 'Acme',
        description: 'Tasks',
        token: { apiOrigin: 'https://api.acme.example' },
        settings: [{ id: 'workspace', label: 'Workspace' }, { id: 'key', label: 'Key', secret: true }],
      },
    },
  } }));
  await fs.writeFile(path.join(packageRoot, 'index.html'), '<script src="main.js"></script>');
  await fs.writeFile(path.join(packageRoot, 'main.js'), 'void 0;');
  const app = express();
  registerGuestRoutes(app, { openchamberDataDir: root, resolveGitBinaryForSpawn: () => 'git' });
  await request(app).post('/api/guests').send({ path: packageRoot }).expect(201);
  return { app, stored: async () => (await getGuestAuth('secret-test', guestAuthPersistPath(root)))?.settings };
};

describe('secret settings', () => {
  it('a secret is stored, and the answer names it without its value', async () => {
    const { app, stored } = await installed();
    const saved = await request(app).put('/api/guests/secret-test/settings').send({ key: 'hidden', workspace: 'acme' }).expect(200);
    expect(saved.body.settings).toEqual({ workspace: 'acme' });
    expect(saved.body.secretsSet).toEqual(['key']);
    expect(await stored()).toEqual({ key: 'hidden', workspace: 'acme' });
  });

  it('saving another field keeps a secret the card does not hold', async () => {
    const { app, stored } = await installed();
    await request(app).put('/api/guests/secret-test/settings').send({ key: 'hidden', workspace: 'acme' }).expect(200);
    await request(app).put('/api/guests/secret-test/settings').send({ workspace: 'other' }).expect(200);
    await request(app).put('/api/guests/secret-test/settings').send({ key: '', workspace: 'third' }).expect(200);
    expect(await stored()).toEqual({ key: 'hidden', workspace: 'third' });
  });

  it('a new value replaces it', async () => {
    const { app, stored } = await installed();
    await request(app).put('/api/guests/secret-test/settings').send({ key: 'hidden' }).expect(200);
    await request(app).put('/api/guests/secret-test/settings').send({ key: 'rotated' }).expect(200);
    expect((await stored()).key).toBe('rotated');
  });
});
