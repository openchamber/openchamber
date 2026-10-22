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
