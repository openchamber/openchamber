/**
 * Provider ids are open strings: persisted stores keep whatever id wrote a
 * record, so a parser checks the syntax only and the provider registry decides
 * at read time whether the id is available. Dependency-free, because the
 * binding contract that imports it is bundled into the web client too.
 */
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;

// Ids that name something other than a provider in the keys that share this
// namespace (tracked items, the read cache, session links), so no registry
// may register them.
const RESERVED_PROVIDER_IDS = Object.freeze(['guest', 'link', 'external', 'repository']);

export const isProviderId = (value) => Object.prototype.toString.call(value) === '[object String]'
  && PROVIDER_ID.test(value);

export const isReservedProviderId = (value) => RESERVED_PROVIDER_IDS.includes(value);

/**
 * Ids an installed extension's source-control provider takes: `ext-` plus its
 * guest id, derived by the host and never declared, so no extension can
 * claim a built-in's id or another extension's. Built-in lists and the
 * tracker registry refuse any id with the prefix.
 */
export const EXTENSION_PROVIDER_PREFIX = 'ext-';

/** An id `extensionProviderId` can return: the prefix, then a guest id. */
export const isExtensionProviderId = (value) => isProviderId(value) && value.startsWith(EXTENSION_PROVIDER_PREFIX)
  && isProviderId(value.slice(EXTENSION_PROVIDER_PREFIX.length));

/**
 * The provider id of a guest's source-control role, or null when the guest id
 * is malformed or too long for the id syntax (more than 28 characters), so
 * such a guest cannot take the role.
 */
export function extensionProviderId(guestId) {
  // Guest ids share the provider id alphabet; the prefixed id must still fit 32 characters.
  if (!isProviderId(guestId)) return null;
  const id = `${EXTENSION_PROVIDER_PREFIX}${guestId}`;
  return isProviderId(id) ? id : null;
}
