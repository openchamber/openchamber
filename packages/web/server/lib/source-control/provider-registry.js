import { sourceControlProviderDescriptors } from './provider-descriptors.js';

/**
 * How each built-in provider's implementation loads. Implementations pull in
 * their SDKs (Octokit, GitBeaker), so they load on first use, never at
 * startup; descriptors stay synchronous in `provider-descriptors.js`.
 */
const BUILT_IN_LOADERS = Object.freeze({
  github: () => import('../github/provider.js'),
  gitlab: () => import('../gitlab/provider.js'),
  gitea: () => import('../gitea/provider.js'),
});

/**
 * Account lifecycle events a provider reports while it works: a connected
 * account, one the provider refused (`invalidated`) and one the user removed.
 * Listeners run in order and are awaited, because bindings must move before
 * the provider changes its auth storage.
 */
export function createAccountEvents() {
  const listeners = [];
  const emit = (kind) => async (payload) => {
    for (const listener of [...listeners]) await listener[kind]?.(payload);
  };
  return Object.freeze({
    connected: emit('connected'),
    invalidated: emit('invalidated'),
    removed: emit('removed'),
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  });
}

/**
 * The source-control provider registry: static descriptors plus their lazily
 * loaded implementations, created once per server runtime.
 *
 * `hostServices[id]` are construction-time services for one provider (its
 * auth store section, fetch, settings reader, test doubles); the registry
 * adds `descriptor`, `authStore`, `readSettings`, `configRoot`, `fetch` and the
 * shared account `events`. Implementations take JSON in and give JSON out, so
 * nothing here depends on how a provider talks to its service.
 */
export function createSourceControlProviders({
  authStore,
  readSettings = async () => ({}),
  configRoot,
  fetch: fetchImpl,
  hostServices = {},
  descriptors = sourceControlProviderDescriptors,
  loaders = BUILT_IN_LOADERS,
} = {}) {
  const events = createAccountEvents();
  const implementations = new Map();

  const implementation = (id) => {
    const descriptor = descriptors.get(id);
    const load = descriptor ? loaders[id] : null;
    if (!(load instanceof Function)) return Promise.resolve(null);
    if (!implementations.has(id)) {
      // The registry's fetch is a default only; a provider's own host
      // services may override it, the rest are the registry's.
      const services = { readSettings, configRoot };
      if (fetchImpl) services.fetch = fetchImpl;
      const loading = load().then((module) => module.createProvider({
        ...services,
        ...hostServices[id],
        descriptor,
        authStore,
        events,
      }));
      // A failed load is not cached: the next request tries again.
      loading.catch(() => implementations.delete(id));
      implementations.set(id, loading);
    }
    return implementations.get(id);
  };

  return Object.freeze({
    descriptors,
    events,
    has: (id) => descriptors.has(id),
    list: () => descriptors.list(),
    describe: (id) => descriptors.get(id),
    implementation,
    /**
     * The neutral transport credential for an exact credential id and
     * revision, or null when its provider is unknown or holds none.
     */
    readTransportCredential: async ({ provider, instance, credentialId, credentialRevision }) => {
      const impl = await implementation(provider);
      if (!(impl?.transport?.readCredential instanceof Function)) return null;
      return impl.transport.readCredential({ instance, credentialId, credentialRevision });
    },
  });
}
