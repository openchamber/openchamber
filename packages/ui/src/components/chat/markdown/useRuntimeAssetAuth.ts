import React from 'react';
import {
  acquireRuntimeUrlAuthToken,
  refreshRuntimeUrlAuthToken,
  subscribeRuntimeUrlAuthToken,
} from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

export interface RuntimeAssetAuthState {
  ready: boolean;
  nonce: number;
}

// `nonce` bumps on token rotation so consumers re-resolve URLs built from the previous token.
export const useRuntimeAssetAuth = (enabled: boolean): RuntimeAssetAuthState => {
  const [ready, setReady] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  const apiBaseUrl = getRuntimeApiBaseUrl();

  React.useEffect(() => {
    if (!enabled) {
      setReady(false);
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const release = acquireRuntimeUrlAuthToken(apiBaseUrl);
    const unsubscribe = subscribeRuntimeUrlAuthToken(() => {
      if (!cancelled) setNonce((current) => current + 1);
    });
    const refresh = () => {
      void refreshRuntimeUrlAuthToken(apiBaseUrl)
        .then(() => {
          if (!cancelled) setReady(true);
        })
        .catch(() => {
          if (!cancelled) retryTimer = setTimeout(refresh, 1000);
        });
    };
    refresh();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      release();
      unsubscribe();
    };
  }, [apiBaseUrl, enabled]);

  return { ready: !enabled || ready, nonce };
};
