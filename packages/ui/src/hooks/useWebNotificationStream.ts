import React from 'react';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useUIStore } from '@/stores/useUIStore';

const isFocused = () => {
  if (!globalThis.document) return true;
  return document.visibilityState === 'visible' && document.hasFocus();
};

export const useWebNotificationStream = (options?: { enabled?: boolean }) => {
  const enabled = options?.enabled ?? true;

  React.useEffect(() => {
    if (!enabled || isDesktopShell() || !isWebRuntime() || !globalThis.window) {
      return;
    }

    // The control stream already belongs to this runtime and reconnects with it.
    // A second EventSource consumed another HTTP/1.1 slot in every browser tab.
    return subscribeOpenchamberEvents((event) => {
      if (event.type !== 'notification') return;
      const settings = useUIStore.getState();
      if (!settings.nativeNotificationsEnabled) return;
      // `requireHidden: false` is the server's explicit opt-out (the always
      // mode, or a plugin notice sent with showWhenFocused).
      if (settings.notificationMode !== 'always' && event.payload.requireHidden !== false && isFocused()) return;

      // Keep the identity fields so the runtime API deduplicates this delivery
      // against the same notification arriving through the main event WebSocket.
      const apis = getRegisteredRuntimeAPIs();
      void apis?.notifications?.notifyAgentCompletion(event.payload);
    });
  }, [enabled]);
};
