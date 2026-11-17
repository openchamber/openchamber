import { sourceControlProviderDescriptors } from './provider-descriptors.js';

const BUILT_IN_LOADERS = Object.freeze({
  github: () => import('../github/provider.js'),
  gitlab: () => import('../gitlab/provider.js'),
  gitea: () => import('../gitea/provider.js'),
  gerrit: () => import('../gerrit/provider.js'),
  forgejo: () => import('../forgejo/provider.js'),
});

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
      const services = { readSettings, configRoot };
      if (fetchImpl) services.fetch = fetchImpl;
      const loading = load().then((module) => module.createProvider({
        ...services,
        ...hostServices[id],
        descriptor,
        authStore,
        events,
      }));
      loading.catch(() => implementations.delete(id));
      implementations.set(id, loading);
    }
    return implementations.get(id);
  };

  const registerExtension = ({ descriptor, guest }) => {
    if (!extensionServices) throw new Error('Extension source-control providers are unavailable in this runtime');
    const previous = extensions.get(descriptor.id);
    descriptors.attachExtension(descriptor);
    extensions.set(descriptor.id, { descriptor, guest, loading: null });
    if (previous) extensionServices.handles.revokeGuest(previous.guest.id);
  };

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
    readTransportCredential: async ({ provider, instance, credentialId, credentialRevision }) => {
      const impl = await implementation(provider);
      if (!(impl?.transport?.readCredential instanceof Function)) return null;
      return impl.transport.readCredential({ instance, credentialId, credentialRevision });
    },
  });
}
