import { isGuestApproved, requestedGuestCapabilities, serviceProvides } from '@openchamber/sdk';

import { buildExtensionDescriptor } from './extension-descriptor.js';
import { extensionProviderId } from './provider-id.js';


export const isSourceControlProviderGuest = (guest) => {
  const granted = Array.isArray(guest?.capabilityGrants) ? guest.capabilityGrants : [];
  return Boolean(guest)
    && guest.enabled !== false
    && serviceProvides(guest.service, 'source-control')
    && Boolean(guest.sourceControl)
    && granted.includes('service')
    && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted })
    && extensionProviderId(guest.id) !== null;
};

/**
 * @param {{
 *   listGuests: () => Promise<object[]>,
 *   register: (input: { descriptor: object, guest: object }) => void,
 *   unregister: (id: string) => void,
 *   dropSection: (id: string) => Promise<unknown>,
 *   emitChanged: () => void,
 * }} deps `dropSection` forgets a provider's stored accounts;
 * `emitChanged` tells clients to read the provider list again.
 */
export function createExtensionProviders({ listGuests, register, unregister, dropSection, emitChanged }) {
  /** @type {Map<string, { descriptorKey: string, key: string, descriptor: object }>} */
  const registered = new Map();
  let queue = Promise.resolve();

  const run = async () => {
    const guests = await listGuests();
    const eligible = new Map();
    for (const guest of guests) {
      if (isSourceControlProviderGuest(guest)) eligible.set(extensionProviderId(guest.id), guest);
    }
    let changed = false;
    for (const [id, guest] of eligible) {
      const descriptorKey = JSON.stringify([guest.name, guest.version ?? '', guest.sourceControl]);
      const key = JSON.stringify([descriptorKey, guest.packageRoot, guest.service, guest.capabilityGrants]);
      const previous = registered.get(id);
      if (previous?.key === key) continue;
      let descriptor = previous?.descriptorKey === descriptorKey ? previous.descriptor : null;
      if (!descriptor) {
        try {
          descriptor = buildExtensionDescriptor({
            guestId: guest.id, contribution: guest.sourceControl, guest: { name: guest.name, version: guest.version ?? '' },
          });
        } catch (error) {
          console.warn(`[source-control] ${guest.id} cannot serve a Git host:`, error?.message ?? error);
          if (previous) {
            unregister(id);
            registered.delete(id);
            changed = true;
          }
          continue;
        }
      }
      register({ descriptor, guest });
      registered.set(id, { descriptorKey, key, descriptor });
      changed = true;
    }
    for (const id of [...registered.keys()]) {
      if (eligible.has(id)) continue;
      unregister(id);
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
    deactivated: async ({ guestId, removed = false }) => {
      await reconcile();
      const id = extensionProviderId(guestId);
      if (removed && id) await dropSection(id);
    },
  });
}
