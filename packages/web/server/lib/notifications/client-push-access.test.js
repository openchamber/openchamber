import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createApnsRuntime } from './apns-runtime.js';
import { createClientPushAccess } from './client-push-access.js';
import { createPushRuntime } from './push-runtime.js';
import { clientSessionKeyFor, sessionKeyFor } from './session-key.js';

const RELAY_URL = 'https://relay.test/v1/push/send';

describe('client push access', () => {
  let dir;
  let clients;
  let apns;
  let push;
  let access;
  let relayedTokens;
  let webPushed;

  const clientToken = (client) => `client:${client.id}`;
  const pair = async (label) => (await clients.createClient({ label })).client;
  const registerPhone = (sessionToken, deviceToken) => apns.addOrUpdateApnsToken(sessionToken, deviceToken);
  const registerBrowser = (sessionToken, endpoint) => push.addOrUpdatePushSubscription(sessionToken, { endpoint, p256dh: 'p', auth: 'a' });

  const notify = async () => {
    relayedTokens.length = 0;
    webPushed.length = 0;
    await apns.sendApnsToAllUiSessions({ title: 't', body: 'b' });
    await push.sendPushToAllUiSessions({ title: 't', body: 'b' });
    return { phones: [...relayedTokens].sort(), browsers: [...webPushed].sort() };
  };

  const stored = async (file, field) => JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))[field];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-client-push-access-'));
    relayedTokens = [];
    webPushed = [];
    process.env.OPENCHAMBER_PUSH_RELAY_URL = RELAY_URL;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url) === RELAY_URL) relayedTokens.push(...JSON.parse(init.body).tokens);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }));

    clients = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath: path.join(dir, 'remote-clients.json') });
    const getInvalidSessionKeys = () => access.invalidSessionKeys();
    apns = createApnsRuntime({
      fsPromises: fs,
      path,
      crypto,
      http2: {},
      APNS_TOKENS_FILE_PATH: path.join(dir, 'apns-tokens.json'),
      readSettingsFromDiskMigrated: async () => ({}),
      relayKeyStore: {
        getOrCreate: async (_slot, generate) => generate(),
        generation: () => 0,
      },
      getInvalidSessionKeys,
    });
    push = createPushRuntime({
      fsPromises: fs,
      path,
      loadWebPush: async () => ({
        generateVAPIDKeys: () => ({ publicKey: 'public', privateKey: 'private' }),
        setVapidDetails: () => {},
        sendNotification: async (subscription) => { webPushed.push(subscription.endpoint); },
      }),
      PUSH_SUBSCRIPTIONS_FILE_PATH: path.join(dir, 'push-subscriptions.json'),
      readSettingsFromDiskMigrated: async () => ({}),
      writeSettingsToDisk: async () => {},
      getInvalidSessionKeys,
    });
    access = createClientPushAccess({
      listClients: clients.listClients,
      removeDevicesOfSessions: [apns.removeApnsDevicesOfSessions, push.removePushDevicesOfSessions],
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.OPENCHAMBER_PUSH_RELAY_URL;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('computes the key registrations made with a client token sit under', async () => {
    const created = await clients.createClient({ label: 'Phone' });
    const uiAuth = createUiAuth({ password: null, clientAuthController: clients });
    const sessionToken = await uiAuth.ensureSessionToken(
      { headers: { authorization: `Bearer ${created.token}` } },
      { setHeader: () => {} },
    );
    expect(sessionKeyFor(sessionToken)).toBe(clientSessionKeyFor(created.client.id));
  });

  it('stops a revoked client\'s device, under every key it registered with, and only that device', async () => {
    const revoked = await pair('Revoked');
    const valid = await pair('Valid');
    await registerPhone('older-cookie-session', 'phone-revoked');
    await registerPhone(clientToken(revoked), 'phone-revoked');
    await registerPhone(clientToken(valid), 'phone-valid');
    await registerPhone('cookie-session', 'phone-cookie');
    await registerBrowser('older-cookie-session', 'https://push.test/revoked');
    await registerBrowser(clientToken(revoked), 'https://push.test/revoked');
    await registerBrowser(clientToken(valid), 'https://push.test/valid');
    await registerBrowser('cookie-session', 'https://push.test/cookie');

    await clients.revokeClient(revoked.id);
    await access.removeDevicesOfClients([revoked.id]);

    expect(await notify()).toEqual({
      phones: ['phone-cookie', 'phone-valid'],
      browsers: ['https://push.test/cookie', 'https://push.test/valid'],
    });
    expect(Object.keys(await stored('apns-tokens.json', 'tokensBySession'))).not.toContain(clientSessionKeyFor(revoked.id));
    expect(Object.keys(await stored('push-subscriptions.json', 'subscriptionsBySession'))).not.toContain(clientSessionKeyFor(revoked.id));
  });

  it('keeps a device that is also registered under a client that is still valid', async () => {
    const revoked = await pair('Old pairing');
    const valid = await pair('New pairing');
    await registerPhone(clientToken(revoked), 'same-phone');
    await registerPhone(clientToken(valid), 'same-phone');
    await registerBrowser(clientToken(revoked), 'https://push.test/same');
    await registerBrowser(clientToken(valid), 'https://push.test/same');

    await clients.revokeClient(revoked.id);
    await access.removeDevicesOfClients([revoked.id]);

    expect(await notify()).toEqual({ phones: ['same-phone'], browsers: ['https://push.test/same'] });
  });

  it('sends nothing to a client that was revoked or expired without any cleanup', async () => {
    const revoked = await pair('Revoked by an older build');
    const expired = (await clients.createClient({ label: 'Expired', expiresAt: '2000-01-01T00:00:00.000Z' })).client;
    await registerPhone(clientToken(revoked), 'phone-revoked');
    await registerPhone(clientToken(expired), 'phone-expired');
    await registerPhone('cookie-session', 'phone-cookie');
    await registerBrowser(clientToken(revoked), 'https://push.test/revoked');
    await registerBrowser(clientToken(expired), 'https://push.test/expired');
    await registerBrowser('cookie-session', 'https://push.test/cookie');

    await clients.revokeClient(revoked.id);

    expect(await notify()).toEqual({ phones: ['phone-cookie'], browsers: ['https://push.test/cookie'] });
  });

  it('sends nothing when the client list cannot be read', async () => {
    await registerPhone('cookie-session', 'phone-cookie');
    await registerBrowser('cookie-session', 'https://push.test/cookie');
    await fs.rm(path.join(dir, 'remote-clients.json'), { force: true });
    await fs.mkdir(path.join(dir, 'remote-clients.json'));

    await expect(apns.sendApnsToAllUiSessions({ title: 't', body: 'b' })).rejects.toThrow();
    await expect(push.sendPushToAllUiSessions({ title: 't', body: 'b' })).rejects.toThrow();
    expect(relayedTokens).toEqual([]);
    expect(webPushed).toEqual([]);
  });
});
