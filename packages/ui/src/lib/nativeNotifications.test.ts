import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { PushNotificationSchema } from '@capacitor/push-notifications';

let platform: 'ios' | 'android' | 'web' = 'web';
let delivered: PushNotificationSchema[] = [];
let removed: PushNotificationSchema[][] = [];
let readFailure: Error | null = null;

mock.module('@/lib/platform', () => ({ getClientPlatform: () => platform }));
mock.module('@capacitor/push-notifications', () => ({
  PushNotifications: {
    getDeliveredNotifications: async () => {
      if (readFailure) throw readFailure;
      return { notifications: delivered };
    },
    removeDeliveredNotifications: async ({ notifications }: { notifications: PushNotificationSchema[] }) => {
      removed.push(notifications);
    },
  },
}));

const { clearNativeSessionNotifications } = await import('./nativeNotifications');

// SAFETY: the clear path reads only id and data, which the fixture sets.
const banner = (id: string, sessionId?: string): PushNotificationSchema => ({
  id,
  title: 'Agent response is ready',
  body: '',
  data: sessionId ? { sessionId } : { type: 'pull-request' },
} as PushNotificationSchema);

describe('clearing native session notifications', () => {
  beforeEach(() => {
    platform = 'android';
    delivered = [];
    removed = [];
    readFailure = null;
  });

  test('removes only the banners of the sessions the user saw', async () => {
    delivered = [
      banner('a', 'ses_seen'),
      banner('b', 'ses_other'),
      banner('c', 'ses_seen'),
      banner('d'),
    ];

    await clearNativeSessionNotifications(['ses_seen']);

    expect(removed).toEqual([[delivered[0], delivered[2]]]);
  });

  test('removes banners for every session marked seen', async () => {
    delivered = [banner('a', 'ses_one'), banner('b', 'ses_two'), banner('c', 'ses_other')];

    await clearNativeSessionNotifications(['ses_one', 'ses_two']);

    expect(removed).toEqual([[delivered[0], delivered[1]]]);
  });

  test('does nothing when no banner belongs to the session', async () => {
    delivered = [banner('a', 'ses_other')];

    await clearNativeSessionNotifications(['ses_seen']);

    expect(removed).toEqual([]);
  });

  test('marking everything seen removes every banner of the known sessions and leaves pull requests', async () => {
    delivered = [banner('a', 'ses_one'), banner('b', 'ses_two'), banner('c')];

    await clearNativeSessionNotifications(['ses_one', 'ses_two']);

    expect(removed).toEqual([[delivered[0], delivered[1]]]);
  });

  test('runs on iOS and stays quiet elsewhere', async () => {
    delivered = [banner('a', 'ses_seen')];

    platform = 'web';
    await clearNativeSessionNotifications(['ses_seen']);
    expect(removed).toEqual([]);

    platform = 'ios';
    await clearNativeSessionNotifications(['ses_seen']);
    expect(removed).toEqual([[delivered[0]]]);
  });

  test('survives a list read that fails before registration completes', async () => {
    readFailure = new Error('registration not called');

    await clearNativeSessionNotifications(['ses_seen']);

    expect(removed).toEqual([]);
  });
});
