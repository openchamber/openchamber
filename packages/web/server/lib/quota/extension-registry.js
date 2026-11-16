import { isExtensionProviderId } from '../source-control/provider-id.js';

const attached = new Map();

export const attachExtensionQuotaProvider = (provider) => {
  if (!isExtensionProviderId(provider?.providerId)) {
    throw new Error(`Extension quota registration is invalid (${String(provider?.providerId)}): not an extension provider id`);
  }
  attached.set(provider.providerId, provider);
};

export const detachExtensionQuotaProvider = (providerId) => attached.delete(providerId);

export const listExtensionQuotaProviders = () => [...attached.values()].map(({ providerId, providerName, icon, guestId }) => ({
  id: providerId, name: providerName, icon, guestId,
}));

export const extensionQuotaProvider = (providerId) => attached.get(providerId) ?? null;
export const extensionQuotaProviderEntries = () => [...attached.entries()];
