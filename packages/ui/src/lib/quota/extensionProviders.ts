import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import type { ExtensionQuotaProviderId, QuotaProviderId } from '@/types';

import { QUOTA_PROVIDERS, type QuotaProviderMeta } from './providers';

/**
 * A usage provider an installed extension serves (`provides: ["quota"]`), as
 * `GET /api/quota/extensions` lists it: the id the server gave it
 * (`ext-<extension id>`), the extension's name and icon to draw the card
 * with, and the extension itself, whose package serves an SVG icon.
 */
export type ExtensionQuotaProvider = {
  id: ExtensionQuotaProviderId;
  name: string;
  /** A Remixicon name or a package SVG path, the extension's own icon. */
  icon: string;
  guestId: string;
};

export const isExtensionQuotaProviderId = (providerId: string): providerId is ExtensionQuotaProviderId => providerId.startsWith('ext-');

// The server's shape for one provider; a list with an entry it cannot read is
// a failed read, kept out of the UI whole, never a shorter list. Accepts every
// name and icon the manifest parse does, so one extension cannot fail the list.
const EXTENSION_QUOTA_PROVIDER_ID = /^ext-[a-z][a-z0-9-]{0,27}$/;
const extensionQuotaProviderSchema = z.object({
  id: z.custom<ExtensionQuotaProviderId>((value) => String(value) === value && EXTENSION_QUOTA_PROVIDER_ID.test(value)),
  name: z.string().trim().min(1),
  icon: z.string().trim().min(1),
  guestId: z.string().regex(/^[a-z][a-z0-9-]{0,27}$/),
});
const providersAnswerSchema = z.object({ extensions: z.array(extensionQuotaProviderSchema).max(64) });

/** The usage providers installed extensions serve on the connected instance. Throws on a failed or unreadable read. */
export const fetchExtensionQuotaProviders = async ({ signal }: { signal?: AbortSignal } = {}): Promise<ExtensionQuotaProvider[]> => {
  const response = await runtimeFetch('/api/quota/extensions', { signal });
  if (!response.ok) throw new Error(`Failed to list usage providers (${response.status})`);
  return providersAnswerSchema.parse(await response.json()).extensions;
};

/** Two lists that would draw the same cards. */
export const sameExtensionQuotaProviders = (a: readonly ExtensionQuotaProvider[], b: readonly ExtensionQuotaProvider[]): boolean => (
  a.length === b.length && a.every((entry, index) => {
    const other = b[index];
    return entry.id === other.id && entry.name === other.name && entry.icon === other.icon && entry.guestId === other.guestId;
  })
);

/** Every usage provider to draw: the built-ins, then the extensions' in the server's order. */
export const quotaProviderList = (extensionProviders: readonly ExtensionQuotaProvider[]): QuotaProviderMeta[] => (
  extensionProviders.length === 0
    ? QUOTA_PROVIDERS
    : [...QUOTA_PROVIDERS, ...extensionProviders.map(({ id, name }) => ({ id, name }))]
);

/** The ids of every usage provider to draw, in the same order. */
export const quotaProviderIds = (extensionProviders: readonly ExtensionQuotaProvider[]): QuotaProviderId[] => (
  quotaProviderList(extensionProviders).map((provider) => provider.id)
);
