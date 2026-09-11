import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useTerminalStore } from '@/stores/useTerminalStore';

const TERMINAL_SESSION_KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;

export const useTerminalSessionKeepalive = (): void => {
  const { terminal } = useRuntimeAPIs();

  React.useEffect(() => {
    if (!terminal.touchSessions) {
      return;
    }
    const touch = () => {
      if (globalThis.navigator?.onLine === false) return;
      const ids: string[] = [];
      for (const dirState of useTerminalStore.getState().sessions.values()) {
        for (const tab of dirState.tabs) {
          if (tab.terminalSessionId && tab.lifecycle !== 'exited') ids.push(tab.terminalSessionId);
        }
      }
      if (ids.length > 0) void terminal.touchSessions?.(ids).catch(() => {});
    };
    touch();
    const interval = setInterval(touch, TERMINAL_SESSION_KEEPALIVE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [terminal]);
};
