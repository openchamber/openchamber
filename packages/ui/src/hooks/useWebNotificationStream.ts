import React from 'react';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import type { NotificationPayload } from '@/lib/api/types';

const NOTIFICATION_STREAM_PATH = '/api/notifications/stream';

// /api/notifications/stream is an OpenChamber-internal endpoint always served
// by the OpenChamber Express server (not the upstream OpenCode). In proxy-bypass
// mode the runtime-url resolver may point at the external OpenCode origin, but
// the Express server is still running on the page origin — so we anchor these
// streams there. Without this, the proxy-bypass deployment would 404 every
// notification and trip an EventSource reconnect loop.
const openchamberStreamUrl = (path: string): string => {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${path}`;
  }
  return path;
};

const isFocused = () => {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
};

const toNotificationPayload = (value: unknown): NotificationPayload | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const properties = record.properties && typeof record.properties === 'object'
    ? record.properties as Record<string, unknown>
    : null;
  if (record.type !== 'openchamber:notification' || !properties) return null;
  return {
    title: typeof properties.title === 'string' ? properties.title : undefined,
    body: typeof properties.body === 'string' ? properties.body : undefined,
    tag: typeof properties.tag === 'string' ? properties.tag : undefined,
  };
};

export const useWebNotificationStream = (options?: { enabled?: boolean }) => {
  const enabled = options?.enabled ?? true;

  React.useEffect(() => {
    if (!enabled || isDesktopShell() || !isWebRuntime() || typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return;
    }

    const source = new EventSource(openchamberStreamUrl(NOTIFICATION_STREAM_PATH));
    source.onmessage = (event) => {
      let data: unknown;
      try {
        data = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }

      const settings = useUIStore.getState();
      if (!settings.nativeNotificationsEnabled) return;
      if (settings.notificationMode !== 'always' && isFocused()) return;

      const payload = toNotificationPayload(data);
      if (!payload) return;

      const apis = getRegisteredRuntimeAPIs();
      void apis?.notifications?.notifyAgentCompletion(payload);
    };

    return () => {
      source.close();
    };
  }, [enabled]);
};
