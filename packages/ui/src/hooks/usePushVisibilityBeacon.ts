import React from 'react';
import { isWebRuntime } from '@/lib/desktop';
import { getClientPlatform, isCapacitorApp } from '@/lib/platform';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

const HEARTBEAT_MS = 20000;

const resolveVisibilityState = (): 'visible' | 'hidden' => {
  if (typeof document === 'undefined') return 'visible';
  return document.visibilityState === 'visible' && document.hasFocus() ? 'visible' : 'hidden';
};

const sendVisibility = (visible: boolean) => {
  if (!isWebRuntime() && !isCapacitorApp()) {
    return;
  }

  const apis = getRegisteredRuntimeAPIs();
  if (!apis?.push?.setVisibility) {
    return;
  }

  void apis.push.setVisibility({ visible, platform: getClientPlatform() });
};

export const usePushVisibilityBeacon = (options?: { enabled?: boolean }) => {
  const enabled = options?.enabled ?? true;
  React.useEffect(() => {
    if (!enabled || (!isWebRuntime() && !isCapacitorApp()) || typeof window === 'undefined') {
      return;
    }

    if (isCapacitorApp()) {
      let active = true;
      let disposed = false;
      let removeListener: (() => void) | null = null;
      const reportActive = () => sendVisibility(active);

      void import('@capacitor/app')
        .then(async ({ App }) => {
          if (disposed) return;
          const state = await App.getState().catch(() => null);
          if (state) active = state.isActive === true;
          reportActive();
          const handle = await App.addListener('appStateChange', ({ isActive }) => {
            active = isActive === true;
            reportActive();
          });
          if (disposed) {
            void handle.remove();
            return;
          }
          removeListener = () => void handle.remove();
        })
        .catch(() => undefined);

      const interval = window.setInterval(() => {
        if (active) sendVisibility(true);
      }, HEARTBEAT_MS);

      return () => {
        disposed = true;
        window.clearInterval(interval);
        removeListener?.();
      };
    }

    if (typeof document === 'undefined') {
      return;
    }

    const report = () => {
      sendVisibility(resolveVisibilityState() === 'visible');
    };

    const reportVisibleOnly = () => {
      if (resolveVisibilityState() === 'visible') {
        sendVisibility(true);
      }
    };

    const reportPageHidden = () => {
      sendVisibility(false);
    };

    report();

    const interval = window.setInterval(reportVisibleOnly, HEARTBEAT_MS);

    document.addEventListener('visibilitychange', report);
    window.addEventListener('pagehide', reportPageHidden);
    window.addEventListener('pageshow', report);
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('pagehide', reportPageHidden);
      window.removeEventListener('pageshow', report);
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
    };
  }, [enabled]);
};
