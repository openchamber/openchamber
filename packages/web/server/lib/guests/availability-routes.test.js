import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildStoreZip } from './extract-zip.test.js';
import { resolveGuestFolders } from './files.js';
import { extensionsPersistPath, readExtensionStore } from './persist.js';
import { registerGuestRoutes } from './routes.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const packageFiles = [
  { name: 'package.json', data: JSON.stringify({ name: 'folders-test', version: '1.0.0', openchamber: {
    apiVersion: 1,
    contributes: { panel: { id: 'folders-test', name: 'Folders Test', icon: 'apps', entry: 'index.html' } },
  } }) },
  { name: 'index.html', data: '<script src="main.js"></script>' },
  { name: 'main.js', data: 'void 0;' },
];

const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-folders-'));
  roots.push(root);
  const packageRoot = path.join(root, 'package');
  await fs.mkdir(packageRoot);
  await Promise.all(packageFiles.map((file) => fs.writeFile(path.join(packageRoot, file.name), file.data)));
  const app = express();
  const onGuestsChanged = vi.fn();
  registerGuestRoutes(app, { openchamberDataDir: root, resolveGitBinaryForSpawn: () => 'git', onGuestsChanged });
  const row = async () => (await request(app).get('/api/guests').expect(200)).body.guests.find((guest) => guest.id === 'folders-test');
  return { app, root, packageRoot, onGuestsChanged, row };
};

const installed = async () => {
  const setup = await fixture();
  await request(setup.app).post('/api/guests').send({ path: setup.packageRoot }).expect(201);
  setup.onGuestsChanged.mockClear();
  const setFolders = (folders) => request(setup.app).put('/api/guests/folders-test/folders').send({ folders });
  return { ...setup, setFolders };
};

describe('installing with folders', () => {
  it('stores them before announcing the new extension', async () => {
    const { app, root, packageRoot, onGuestsChanged, row } = await fixture();
    const announced = [];
    onGuestsChanged.mockImplementation(() => announced.push(readExtensionStore(extensionsPersistPath(root))));
    const answer = await request(app).post('/api/guests').send({ path: packageRoot, folders: ['/work'] }).expect(201);

    expect(answer.body.guest.folders).toEqual([path.resolve('/work')]);
    expect((await row()).folders).toEqual([path.resolve('/work')]);
    expect(announced.length).toBeGreaterThan(0);
    for (const stored of await Promise.all(announced)) expect(stored.guestFolders).toEqual({ 'folders-test': [path.resolve('/work')] });
  });

  it('refuses a relative folder without installing', async () => {
    const { app, packageRoot, row } = await fixture();
    const answer = await request(app).post('/api/guests').send({ path: packageRoot, folders: ['projects/flow'] }).expect(400);
    expect(answer.body.error).toBe('invalid-folders');
    expect(await row()).toBeUndefined();
  });

  it('takes a ZIP upload\'s folders from the query', async () => {
    const { app, row } = await fixture();
    await request(app).post('/api/guests/upload')
      .query({ folders: JSON.stringify(['/work', '/other']) })
      .set('Content-Type', 'application/octet-stream')
      .send(buildStoreZip(packageFiles))
      .expect(201);
    expect((await row()).folders).toEqual([path.resolve('/work'), path.resolve('/other')]);
  });

  it('a replace with folders puts them in place of the stored ones', async () => {
    const { app, packageRoot, setFolders, row } = await installed();
    await setFolders(['/work']).expect(200);
    const answer = await request(app).post('/api/guests').send({ path: packageRoot, replace: true, folders: ['/other'] }).expect(200);
    expect(answer.body.guest.folders).toEqual([path.resolve('/other')]);
    expect((await row()).folders).toEqual([path.resolve('/other')]);
  });

  it('a replace without folders keeps the stored ones', async () => {
    const { app, packageRoot, setFolders, row } = await installed();
    await setFolders(['/work']).expect(200);
    await request(app).post('/api/guests').send({ path: packageRoot, replace: true }).expect(200);
    expect((await row()).folders).toEqual([path.resolve('/work')]);
  });

  it('a replace with an empty list clears them in the same request, from a folder or a ZIP', async () => {
    const { app, root, packageRoot, setFolders, row } = await installed();
    await setFolders(['/work']).expect(200);
    const answer = await request(app).post('/api/guests').send({ path: packageRoot, replace: true, folders: [] }).expect(200);
    expect(answer.body.guest).not.toHaveProperty('folders');
    expect(await row()).not.toHaveProperty('folders');

    await request(app).post('/api/guests/upload').query({ replace: 'true', folders: JSON.stringify(['/zip']) })
      .set('Content-Type', 'application/octet-stream').send(buildStoreZip(packageFiles)).expect(200);
    expect((await row()).folders).toEqual([path.resolve('/zip')]);
    await request(app).post('/api/guests/upload').query({ replace: 'true', folders: '[]' })
      .set('Content-Type', 'application/octet-stream').send(buildStoreZip(packageFiles)).expect(200);
    expect(await row()).not.toHaveProperty('folders');
    expect((await readExtensionStore(extensionsPersistPath(root))).guestFolders).toEqual({});
  });

  it('refuses a ZIP upload whose folders are not a JSON list of full paths', async () => {
    const { app, row } = await fixture();
    for (const folders of ['/work', '["projects/flow"]']) {
      const answer = await request(app).post('/api/guests/upload').query({ folders })
        .set('Content-Type', 'application/octet-stream').send(buildStoreZip(packageFiles)).expect(400);
      expect(answer.body.error).toBe('invalid-folders');
    }
    expect(await row()).toBeUndefined();
  });
});

