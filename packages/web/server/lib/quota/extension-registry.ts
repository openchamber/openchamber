import { isExtensionProviderId } from '../source-control/provider-id.js';
import type { LegacyAuthFile } from '../opencode/auth.js';
import type { QuotaResult } from './utils/contracts.js';

export interface ExtensionQuotaProvider {
  readonly providerId: string | null;
  readonly providerName: string;
  readonly icon: string;
  readonly guestId: string;
  readonly isConfigured: (auth: LegacyAuthFile) => boolean;
  readonly fetchQuota: () => Promise<QuotaResult<string | null>>;
}

const attached = new Map<string | null, ExtensionQuotaProvider>();

export const attachExtensionQuotaProvider = (provider: ExtensionQuotaProvider) => {
  if (!isExtensionProviderId(provider?.providerId)) {
    throw new Error(`Extension quota registration is invalid (${String(provider?.providerId)}): not an extension provider id`);
  }
  attached.set(provider.providerId, provider);
};

export const detachExtensionQuotaProvider = (providerId: string | null) => attached.delete(providerId);

export const listExtensionQuotaProviders = () => [...attached.values()].map(({ providerId, providerName, icon, guestId }) => ({
  id: providerId, name: providerName, icon, guestId,
}));

export const extensionQuotaProvider = (providerId: string | null) => attached.get(providerId) ?? null;
export const extensionQuotaProviderEntries = () => [...attached.entries()];
