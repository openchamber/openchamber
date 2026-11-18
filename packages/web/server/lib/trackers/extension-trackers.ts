import { buildExtensionTrackerDescriptor } from './extension-descriptor.js';
import { createExtensionTracker, isTrackerGuest } from './extension-tracker.js';
import { extensionProviderId } from '../source-control/provider-id.js';
import type { GuestRecord } from '../guests/contracts.js';
import type { ExtensionTrackerOptions, TrackerGuest } from './extension-tracker.js';
import type { createTrackerRegistry } from './registry.js';
import type { TrackerDescriptor } from './tracker-contract.js';

export type ExtensionTrackersOptions = Pick<ExtensionTrackerOptions, 'currentGuest' | 'accounts' | 'handles' | 'oauth' | 'persistPath' | 'now' | 'warn'> & {
  listGuests: () => Promise<GuestRecord[]>;
  registry: ReturnType<typeof createTrackerRegistry>;
  sessionStatus: { forget: (id: string) => void };
  proxyServiceRequest?: ExtensionTrackerOptions['proxy'];
  emitChanged: () => void;
};

type RegisteredTracker = {
  descriptorKey: string;
  key: string;
  descriptor: TrackerDescriptor;
  adapter: ReturnType<typeof createExtensionTracker>;
  guestId: string;
};

const hasErrorMessage = (value: unknown): value is { message?: unknown } => value !== null
  && (typeof value === 'object' || typeof value === 'function');

export function createExtensionTrackers({
  listGuests, currentGuest, registry, accounts, handles, oauth, sessionStatus, proxyServiceRequest, persistPath, emitChanged,
  now = Date.now, warn = (...args) => console.warn(...args),
}: ExtensionTrackersOptions) {
  const registered = new Map<string, RegisteredTracker>();
  let queue = Promise.resolve();

  const detach = (id: string) => {
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
      warn('[trackers] the extension catalog could not be read:', hasErrorMessage(error) ? error.message ?? error : error);
      return;
    }
    const eligible = new Map<string, TrackerGuest>();
    for (const guest of Array.isArray(guests) ? guests : []) {
      if (isTrackerGuest(guest)) {
        const id = extensionProviderId(guest.id);
        if (id !== null) eligible.set(id, guest);
      }
    }
    let changed = false;
    for (const [id, guest] of eligible) {
      let instance: string | null = null;
      try {
        instance = (await accounts.read(id))?.instance ?? null;
      } catch (error) {
        warn(`[trackers] ${id}: the account store could not be read:`, hasErrorMessage(error) ? error.message ?? error : error);
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
          warn(`[trackers] ${guest.id} cannot serve a tracker:`, hasErrorMessage(error) ? error.message ?? error : error);
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
    deactivated: async ({ guestId, removed = false }: { guestId: string; removed?: boolean }) => {
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
