import { sourceControlProviderDescriptors } from './provider-descriptors.js';
import type { createSettingsRuntime } from '../settings/settings-runtime.js';
import type { AccountEvents, ProviderDescriptor, ProviderId, ProviderImplementation, ProviderMutations } from './provider-contract.js';
import type { BindingTransportAccount } from './binding-service-contracts.js';
import type { createSourceControlAuthStore } from './auth-storage.js';
import type { createExtensionProvider, ExtensionProviderOptions } from './extension-provider.js';
import type { GitHubProviderOptions } from '../github/provider.js';
import type { GitLabProviderOptions } from '../gitlab/provider.js';
import type { GiteaProviderOptions } from '../gitea/provider.js';
import type { GerritProviderOptions } from '../gerrit/provider.js';
import type { ForgejoProviderOptions } from '../forgejo/provider.js';

export type AccountEventPayloads = {
  connected: Parameters<AccountEvents['connected']>[0];
  invalidated: { provider: string; instance: unknown; accountId: unknown };
  removed: Parameters<AccountEvents['removed']>[0];
};
type AccountListener = { [Kind in keyof AccountEventPayloads]?: (payload: AccountEventPayloads[Kind]) => void | Promise<void> };
type ReadSettings = ReturnType<typeof createSettingsRuntime>['readSettingsFromDisk'];
type AuthStore = ReturnType<typeof createSourceControlAuthStore>;
type ExtensionServices = Pick<ExtensionProviderOptions, 'handles' | 'persistPath' | 'currentGuest' | 'reconcile'>;

export type RegisteredMutationInput = object;
type RegisteredProviderTarget = object;
export interface TransportCredentialRequest {
  instance: string;
  credentialId: string;
  credentialRevision?: number | undefined;
}

export interface RegisteredProvider {
  auth: ProviderImplementation['auth'];
  transport: {
    readCredential(input: TransportCredentialRequest): Promise<BindingTransportAccount | null>;
  };
  resources: ProviderImplementation['resources'];
  mutations?: ProviderMutations<RegisteredMutationInput, RegisteredProviderTarget>;
  classifyFailure(cause: unknown): ReturnType<ReturnType<typeof createExtensionProvider>['classifyFailure']>;
}

export interface ProviderServices {
  readSettings: ReadSettings;
  configRoot: string | undefined;
  fetch?: typeof fetch | undefined;
  descriptor: ProviderDescriptor;
  authStore: AuthStore;
  events: ReturnType<typeof createAccountEvents>;
}
type ProviderLoader = () => Promise<{ createProvider: (services: ProviderServices) => RegisteredProvider }>;
type ProviderLoaders = Readonly<Partial<Record<ProviderId, ProviderLoader>>>;
type RegistrySupplied = 'descriptor' | 'authStore' | 'events';
type SharedServices = Pick<ProviderServices, 'readSettings' | 'configRoot' | 'fetch'>;
type HostOptions<Options> = Options extends unknown
  ? Omit<Options, RegistrySupplied | keyof SharedServices> & Partial<SharedServices>
  : never;
export interface BuiltInHostServices {
  readonly github?: HostOptions<GitHubProviderOptions>;
  readonly gitlab?: HostOptions<GitLabProviderOptions>;
  readonly gitea?: HostOptions<GiteaProviderOptions>;
  readonly gerrit?: HostOptions<GerritProviderOptions>;
  readonly forgejo?: HostOptions<ForgejoProviderOptions>;
}
type ProviderHostServices = NonNullable<BuiltInHostServices[keyof BuiltInHostServices]>;
type HostServices = BuiltInHostServices & { readonly [id: ProviderId]: ProviderHostServices | undefined };

const BUILT_IN_LOADERS: ProviderLoaders = Object.freeze({
  github: () => import('../github/provider.js'),
  gitlab: () => import('../gitlab/provider.js'),
  gitea: () => import('../gitea/provider.js'),
  gerrit: () => import('../gerrit/provider.js'),
  forgejo: () => import('../forgejo/provider.js'),
});

