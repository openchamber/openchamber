// Removes the native app's delivered notifications for sessions the user has
// seen. Desktop clears its own through the Electron IPC command in
// `desktop.ts`; a browser has no delivered-notification list to clear.
//
// The Capacitor push plugin owns the delivered-notification list on both
// platforms, so no app-local native plugin is needed: `getDeliveredNotifications`
// returns each banner with its `data`, which carries `sessionId` from the push
// (Android's `SealedPushMessagingService` copies it into the notification's
// extras, iOS keeps it in the request's userInfo). Matching on that id, never on
// the banner tag, keeps a session's banners apart from pull-request alerts,
// which name no session.

import type { PushNotificationSchema } from '@capacitor/push-notifications';

import { getClientPlatform } from '@/lib/platform';

// The plugin types `data` as `any`. This app's push sender puts a string
// `sessionId` there, so that is the shape read at this boundary; a banner from
// another sender, such as a pull-request alert, has none and does not match.
type SessionPushData = { sessionId?: string };

const sessionIdOf = (notification: PushNotificationSchema): string | undefined => {
  const data: SessionPushData | undefined = notification.data;
  return data?.sessionId;
};

const removeDelivered = async (matches: (notification: PushNotificationSchema) => boolean): Promise<void> => {
  const platform = getClientPlatform();
  if (platform !== 'ios' && platform !== 'android') return;

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    const delivered = await PushNotifications.getDeliveredNotifications();
    const matching = delivered.notifications.filter(matches);
    if (matching.length === 0) return;
    await PushNotifications.removeDeliveredNotifications({ notifications: matching });
  } catch {
    // The plugin rejects the list read before its registration completes, and
    // the next view clears what this one missed.
  }
};

export const clearNativeSessionNotifications = async (sessionIds: readonly string[]): Promise<void> => {
  if (sessionIds.length === 0) return;
  const wanted = new Set(sessionIds);
  await removeDelivered((notification) => {
    const sessionId = sessionIdOf(notification);
    return sessionId !== undefined && wanted.has(sessionId);
  });
};
