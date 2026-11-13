import type { PushNotificationSchema } from '@capacitor/push-notifications';

import { getClientPlatform } from '@/lib/platform';

type SessionPushData = { sessionId?: string };

type NativePush = {
  getDeliveredNotifications: () => Promise<{ notifications: PushNotificationSchema[] }>;
  removeDeliveredNotifications: (options: { notifications: PushNotificationSchema[] }) => Promise<void>;
};

const loadNativePush = async (): Promise<NativePush> => {
  const { PushNotifications } = await import('@capacitor/push-notifications');
  return PushNotifications;
};

const sessionIdOf = (notification: PushNotificationSchema): string | undefined => {
  const data: SessionPushData | undefined = notification.data;
  return data?.sessionId;
};

export const clearNativeSessionNotifications = async (
  sessionIds: readonly string[],
  platform: ReturnType<typeof getClientPlatform> = getClientPlatform(),
  loadPush: () => Promise<NativePush> = loadNativePush,
): Promise<void> => {
  if (platform !== 'ios' && platform !== 'android') return;
  if (sessionIds.length === 0) return;

  const wanted = new Set(sessionIds);
  try {
    const push = await loadPush();
    const delivered = await push.getDeliveredNotifications();
    const matching = delivered.notifications.filter((notification) => {
      const sessionId = sessionIdOf(notification);
      return sessionId !== undefined && wanted.has(sessionId);
    });
    if (matching.length === 0) return;
    await push.removeDeliveredNotifications({ notifications: matching });
  } catch {
    return;
  }
};
