import React from 'react';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getClientPlatform } from '@/lib/platform';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Registers the native iOS APNs device token with the connected server so the app can
 * receive remote push even when suspended/closed. Delivery goes through the central relay
 * (server posts generic text → relay signs+sends) — see
 * `packages/web/server/lib/notifications/APNS.md`.
 *
 * Lazy-imports `@capacitor/push-notifications` (only present in the Capacitor shell),
 * mirroring the other `@capacitor/*` integrations in MobileApp. On `registration` the
 * device token is sent to the server via `apis.push.registerApnsToken`; tapping a push
 * deep-links to its session. Pass `enabled = isNativeMobileApp && isConnected`; the hook
 * additionally gates on the `nativeNotificationsEnabled` setting and re-registers when
 * the connection (and thus the active server endpoint) changes.
 */
// Native push: iOS uses APNs, Android uses FCM. Both are set up natively (google-services.json +
// the Google Services Gradle plugin on Android), so @capacitor/push-notifications' register()
// returns the right token per platform. The token is sent to the server tagged with its platform
// so the relay routes it to APNs vs FCM.
const isNativePushPlatform = (): boolean => {
  if (typeof window === 'undefined') return false;
  const capacitor = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  const platform = capacitor?.getPlatform?.();
  return platform === 'ios' || platform === 'android';
};

export const useNativePushRegistration = (options: { enabled: boolean }): void => {
  const { enabled } = options;
  const nativeNotificationsEnabled = useUIStore((state) => state.nativeNotificationsEnabled);
  const lastTokenRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!enabled || !nativeNotificationsEnabled || !isNativePushPlatform()) {
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
          void apis?.push?.registerApnsToken?.({ token: token.value, platform: getClientPlatform() });
        });

        const registrationErrorHandle = await PushNotifications.addListener('registrationError', (error) => {
          console.warn('[Push] APNs registration error:', error);
        });

        // Note: notification-tap handling lives in the deep-link layer (`useDeepLinkSource`
        // in deepLinkNavigation), registered unconditionally so cold-launch taps aren't lost
        // while disconnected.

        await PushNotifications.register().catch(() => undefined);

        if (disposed) {
          void registrationHandle.remove();
          void registrationErrorHandle.remove();
          return;
        }
        cleanup.push(
          () => void registrationHandle.remove(),
          () => void registrationErrorHandle.remove(),
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
