import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createNotificationChannelAccounts, notificationChannelsPersistPath } from './channel-accounts.js';

const withStore = async (run) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-channel-accounts-'));
  try {
    await run(notificationChannelsPersistPath(dir), dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

describe('notification channel accounts', () => {
  test('reads revisionless accounts and rejects stale invalidation even when the replacement has the same token and timestamp', async () => {
    await withStore(async (persistPath) => {
      const legacy = { instance: 'https://slack.com', account: { id: 'U1', login: null, token: 'token', connectedAt: 1_000, status: 'valid' } };
      await fs.writeFile(persistPath, JSON.stringify({ version: 1, channels: { 'ext-slack': legacy } }));
      const accounts = createNotificationChannelAccounts({ persistPath, now: () => 1_000 });
      expect(await accounts.read('ext-slack')).toEqual(legacy);
      const candidate = { instance: legacy.instance, token: 'token', account: { id: 'U1', login: null } };
      await accounts.set('ext-slack', candidate);
      const previous = await accounts.read('ext-slack');
      await accounts.set('ext-slack', candidate);
      expect(await accounts.markInvalid('ext-slack', 'unauthorized', previous)).toBe(false);
      expect((await accounts.read('ext-slack')).account.status).toBe('valid');
      expect(await accounts.markInvalid('ext-slack', 'unauthorized', legacy)).toBe(false);
    });
  });

  test('stores one account per channel, hands the token to the reader only, and keeps the file private', async () => {
    await withStore(async (persistPath) => {
      let time = 1_000;
      const accounts = createNotificationChannelAccounts({ persistPath, now: () => time });
      expect(await accounts.read('ext-slack')).toBeNull();
      expect(await accounts.publicView('ext-slack')).toBeNull();
      expect(await accounts.list()).toEqual({});

      const view = await accounts.set('ext-slack', { instance: 'https://slack.com', token: 'xoxb-secret', account: { id: 'U1', login: 'mona', name: 'Mona' } });
      expect(view).toEqual({ instance: 'https://slack.com', account: { id: 'U1', login: 'mona', name: 'Mona', connectedAt: 1_000, status: 'valid' } });
      expect(JSON.stringify(view)).not.toContain('xoxb-secret');
      expect((await accounts.read('ext-slack'))?.account.token).toBe('xoxb-secret');
      expect(await accounts.list()).toEqual({ 'ext-slack': view });
      expect((await fs.stat(persistPath)).mode & 0o777).toBe(0o600);

      time = 2_000;
      const replaced = await accounts.set('ext-slack', { instance: 'https://slack.com', token: 'xoxb-other', account: { id: 'U2', login: null } });
      expect(replaced.account).toEqual({ id: 'U2', login: null, connectedAt: 2_000, status: 'valid' });
      expect((await accounts.read('ext-slack'))?.account.token).toBe('xoxb-other');

      expect(await accounts.markInvalid('ext-slack')).toBe(true);
      expect((await accounts.publicView('ext-slack'))?.account).toMatchObject({ status: 'invalid', invalidReason: 'unauthorized' });
      expect(await accounts.markInvalid('ext-none')).toBe(false);

      expect(await accounts.remove('ext-slack')).toBe(true);
      expect(await accounts.remove('ext-slack')).toBe(false);
      expect(await accounts.read('ext-slack')).toBeNull();
    });
  });

  test('a corrupt file is an error, never a disconnected channel', async () => {
    await withStore(async (persistPath) => {
      await fs.writeFile(persistPath, '{"version":1,"channels":{"ext-slack":{"instance":"https://slack.com"}}}');
      const accounts = createNotificationChannelAccounts({ persistPath });
      await expect(accounts.read('ext-slack')).rejects.toMatchObject({ code: 'INVALID_NOTIFICATION_CHANNELS_STORE' });
      await fs.writeFile(persistPath, 'not json');
      await expect(accounts.list()).rejects.toMatchObject({ code: 'INVALID_NOTIFICATION_CHANNELS_STORE' });
      await fs.writeFile(persistPath, '');
      expect(await accounts.list()).toEqual({});
    });
  });

  test('writes to one file land in order', async () => {
    await withStore(async (persistPath) => {
      const accounts = createNotificationChannelAccounts({ persistPath });
      await Promise.all([
        accounts.set('ext-a', { instance: 'https://a.example', token: 't-a', account: { id: 'A', login: 'a' } }),
        accounts.set('ext-b', { instance: 'https://b.example', token: 't-b', account: { id: 'B', login: 'b' } }),
        accounts.markInvalid('ext-a', 'expired'),
      ]);
      const list = await accounts.list();
      expect(Object.keys(list).sort()).toEqual(['ext-a', 'ext-b']);
      expect(list['ext-a']?.account).toMatchObject({ status: 'invalid', invalidReason: 'expired' });
      expect(list['ext-b']?.account.status).toBe('valid');
    });
  });
});
