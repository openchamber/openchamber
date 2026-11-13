import { beforeEach, describe, expect, test } from 'bun:test';
import type { PushNotificationSchema } from '@capacitor/push-notifications';

import { clearNativeSessionNotifications } from './nativeNotifications';

let delivered: PushNotificationSchema[] = [];
let removed: PushNotificationSchema[][] = [];
let readFailure: Error | null = null;

const loadPush = async () => ({
  getDeliveredNotifications: async () => {
    if (readFailure) throw readFailure;
    return { notifications: delivered };
  },
  removeDeliveredNotifications: async ({ notifications }: { notifications: PushNotificationSchema[] }) => {
    removed.push(notifications);
  },
});

// SAFETY: the clear path reads only id and data, which the fixture sets.
const banner = (id: string, sessionId?: string): PushNotificationSchema => ({
  id,
  title: 'Agent response is ready',
  body: '',
  data: sessionId ? { sessionId } : { type: 'pull-request' },
} as PushNotificationSchema);

const clearOnAndroid = (sessionIds: readonly string[]): Promise<void> => (
  clearNativeSessionNotifications(sessionIds, 'android', loadPush)
);

describe('clearing native session notifications', () => {
  beforeEach(() => {
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

    await clearOnAndroid(['ses_seen']);

    expect(removed).toEqual([[delivered[0], delivered[2]]]);
  });

  test('removes banners for every session marked seen', async () => {
    delivered = [banner('a', 'ses_one'), banner('b', 'ses_two'), banner('c', 'ses_other')];

    await clearOnAndroid(['ses_one', 'ses_two']);

    expect(removed).toEqual([[delivered[0], delivered[1]]]);
  });

  test('does nothing when no banner belongs to the session', async () => {
    delivered = [banner('a', 'ses_other')];

    await clearOnAndroid(['ses_seen']);

    expect(removed).toEqual([]);
  });

  test('marking everything seen removes every banner of the known sessions and leaves pull requests', async () => {
    delivered = [banner('a', 'ses_one'), banner('b', 'ses_two'), banner('c')];

    await clearOnAndroid(['ses_one', 'ses_two']);

    expect(removed).toEqual([[delivered[0], delivered[1]]]);
  });

  test('runs on iOS and stays quiet elsewhere', async () => {
    delivered = [banner('a', 'ses_seen')];

    await clearNativeSessionNotifications(['ses_seen'], 'web', loadPush);
    expect(removed).toEqual([]);

    await clearNativeSessionNotifications(['ses_seen'], 'ios', loadPush);
    expect(removed).toEqual([[delivered[0]]]);
  });

  test('survives a list read that fails before registration completes', async () => {
    readFailure = new Error('registration not called');

    await clearOnAndroid(['ses_seen']);

    expect(removed).toEqual([]);
  });
});
