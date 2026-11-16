import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGuestRoutes } from './routes.js';

const roots = [];
afterEach(async () => {
  delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const writePackage = async (packageRoot, { id, plugin = true } = {}) => {
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', openchamber: {
    apiVersion: 1, contributes: { panel: { id, name: id, icon: 'cup' }, ...(plugin ? { opencodePlugin: 'plugin' } : {}) },
  } }));
  if (plugin) {
    await fs.mkdir(path.join(packageRoot, 'plugin'), { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'plugin', 'package.json'), JSON.stringify({ name: `${id}-plugin`, version: '1.0.0', type: 'module', main: 'index.js' }));
    await fs.writeFile(path.join(packageRoot, 'plugin', 'index.js'), 'export default { id: "p", setup: async () => {} }');
  }
};

const harness = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-plugin-routes-')));
  roots.push(root);
  const state = { delivery: 'file', targets: [], globalConfigPath: path.join(root, 'global', 'opencode.json'), readFails: false };
  const addGlobalEntry = vi.fn((directory) => {
    state.targets.push(directory);
    return { path: state.globalConfigPath, added: true };
  });
  const onGuestsChanged = vi.fn();
  const app = express();
  registerGuestRoutes(app, {
    openchamberDataDir: root,
    resolveGitBinaryForSpawn: () => 'git',
    onGuestsChanged,
    opencodePlugins: {
      delivery: () => state.delivery,
      readGlobalEntries: () => {
        if (state.readFails) throw Object.assign(new Error('Failed to read OpenCode configuration'), { code: 'EACCES' });
        return { path: state.globalConfigPath, targets: [...state.targets] };
      },
      addGlobalEntry,
    },
  });
  const packageRoot = path.join(root, 'teapot');
  await writePackage(packageRoot, { id: 'teapot' });
  const install = () => request(app).post('/api/guests').send({ path: packageRoot }).expect(201);
  const approve = () => request(app).put('/api/guests/teapot/capabilities').send({ granted: ['opencodePlugin'] });
  const press = () => request(app).post('/api/guests/teapot/opencode-plugin/global-config');
  const listing = async () => (await request(app).get('/api/guests').expect(200)).body;
  return { app, root, state, addGlobalEntry, onGuestsChanged, packageRoot, install, approve, press, listing };
};

