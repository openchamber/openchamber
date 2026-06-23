import type { NotificationPayload, NotificationsAPI } from '@/lib/api/types';

// Native (Capacitor) notifications for the iOS mobile app, backed by Local
// Notifications. The existing SSE notification stream (useWebNotificationStream) already
// gates on the notification settings + focus, then calls `notifyAgentCompletion`; here we
// just deliver it as a native banner. Works while the app is alive or in the brief
// background window iOS grants before suspending. (True background-when-suspended needs
// APNs, which is implemented but frozen — see notifications/APNS.md.)

const DEDUPE_TTL_MS = 5000;
const recentTags = new Map<string, number>();

let notificationCounter = 1;
const nextNotificationId = (): number => {
  // Local Notification ids must be 32-bit ints; wrap well within that range.
  notificationCounter = (notificationCounter % 2_000_000_000) + 1;
  return notificationCounter;
};

const shouldDeliver = (tag: string | undefined): boolean => {
  if (!tag) return true;
  const now = Date.now();
  for (const [key, at] of recentTags) {
    if (now - at > DEDUPE_TTL_MS) recentTags.delete(key);
  }
  const prev = recentTags.get(tag) ?? 0;
  if (now - prev < DEDUPE_TTL_MS) return false;
  recentTags.set(tag, now);
  return true;
};

const ensurePermission = async (): Promise<boolean> => {
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const check = await LocalNotifications.checkPermissions().catch(() => null);
    if (check?.display === 'granted') return true;
    const requested = await LocalNotifications.requestPermissions().catch(() => null);
    return requested?.display === 'granted';
  } catch {
    return false;
  }
};

export const createNativeNotificationsAPI = (): NotificationsAPI => ({
  async notifyAgentCompletion(payload?: NotificationPayload): Promise<boolean> {
    if (!shouldDeliver(payload?.tag)) return true;
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      if (!(await ensurePermission())) return false;
      await LocalNotifications.schedule({
        notifications: [
          {
            id: nextNotificationId(),
            title: payload?.title ?? 'OpenChamber',
            body: payload?.body ?? '',
            // Carried back on tap (see useNativeLocalNotifications) to deep-link.
            extra: {
              sessionId: payload?.sessionId,
              type: payload?.kind,
            },
          },
        ],
      });
      return true;
    } catch (error) {
      console.warn('[LocalNotifications] schedule failed:', error);
      return false;
    }
  },
  async canNotify() {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const check = await LocalNotifications.checkPermissions().catch(() => null);
      return check?.display === 'granted';
    } catch {
      return false;
    }
  },
});
