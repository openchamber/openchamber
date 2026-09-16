import React from 'react';

import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { resolveGuestFrameUrl, type GuestFrameUrl } from './frame-url';

type GuestFrameOptions = {
  guestId: string;
  entry: string | null;
  instanceKey: string;
  enabled: boolean;
};

type FrameState =
  | { key: string; status: 'loading' | 'error' }
  | { key: string; status: 'ready'; source: GuestFrameUrl };

/** Keep a loaded document alive; renew scoped auth only when it navigates again. */
export const useGuestFrameUrl = ({ guestId, entry, instanceKey, enabled }: GuestFrameOptions) => {
  const [state, setState] = React.useState<FrameState | null>(null);
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
    setState({ key, status: 'loading' });
    if (!entry || !enabled) return;
    let cancelled = false;
    const abort = new AbortController();
    void resolveGuestFrameUrl(guestId, entry, abort.signal)
      .then((next) => {
        if (!cancelled) setState({ key, status: 'ready', source: next });
      })
      .catch(() => {
        if (!cancelled) setState({ key, status: 'error' });
      });
    return () => { cancelled = true; abort.abort(); };
  }, [enabled, entry, guestId, key, reloadGeneration]);

  const current = state?.key === key && state.status === 'ready' ? state.source : null;
  const recoverExpiredNavigation = (): boolean => {
    if (!current) return true;
    if (current.kind === 'document') return false;
    if (Date.now() < current.expiresAt) return false;
    if (!recoveryAttempted.current) {
      setState({ key, status: 'loading' });
      recoveryAttempted.current = true;
      setReloadGeneration((generation) => generation + 1);
    } else {
      setState({ key, status: 'error' });
    }
    return true;
  };

  const acknowledgeHandshake = React.useCallback(() => {
    recoveryAttempted.current = false;
  }, []);

  return {
    src: current?.kind === 'url' ? current.url : '',
    srcDoc: current?.kind === 'document' ? current.html : undefined,
    status: state?.key === key ? state.status : 'loading',
    recoverExpiredNavigation,
    acknowledgeHandshake,
  };
};
