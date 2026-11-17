import React from 'react';
import { registerPlugin } from '@capacitor/core';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getClientPlatform } from '@/lib/platform';
import type { ApnsTokenPayload } from '@/lib/api/types';
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
// APNs environment of this build. Xcode/dev-signed installs get sandbox device tokens,
// TestFlight/App Store installs get production ones; the native iOS shell reports which via
// a global injected in SceneDelegate (see packages/mobile/ios/App/App/AppDelegate.swift).
// Undefined when the global is absent (Android, or a shell predating the injection) — the
// server then defaults to production, matching released builds.
const getApnsEnvironment = (): 'sandbox' | 'production' | undefined => {
  if (typeof window === 'undefined') return undefined;
  const env = (window as typeof window & { __OPENCHAMBER_APNS_ENV__?: string }).__OPENCHAMBER_APNS_ENV__;
  if (env === 'development') return 'sandbox';
  if (env === 'production') return 'production';
  return undefined;
};

/**
 * The key this phone opens sealed push text with. The native shell makes it
 * once and keeps it where its notification extension (iOS) or messaging
 * service (Android) can read it; iOS stamps it on the page at document start,
 * Android answers through the app-local PushKey plugin. Undefined from a shell
 * that predates it: the server then keeps sending plain text.
 */
const PUSH_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

declare global {
  interface Window {
    __OPENCHAMBER_PUSH_KEY__?: string;
  }
}

interface PushKeyPlugin {
  get(): Promise<{ key: string }>;
  pushAvailable(): Promise<{ available: boolean }>;
}

const PushKey = registerPlugin<PushKeyPlugin>('PushKey');

const getPushKey = async (): Promise<string | undefined> => {
  const injected = window.__OPENCHAMBER_PUSH_KEY__;
  if (injected && PUSH_KEY_PATTERN.test(injected)) return injected;
  // iOS has no PushKey plugin: the call rejects, and the injected key above
  // is its answer.
  const key = await PushKey.get().then((result) => result.key).catch(() => undefined);
  return key && PUSH_KEY_PATTERN.test(key) ? key : undefined;
};

/**
 * Whether this native build has Firebase configured. Without it (a package with no client in
 * google-services.json) the push plugin's register() throws on the native side, so the app must
 * not call it. iOS and older Android builds have no answer and count as available.
 */
const isPushAvailable = async (): Promise<boolean> =>
  PushKey.pushAvailable().then((result) => result.available).catch(() => true);

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
  // Settles when the latest registerApnsToken POST settles. The disable
  // effect waits on it so its DELETE lands after an in-flight POST —
  // otherwise the POST's server-side upsert would resurrect a registration
  // the user just turned off (#2159).
  const inFlightRegistrationRef = React.useRef<Promise<unknown> | null>(null);

  React.useEffect(() => {
    if (!enabled || !nativeNotificationsEnabled || !isNativePushPlatform()) {
      return;
    }

    let disposed = false;
    const cleanup: Array<() => void> = [];

    void import('@capacitor/push-notifications')
      .then(async ({ PushNotifications }) => {
        if (disposed) return;
        if (!(await isPushAvailable())) return;

        let permission = await PushNotifications.checkPermissions().catch(() => null);
        if (permission?.receive !== 'granted') {
          permission = await PushNotifications.requestPermissions().catch(() => null);
        }
        if (permission?.receive !== 'granted') {
          return;
        }

        const registrationHandle = await PushNotifications.addListener('registration', (token) => {
          lastTokenRef.current = token.value;
          void getPushKey().then((pushKey) => {
            // The key lookup is async: if this lifecycle ended while it was
            // in flight (notifications disabled, disconnect, unmount), the
            // disable path has already unregistered — posting now would
            // re-register a device the user turned off (#2159).
            if (disposed) return;
            const apis = getRegisteredRuntimeAPIs();
            const payload: ApnsTokenPayload = {
              token: token.value,
              platform: getClientPlatform(),
              environment: getApnsEnvironment(),
            };
            if (pushKey) payload.pushKey = pushKey;
            const registration = Promise.resolve(apis?.push?.registerApnsToken?.(payload)).catch(() => undefined);
            inFlightRegistrationRef.current = registration;
            void registration.finally(() => {
              if (inFlightRegistrationRef.current === registration) {
                inFlightRegistrationRef.current = null;
              }
            });
          });
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
    const inFlight = inFlightRegistrationRef.current;
    void (async () => {
      // A registration POST already in flight must settle before the DELETE
      // is sent, or its upsert lands after the removal and the device stays
      // registered with notifications off (#2159).
      if (inFlight) await inFlight.catch(() => undefined);
      await apis?.push?.unregisterApnsToken?.({ token });
    })();
  }, [nativeNotificationsEnabled]);
};
