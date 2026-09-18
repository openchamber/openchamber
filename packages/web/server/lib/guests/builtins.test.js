import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

import { registerBuiltInGuests, listInstalledGuests, invalidateGuestCatalog, toPublicGuest } from './catalog.js';
import { registerGuestRoutes } from './routes.js';
import { readExtensionStore, writeExtensionStore } from './persist.js';
import { getServiceStatus, stopAllGuestServices } from './service.js';

const roots = [];
const releases = [];
const id = 'openchamber-builtin-fixture';
afterEach(async () => {
  await stopAllGuestServices();
  for (const release of releases.splice(0)) release();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const manifest = (panelId = id) => ({
  name: 'fixture', version: '1.0.0', type: 'module',
  openchamber: { apiVersion: 1, contributes: {
    panel: { id: panelId, name: 'Fixture', icon: 'puzzle', entry: 'panel/index.html' },
    capabilities: ['files', 'sessions'],
    integration: { name: 'Fixture', description: 'GitHub', token: { apiOrigin: 'https://api.github.com', scheme: 'bearer', account: { path: '/user', name: 'login' } } },
  } },
});
const writePackage = async (root, definition) => {
  await fs.mkdir(path.join(root, 'panel'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(definition));
  await fs.writeFile(path.join(root, 'panel/index.html'), '<script src="main.js"></script>');
  await fs.writeFile(path.join(root, 'panel/main.js'), 'console.log("fixture");');
};
const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-builtins-'));
  roots.push(root);
  const bundle = path.join(root, 'app-bundle');
  const packageRoot = path.join(bundle, 'fixture');
  const data = path.join(root, 'data');
  const persistPath = path.join(data, 'extensions.json');
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'README.md'), 'Fixture project');
  await writePackage(packageRoot, manifest());
  await fs.writeFile(path.join(bundle, 'registry.json'), JSON.stringify({ version: 1, extensions: [{ id, directory: 'fixture' }] }));
  releases.push(await registerBuiltInGuests({ persistPath, root: bundle }));
  const app = express();
  registerGuestRoutes(app, { openchamberDataDir: data, openchamberVersion: '1.23.2', resolveGitBinaryForSpawn: () => 'git', resolveOptionalProjectDirectory: () => ({ directory: project }) });
  return { root, bundle, packageRoot, persistPath, api: request(app) };
};

