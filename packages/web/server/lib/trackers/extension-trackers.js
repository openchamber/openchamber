import { buildExtensionTrackerDescriptor } from './extension-descriptor.js';
import { createExtensionTracker, isTrackerGuest } from './extension-tracker.js';
import { extensionProviderId } from '../source-control/provider-id.js';


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
      warn('[trackers] the extension catalog could not be read:', error?.message ?? error);
      return;
    }
    const eligible = new Map();
    for (const guest of Array.isArray(guests) ? guests : []) {
      if (isTrackerGuest(guest)) eligible.set(extensionProviderId(guest.id), guest);
    }
    let changed = false;
    for (const [id, guest] of eligible) {
      let instance = null;
      try {
        instance = (await accounts.read(id))?.instance ?? null;
      } catch (error) {
        warn(`[trackers] ${id}: the account store could not be read:`, error?.message ?? error);
      }
      const descriptorKey = JSON.stringify([guest.name, guest.version ?? '', guest.tracker, instance]);
      const key = JSON.stringify([descriptorKey, guest.packageRoot, guest.service, guest.capabilityGrants]);
      const previous = registered.get(id);
      if (previous?.key === key) continue;
      let descriptor = previous?.descriptorKey === descriptorKey ? previous.descriptor : null;
      if (!descriptor) {
        try {
          descriptor = buildExtensionTrackerDescriptor({ guestId: guest.id, contribution: guest.tracker, instance });
        } catch (error) {
          warn(`[trackers] ${guest.id} cannot serve a tracker:`, error?.message ?? error);
          if (previous) {
            detach(id);
            changed = true;
          }
          continue;
        }
      }
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
