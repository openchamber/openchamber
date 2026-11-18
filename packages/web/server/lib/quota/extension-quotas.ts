import { createExtensionQuotaProvider, isQuotaGuest } from './extension-quota.js';
import type { QuotaGuest } from './extension-quota.js';
import { extensionProviderId } from '../source-control/provider-id.js';
import type { GuestRecord } from '../guests/contracts.js';
import type { ExtensionQuotaProvider } from './extension-registry.js';

type AdapterDependencies = Parameters<typeof createExtensionQuotaProvider>[0];

export interface ExtensionQuotaProvidersDependencies {
  listGuests: () => Promise<GuestRecord[]>;
  currentGuest: (guestId: string) => Promise<GuestRecord | null>;
  loadRegistry: () => Promise<{
    attachExtensionQuotaProvider: (provider: ExtensionQuotaProvider) => void;
    detachExtensionQuotaProvider: (id: string | null) => boolean;
  }>;
  persistPath: string;
  proxyServiceRequest?: AdapterDependencies['proxy'];
  readCredentials?: AdapterDependencies['readCredentials'];
  emitChanged: () => void;
  warn?: (...args: unknown[]) => void;
}

const isEligibleGuest = (guest: GuestRecord): guest is QuotaGuest => isQuotaGuest(guest);
const hasOptionalMessage = (value: unknown): value is { message?: unknown } =>
  value !== null && value !== undefined;

export function createExtensionQuotaProviders({
  listGuests, currentGuest, loadRegistry, persistPath, proxyServiceRequest, readCredentials, emitChanged,
  warn = (...args) => console.warn(...args),
}: ExtensionQuotaProvidersDependencies) {
  const registered = new Map<string | null, { key: string }>();
  let queue = Promise.resolve();

  const run = async () => {
    let guests;
    try {
      guests = await listGuests();
    } catch (error) {
      const message = hasOptionalMessage(error) ? error.message : undefined;
      warn('[quota] the extension catalog could not be read:', message ?? error);
      return;
    }
    const eligible = new Map<string | null, QuotaGuest>();
    for (const guest of Array.isArray(guests) ? guests : []) {
      if (isEligibleGuest(guest)) eligible.set(extensionProviderId(guest.id), guest);
    }
    if (eligible.size === 0 && registered.size === 0) return;
    const registry = await loadRegistry();
    let changed = false;
    for (const [id, guest] of eligible) {
      const key = JSON.stringify([guest.name, guest.icon, guest.version ?? '', guest.quota, guest.packageRoot, guest.service, guest.capabilityGrants]);
      if (registered.get(id)?.key === key) continue;
      const dependencies: AdapterDependencies = {
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
