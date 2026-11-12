import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGuestRoutes, settleGuestDeactivationListeners } from './routes.js';

const roots = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const installed = async (listeners) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-deactivation-'));
  roots.push(root);
  const packageRoot = path.join(root, 'package');
  await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'deactivation-test', version: '1.0.0', openchamber: {
    apiVersion: 1, contributes: { panel: { id: 'deactivation-test', name: 'Deactivation Test', icon: 'apps' }, background: { entry: 'index.html' } },
  } }));
  await fs.writeFile(path.join(packageRoot, 'index.html'), '<script src="main.js"></script>');
  await fs.writeFile(path.join(packageRoot, 'main.js'), 'void 0;');
  const app = express();
  registerGuestRoutes(app, { openchamberDataDir: root, resolveGitBinaryForSpawn: () => 'git', ...listeners });
  await request(app).post('/api/guests').send({ path: packageRoot }).expect(201);
  return app;
};

describe('deactivation listeners', () => {
  it('a failing listener never turns a stored pause or removal into an error answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onGuestDeactivated = vi.fn(async () => { throw new Error('listener broke'); });
    const app = await installed({ onGuestDeactivated });
    const paused = await request(app).put('/api/guests/deactivation-test/enabled').send({ enabled: false }).expect(200);
    expect(paused.body.guest.enabled).toBe(false);
    await request(app).delete('/api/guests/deactivation-test').expect(204);
    expect(onGuestDeactivated).toHaveBeenCalledTimes(2);
    expect(onGuestDeactivated).toHaveBeenLastCalledWith(expect.objectContaining({ guestId: 'deactivation-test', removed: true }));
  });

  it('runs every listener when one fails, and logs the failure under its name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const withdrawn = vi.fn(async () => undefined);
    const listener = settleGuestDeactivationListeners([
      { name: 'hand back a role', listener: () => { throw new Error('browser broke'); } },
      { name: 'withdraw a Git host', listener: withdrawn },
    ]);
    await expect(listener({ guestId: 'forge', guestName: 'Forge' })).resolves.toBeUndefined();
    expect(withdrawn).toHaveBeenCalledWith({ guestId: 'forge', guestName: 'Forge' });
    expect(warn).toHaveBeenCalledWith('Failed to hand back a role:', 'browser broke');
  });
});
