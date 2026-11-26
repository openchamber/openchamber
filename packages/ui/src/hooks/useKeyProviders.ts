import * as React from 'react';

import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { fetchKeyProviders, subscribeKeyProvidersStale, withoutAddress, type KeyProvider } from '@/lib/voice/keyProviders';

const NO_PROVIDERS: readonly KeyProvider[] = [];

type Answer = { baseURL: string; runtimeKey: string; providers: readonly KeyProvider[] | null };

export function useKeyProviders(serverUrl: string, committedUrl: string) {
  const baseURL = committedUrl.trim();
  const settled = serverUrl.trim() === baseURL;
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const [answer, setAnswer] = React.useState<Answer | null>(null);
  const [revision, refresh] = React.useReducer((count: number) => count + 1, 0);

  React.useEffect(() => subscribeKeyProvidersStale(() => refresh()), [refresh]);

  React.useEffect(() => {
    const controller = new AbortController();
    fetchKeyProviders(baseURL, controller.signal)
      .catch(() => null)
      .then((providers) => { if (!controller.signal.aborted) setAnswer({ baseURL, runtimeKey, providers }); });
    return () => controller.abort();
  }, [baseURL, runtimeKey, revision]);

  const current = answer !== null && answer.runtimeKey === runtimeKey ? answer : null;
  const providers = React.useMemo(() => {
    if (current?.providers == null) return NO_PROVIDERS;
    return settled && current.baseURL === baseURL ? current.providers : withoutAddress(current.providers);
  }, [current, baseURL, settled]);
  const read = current?.baseURL === baseURL;
  return { providers, failed: read && current.providers === null, settled: settled && read, refresh, runtimeKey };
}
