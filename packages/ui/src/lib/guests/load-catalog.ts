import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { getRuntimeKey } from '@/lib/runtime-switch';

import { useGuestBadgeStore } from './badge-store.ts';
import { parseGuestCatalogJson } from './parse.ts';
import { useGuestsStore } from './store.ts';

const alignCatalogRuntime = (runtimeKey: string): void => {
  const store = useGuestsStore.getState();
  if (store.runtimeKey !== runtimeKey) {
    store.resetForRuntimeSwitch(runtimeKey);
    useGuestBadgeStore.getState().resetForRuntimeSwitch();
  }
};

let inFlight: { runtimeKey: string; request: Promise<void> } | null = null;

/**
 * One request at a time per runtime: the rail, the composer, and the dialogs
 * all ask on mount. A request still running for the previous server is not
 * reused after a switch; its answer is dropped by the runtime check below,
 * and the new server gets its own request.
 */
export const loadGuestCatalog = (): Promise<void> => {
  const runtimeKey = getRuntimeKey();
  if (inFlight && inFlight.runtimeKey === runtimeKey) return inFlight.request;
  const request = loadGuestCatalogOnce(runtimeKey).finally(() => {
    if (inFlight?.request === request) inFlight = null;
  });
  inFlight = { runtimeKey, request };
  return request;
};

const loadGuestCatalogOnce = async (runtimeKey: string): Promise<void> => {
  alignCatalogRuntime(runtimeKey);

  const store = useGuestsStore.getState();
  if (isVSCodeRuntime() || isMobileSurfaceRuntime()) {
    store.markUnsupported(runtimeKey);
    return;
  }

  store.markLoading();
  try {
    const response = await runtimeFetch('/api/guests');
    if (useGuestsStore.getState().runtimeKey !== runtimeKey) {
      return;
    }
    if (!response.ok) {
      store.markFailed(runtimeKey, { method: 'GET', path: '/api/guests', kind: 'http', status: response.status });
      return;
    }
    const content = await response.text().catch(() => null);
    const guests = content === null ? null : parseGuestCatalogJson(content);
    if (useGuestsStore.getState().runtimeKey !== runtimeKey) {
      return;
    }
    if (!guests) {
      store.markFailed(runtimeKey, { method: 'GET', path: '/api/guests', kind: 'invalid-response', status: response.status });
      return;
    }
    useGuestsStore.getState().replaceCatalog(guests, runtimeKey);
  } catch {
    useGuestsStore.getState().markFailed(runtimeKey, { method: 'GET', path: '/api/guests', kind: 'network' });
  }
};
