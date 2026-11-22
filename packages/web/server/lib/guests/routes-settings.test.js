import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { guestAuthPersistPath } from './auth-store.js';
import { writeExtensionStore } from './persist.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

// A guest panel that declares one integration setting, so PUT
// /api/guests/:id/settings accepts it through the shared saveSettings operation.
const makeGuest = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-settings-'));
  roots.push(root);
  const packageRoot = path.join(root, 'guest');
  await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, 'index.html'), '<!doctype html><html><body></body></html>');
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'settings-guest',
    version: '1.0.0',
    openchamber: {
      apiVersion: 1,
      contributes: {
        panel: { id: 'settings-guest', name: 'Settings guest', icon: 'apps', entry: 'index.html' },
        integration: {
          name: 'Settings guest',
          description: 'Fixture integration',
          token: { apiOrigin: 'https://api.example.com' },
          settings: [{ id: 'list-id', label: 'List ID' }],
        },
      },
    },
  }));
  await writeExtensionStore(path.join(root, 'extensions.json'), {
    paths: [packageRoot],
    sources: { [packageRoot]: 'path' },
  });
  const app = express();
  registerGuestRoutes(app, { openchamberDataDir: root });
  return { root, app };
};

const readStoredSettings = async (root) => {
  const store = JSON.parse(await fs.readFile(guestAuthPersistPath(root), 'utf8'));
  return store.guests['settings-guest']?.settings ?? {};
};

const { registerGuestRoutes } = await import('./routes.js');

describe('guest settings clamp surrogate-pair boundary (#2014)', () => {
  test('keeps a straddling value from persisting a lone surrogate', async () => {
    const { root, app } = await makeGuest();
    // 1,999 ASCII units, then an emoji (two code units) straddling offset 2,000.
    const straddling = `${'d'.repeat(1999)}\u{1F600}x`;

    const response = await request(app)
      .put('/api/guests/settings-guest/settings')
      .set('Host', 'oc.test')
      .send({ 'list-id': straddling });

    expect(response.status).toBe(200);
    const stored = await readStoredSettings(root);
    expect(stored['list-id']).toBe('d'.repeat(1999));
    expect(stored['list-id'].isWellFormed()).toBe(true);
    expect(Buffer.from(stored['list-id'], 'utf8').toString('utf8')).toBe(stored['list-id']);
    expect(await fs.readFile(guestAuthPersistPath(root), 'utf8')).not.toContain('\\ud83d');
  });

  test('still cuts an ASCII value at exactly 2,000 characters', async () => {
    const { root, app } = await makeGuest();

    const response = await request(app)
      .put('/api/guests/settings-guest/settings')
      .set('Host', 'oc.test')
      .send({ 'list-id': 'a'.repeat(2100) });

    expect(response.status).toBe(200);
    const stored = await readStoredSettings(root);
    expect(stored['list-id']).toBe('a'.repeat(2000));
    expect(stored['list-id'].length).toBe(2000);
  });
});
