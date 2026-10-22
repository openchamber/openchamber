import { isGuestApproved, requestedGuestCapabilities, serviceProvides } from '@openchamber/sdk';

import { buildExtensionDescriptor } from './extension-descriptor.js';
import { extensionProviderId } from './provider-id.js';

/**
 * Which installed extensions serve a Git host right now, kept in step with
 * the extension catalog. The catalog is the authority, never an event's
 * payload: every reconcile reads it and registers what is eligible and
 * unregisters what no longer is.
 *
 * A guest is eligible when it is enabled, fully approved with an effective
 * `service` grant (the catalog already drops a grant whose scope changed),
 * provides `source-control` with a parsed `contributes.sourceControl`, and
 * has an id that can name a provider (`ext-<guestId>`).
 *
 * Runs once at start, after approval, enable, install or replace and
 * update (`onGuestActivated`), and after pause, removal or withdrawn approval
 * (`onGuestDeactivated`). Runs are serialized, so two triggers never
 * interleave a register with an unregister.
 */

/** Whether a catalog row may serve a Git host; the adapter asks again on every call. */
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
    // A catalog that cannot be read changes nothing: it is not an empty catalog.
    const guests = await listGuests();
    const eligible = new Map();
    for (const guest of guests) {
      if (isSourceControlProviderGuest(guest)) eligible.set(extensionProviderId(guest.id), guest);
    }
    let changed = false;
    for (const [id, guest] of eligible) {
      // The descriptor depends on the version and the contribution; the
      // implementation also on where the package lives and what was granted.
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
          // One broken contribution leaves every other provider as it is.
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
    /**
     * After a pause, a removal or withdrawn approval. A removed extension's
     * accounts go with it ("remove means forget"); its mutation and audit
     * records stay.
     */
    deactivated: async ({ guestId, removed = false }) => {
      await reconcile();
      const id = extensionProviderId(guestId);
      if (removed && id) await dropSection(id);
    },
  });
}
