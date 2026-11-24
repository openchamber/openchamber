import * as React from 'react';

import { isConnectedToSharedOpenCodeService } from '@/lib/sharedOpenCodeService';
import { subscribeServerConnect } from '@/sync/server-connect';

const READ_TIMEOUT_MS = 4_000;

export const useSharedOpenCodeService = (refreshKey = 0): boolean => {
  const [connected, setConnected] = React.useState(false);

  React.useEffect(() => {
    let latest = 0;
    const load = async () => {
      latest += 1;
      const request = latest;
      const next = await isConnectedToSharedOpenCodeService(AbortSignal.timeout(READ_TIMEOUT_MS)).catch(() => null);
      if (next !== null && request === latest) setConnected(next);
    };
    const reload = () => { void load(); };
    reload();
    window.addEventListener('focus', reload);
    const stopConnectListening = subscribeServerConnect(reload);
    return () => {
      latest = -1;
      stopConnectListening();
      window.removeEventListener('focus', reload);
    };
  }, [refreshKey]);

  return connected;
};
