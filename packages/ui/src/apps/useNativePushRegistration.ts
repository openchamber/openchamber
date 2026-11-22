import React from 'react';
import { registerPlugin } from '@capacitor/core';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getClientPlatform } from '@/lib/platform';
import type { ApnsTokenPayload } from '@/lib/api/push';
import { useUIStore } from '@/stores/useUIStore';

import { MOBILE_CONNECTIONS_CHANGED_EVENT } from './mobileConnections';
import { loadStoredPushToken, nativePushHasTarget, syncPushTokenToSavedConnections } from './mobilePushTokens';

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
  const tokenPayloadRef = React.useRef<ApnsTokenPayload | null>(null);
  const syncQueueRef = React.useRef<Promise<void>>(Promise.resolve());

  const syncToken = React.useCallback((payload: ApnsTokenPayload, action: 'register' | 'unregister'): Promise<void> => {
    const run = async () => {
      const activeCovered = await syncPushTokenToSavedConnections(payload, action).catch(() => false);
      if (activeCovered) return;
      const apis = getRegisteredRuntimeAPIs();
      if (action === 'register') await apis?.push?.registerApnsToken?.(payload);
      else await apis?.push?.unregisterApnsToken?.(payload);
    };
    syncQueueRef.current = syncQueueRef.current.then(run, run).catch(() => undefined);
    return syncQueueRef.current;
  }, []);

  React.useEffect(() => {
    if (!enabled || !nativeNotificationsEnabled || !isNativePushPlatform()) {
      return;
    }

    let disposed = false;
    const cleanup: Array<() => void> = [];

    void import('@capacitor/push-notifications')
      .then(async ({ PushNotifications }) => {
        if (disposed) return;

        const delivery = await getRegisteredRuntimeAPIs()?.push?.getDeliveryStatus?.();
        if (disposed || !nativePushHasTarget(delivery)) return;

        let permission = await PushNotifications.checkPermissions().catch(() => null);
        if (permission?.receive !== 'granted') {
          permission = await PushNotifications.requestPermissions().catch(() => null);
        }
        if (permission?.receive !== 'granted') {
          return;
        }

        if (tokenPayloadRef.current) {
          void syncToken(tokenPayloadRef.current, 'register');
        } else {
          void loadStoredPushToken().then((stored) => {
            if (disposed || !stored || tokenPayloadRef.current) return;
            tokenPayloadRef.current = stored;
            void syncToken(stored, 'register');
          });
        }

        const handleConnectionsChanged = () => {
          const payload = tokenPayloadRef.current;
          if (payload && useUIStore.getState().nativeNotificationsEnabled) void syncToken(payload, 'register');
        };
        window.addEventListener(MOBILE_CONNECTIONS_CHANGED_EVENT, handleConnectionsChanged);
        cleanup.push(() => window.removeEventListener(MOBILE_CONNECTIONS_CHANGED_EVENT, handleConnectionsChanged));

        const registrationHandle = await PushNotifications.addListener('registration', (token) => {
          lastTokenRef.current = token.value;
          void getPushKey().then((pushKey) => {
            if (disposed || !useUIStore.getState().nativeNotificationsEnabled) return;
            const payload: ApnsTokenPayload = {
              token: token.value,
              platform: getClientPlatform(),
              environment: getApnsEnvironment(),
            };
            if (pushKey) payload.pushKey = pushKey;
            tokenPayloadRef.current = payload;
            void syncToken(payload, 'register');
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
  }, [enabled, nativeNotificationsEnabled, syncToken]);

  React.useEffect(() => {
    if (nativeNotificationsEnabled) return;
    const token = lastTokenRef.current;
    const payload: ApnsTokenPayload | null = tokenPayloadRef.current ?? (token ? { token } : null);
    if (payload) {
      lastTokenRef.current = null;
      tokenPayloadRef.current = null;
      void syncToken(payload, 'unregister');
      return;
    }
    void loadStoredPushToken().then((stored) => {
      if (stored && !useUIStore.getState().nativeNotificationsEnabled) void syncToken(stored, 'unregister');
    });
  }, [nativeNotificationsEnabled, syncToken]);
};
