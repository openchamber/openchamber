import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
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

let announcedChanges = 0;
let inFlight: { runtimeKey: string; changes: number; request: Promise<void> } | null = null;

export const loadGuestCatalog = (): Promise<void> => {
  const runtimeKey = getRuntimeKey();
  const running = inFlight?.runtimeKey === runtimeKey ? inFlight : null;
  if (running && running.changes === announcedChanges) return running.request;
  const after = () => (getRuntimeKey() === runtimeKey ? loadGuestCatalogOnce(runtimeKey) : undefined);
  const request = (running ? running.request.then(after) : loadGuestCatalogOnce(runtimeKey))
    .finally(() => {
      if (inFlight?.request === request) inFlight = null;
    });
  inFlight = { runtimeKey, changes: announcedChanges, request };
  return request;
};

export const reloadGuestCatalog = (): Promise<void> => {
  announcedChanges += 1;
  return loadGuestCatalog();
};

const loadGuestCatalogOnce = async (runtimeKey: string): Promise<void> => {
  alignCatalogRuntime(runtimeKey);

  const store = useGuestsStore.getState();
  if (isVSCodeRuntime()) {
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
    useGuestsStore.getState().replaceCatalog(catalog.guests, runtimeKey, catalog.unreadable, catalog.opencodePlugins);
  } catch {
    useGuestsStore.getState().markFailed(runtimeKey, { method: 'GET', path: '/api/guests', kind: 'network' });
  }
};
