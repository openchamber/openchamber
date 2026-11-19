import { isGuestApproved, requestedGuestCapabilities, serviceProvides } from '@openchamber/sdk';

import { buildExtensionDescriptor } from './extension-descriptor.js';
import { extensionProviderId } from './provider-id.js';
import type { GuestRecord } from '../guests/contracts.js';
import type { ProviderDescriptor } from './provider-contract.js';
import type { createSourceControlAuthStore } from './auth-storage.js';

export type SourceControlProviderGuest = GuestRecord & {
  service: NonNullable<GuestRecord['service']>;
  sourceControl: NonNullable<GuestRecord['sourceControl']>;
};
export interface ExtensionProvidersOptions {
  listGuests(): Promise<GuestRecord[]>;
  register(input: { descriptor: ProviderDescriptor; guest: SourceControlProviderGuest }): void;
  unregister(id: string): void;
  dropSection: ReturnType<typeof createSourceControlAuthStore>['dropSection'];
  emitChanged(): void;
}
const hasErrorMessage = (value: unknown): value is { message?: unknown } => value !== null && value !== undefined;
const isPresentGuest = (guest: GuestRecord | null | undefined): guest is GuestRecord => Boolean(guest);
const providerIdFor = (guest: SourceControlProviderGuest) => {
  const id = extensionProviderId(guest.id);
  if (id === null) throw new TypeError('Eligible source control provider has no provider ID');
  return id;
};

export const isSourceControlProviderGuest = (guest: GuestRecord | null | undefined): guest is SourceControlProviderGuest => {
  const granted = Array.isArray(guest?.capabilityGrants) ? guest.capabilityGrants : [];
  return isPresentGuest(guest)
    && guest.enabled !== false
    && serviceProvides(guest.service, 'source-control')
    && Boolean(guest.sourceControl)
    && granted.includes('service')
    && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted })
    && extensionProviderId(guest.id) !== null;
};

export function createExtensionProviders({ listGuests, register, unregister, dropSection, emitChanged }: ExtensionProvidersOptions) {
  const registered = new Map<string, { descriptorKey: string; key: string; descriptor: ProviderDescriptor }>();
  let queue = Promise.resolve();

  const run = async () => {
    const guests = await listGuests();
    const eligible = new Map<string, SourceControlProviderGuest>();
    for (const guest of guests) {
      if (isSourceControlProviderGuest(guest)) eligible.set(providerIdFor(guest), guest);
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
          console.warn(`[source-control] ${guest.id} cannot serve a Git host:`, (hasErrorMessage(error) ? error.message : undefined) ?? error);
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
    deactivated: async ({ guestId, removed = false }: { guestId: string; removed?: boolean }) => {
      await reconcile();
      const id = extensionProviderId(guestId);
      if (removed && id) await dropSection(id);
    },
  });
}
