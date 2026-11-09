import { createExtensionQuotaProvider, isQuotaGuest } from './extension-quota.js';
import { extensionProviderId } from '../source-control/provider-id.js';

/**
 * Which installed extensions report usage right now, kept in step with the
 * extension catalog: the extension layer over the quota registry's built-ins.
 * The catalog is the authority, never an event's payload: every reconcile
 * reads it, attaches what is eligible and detaches what no longer is.
 *
 * A guest is eligible when it is enabled, fully approved with an effective
 * `service` grant (the catalog already drops a grant whose scope changed, so
 * a changed provider list leaves the card until the user approves again),
 * provides `quota` with a parsed `contributes.quota`, and has an id that can
 * name a provider (`ext-<guestId>`).
 *
 * Runs once at start, after approval, enable, install or replace and update
 * (`onGuestActivated`), and after pause, removal or withdrawn approval
 * (`onGuestDeactivated`). Runs are serialized, so two triggers never
 * interleave an attach with a detach. The role keeps nothing of its own on
 * the server, so a pause and a removal both only detach; the user's Usage
 * settings for the card are instance settings, kept like a built-in's.
 */

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
      // A catalog that cannot be read changes nothing: it is not an empty catalog.
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
      // The card depends on the name, the icon and the version; the adapter also on
      // the listed providers, where the package lives and what was granted.
      const key = JSON.stringify([guest.name, guest.icon, guest.version ?? '', guest.quota, guest.packageRoot, guest.service, guest.capabilityGrants]);
      if (registered.get(id)?.key === key) continue;
      // A replacement (new version, grant change) takes the slot; a read the old
      // adapter has in flight answers through the registry's coalescing as before.
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
    /** After a pause, a removal or withdrawn approval: the card leaves; nothing is stored for the role. */
    deactivated: () => reconcile(),
  });
}