describe('app-owned extensions', () => {
  test('each instance owns its disabled state independently', async () => {
    const first = await fixture();
    const second = await fixture();
    await first.api.put(`/api/guests/${id}/enabled`).send({ enabled: false }).expect(200);
    expect((await first.api.get('/api/guests').expect(200)).body.guests[0].enabled).toBe(false);
    expect((await second.api.get('/api/guests').expect(200)).body.guests[0].enabled).toBe(true);
  });
  test('ships enabled with its exact declared grants and no persisted approval', async () => {
    const { api, persistPath } = await fixture();
    const response = await api.get('/api/guests').expect(200);
    const guest = response.body.guests[0];
    expect(guest.source).toBe('bundled');
    expect(guest.enabled).toBe(true);
    expect(guest.path).toBeNull();
    expect([...guest.capabilities.granted].sort()).toEqual([...guest.capabilities.requested].sort());
    expect(guest.capabilities.granted).toContain('files');
    expect(guest.capabilities.granted).toContain('network');
    expect((await readExtensionStore(persistPath)).capabilityGrants).toEqual({});
    await api.post(`/api/guests/${id}/files`).send({ op: 'read', path: 'README.md' }).expect(200);
    const deniedModel = await api.post(`/api/guests/${id}/generate`).send({ prompt: 'not declared' }).expect(400);
    expect(deniedModel.body.error).toBe('NOT_GRANTED');
    await api.put(`/api/guests/${id}/capabilities`).send({ granted: [] }).expect(400, { error: 'bundled' });
    await api.delete(`/api/guests/${id}`).expect(400, { error: 'bundled' });
    await api.post(`/api/guests/${id}/update`).expect(400, { error: 'not-git' });
  });

  test('disable survives a new application version and preserves storage and credentials', async () => {
    const { api, persistPath, packageRoot, bundle } = await fixture();
    await api.post(`/api/guests/${id}/storage`).send({ op: 'set', key: 'note', value: 'keep this' }).expect(200);
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ login: 'fixture' }));
    try {
      await api.put(`/api/guests/${id}/token`).send({ token: 'fixture-token' }).expect(200);
    } finally { fetch.mockRestore(); }
    await api.put(`/api/guests/${id}/enabled`).send({ enabled: false }).expect(200);
    const deniedFile = await api.post(`/api/guests/${id}/files`).send({ op: 'read', path: 'README.md' }).expect(400);
    expect(deniedFile.body.error).toBe('DISABLED');
    const blockedFetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Disabled extension reached the provider'));
    try {
      const deniedRequest = await api.post(`/api/guests/${id}/request`).send({ method: 'GET', path: '/user' }).expect(400);
      expect(deniedRequest.body.error).toBe('DISABLED');
      expect(blockedFetch.mock.calls).toHaveLength(0);
    } finally { blockedFetch.mockRestore(); }
    const next = manifest();
    next.version = '2.0.0';
    next.openchamber.contributes.capabilities.push('model');
    await writePackage(packageRoot, next);
    releases.push(await registerBuiltInGuests({ persistPath, root: bundle }));
    const updated = (await api.get('/api/guests').expect(200)).body.guests[0];
    expect(updated.enabled).toBe(false);
    expect(updated.version).toBe('2.0.0');
    expect(updated.capabilities.granted).toContain('model');
    expect((await readExtensionStore(persistPath)).disabledGuests[id]).toBe(true);
    await api.put(`/api/guests/${id}/enabled`).send({ enabled: true }).expect(200);
    const saved = await api.post(`/api/guests/${id}/storage`).send({ op: 'get', key: 'note' }).expect(200);
    expect(saved.body.value).toBe('keep this');
    expect((await api.get(`/api/guests/${id}/oauth/status`).expect(200)).body.connected).toBe(true);
  });

  test('a package cannot claim built-in trust or replace a reserved ID', async () => {
    const { api, root, persistPath } = await fixture();
    const forged = path.join(root, 'forged');
    const definition = manifest('third-party');
    definition.builtin = true;
    definition.openchamber.builtin = true;
    await writePackage(forged, definition);
    const installed = await api.post('/api/guests').send({ path: forged, source: 'bundled' }).expect(201);
    expect(installed.body.guest.source).toBe('path');
    expect(installed.body.guest.capabilities.granted).toEqual([]);
    await writePackage(forged, manifest());
    await api.post('/api/guests').send({ path: forged, replace: true }).expect(400, { error: 'reserved-id' });
    await writeExtensionStore(persistPath, { paths: [forged], sources: {}, capabilityGrants: { [id]: ['files', 'network'] } });
    const guests = await listInstalledGuests({ persistPath });
    expect(guests).toHaveLength(1);
    expect(guests[0].source).toBe('bundled');
    expect(guests[0].packageRoot).not.toBe(forged);
  });

  test('automatic grants never move a saved token to a changed provider origin', async () => {
    const { api, packageRoot, persistPath } = await fixture();
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ login: 'fixture' }));
    try { await api.put(`/api/guests/${id}/token`).send({ token: 'fixture-token' }).expect(200); }
    finally { fetch.mockRestore(); }
    const definition = manifest();
    definition.openchamber.contributes.integration.token.apiOrigin = 'https://api.example.com';
    await writePackage(packageRoot, definition);
    invalidateGuestCatalog(persistPath);
    expect((await api.get('/api/guests').expect(200)).body.guests[0].capabilities.granted).toContain('network');
    expect((await api.get(`/api/guests/${id}/oauth/status`).expect(200)).body.connected).toBe(false);
  });

  test('rejects invalid registries and does not elevate symlinked packages outside the bundle', async () => {
    const { root, bundle, persistPath } = await fixture();
    const outside = path.join(root, 'outside');
    await writePackage(outside, manifest());
    const broken = path.join(bundle, 'linked');
    await fs.symlink(outside, broken, 'dir');
    await fs.writeFile(path.join(bundle, 'registry.json'), JSON.stringify({ version: 1, extensions: [{ id, directory: '../outside' }] }));
    await expect(registerBuiltInGuests({ persistPath, root: bundle })).rejects.toThrow();
    const otherId = 'openchamber-builtin-linked';
    await fs.writeFile(path.join(bundle, 'registry.json'), JSON.stringify({ version: 1, extensions: [{ id, directory: 'fixture' }, { id: otherId, directory: 'linked' }] }));
    releases.push(await registerBuiltInGuests({ persistPath, root: bundle }));
    const guests = await listInstalledGuests({ persistPath });
    expect(guests.map((guest) => guest.id)).toEqual([id]);
    expect(toPublicGuest(guests[0]).capabilities.granted).toContain('network');
  });

  test('disable stops an automatically approved built-in service', async () => {
    const { api, packageRoot, persistPath } = await fixture();
    const definition = manifest();
    definition.openchamber.contributes.service = { runtime: 'host', entry: 'service.mjs' };
    await fs.writeFile(path.join(packageRoot, 'service.mjs'), `import http from 'node:http';
http.createServer((req,res)=>{ if(req.headers.authorization!=='Bearer '+process.env.OPENCHAMBER_SERVICE_TOKEN){res.writeHead(401);res.end();return;}res.end('ok'); }).listen(Number(process.env.OPENCHAMBER_SERVICE_PORT),'127.0.0.1');`);
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(definition));
    invalidateGuestCatalog(persistPath);
    await api.post(`/api/guests/${id}/service/request`).send({ method: 'GET', path: '/test' }).expect(200);
    expect(getServiceStatus(id)).toBe('ready');
    await api.put(`/api/guests/${id}/enabled`).send({ enabled: false }).expect(200);
    expect(getServiceStatus(id)).toBe('stopped');
  });
});
