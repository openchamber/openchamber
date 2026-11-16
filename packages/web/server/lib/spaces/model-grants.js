import { SpaceError } from './errors.js';

const HEADER_BY_PROVIDER = new Map([
  ['anthropic', 'x-api-key'],
  ['google', 'x-goog-api-key'],
  ...['openai', 'openrouter', 'groq', 'mistral', 'deepseek', 'xai'].map((provider) => [provider, 'authorization']),
]);

/** @param {string} providerId */
export const isProviderKnownByName = (providerId) => HEADER_BY_PROVIDER.has(providerId);

/**
 * @param {{ hostCatalog: { read: Function, list: Function, readStoredKey: Function }, readHostSecret: Function }} dependencies
 */
export function createModelGrants({ hostCatalog, readHostSecret }) {
  const readCatalogProvider = async (providerId, directory) => {
    try {
      return await hostCatalog.read(providerId, directory);
    } catch (error) {
      throw new SpaceError('host_catalog_unreadable', `The providers of OpenCode on this computer could not be read: ${error?.message ?? error}`);
    }
  };

  const secretOf = async (source) => {
    if (source.kind === 'env') return readHostSecret(source.name);
    if (source.kind === 'stored') return hostCatalog.readStoredKey(source.integration).catch(() => null);
    return null;
  };

  const headersOf = (definition) => (definition && Object.keys(definition.headers).length > 0 ? definition.headers : null);

  const catalogHeadersFor = async (grant, repository) => (isProviderKnownByName(grant.provider) ? null : headersOf(await hostCatalog.read(grant.provider, repository).catch(() => null)));

  const catalogDefinitionsOf = async (grants, repository) => {
    const definitions = new Map();
    for (const grant of grants) {
      if (grant.kind !== 'model' || isProviderKnownByName(grant.provider)) continue;
      const definition = await hostCatalog.read(grant.provider, repository).catch(() => null);
      if (!definition) throw new SpaceError('host_catalog_unreadable', `The provider ${grant.provider} could not be read from OpenCode on this computer, so the space's model configuration was not written.`);
      definitions.set(grant.provider, { baseURL: definition.baseURL, models: definition.models });
    }
    return definitions;
  };

  const modelGrantOf = async (asked, repository) => {
    const known = HEADER_BY_PROVIDER.get(asked.provider);
    const definition = !known || asked.secret.kind === 'stored' ? await readCatalogProvider(asked.provider, repository) : null;
    if (!known && !definition?.window) {
      throw new SpaceError('provider_not_supported', `A key for ${asked.provider} cannot be given through the network filter yet: it reads its key in a way the network filter does not know.`);
    }
    if (known && !asked.upstream) throw new SpaceError('invalid_grant_request', `A key for ${asked.provider} names the provider's API.`);
    const upstream = known ? asked.upstream : definition.window.upstream;
    const header = known ?? definition.window.header;
    const source = asked.secret.kind === 'typed' ? { kind: 'typed' } : asked.secret.kind === 'stored' ? { kind: 'stored', integration: definition?.integration ?? asked.provider } : { kind: 'env', name: asked.secret.name };
    const secret = asked.secret.kind === 'typed' ? asked.secret.value : await secretOf(source);
    if (typeof secret !== 'string' || secret === '') {
      if (source.kind === 'stored') throw new SpaceError('stored_key_missing', `OpenChamber has no key saved for ${asked.provider}. Add one in Settings, Providers, or give a key another way.`);
      throw new SpaceError('secret_source_missing', `The environment variable ${asked.secret.name} is not set for OpenChamber, so there is no key to give.`);
    }
    const window = { upstream, header, secret };
    const headers = known ? null : headersOf(definition);
    if (headers) window.headers = headers;
    return { grant: { kind: 'model', id: asked.provider, provider: asked.provider, upstream, header, source }, window };
  };

  const listCatalogProviders = async (directory) => ({
    providers: (await hostCatalog.list(directory)).map((provider) => ({ ...provider, supported: provider.supported || isProviderKnownByName(provider.id) })),
  });

  return { modelGrantOf, secretOf, catalogHeadersFor, catalogDefinitionsOf, listCatalogProviders };
}
