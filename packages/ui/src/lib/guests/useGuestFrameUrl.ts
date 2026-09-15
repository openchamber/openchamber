import React from 'react';

import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { resolveGuestFrameUrl, type GuestFrameUrl } from './frame-url';

type GuestFrameOptions = {
  guestId: string;
  entry: string | null;
  instanceKey: string;
  enabled: boolean;
};

/** Keep a loaded document alive; renew scoped auth only when it navigates again. */
export const useGuestFrameUrl = ({ guestId, entry, instanceKey, enabled }: GuestFrameOptions) => {
  const [source, setSource] = React.useState<(GuestFrameUrl & { key: string }) | null>(null);
  const [reloadGeneration, setReloadGeneration] = React.useState(0);
  const recoveryAttempted = React.useRef(false);
  const [runtimeKey, setRuntimeKey] = React.useState(getRuntimeKey);
  const key = JSON.stringify([runtimeKey, guestId, entry, instanceKey, enabled]);

  React.useEffect(() => subscribeRuntimeEndpointChanged((detail) => {
    setRuntimeKey(detail.runtimeKey);
  }), []);

  React.useEffect(() => {
    recoveryAttempted.current = false;
  }, [key]);

  React.useEffect(() => {
    setSource(null);
    if (!entry || !enabled) return;
    let cancelled = false;
    void resolveGuestFrameUrl(guestId, entry)
      .then((next) => {
        if (!cancelled) setSource({ ...next, key });
      })
      .catch(() => {
        // Leave the source empty so the owner shows its existing failure state.
      });
    return () => { cancelled = true; };
  }, [enabled, entry, guestId, key, reloadGeneration]);

  const current = source?.key === key ? source : null;
  const recoverExpiredNavigation = (): boolean => {
    if (!current) return true;
    if (Date.now() < current.expiresAt) return false;
    setSource(null);
    if (!recoveryAttempted.current) {
      recoveryAttempted.current = true;
      setReloadGeneration((generation) => generation + 1);
    }
    return true;
  };

  const acknowledgeHandshake = React.useCallback(() => {
    recoveryAttempted.current = false;
  }, []);

  return { src: current?.url ?? '', recoverExpiredNavigation, acknowledgeHandshake };
};
