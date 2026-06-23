import React from 'react';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * FROZEN / NOT WIRED. APNs remote push is implemented end-to-end but intentionally
 * dormant — see `packages/web/server/lib/notifications/APNS.md`. It will be reused once
 * OpenChamber ships its own encrypted relay (so users don't each configure APNs). To
 * reinstate, call this hook from MobileApp and restore the iOS entitlement / background
 * mode per that doc.
 *
 * Registers the native iOS APNs device token with the connected server so the app can
 * receive remote push even when suspended/closed.
 *
 * Lazy-imports `@capacitor/push-notifications` (only present in the Capacitor shell),
 * mirroring the other `@capacitor/*` integrations in MobileApp. On `registration` the
 * device token is sent to the server via `apis.push.registerApnsToken`; tapping a push
 * deep-links to its session. Pass `enabled = isNativeMobileApp && isConnected`; the hook
 * additionally gates on the `nativeNotificationsEnabled` setting and re-registers when
 * the connection (and thus the active server endpoint) changes.
 */
export const useNativePushRegistration = (options: { enabled: boolean }): void => {
  const { enabled } = options;
  const nativeNotificationsEnabled = useUIStore((state) => state.nativeNotificationsEnabled);
  const lastTokenRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!enabled || !nativeNotificationsEnabled) {
      return;
    }

    let disposed = false;
    const cleanup: Array<() => void> = [];

    void import('@capacitor/push-notifications')
      .then(async ({ PushNotifications }) => {
        if (disposed) return;

        let permission = await PushNotifications.checkPermissions().catch(() => null);
        if (permission?.receive !== 'granted') {
          permission = await PushNotifications.requestPermissions().catch(() => null);
        }
        if (permission?.receive !== 'granted') {
          return;
        }

        const registrationHandle = await PushNotifications.addListener('registration', (token) => {
          lastTokenRef.current = token.value;
          const apis = getRegisteredRuntimeAPIs();
          void apis?.push?.registerApnsToken?.({ token: token.value });
        });

        const registrationErrorHandle = await PushNotifications.addListener('registrationError', (error) => {
          console.warn('[Push] APNs registration error:', error);
        });

        // Tap on a delivered push → open its session.
        const actionHandle = await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const data = action?.notification?.data as Record<string, unknown> | undefined;
          const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : undefined;
          if (sessionId) {
            void useSessionUIStore.getState().setCurrentSession(sessionId);
          }
        });

        await PushNotifications.register().catch(() => undefined);

        if (disposed) {
          void registrationHandle.remove();
          void registrationErrorHandle.remove();
          void actionHandle.remove();
          return;
        }
        cleanup.push(
          () => void registrationHandle.remove(),
          () => void registrationErrorHandle.remove(),
          () => void actionHandle.remove(),
        );
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
    };
  }, [enabled, nativeNotificationsEnabled]);

  // When notifications are turned off, drop the token from the server so it stops
  // pushing to this device. (Separate from the register effect so a transient
  // disconnect doesn't unregister.)
  React.useEffect(() => {
    if (nativeNotificationsEnabled) return;
    const token = lastTokenRef.current;
    if (!token) return;
    lastTokenRef.current = null;
    const apis = getRegisteredRuntimeAPIs();
    void apis?.push?.unregisterApnsToken?.({ token });
  }, [nativeNotificationsEnabled]);
};
