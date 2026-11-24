import { describe, expect, it, vi } from 'vitest';

import { createSettingsWriteQueue } from '../settings/settings-write-queue.js';
import { registerNotificationRoutes } from './routes.js';

const subscribeBody = {
  endpoint: 'https://push.example/endpoint',
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
  origin: 'https://host.example',
};

const createSubscribeRoute = (initialSettings) => {
  let settings = initialSettings;
  const writeSettingsToDisk = vi.fn(async (next) => { settings = next; });
  const { updateSettingsFromDisk } = createSettingsWriteQueue(async () => settings, writeSettingsToDisk, (save) => save());
  const setPushInitialized = vi.fn();
  const routes = new Map();
  registerNotificationRoutes({
    get: () => {},
    post: (route, handler) => routes.set(route, handler),
    delete: () => {},
  }, {
    ensurePushInitialized: async () => {},
    getUiSessionTokenFromRequest: () => 'ui-token',
    updateSettingsFromDisk,
    addOrUpdatePushSubscription: async () => {},
    setPushInitialized,
  });
  const subscribe = () => routes.get('/api/push/subscribe')(
    { headers: {}, body: subscribeBody },
    { json: () => {}, status() { return this; } },
  );
  return { subscribe, writeSettingsToDisk, setPushInitialized, getSettings: () => settings };
};

describe('push subscribe route', () => {
  it('stores the first public origin once and resets push only then', async () => {
    const { subscribe, writeSettingsToDisk, setPushInitialized, getSettings } = createSubscribeRoute({});

    await subscribe();
    expect(getSettings().publicOrigin).toBe('https://host.example');
    expect(writeSettingsToDisk).toHaveBeenCalledTimes(1);
    expect(setPushInitialized).toHaveBeenCalledTimes(1);
    expect(setPushInitialized).toHaveBeenCalledWith(false);

    await subscribe();
    await subscribe();
    expect(writeSettingsToDisk).toHaveBeenCalledTimes(1);
    expect(setPushInitialized).toHaveBeenCalledTimes(1);
  });

  it('leaves settings and push alone when an origin is already saved', async () => {
    const { subscribe, writeSettingsToDisk, setPushInitialized } = createSubscribeRoute({ publicOrigin: 'https://saved.example' });

    await subscribe();
    expect(writeSettingsToDisk).not.toHaveBeenCalled();
    expect(setPushInitialized).not.toHaveBeenCalled();
  });
});
