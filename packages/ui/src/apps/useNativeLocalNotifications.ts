import React from 'react';

import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Wires native iOS Local Notifications for the Capacitor app: requests the system
 * notification permission while the app is foregrounded, and opens the relevant session
 * when a delivered notification is tapped. Delivery itself goes through the native
 * notifications API (see nativeNotifications.ts) driven by the existing SSE stream.
 *
 * Pass `enabled = isNativeMobileApp`.
 */
export const useNativeLocalNotifications = (options: { enabled: boolean }): void => {
  const { enabled } = options;
  const nativeNotificationsEnabled = useUIStore((state) => state.nativeNotificationsEnabled);

  // Tap on a delivered notification → open its session.
  React.useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    const cleanup: Array<() => void> = [];

    void import('@capacitor/local-notifications')
      .then(async ({ LocalNotifications }) => {
        if (disposed) return;
        const tapHandle = await LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
          const extra = action?.notification?.extra as Record<string, unknown> | undefined;
          const sessionId = typeof extra?.sessionId === 'string' ? extra.sessionId : undefined;
          if (sessionId) {
            void useSessionUIStore.getState().setCurrentSession(sessionId);
          }
        });
        if (disposed) {
          void tapHandle.remove();
          return;
        }
        cleanup.push(() => void tapHandle.remove());
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
    };
  }, [enabled]);

  // Request the notification permission upfront (while foregrounded) so the prompt
  // doesn't have to appear mid-delivery.
  React.useEffect(() => {
    if (!enabled || !nativeNotificationsEnabled) return;

    void import('@capacitor/local-notifications')
      .then(async ({ LocalNotifications }) => {
        const check = await LocalNotifications.checkPermissions().catch(() => null);
        if (check?.display !== 'granted') {
          await LocalNotifications.requestPermissions().catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, [enabled, nativeNotificationsEnabled]);
};