describe('an extension\'s OpenCode plugin on the guest routes', () => {
  it('the listing says how plugins reach OpenCode and which folders the global config already lists', async () => {
    const { state, install, approve, listing, packageRoot } = await harness();
    // No package ships a plugin: the global config is not read for the listing.
    expect((await listing()).opencodePlugins).toEqual({ delivery: 'file', globalConfigPath: null, inGlobalConfig: [] });
    await install();
    await approve().expect(200);
    const listed = await listing();
    expect(listed.guests.map((guest) => [guest.id, guest.opencodePlugin, guest.capabilities])).toEqual([['teapot', true, { requested: ['opencodePlugin'], granted: ['opencodePlugin'] }]]);
    expect(listed.opencodePlugins).toEqual({ delivery: 'file', globalConfigPath: state.globalConfigPath, inGlobalConfig: [] });
    state.targets.push(path.join(packageRoot, 'plugin'));
    state.delivery = 'restart';
    expect((await listing()).opencodePlugins).toEqual({ delivery: 'restart', globalConfigPath: state.globalConfigPath, inGlobalConfig: ['teapot'] });
  });

  it('"Add to global config" writes the plugin folder only where the managed config does not reach OpenCode, for an active approved extension', async () => {
    const { app, state, addGlobalEntry, onGuestsChanged, install, approve, press, listing, packageRoot } = await harness();
    expect((await press().expect(404)).body).toEqual({ error: 'not-found' });
    await install();
    // Installed, not yet approved: nothing is written anywhere.
    expect((await press().expect(409)).body).toEqual({ error: 'inactive' });
    await approve().expect(200);
    // A managed OpenCode reads our file: the button has nothing to do.
    expect((await press().expect(409)).body).toEqual({ error: 'not-needed', delivery: 'file' });
    state.delivery = 'remote';
    expect((await press().expect(409)).body).toEqual({ error: 'not-needed', delivery: 'remote' });
    expect(addGlobalEntry).not.toHaveBeenCalled();

    state.delivery = 'none';
    onGuestsChanged.mockClear();
    expect((await press().expect(200)).body).toEqual({ path: state.globalConfigPath });
    expect(addGlobalEntry).toHaveBeenCalledWith(path.join(packageRoot, 'plugin'));
    expect(onGuestsChanged).toHaveBeenCalled();
    expect((await listing()).opencodePlugins.inGlobalConfig).toEqual(['teapot']);

    // Pressed again: the helper answers that it is there; nothing to announce.
    addGlobalEntry.mockImplementationOnce(() => ({ path: state.globalConfigPath, added: false }));
    onGuestsChanged.mockClear();
    expect((await press().expect(200)).body).toEqual({ path: state.globalConfigPath });
    expect(onGuestsChanged).not.toHaveBeenCalled();

    // Paused: refused, whatever the delivery state.
    await request(app).put('/api/guests/teapot/enabled').send({ enabled: false }).expect(200);
    expect((await press().expect(409)).body).toEqual({ error: 'inactive' });
    await request(app).put('/api/guests/teapot/enabled').send({ enabled: true }).expect(200);

    // The global file the user keeps does not parse, or the write fails: the reason reaches the card.
    addGlobalEntry.mockImplementationOnce(() => { throw Object.assign(new Error('OpenCode configuration at /g/opencode.json contains invalid JSONC'), { code: 'CONFIG_INVALID' }); });
    expect((await press().expect(409)).body).toEqual({ error: 'config-invalid', message: 'OpenCode configuration at /g/opencode.json contains invalid JSONC' });
    addGlobalEntry.mockImplementationOnce(() => { throw new Error('Failed to write OpenCode configuration'); });
    expect((await press().expect(500)).body).toEqual({ error: 'write-failed', message: 'Failed to write OpenCode configuration' });

    // The folder left the package after the install: nothing is written for it.
    await fs.rm(path.join(packageRoot, 'plugin'), { recursive: true, force: true });
    expect((await press().expect(409)).body).toEqual({ error: 'plugin-missing' });
  });

  it('a global config that cannot be read leaves the extension list whole, and the button then answers the reason', async () => {
    const { state, addGlobalEntry, install, approve, press, listing } = await harness();
    await install();
    await approve().expect(200);
    state.delivery = 'none';
    state.readFails = true;
    const listed = await listing();
    expect(listed.guests.map((guest) => guest.id)).toEqual(['teapot']);
    expect(listed.opencodePlugins).toEqual({ delivery: 'none', globalConfigPath: null, inGlobalConfig: [] });
    addGlobalEntry.mockImplementationOnce(() => { throw Object.assign(new Error('Failed to read OpenCode configuration'), { code: 'EACCES' }); });
    expect((await press().expect(500)).body).toEqual({ error: 'write-failed', message: 'Failed to read OpenCode configuration' });
  });

  it('a pause that lands while the folder is being checked keeps the entry out of the user\'s file', async () => {
    const { app, state, addGlobalEntry, install, approve, press } = await harness();
    await install();
    await approve().expect(200);
    state.delivery = 'none';
    // The first folder check of the press waits for the pause to land.
    const realpath = vi.spyOn(fs, 'realpath');
    let paused = false;
    realpath.mockImplementationOnce(async (target) => {
      await request(app).put('/api/guests/teapot/enabled').send({ enabled: false }).expect(200);
      paused = true;
      return realpath.getMockImplementation() ? fs.realpath(target) : target;
    });
    try {
      expect((await press().expect(409)).body).toEqual({ error: 'inactive' });
    } finally {
      realpath.mockRestore();
    }
    expect(paused).toBe(true);
    expect(addGlobalEntry).not.toHaveBeenCalled();
  });

  it('a package without a plugin has no button', async () => {
    const { app, root, state } = await harness();
    const other = path.join(root, 'plain');
    await writePackage(other, { id: 'plain', plugin: false });
    await request(app).post('/api/guests').send({ path: other }).expect(201);
    state.delivery = 'none';
    expect((await request(app).post('/api/guests/plain/opencode-plugin/global-config').expect(404)).body).toEqual({ error: 'no-plugin' });
  });

  it('enterprise mode refuses the plugin from a local folder: no grant in the listing, no write from the button', async () => {
    const { state, addGlobalEntry, install, approve, press, listing } = await harness();
    await install();
    await approve().expect(200);
    state.delivery = 'none';
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    const [guest] = (await listing()).guests;
    expect(guest.enterpriseBlocked).toEqual(['opencodePlugin']);
    expect(guest.capabilities.granted).toEqual([]);
    expect((await press().expect(403)).body).toEqual({ error: 'enterprise-mode' });
    expect(addGlobalEntry).not.toHaveBeenCalled();
    delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    expect((await press().expect(200)).body).toEqual({ path: state.globalConfigPath });
  });
});
