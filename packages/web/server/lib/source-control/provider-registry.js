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
  gerrit: () => import('../gerrit/provider.js'),
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
 *
 * Extension providers (`ext-<guestId>`) join and leave at runtime:
 * `registerExtension` attaches the descriptor to the facade (so every reader
 * of it sees the provider) and builds the implementation on first use with
 * `extensionServices` (`{ handles, persistPath, currentGuest, reconcile, proxy? }`,
 * see `extension-provider.js`); `unregisterExtension` detaches it, disposes
 * and drops the implementation and revokes the guest's outbound handles.
 */
export function createSourceControlProviders({
  authStore,
  readSettings = async () => ({}),
  configRoot,
  fetch: fetchImpl,
  hostServices = {},
  descriptors = sourceControlProviderDescriptors,
  loaders = BUILT_IN_LOADERS,
  extensionServices = null,
} = {}) {
  const events = createAccountEvents();
  const implementations = new Map();
  /** @type {Map<string, { descriptor: object, guest: object, loading: Promise<object> | null }>} */
  const extensions = new Map();

  const extensionImplementation = (entry) => {
    entry.loading ??= import('./extension-provider.js').then((module) => module.createExtensionProvider({
      ...extensionServices,
      descriptor: entry.descriptor,
      guest: entry.guest,
      store: authStore.section(entry.descriptor.id),
      events,
    }));
    // A failed build is not cached: the next request tries again.
    entry.loading.catch(() => { entry.loading = null; });
    return entry.loading;
  };

  const implementation = (id) => {
    const extension = extensions.get(id);
    if (extension) return extensionImplementation(extension);
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

  /** Serves `descriptor` (an `ext-` id) through `guest`'s service, replacing an earlier registration. */
  const registerExtension = ({ descriptor, guest }) => {
    if (!extensionServices) throw new Error('Extension source-control providers are unavailable in this runtime');
    const previous = extensions.get(descriptor.id);
    descriptors.attachExtension(descriptor);
    extensions.set(descriptor.id, { descriptor, guest, loading: null });
    if (previous) extensionServices.handles.revokeGuest(previous.guest.id);
  };

  /**
   * True when the id named a registered extension provider. The built
   * implementation is disposed, so a call still running cannot write an
   * account back after removal dropped the provider's section.
   */
  const unregisterExtension = (id) => {
    const entry = extensions.get(id);
    if (!entry) return false;
    extensions.delete(id);
    descriptors.detachExtension(id);
    extensionServices.handles.revokeGuest(entry.guest.id);
    entry.loading?.then((impl) => impl.dispose(), () => undefined);
    return true;
  };

  return Object.freeze({
    descriptors,
    events,
    registerExtension,
    unregisterExtension,
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
