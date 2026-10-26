const REQUIRED_PROVIDER_METHODS = ['start', 'stop', 'checkAvailability', 'resolvePublicUrl'];

export function createTunnelProviderRegistry(initialProviders = []) {
  const providers = new Map();
  let sealed = false;

  const register = (provider) => {
    if (sealed) {
      throw new Error('Tunnel provider registry is sealed; no further registrations allowed');
    }
    if (!provider || typeof provider.id !== 'string' || provider.id.trim().length === 0) {
      throw new Error('Tunnel provider must define a non-empty id');
    }
    for (const method of REQUIRED_PROVIDER_METHODS) {
      if (typeof provider[method] !== 'function') {
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

  const get = (providerId) => {
    if (typeof providerId !== 'string' || providerId.trim().length === 0) {
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
