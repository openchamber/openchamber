import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { registerGuestRoutes } from './routes.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path fill="currentColor" d="M0 0h1v1z"/></svg>';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const installed = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-logo-routes-')));
  roots.push(root);
  const packageRoot = path.join(root, 'logos');
  await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'logos', version: '1.0.0',
    openchamber: { apiVersion: 1, contributes: { panel: { id: 'logos', name: 'Logos', icon: 'cup' }, providerLogos: { acme: 'acme.svg', other: 'acme.png' } } },
  }));
  await fs.writeFile(path.join(packageRoot, 'acme.svg'), SVG);
  await fs.writeFile(path.join(packageRoot, 'acme.png'), 'png-bytes');
  const app = express();
  registerGuestRoutes(app, { openchamberDataDir: root, resolveGitBinaryForSpawn: () => 'git', onGuestsChanged: () => {} });
  await request(app).post('/api/guests').send({ path: packageRoot }).expect(201);
  return app;
};

const text = (req) => req.buffer(true).parse((res, done) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks).toString('utf8')));
});

describe('an extension\'s provider logo on the asset route', () => {
  it('colours an SVG for the theme it is asked for and keeps it inert', async () => {
    const app = await installed();

    const dark = await text(request(app).get('/api/guests/logos/acme.svg?theme=dark')).expect(200);
    expect(dark.body).toContain('#f5f5f5');
    expect(dark.headers['content-security-policy']).toContain('sandbox');
    const light = await text(request(app).get('/api/guests/logos/acme.svg?theme=light')).expect(200);
    expect(light.body).toContain('#111111');
  });

  it('leaves everything else as the package shipped it', async () => {
    const app = await installed();

    expect((await text(request(app).get('/api/guests/logos/acme.svg')).expect(200)).body).toBe(SVG);
    expect((await text(request(app).get('/api/guests/logos/acme.svg?theme=sepia')).expect(200)).body).toBe(SVG);
    expect((await text(request(app).get('/api/guests/logos/acme.svg?theme=dark&theme=light')).expect(200)).body).toBe(SVG);
    expect((await text(request(app).get('/api/guests/logos/acme.png?theme=dark')).expect(200)).body).toBe('png-bytes');
  });
});
