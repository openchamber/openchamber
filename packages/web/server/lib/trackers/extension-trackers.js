import { buildExtensionTrackerDescriptor } from './extension-descriptor.js';
import { createExtensionTracker, isTrackerGuest } from './extension-tracker.js';
import { extensionProviderId } from '../source-control/provider-id.js';

/**
 * Which installed extensions serve a tracker right now, kept in step with the
 * extension catalog: the extension layer over the registry's built-ins. The
 * catalog is the authority, never an event's payload: every reconcile reads it,
 * attaches what is eligible and detaches what no longer is.
 *
 * A guest is eligible when it is enabled, fully approved with an effective
 * `service` grant (the catalog already drops a grant whose scope changed),
 * provides `tracker` with a parsed `contributes.tracker`, and has an id that
 * can name a provider (`ext-<guestId>`).
 *
 * Runs once at start, after approval, enable, install or replace and update
 * (`onGuestActivated`), after pause, removal or withdrawn approval
 * (`onGuestDeactivated`), and when a tracker's instance is set or cleared
 * (the descriptor's link patterns follow the connected server). Runs are
 * serialized, so two triggers never interleave an attach with a detach.
 */

/**
 * @param {{
 *   listGuests: () => Promise<object[]>,
 *   currentGuest: (guestId: string) => Promise<object | null>,
 *   registry: ReturnType<typeof import('./registry.js').createTrackerRegistry>,
 *   accounts: ReturnType<typeof import('./extension-accounts.js').createTrackerAccounts>,
 *   handles: ReturnType<typeof import('../source-control/outbound-handles.js').createOutboundHandles>,
 *   oauth: ReturnType<typeof import('./extension-oauth.js').createTrackerOAuth>,
 *   sessionStatus: { forget: (id: string) => void },
 *   proxyServiceRequest?: (params: object) => Promise<{ status: number, body: string }>,
 *   persistPath: string,
 *   emitChanged: () => void,
 *   now?: () => number,
 *   warn?: (...args: unknown[]) => void,
 * }} deps `emitChanged` tells clients to read the tracker list again.
 */
export function createExtensionTrackers({
  listGuests, currentGuest, registry, accounts, handles, oauth, sessionStatus, proxyServiceRequest, persistPath, emitChanged,
  now = Date.now, warn = (...args) => console.warn(...args),
}) {
  /** @type {Map<string, { descriptorKey: string, key: string, descriptor: object, adapter: { dispose: () => void } }>} */
  const registered = new Map();
  let queue = Promise.resolve();

  const detach = (id) => {
    const previous = registered.get(id);
    if (!previous) return;
    registered.delete(id);
    registry.detachExtension(id);
    sessionStatus.forget(id);
    handles.revokeGuest(previous.guestId);
    previous.adapter.dispose();
  };

  const run = async () => {
    let guests;
    try {
      guests = await listGuests();
    } catch (error) {
      // A catalog that cannot be read changes nothing: it is not an empty catalog.
      warn('[trackers] the extension catalog could not be read:', error?.message ?? error);
      return;
    }
    const eligible = new Map();
    for (const guest of Array.isArray(guests) ? guests : []) {
      if (isTrackerGuest(guest)) eligible.set(extensionProviderId(guest.id), guest);
    }
    let changed = false;
    for (const [id, guest] of eligible) {
      // The descriptor's link patterns follow the server the accounts live on.
      let instance = null;
      try {
        instance = (await accounts.read(id))?.instance ?? null;
      } catch (error) {
        warn(`[trackers] ${id}: the account store could not be read:`, error?.message ?? error);
      }
      // The descriptor depends on the version, the contribution and the instance;
      // the adapter also on where the package lives and what was granted.
      const descriptorKey = JSON.stringify([guest.name, guest.version ?? '', guest.tracker, instance]);
      const key = JSON.stringify([descriptorKey, guest.packageRoot, guest.service, guest.capabilityGrants]);
      const previous = registered.get(id);
      if (previous?.key === key) continue;
      let descriptor = previous?.descriptorKey === descriptorKey ? previous.descriptor : null;
      if (!descriptor) {
        try {
          descriptor = buildExtensionTrackerDescriptor({ guestId: guest.id, contribution: guest.tracker, instance });
        } catch (error) {
          // One broken contribution leaves every other tracker as it is.
          warn(`[trackers] ${guest.id} cannot serve a tracker:`, error?.message ?? error);
          if (previous) {
            detach(id);
            changed = true;
          }
          continue;
        }
      }
      // A replacement (new version, grant change, the first server connected) keeps
      // what the old adapter started: pending sign-ins and connects commit through
      // the store's own identities, whichever adapter finishes them. Only the
      // session-status runtime, which closed over the old adapter, is rebuilt.
      if (previous) sessionStatus.forget(id);
      const adapter = createExtensionTracker({
        descriptor,
        guest: { id: guest.id, name: guest.name, packageRoot: guest.packageRoot, service: guest.service, capabilityGrants: guest.capabilityGrants },
        contribution: guest.tracker,
        currentGuest,
        reconcile,
        accounts,
        handles,
        oauth,
        persistPath,
        proxy: proxyServiceRequest,
        now,
        warn,
      });
      registry.attachExtension({ descriptor, load: async () => adapter });
      registered.set(id, { descriptorKey, key, descriptor, adapter, guestId: guest.id });
      changed = true;
    }
    for (const id of [...registered.keys()]) {
      if (eligible.has(id)) continue;
      detach(id);
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
     * accounts, client, mapping and session records go with it ("remove means
     * forget").
     */
    deactivated: async ({ guestId, removed = false }) => {
      const id = extensionProviderId(guestId);
      if (id) {
        oauth.dropProvider(id);
        accounts.cancelConnect(id);
      }
      await reconcile();
      if (removed && id) await accounts.remove(id);
    },
  });
}
