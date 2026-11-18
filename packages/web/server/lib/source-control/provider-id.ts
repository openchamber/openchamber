const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;

export type ProviderId = string;

const RESERVED_PROVIDER_IDS = Object.freeze(['guest', 'link', 'external', 'repository']);

export const isProviderId = (value: unknown): value is ProviderId => string(value)
  && PROVIDER_ID.test(value);

export const isReservedProviderId = (value: string) => RESERVED_PROVIDER_IDS.includes(value);

export const EXTENSION_PROVIDER_PREFIX = 'ext-';

export const isExtensionProviderId = (value: unknown): value is string => isProviderId(value) && value.startsWith(EXTENSION_PROVIDER_PREFIX)
  && isProviderId(value.slice(EXTENSION_PROVIDER_PREFIX.length));

export const isProviderUserId = (provider: string, instance: string, value: unknown): value is string => {
  if (typeof value !== 'string' || !value.startsWith(`${instance}#`)) return false;
  const id = value.slice(instance.length + 1);
  return isExtensionProviderId(provider) ? id.length > 0 && id.length <= 256 : /^\d+$/.test(id);
};

export function extensionProviderId(guestId: string) {
  if (!isProviderId(guestId)) return null;
  const id = `${EXTENSION_PROVIDER_PREFIX}${guestId}`;
  return isProviderId(id) ? id : null;
}

export const isProviderUsername = (value: unknown): value is string => string(value)
  && /^[\x20-\x39\x3b-\x7e]{1,256}$/.test(value) && value.trim() === value;
import { isSourceControlString as string } from './input-guards.js';
