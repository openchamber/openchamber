import React from 'react';
import { fetchQuotaAccounts, type QuotaAccountUsage } from '@/lib/quota/fetchQuota';
import { subscribeCredentialChanges } from '@/lib/opencode/integration-catalog';
import { captureRuntimeInstance, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { afterDelay } from '@/lib/timing/afterDelay';

type Snapshot = { scope: string; accounts: QuotaAccountUsage[] | null; status: 'loading' | 'ready' | 'error' };

export function useWorkStatusAccounts(enabled: boolean, providers: string) {
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const scope = JSON.stringify([runtimeKey, providers]);
  const [snapshot, setSnapshot] = React.useState<Snapshot>();
  const pending = React.useRef<AbortController | null>(null);

  const load = React.useCallback((refresh: boolean) => {
    if (!enabled) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const isCurrent = captureRuntimeInstance();
    setSnapshot((previous) => ({ scope, accounts: previous?.scope === scope ? previous.accounts : null, status: 'loading' }));
    void fetchQuotaAccounts(providers, refresh, controller.signal).then((accounts) => {
      if (!controller.signal.aborted && isCurrent()) setSnapshot({ scope, accounts, status: 'ready' });
    }, () => {
      if (!controller.signal.aborted && isCurrent()) {
        setSnapshot((previous) => ({ scope, accounts: previous?.scope === scope ? previous.accounts : null, status: 'error' }));
      }
    });
  }, [enabled, providers, scope]);

  React.useEffect(() => {
    if (!enabled) return;
    load(false);
    const unsubscribe = subscribeCredentialChanges(() => load(false));
    return () => {
      unsubscribe();
      pending.current?.abort();
    };
  }, [enabled, load]);

  return {
    snapshot: snapshot?.scope === scope ? snapshot : undefined,
    refresh: () => load(true),
  };
}

export function useQuotaRetryElapsed(retryAt: number) {
  const getSnapshot = React.useCallback(() => Date.now() >= retryAt, [retryAt]);
  const subscribe = React.useCallback((notify: () => void) => {
    let cancel: (() => void) | undefined;
    const check = () => {
      const delay = retryAt - Date.now();
      if (delay <= 0) notify();
      else cancel = afterDelay(Math.min(delay, 2_147_483_647), check);
    };
    check();
    return () => cancel?.();
  }, [retryAt]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
