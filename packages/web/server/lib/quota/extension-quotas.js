import { createExtensionQuotaProvider, isQuotaGuest } from './extension-quota.js';
import { extensionProviderId } from '../source-control/provider-id.js';


/**
 * @param {{
 *   listGuests: () => Promise<object[]>,
 *   currentGuest: (guestId: string) => Promise<object | null>,
 *   loadRegistry: () => Promise<{ attachExtensionQuotaProvider: (provider: object) => void, detachExtensionQuotaProvider: (id: string) => boolean }>,
 *   persistPath: string,
 *   proxyServiceRequest?: (params: object) => Promise<{ status: number, body: string }>,
 *   readCredentials?: () => Promise<Record<string, object>>,
 *   emitChanged: () => void,
 *   warn?: (...args: unknown[]) => void,
 * }} deps `loadRegistry` answers the quota module, which the server loads on
 * first use; a host with no such extension never loads it here. `emitChanged`
 * tells clients to read the provider list again.
 */
export function createExtensionQuotaProviders({
  listGuests, currentGuest, loadRegistry, persistPath, proxyServiceRequest, readCredentials, emitChanged,
  warn = (...args) => console.warn(...args),
}) {
  /** @type {Map<string, { key: string }>} */
  const registered = new Map();
  let queue = Promise.resolve();

  const run = async () => {
    let guests;
    try {
      guests = await listGuests();
    } catch (error) {
      warn('[quota] the extension catalog could not be read:', error?.message ?? error);
      return;
    }
    const eligible = new Map();
    for (const guest of Array.isArray(guests) ? guests : []) {
      if (isQuotaGuest(guest)) eligible.set(extensionProviderId(guest.id), guest);
    }
    if (eligible.size === 0 && registered.size === 0) return;
    const registry = await loadRegistry();
    let changed = false;
    for (const [id, guest] of eligible) {
      const key = JSON.stringify([guest.name, guest.icon, guest.version ?? '', guest.quota, guest.packageRoot, guest.service, guest.capabilityGrants]);
      if (registered.get(id)?.key === key) continue;
      /** @type {Parameters<typeof createExtensionQuotaProvider>[0]} */
      const dependencies = {
        guest: { id: guest.id, name: guest.name, icon: guest.icon, packageRoot: guest.packageRoot, service: guest.service, capabilityGrants: guest.capabilityGrants },
        contribution: guest.quota,
        currentGuest,
        reconcile,
        persistPath,
      };
      if (proxyServiceRequest) dependencies.proxy = proxyServiceRequest;
      if (readCredentials) dependencies.readCredentials = readCredentials;
      dependencies.warn = warn;
      registry.attachExtensionQuotaProvider(createExtensionQuotaProvider(dependencies));
      registered.set(id, { key });
      changed = true;
    }
    for (const id of [...registered.keys()]) {
      if (eligible.has(id)) continue;
      registry.detachExtensionQuotaProvider(id);
      registered.delete(id);
      changed = true;
    }
    if (changed) emitChanged();
  };

  const reconcile = () => {
    queue = queue.then(run, run);
    return queue;
  };

  return Object.freeze({
    reconcile,
    deactivated: () => reconcile(),
  });
}
