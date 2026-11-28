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

    let interval: number | null = null;
    const renewVisible = isCapacitorApp()
      ? () => sendVisibility(true)
      : () => { if (resolveVisibilityState() === 'visible') sendVisibility(true); };
    const setBeating = (beating: boolean) => {
      if (beating && interval === null) interval = window.setInterval(renewVisible, HEARTBEAT_MS);
      if (!beating && interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };

    if (isCapacitorApp()) {
      let disposed = false;
      let removeListener: (() => void) | null = null;
      const reportActive = (active: boolean) => {
        setBeating(active);
        sendVisibility(active);
      };

      setBeating(true);
      void import('@capacitor/app')
        .then(async ({ App }) => {
          if (disposed) return;
          const state = await App.getState().catch(() => null);
          if (disposed) return;
          reportActive(state ? state.isActive === true : true);
          const handle = await App.addListener('appStateChange', ({ isActive }) => {
            reportActive(isActive === true);
          });
          if (disposed) {
            void handle.remove();
            return;
          }
          removeListener = () => void handle.remove();
        })
        .catch(() => undefined);

      return () => {
        disposed = true;
        setBeating(false);
        removeListener?.();
      };
    }

    if (typeof document === 'undefined') {
      return;
    }

    const report = () => {
      const visible = resolveVisibilityState() === 'visible';
      setBeating(visible);
      sendVisibility(visible);
    };

    const reportPageHidden = () => {
      setBeating(false);
      sendVisibility(false);
    };

    report();

    document.addEventListener('visibilitychange', report);
    window.addEventListener('pagehide', reportPageHidden);
    window.addEventListener('pageshow', report);
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);

    return () => {
      setBeating(false);
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('pagehide', reportPageHidden);
      window.removeEventListener('pageshow', report);
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
    };
  }, [enabled]);
};
