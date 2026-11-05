import React from 'react';

import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { resolveGuestFrameUrl, type GuestFrameUrl } from './frame-url';

type GuestFrameOptions = {
  /** A read over the relay may be kept and shared by frames with one `instanceKey`. */
  reuseDocument?: boolean;
  guestId: string;
  entry: string | null;
  instanceKey: string;
  enabled: boolean;
  /** Approved `contributes.origins`; relay documents carry them in their policy. Part of `instanceKey`. */
  origins: readonly string[];
};

/** Past this a load counts as failed and the pane offers another try; a read over the relay can be slow. */
const FRAME_LOAD_TIMEOUT_MS = 60_000;

type FrameState =
  | { key: string; status: 'loading' | 'error' }
  | { key: string; status: 'ready'; source: GuestFrameUrl };

/** Keep a loaded document alive; renew scoped auth only when it navigates again. */
export const useGuestFrameUrl = ({ guestId, entry, instanceKey, enabled, origins, reuseDocument = false }: GuestFrameOptions) => {
  // `instanceKey` changes with the list, so the effect re-runs; the ref only avoids an array dependency.
  const originsRef = React.useRef(origins);
  originsRef.current = origins;
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
    const deadline = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      abort.abort();
      setState({ key, status: 'error' });
    }, FRAME_LOAD_TIMEOUT_MS);
    void resolveGuestFrameUrl(guestId, entry, abort.signal, originsRef.current, reuseDocument ? key : undefined)
      .then((next) => {
        if (!cancelled) setState({ key, status: 'ready', source: next });
      })
      .catch(() => {
        if (!cancelled) setState({ key, status: 'error' });
      })
      .finally(() => clearTimeout(deadline));
    return () => { cancelled = true; clearTimeout(deadline); abort.abort(); };
  }, [enabled, entry, guestId, key, reloadGeneration, reuseDocument]);

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

  const retry = React.useCallback(() => setReloadGeneration((generation) => generation + 1), []);

  return {
    retry,
    src: current?.kind === 'url' ? current.url : '',
    srcDoc: current?.kind === 'document' ? current.html : undefined,
    status: state?.key === key ? state.status : 'loading',
    recoverExpiredNavigation,
    acknowledgeHandshake,
  };
};