export function createAccountEvents() {
  const listeners: AccountListener[] = [];
  const emit = <Kind extends keyof AccountEventPayloads>(kind: Kind) => async (payload: AccountEventPayloads[Kind]) => {
    for (const listener of [...listeners]) await listener[kind]?.(payload);
  };
  return Object.freeze({
    connected: emit('connected'),
    invalidated: emit('invalidated'),
    removed: emit('removed'),
    subscribe: (listener: AccountListener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  });
}

interface RegistryOptions {
  authStore: AuthStore;
  readSettings?: ReadSettings;
  configRoot?: string;
  fetch?: typeof fetch;
  hostServices?: HostServices;
  descriptors?: typeof sourceControlProviderDescriptors;
  loaders?: ProviderLoaders;
  extensionServices?: ExtensionServices | null;
}
type ExtensionRegistration = Pick<ExtensionProviderOptions, 'descriptor' | 'guest'>;
interface ExtensionEntry extends ExtensionRegistration {
  services: ExtensionServices;
  loading: Promise<ReturnType<typeof createExtensionProvider>> | null;
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
}: RegistryOptions) {
  const events = createAccountEvents();
  const implementations = new Map<ProviderId, Promise<RegisteredProvider>>();
  const extensions = new Map<ProviderId, ExtensionEntry>();

  const extensionImplementation = (entry: ExtensionEntry) => {
    entry.loading ??= import('./extension-provider.js').then((module) => module.createExtensionProvider({
      ...entry.services,
      descriptor: entry.descriptor,
      guest: entry.guest,
      store: authStore.section(entry.descriptor.id),
      events,
    }));
    entry.loading.catch(() => { entry.loading = null; });
    return entry.loading;
  };

  const implementation = (id: ProviderId): Promise<RegisteredProvider | null> => {
    const extension = extensions.get(id);
    if (extension) return extensionImplementation(extension);
    const descriptor = descriptors.get(id);
    const load = descriptor ? loaders[id] : null;
    if (!descriptor || !(load instanceof Function)) return Promise.resolve(null);
    let loading = implementations.get(id);
    if (!loading) {
      const services: SharedServices = { readSettings, configRoot };
      if (fetchImpl) services.fetch = fetchImpl;
      loading = load().then((module) => module.createProvider({
        ...services,
        ...hostServices[id],
        descriptor,
        authStore,
        events,
      }));
      loading.catch(() => implementations.delete(id));
      implementations.set(id, loading);
    }
    return loading;
  };

  const registerExtension = ({ descriptor, guest }: ExtensionRegistration) => {
    if (!extensionServices) throw new Error('Extension source-control providers are unavailable in this runtime');
    const previous = extensions.get(descriptor.id);
    descriptors.attachExtension(descriptor);
    extensions.set(descriptor.id, { descriptor, guest, services: extensionServices, loading: null });
    if (previous) extensionServices.handles.revokeGuest(previous.guest.id);
  };

  const unregisterExtension = (id: ProviderId) => {
    const entry = extensions.get(id);
    if (!entry) return false;
    extensions.delete(id);
    descriptors.detachExtension(id);
    entry.services.handles.revokeGuest(entry.guest.id);
    entry.loading?.then((impl) => impl.dispose(), () => undefined);
    return true;
  };

  return Object.freeze({
    descriptors,
    events,
    registerExtension,
    unregisterExtension,
    has: (id: ProviderId) => descriptors.has(id),
    list: () => descriptors.list(),
    describe: (id: ProviderId) => descriptors.get(id),
    implementation,
    readTransportCredential: async ({ provider, instance, credentialId, credentialRevision }: TransportCredentialRequest & { provider: ProviderId }) => {
      const impl = await implementation(provider);
      if (!(impl?.transport?.readCredential instanceof Function)) return null;
      return impl.transport.readCredential({ instance, credentialId, credentialRevision });
    },
  });
}
