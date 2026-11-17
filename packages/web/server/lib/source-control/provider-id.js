const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;

const RESERVED_PROVIDER_IDS = Object.freeze(['guest', 'link', 'external', 'repository']);

export const isProviderId = (value) => Object.prototype.toString.call(value) === '[object String]'
  && PROVIDER_ID.test(value);

export const isReservedProviderId = (value) => RESERVED_PROVIDER_IDS.includes(value);

export const EXTENSION_PROVIDER_PREFIX = 'ext-';

export const isExtensionProviderId = (value) => isProviderId(value) && value.startsWith(EXTENSION_PROVIDER_PREFIX)
  && isProviderId(value.slice(EXTENSION_PROVIDER_PREFIX.length));

export const isProviderUserId = (provider, instance, value) => {
  if (typeof value !== 'string' || !value.startsWith(`${instance}#`)) return false;
  const id = value.slice(instance.length + 1);
  return isExtensionProviderId(provider) ? id.length > 0 && id.length <= 256 : /^\d+$/.test(id);
};

export function extensionProviderId(guestId) {
  if (!isProviderId(guestId)) return null;
  const id = `${EXTENSION_PROVIDER_PREFIX}${guestId}`;
  return isProviderId(id) ? id : null;
}

export const isProviderUsername = (value) => Object.prototype.toString.call(value) === '[object String]'
  && /^[\x20-\x39\x3b-\x7e]{1,256}$/.test(value) && value.trim() === value;
