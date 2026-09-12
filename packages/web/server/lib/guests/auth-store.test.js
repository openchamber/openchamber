import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  dropGuestTokens,
  forgetGuestAuth,
  getGuestAuth,
  guestAuthPersistPath,
  patchGuestAuth,
  readGuestAuthStore,
} from './auth-store.js';

describe('guestAuthPersistPath', () => {
  test('joins the instance data dir and refuses a relative path', () => {
    const dataDir = path.join(os.tmpdir(), 'oc-guest-auth-a');
    expect(guestAuthPersistPath(dataDir)).toBe(path.join(dataDir, 'guest-auth.json'));
    expect(() => guestAuthPersistPath('relative')).toThrow('absolute OpenChamber data dir');
  });
});

describe('guest auth store', () => {
  test('round-trips tokens and writes 0o600', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oc-guest-auth-'));
    const file = guestAuthPersistPath(dir);
    expect(await readGuestAuthStore(file)).toEqual({ guests: {} });
    await patchGuestAuth('clickup', {
      clientId: 'id',
      clientSecret: 'secret',
      accessToken: 'tok',
      account: 'ada',
      settings: { 'list-id': '123' },
    }, file);
    expect(await getGuestAuth('clickup', file)).toMatchObject({
      clientId: 'id',
      accessToken: 'tok',
      account: 'ada',
      settings: { 'list-id': '123' },
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    await dropGuestTokens('clickup', file);
    const after = await getGuestAuth('clickup', file);
    expect(after?.accessToken).toBeUndefined();
    expect(after?.clientId).toBe('id');
    expect(after?.settings).toEqual({ 'list-id': '123' });
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  test('forgets a guest entirely when its package is removed', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oc-guest-auth-'));
    const file = guestAuthPersistPath(dir);
    try {
      await patchGuestAuth('clickup', { clientId: 'app', clientSecret: 'secret', accessToken: 'token' }, file);
      await patchGuestAuth('other', { accessToken: 'keep' }, file);
      await forgetGuestAuth('clickup', file);
      expect(await getGuestAuth('clickup', file)).toBeNull();
      expect((await getGuestAuth('other', file))?.accessToken).toBe('keep');
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  test('treats a blank file as an empty store', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oc-guest-auth-'));
    const file = guestAuthPersistPath(dir);
    await fs.promises.writeFile(file, '', 'utf8');
    expect(await readGuestAuthStore(file)).toEqual({ guests: {} });
    await fs.promises.writeFile(file, '\uFEFF\n', 'utf8');
    expect(await readGuestAuthStore(file)).toEqual({ guests: {} });
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  test('refuses a corrupt store', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oc-guest-auth-'));
    const file = guestAuthPersistPath(dir);
    await fs.promises.writeFile(file, '{"guests":[]}', 'utf8');
    try {
      await readGuestAuthStore(file);
      throw new Error('should have thrown');
    } catch (error) {
      expect(String(error)).toContain('Invalid guest auth store');
    }
    await fs.promises.writeFile(file, '{', 'utf8');
    try {
      await readGuestAuthStore(file);
      throw new Error('should have thrown');
    } catch (error) {
      expect(String(error)).toContain('Invalid guest auth store');
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
});