describe('resolveGuestFolders', () => {
  it('expands the home folder, normalizes and drops repeats', () => {
    expect(resolveGuestFolders(['~/projects/flow', '/work/a/../b/', '~/projects/flow'], '/home/me', path.posix))
      .toEqual(['/home/me/projects/flow', '/work/b']);
  });

  it('refuses the whole list when one folder is relative', () => {
    expect(resolveGuestFolders(['/work', 'projects/flow'], '/home/me', path.posix)).toBeNull();
  });
});

describe('PUT /api/guests/:id/folders', () => {
  it('stores absolute folders, puts them on the catalog row and announces the change', async () => {
    const { root, onGuestsChanged, setFolders, row } = await installed();
    expect(await row()).not.toHaveProperty('folders');

    const answer = await setFolders(['~/projects/flow']).expect(200);
    const expected = [path.join(os.homedir(), 'projects', 'flow')];
    expect(answer.body.guest.folders).toEqual(expected);
    expect((await row()).folders).toEqual(expected);
    expect(onGuestsChanged).toHaveBeenCalledTimes(1);
    expect((await readExtensionStore(extensionsPersistPath(root))).guestFolders).toEqual({ 'folders-test': expected });
  });

  it('an empty list removes the limit', async () => {
    const { root, setFolders, row } = await installed();
    await setFolders(['/work']).expect(200);
    await setFolders([]).expect(200);
    expect(await row()).not.toHaveProperty('folders');
    expect((await readExtensionStore(extensionsPersistPath(root))).guestFolders).toEqual({});
  });

  it('refuses a relative folder or an unknown extension and keeps what was stored', async () => {
    const { app, setFolders, row } = await installed();
    await setFolders(['/work']).expect(200);
    await setFolders(['projects/flow']).expect(400);
    await request(app).put('/api/guests/missing/folders').send({ folders: [] }).expect(404);
    expect((await row()).folders).toEqual([path.resolve('/work')]);
  });

  it('replacing the extension from another folder keeps its folders', async () => {
    const { app, root, setFolders, row } = await installed();
    await setFolders(['/work']).expect(200);
    const copy = path.join(root, 'copy');
    await fs.cp(path.join(root, 'package'), copy, { recursive: true });
    await request(app).post('/api/guests').send({ path: copy, replace: true }).expect(200);
    expect((await row()).folders).toEqual([path.resolve('/work')]);
  });

  it('removing the extension drops its folders', async () => {
    const { app, root, setFolders } = await installed();
    await setFolders(['/work']).expect(200);
    await request(app).delete('/api/guests/folders-test').expect(204);
    expect((await readExtensionStore(extensionsPersistPath(root))).guestFolders).toEqual({});
  });
});
