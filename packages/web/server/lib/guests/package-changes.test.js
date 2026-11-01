import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGuestRoutes } from './routes.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const revisionOf = async (app) => {
  const listed = await request(app).get('/api/guests').expect(200);
  return listed.body.guests.find((guest) => guest.id === 'hot-folder')?.revision ?? 0;
};

describe('folder install edits', () => {
  it('a rebuilt script raises the revision and announces the change', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-package-changes-'));
    roots.push(root);
    const packageRoot = path.join(root, 'package');
    await fs.mkdir(packageRoot);
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'hot-folder', version: '1.0.0', openchamber: {
      apiVersion: 1, contributes: { panel: { id: 'hot-folder', name: 'Hot Folder', icon: 'apps', entry: 'index.html' } },
    } }));
    await fs.writeFile(path.join(packageRoot, 'index.html'), '<script src="main.js"></script>');
    await fs.writeFile(path.join(packageRoot, 'main.js'), 'void 0;');
    const onGuestsChanged = vi.fn();
    const app = express();
    registerGuestRoutes(app, { openchamberDataDir: root, resolveGitBinaryForSpawn: () => 'git', onGuestsChanged, watchFolderInstalls: true });
    await request(app).post('/api/guests').send({ path: packageRoot }).expect(201);
    const installed = await revisionOf(app);
    onGuestsChanged.mockClear();

    await fs.writeFile(path.join(packageRoot, 'main.js'), 'void 0; void 1;');
    let revision = installed;
    for (let attempt = 0; revision === installed && attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      revision = await revisionOf(app);
    }

    expect(revision).toBe(installed + 1);
    expect(onGuestsChanged).toHaveBeenCalled();
  });
});
