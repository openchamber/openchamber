import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createGuestMarks } from './marks.js';
import { registerGuestRoutes } from './routes.js';

const roots = [];
afterEach(async () => {
  delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const writePackage = async (packageRoot, id, contributes = { marks: true }) => {
  await fs.mkdir(path.join(packageRoot, 'service'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'service', 'main.js'), '');
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', openchamber: {
    apiVersion: 1,
    contributes: { panel: { id, name: id, icon: 'cup' }, service: { entry: 'service/main.js', runtime: 'host', keepRunning: true }, ...contributes },
  } }));
};

const failed = { icon: 'close-circle', tone: 'error', text: '2 tests failed' };

const harness = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-marks-routes-')));
  roots.push(root);
  // Each guest's process holds the token named after it.
  const marks = createGuestMarks({ guestIdOfToken: (token) => token.replace(/^token-/, '') });
  const app = express();
  registerGuestRoutes(app, { openchamberDataDir: root, resolveGitBinaryForSpawn: () => 'git', marks });
  const install = async (id, contributes) => {
    await writePackage(path.join(root, id), id, contributes);
    await request(app).post('/api/guests').send({ path: path.join(root, id) }).expect(201);
  };
  const approve = (id, granted = ['service', 'marks']) => request(app).put(`/api/guests/${id}/capabilities`).send({ granted }).expect(200);
  const listed = async () => (await request(app).get('/api/guests/marks').expect(200)).body;
  return { app, marks, install, approve, listed };
};

describe('extension marks on the guest routes', () => {
  it('the catalog says an extension asks for marks, and the approval covers them', async () => {
    const { app, install } = await harness();
    await install('desk');
    const { guests } = (await request(app).get('/api/guests').expect(200)).body;
    expect(guests.map((guest) => [guest.id, guest.marks, guest.capabilities])).toEqual([['desk', true, { requested: ['service', 'marks'], granted: [] }]]);
    await request(app).put('/api/guests/desk/capabilities').send({ granted: ['service'] }).expect(400);
  });

  it('lists the marks of every extension that may show them, under its id', async () => {
    const { marks, install, approve, listed } = await harness();
    await install('desk');
    await install('ci');
    await approve('desk');
    await approve('ci');
    expect(await listed()).toEqual({ marks: [] });
    marks.set('desk', 'token-desk', { sessionId: 'ses_1' }, failed);
    marks.set('ci', 'token-ci', { directory: '/repo', branch: 'main' }, { ...failed, url: 'https://ci.example/7' });
    expect((await listed()).marks.sort((a, b) => a.guestId.localeCompare(b.guestId))).toEqual([
      { guestId: 'ci', target: { directory: '/repo', branch: 'main' }, mark: { ...failed, url: 'https://ci.example/7' } },
      { guestId: 'desk', target: { sessionId: 'ses_1' }, mark: failed },
    ]);
  });

  it('shows none of an extension that is not approved, paused, or removed', async () => {
    const { app, marks, install, approve, listed } = await harness();
    await install('desk');
    marks.set('desk', 'token-desk', { sessionId: 'ses_1' }, failed);
    expect(await listed()).toEqual({ marks: [] });
    await approve('desk');
    expect((await listed()).marks).toHaveLength(1);
    await request(app).put('/api/guests/desk/enabled').send({ enabled: false }).expect(200);
    expect(await listed()).toEqual({ marks: [] });
    await request(app).delete('/api/guests/desk').expect(204);
    expect(await listed()).toEqual({ marks: [] });
  });

  it('shows none in enterprise mode, which refuses the service that sets them', async () => {
    const { marks, install, approve, listed } = await harness();
    await install('desk');
    await approve('desk');
    marks.set('desk', 'token-desk', { sessionId: 'ses_1' }, failed);
    expect((await listed()).marks).toHaveLength(1);
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    expect(await listed()).toEqual({ marks: [] });
  });

  it('shows none of an extension that does not ask for marks', async () => {
    const { marks, install, approve, listed } = await harness();
    await install('desk', {});
    await approve('desk', ['service']);
    marks.set('desk', 'token-desk', { sessionId: 'ses_1' }, failed);
    expect(await listed()).toEqual({ marks: [] });
  });
});
