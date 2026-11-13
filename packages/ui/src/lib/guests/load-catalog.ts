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

/** Changes the server announced; a request answers only for those it started after. */
let announcedChanges = 0;
let inFlight: { runtimeKey: string; changes: number; request: Promise<void> } | null = null;

/**
 * One request at a time per runtime: the rail, the composer, and the dialogs
 * all ask on mount. A request still running for the previous server is not
 * reused after a switch; its answer is dropped by the runtime check below,
 * and the new server gets its own request. A request that started before an
 * announced change may hold the old list, so a new one runs after it.
 */
export const loadGuestCatalog = (): Promise<void> => {
  const runtimeKey = getRuntimeKey();
  const running = inFlight?.runtimeKey === runtimeKey ? inFlight : null;
  if (running && running.changes === announcedChanges) return running.request;
  // After a switch the queued read belongs to a server the store no longer follows.
  const after = () => (getRuntimeKey() === runtimeKey ? loadGuestCatalogOnce(runtimeKey) : undefined);
  const request = (running ? running.request.then(after) : loadGuestCatalogOnce(runtimeKey))
    .finally(() => {
      if (inFlight?.request === request) inFlight = null;
    });
  inFlight = { runtimeKey, changes: announcedChanges, request };
  return request;
};

/** The server announced a catalog change; read it from a request that starts after now. */
export const reloadGuestCatalog = (): Promise<void> => {
  announcedChanges += 1;
  return loadGuestCatalog();
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
    const catalog = content === null ? null : parseGuestCatalogJson(content);
    if (useGuestsStore.getState().runtimeKey !== runtimeKey) {
      return;
    }
    if (!catalog) {
      store.markFailed(runtimeKey, { method: 'GET', path: '/api/guests', kind: 'invalid-response', status: response.status });
      return;
    }
    useGuestsStore.getState().replaceCatalog(catalog.guests, runtimeKey, catalog.unreadable);
  } catch {
    useGuestsStore.getState().markFailed(runtimeKey, { method: 'GET', path: '/api/guests', kind: 'network' });
  }
};
