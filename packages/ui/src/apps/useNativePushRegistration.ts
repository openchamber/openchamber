import React from 'react';
import { registerPlugin } from '@capacitor/core';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getClientPlatform } from '@/lib/platform';
import type { ApnsTokenPayload } from '@/lib/api/types';
import { useUIStore } from '@/stores/useUIStore';

const getApnsEnvironment = (): 'sandbox' | 'production' | undefined => {
  if (typeof window === 'undefined') return undefined;
  const env = (window as typeof window & { __OPENCHAMBER_APNS_ENV__?: string }).__OPENCHAMBER_APNS_ENV__;
  if (env === 'development') return 'sandbox';
  if (env === 'production') return 'production';
  return undefined;
};

const PUSH_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

declare global {
  interface Window {
    __OPENCHAMBER_PUSH_KEY__?: string;
  }
}

interface PushKeyPlugin {
  get(): Promise<{ key: string }>;
}

const PushKey = registerPlugin<PushKeyPlugin>('PushKey');

const getPushKey = async (): Promise<string | undefined> => {
  const injected = window.__OPENCHAMBER_PUSH_KEY__;
  if (injected && PUSH_KEY_PATTERN.test(injected)) return injected;
  const key = await PushKey.get().then((result) => result.key).catch(() => undefined);
  return key && PUSH_KEY_PATTERN.test(key) ? key : undefined;
};

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
          void getPushKey().then((pushKey) => {
            const apis = getRegisteredRuntimeAPIs();
            const payload: ApnsTokenPayload = {
              token: token.value,
              platform: getClientPlatform(),
              environment: getApnsEnvironment(),
            };
            if (pushKey) payload.pushKey = pushKey;
            void apis?.push?.registerApnsToken?.(payload);
          });
        });

        const registrationErrorHandle = await PushNotifications.addListener('registrationError', (error) => {
          console.warn('[Push] APNs registration error:', error);
        });


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

  React.useEffect(() => {
    if (nativeNotificationsEnabled) return;
    const token = lastTokenRef.current;
    if (!token) return;
    lastTokenRef.current = null;
    const apis = getRegisteredRuntimeAPIs();
    void apis?.push?.unregisterApnsToken?.({ token });
  }, [nativeNotificationsEnabled]);
};
