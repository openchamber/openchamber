import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPushRuntime } from './push-runtime.js';

const createRuntime = ({ fsPromises } = {}) => createPushRuntime({
  fsPromises: fsPromises ?? {
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async () => JSON.stringify({ version: 1, subscriptionsBySession: {} })),
    writeFile: vi.fn(async () => {}),
  },
  path: { dirname: () => '/tmp' },
  loadWebPush: async () => ({
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'public', privateKey: 'private' })),
    sendNotification: vi.fn(async () => {}),
    setVapidDetails: vi.fn(),
  }),
  PUSH_SUBSCRIPTIONS_FILE_PATH: '/tmp/push-subscriptions.json',
  readSettingsFromDiskMigrated: vi.fn(async () => ({})),
  writeSettingsToDisk: vi.fn(async () => {}),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('push runtime visibility tracking', () => {
  it('keeps visible UI state when another client reports hidden', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();

    runtime.updateUiVisibility('visible-client', true);
    runtime.updateUiVisibility('hidden-client', false);

    expect(runtime.isAnyUiVisible()).toBe(true);
    expect(runtime.isUiVisible('visible-client')).toBe(true);
    expect(runtime.isUiVisible('hidden-client')).toBe(false);

    vi.advanceTimersByTime(30_001);

    expect(runtime.isAnyUiVisible()).toBe(false);
    expect(runtime.isUiVisible('visible-client')).toBe(false);
  });

  it('treats only mobile platforms as non-interactive for isAnyInteractiveClientVisible', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();

    // Only the phone (foreground) is connected → no interactive client to absorb the notification.
    runtime.updateUiVisibility('phone', true, 'ios');
    expect(runtime.isAnyUiVisible()).toBe(true);
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);

    // A visible desktop counts as interactive → suppress mobile push.
    runtime.updateUiVisibility('desktop', true, 'desktop');
    expect(runtime.isAnyInteractiveClientVisible()).toBe(true);

    // Desktop hidden again → back to mobile-only, push should flow to the phone.
    runtime.updateUiVisibility('desktop', false, 'desktop');
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);

    // A client that never reported a platform is treated as interactive (conservative).
    runtime.updateUiVisibility('legacy', true);
    expect(runtime.isAnyInteractiveClientVisible()).toBe(true);
  });

  it('remembers the last platform when a heartbeat omits it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();
    runtime.updateUiVisibility('phone', true, 'android');
    runtime.updateUiVisibility('phone', true); // heartbeat without platform
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);
  });
});

describe('push subscription persistence', () => {
  it('saves the next subscription after a write fails on a full disk', async () => {
    let content = JSON.stringify({ version: 1, subscriptionsBySession: {} });
    let failNextWrite = true;
    const runtime = createRuntime({
      fsPromises: {
        mkdir: vi.fn(async () => {}),
        readFile: vi.fn(async () => content),
        writeFile: vi.fn(async (_path, data) => {
          if (failNextWrite) {
            failNextWrite = false;
            const error = new Error('ENOSPC: no space left on device, write');
            error.code = 'ENOSPC';
            throw error;
          }
          content = data;
        }),
      },
    });
    const subscription = (endpoint) => ({ endpoint, p256dh: 'p256dh', auth: 'auth' });

    await expect(runtime.addOrUpdatePushSubscription('ui-token', subscription('https://push.test/a'))).rejects.toThrow('ENOSPC');
    await expect(runtime.addOrUpdatePushSubscription('ui-token', subscription('https://push.test/b'))).resolves.toBeUndefined();

    const stored = JSON.parse(content);
    expect(Object.values(stored.subscriptionsBySession).flat().map((entry) => entry.endpoint)).toEqual(['https://push.test/b']);
  });
});
