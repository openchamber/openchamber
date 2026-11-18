import type { TunnelProvider } from './contracts.js';

const REQUIRED_PROVIDER_METHODS: (keyof Pick<TunnelProvider, 'start' | 'stop' | 'checkAvailability' | 'resolvePublicUrl'>)[] = ['start', 'stop', 'checkAvailability', 'resolvePublicUrl'];

const isProviderMethod = (value: unknown): value is (...args: never[]) => void => typeof value === 'function';
const isProviderId = (value: unknown): value is string => typeof value === 'string';

export function createTunnelProviderRegistry(initialProviders: TunnelProvider[] = []) {
  const providers = new Map<string, TunnelProvider>();
  let sealed = false;

  const register = (provider: TunnelProvider) => {
    if (sealed) {
      throw new Error('Tunnel provider registry is sealed; no further registrations allowed');
    }
    if (!provider || !isProviderId(provider.id) || provider.id.trim().length === 0) {
      throw new Error('Tunnel provider must define a non-empty id');
    }
    for (const method of REQUIRED_PROVIDER_METHODS) {
      if (!isProviderMethod(provider[method])) {
        throw new Error(`Tunnel provider '${provider.id}' must implement ${method}()`);
      }
    }
    const key = provider.id.trim().toLowerCase();
    if (providers.has(key)) {
      throw new Error(`Tunnel provider '${key}' is already registered`);
    }
    providers.set(key, provider);
    return provider;
  };

  const get = (providerId: string | undefined) => {
    if (!isProviderId(providerId) || providerId.trim().length === 0) {
      return null;
    }
    return providers.get(providerId.trim().toLowerCase()) ?? null;
  };

  const list = () => Array.from(providers.values());

  const listCapabilities = () => list().map((provider) => ({ ...provider.capabilities }));

  for (const provider of initialProviders) {
    register(provider);
  }

  const seal = () => { sealed = true; };

  return {
    register,
    get,
    list,
    listCapabilities,
    seal,
  };
}
