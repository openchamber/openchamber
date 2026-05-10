import React from 'react';
import { isWebRuntime } from '@/lib/desktop';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

const HEARTBEAT_MS = 20000;

const resolveVisibilityState = (): 'visible' | 'hidden' => {
  if (typeof document === 'undefined') return 'visible';
  const state = document.visibilityState;
  return state === 'hidden' && document.hasFocus() ? 'visible' : state;
};

const sendVisibility = (visible: boolean) => {
  if (!isWebRuntime()) {
    return;
  }

  const apis = getRegisteredRuntimeAPIs();
  if (!apis?.push?.setVisibility) {
    return;
  }

  void apis.push.setVisibility({ visible });
};

export const usePushVisibilityBeacon = (options?: { enabled?: boolean }) => {
  const enabled = options?.enabled ?? true;
  React.useEffect(() => {
    if (!enabled || !isWebRuntime() || typeof document === 'undefined') {
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

    // Heartbeat while visible so server TTL (30s) never expires.
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
