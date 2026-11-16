import { isExtensionProviderId } from '../source-control/provider-id.js';

/**
 * Usage providers installed extensions serve (`extension-quotas.js`), apart
 * from the built-ins so `GET /api/quota/extensions` answers from memory: no
 * provider module loads for it and OpenCode is not asked. `ext-<guestId>` ids
 * only, which no built-in takes, so an extension can never replace a
 * built-in's entry. A re-attach (a new version of the extension) keeps the
 * slot's place.
 */
const attached = new Map();

export const attachExtensionQuotaProvider = (provider) => {
  if (!isExtensionProviderId(provider?.providerId)) {
    throw new Error(`Extension quota registration is invalid (${String(provider?.providerId)}): not an extension provider id`);
  }
  attached.set(provider.providerId, provider);
};

export const detachExtensionQuotaProvider = (providerId) => attached.delete(providerId);

/** What `GET /api/quota/extensions` lists, for the UI's cards: the id, the name and icon to draw, the extension they come from. */
export const listExtensionQuotaProviders = () => [...attached.values()].map(({ providerId, providerName, icon, guestId }) => ({
  id: providerId, name: providerName, icon, guestId,
}));

export const extensionQuotaProvider = (providerId) => attached.get(providerId) ?? null;
export const extensionQuotaProviderEntries = () => [...attached.entries()];
