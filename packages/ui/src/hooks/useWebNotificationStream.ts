import React from 'react';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { toast } from '@/components/ui';
import { isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useUIStore } from '@/stores/useUIStore';

const isFocused = () => {
  if (!globalThis.document) return true;
  return document.visibilityState === 'visible' && document.hasFocus();
};

const notificationToastId = (kind?: string, title?: string, body?: string, tag?: string) => {
  if (tag) return tag;
  const fallback = [kind, title, body].filter(Boolean).join('|');
  return fallback || undefined;
};

const showPluginToast = (payload: { kind?: string; title?: string; body?: string; tag?: string }) => {
  if (payload.kind !== 'plugin' || !payload.title) return;
  toast.info(payload.title, {
    id: notificationToastId(payload.kind, payload.title, payload.body, payload.tag),
    description: payload.body,
  });
};

const shouldShowPluginToast = (payload: { kind?: string; showWhenFocused?: boolean }, focused: boolean) => (
  payload.kind === 'plugin' && focused && payload.showWhenFocused === true
);

export const useWebNotificationStream = (options?: { enabled?: boolean }) => {
  const enabled = options?.enabled ?? true;

  React.useEffect(() => {
    if (!enabled || isDesktopShell() || !isWebRuntime() || !globalThis.window) {
      return;
    }

    return subscribeOpenchamberEvents((event) => {
      if (event.type !== 'notification') return;
      if (event.payload.kind === 'share-answer' && event.payload.toastOnly === true) return;
      const settings = useUIStore.getState();
      if (!settings.nativeNotificationsEnabled) return;
      const focused = isFocused();
      if (shouldShowPluginToast(event.payload, focused)) {
        showPluginToast(event.payload);
        return;
      }
      if (settings.notificationMode !== 'always' && event.payload.requireHidden !== false && focused) return;

      const apis = getRegisteredRuntimeAPIs();
      void apis?.notifications?.notifyAgentCompletion(event.payload);
    });
  }, [enabled]);
};
