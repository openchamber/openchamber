import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { guestAuthPersistPath } from './auth-store.js';
import { toolLinkSettingsOf } from './oauth.js';
import { registerGuestRoutes } from './routes.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const integration = {
  name: 'Tracker',
  description: 'Issues',
  token: { apiOrigin: 'https://api.tracker.example' },
  settings: [{ id: 'site', label: 'Site' }, { id: 'space', label: 'Space' }, { id: 'key', label: 'Key', secret: true }],
};
const linkTool = { match: 'tracker_issue', output: 'card', card: { title: '{output.title}', link: { label: 'Open', url: 'https://{settings.site}/browse/{output.key}' } } };

const installed = async (tools = [linkTool]) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-card-link-settings-'));
  roots.push(root);
  const packageRoot = path.join(root, 'package');
  await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'tracker-test', version: '1.0.0', openchamber: {
    apiVersion: 1,
    contributes: { panel: { id: 'tracker-test', name: 'Tracker Test', icon: 'apps', entry: 'index.html' }, integration, tools },
  } }));
  await fs.writeFile(path.join(packageRoot, 'index.html'), '<script src="main.js"></script>');
  await fs.writeFile(path.join(packageRoot, 'main.js'), 'void 0;');
  const app = express();
  const onGuestsChanged = vi.fn();
  registerGuestRoutes(app, { openchamberDataDir: root, resolveGitBinaryForSpawn: () => 'git', onGuestsChanged });
  await request(app).post('/api/guests').send({ path: packageRoot }).expect(201);
  onGuestsChanged.mockClear();
  const save = (settings) => request(app).put('/api/guests/tracker-test/settings').send(settings).expect(200);
  const row = async () => (await request(app).get('/api/guests').expect(200)).body.guests.find((guest) => guest.id === 'tracker-test');
  return { app, root, onGuestsChanged, save, row };
};

describe('the settings a card link reads', () => {
  it('are the named, declared, non-secret fields that hold a value', () => {
    const guest = { integration, tools: [
      linkTool,
      { match: 'tracker_secret', output: 'card', card: { title: '{output.t}', link: { label: 'Open', url: 'https://{settings.key}/{settings.gone}/{settings.constructor}/{output.key}' } } },
    ] };
    expect(toolLinkSettingsOf({ settings: { site: 'acme.example', space: 'DEV', key: 'hidden', gone: 'old' } }, guest)).toEqual({ site: 'acme.example' });
    expect(toolLinkSettingsOf({ settings: { site: '' } }, guest)).toEqual({});
    expect(toolLinkSettingsOf(null, guest)).toEqual({});
    expect(toolLinkSettingsOf({ settings: { site: 'acme.example' } }, { integration, tools: [{ match: 'x', output: 'json' }] })).toEqual({});
    expect(toolLinkSettingsOf({ settings: { site: 'acme.example' } }, { tools: [linkTool] })).toEqual({});
  });

  it('travel on the catalog row, and nothing else of the settings does', async () => {
    const { save, row } = await installed();
    expect(await row()).not.toHaveProperty('toolLinkSettings');

    await save({ site: 'acme.example', space: 'DEV', key: 'hidden' });
    expect((await row()).toolLinkSettings).toEqual({ site: 'acme.example' });

    await save({ site: '' });
    expect(await row()).not.toHaveProperty('toolLinkSettings');
  });

  it('a save announces the catalog only when such a value changed', async () => {
    const { save, onGuestsChanged } = await installed();

    await save({ site: 'acme.example' });
    expect(onGuestsChanged).toHaveBeenCalledTimes(1);

    await save({ site: 'acme.example', space: 'DEV', key: 'hidden' });
    await save({ site: ' acme.example ' });
    expect(onGuestsChanged).toHaveBeenCalledTimes(1);

    await save({ site: 'other.example' });
    expect(onGuestsChanged).toHaveBeenCalledTimes(2);
  });

  it('no extension names a setting: the auth store is not read for the catalog', async () => {
    const { root, row } = await installed([{ match: 'tracker_issue', output: 'card', card: { title: '{output.title}', link: { label: 'Open', url: '{output.url}' } } }]);
    await fs.writeFile(guestAuthPersistPath(root), 'not json');
    expect((await row()).tools).toHaveLength(1);
  });

  it('an unreadable auth store costs the link values and keeps the catalog', async () => {
    const { root, save, row } = await installed();
    await save({ site: 'acme.example' });
    await fs.writeFile(guestAuthPersistPath(root), 'not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guest = await row();
    warn.mockRestore();
    expect(guest.tools).toHaveLength(1);
    expect(guest).not.toHaveProperty('toolLinkSettings');
  });
});
