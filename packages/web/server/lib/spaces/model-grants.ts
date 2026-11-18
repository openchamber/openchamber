import { SpaceError, spaceErrorProperty } from './errors.js';
import { transferValue } from './code-transfer.js';
import type { createHostCatalog } from './host-catalog.js';
import type { SpaceGrant, SecretSource } from './space-records.js';
import type { GrantRequest } from './journey.js';

const HEADER_BY_PROVIDER = new Map<string, string>([
  ['anthropic', 'x-api-key'],
  ['google', 'x-goog-api-key'],
  ...['openai', 'openrouter', 'groq', 'mistral', 'deepseek', 'xai'].map((provider): [string, string] => [provider, 'authorization']),
]);

export const isProviderKnownByName = (providerId: string) => HEADER_BY_PROVIDER.has(providerId);

type HostCatalog = ReturnType<typeof createHostCatalog>;
type CatalogDefinition = NonNullable<Awaited<ReturnType<HostCatalog['read']>>>;
export interface ModelGrantWindow {
  upstream: string;
  header: string;
  secret: string;
  headers?: CatalogDefinition['headers'];
}

export const isSecretString = (value: unknown): value is string => typeof value === 'string';

export function createModelGrants<HostSecret>({ hostCatalog, readHostSecret }: { hostCatalog: HostCatalog; readHostSecret: (name: string) => HostSecret | undefined }) {
  const readCatalogProvider = async (providerId: string, directory: string | null) => {
    try {
      return await hostCatalog.read(providerId, directory);
    } catch (error) {
      throw new SpaceError('host_catalog_unreadable', `The providers of OpenCode on this computer could not be read: ${spaceErrorProperty(error, 'message') ?? error}`);
    }
  };

  const secretOf = async (source: SecretSource) => {
    if (source.kind === 'env') return readHostSecret(source.name);
    if (source.kind === 'stored') return hostCatalog.readStoredKey(source.integration).catch(() => null);
    return null;
  };

  const headersOf = (definition: CatalogDefinition | null) => (definition && Object.keys(definition.headers).length > 0 ? definition.headers : null);

  const catalogHeadersFor = async (grant: Extract<SpaceGrant, { kind: 'model' }>, repository: string | null) => (isProviderKnownByName(grant.provider) ? null : headersOf(await hostCatalog.read(grant.provider, repository).catch(() => null)));

  const catalogDefinitionsOf = async (grants: SpaceGrant[], repository: string | null) => {
    const definitions = new Map<string, Pick<CatalogDefinition, 'baseURL' | 'models'>>();
    for (const grant of grants) {
      if (grant.kind !== 'model' || isProviderKnownByName(grant.provider)) continue;
      const definition = await hostCatalog.read(grant.provider, repository).catch(() => null);
      if (!definition) throw new SpaceError('host_catalog_unreadable', `The provider ${grant.provider} could not be read from OpenCode on this computer, so the space's model configuration was not written.`);
      definitions.set(grant.provider, { baseURL: definition.baseURL, models: definition.models });
    }
    return definitions;
  };

  const modelGrantOf = async (asked: Extract<GrantRequest, { kind: 'model' }>, repository: string | null) => {
    const known = HEADER_BY_PROVIDER.get(asked.provider);
    const definition = !known || asked.secret.kind === 'stored' ? await readCatalogProvider(asked.provider, repository) : null;
    if (!known && !definition?.window) {
      throw new SpaceError('provider_not_supported', `A key for ${asked.provider} cannot be given through the network filter yet: it reads its key in a way the network filter does not know.`);
    }
    if (known && !asked.upstream) throw new SpaceError('invalid_grant_request', `A key for ${asked.provider} names the provider's API.`);
    const upstream = known ? transferValue(asked.upstream) : transferValue(transferValue(definition).window).upstream;
    const header = known ?? transferValue(transferValue(definition).window).header;
    const source: SecretSource = asked.secret.kind === 'typed' ? { kind: 'typed' } : asked.secret.kind === 'stored' ? { kind: 'stored', integration: definition?.integration ?? asked.provider } : { kind: 'env', name: asked.secret.name };
    const secret = asked.secret.kind === 'typed' ? asked.secret.value : await secretOf(source);
    if (!isSecretString(secret) || secret === '') {
      if (source.kind === 'stored') throw new SpaceError('stored_key_missing', `OpenChamber has no key saved for ${asked.provider}. Add one in Settings, Providers, or give a key another way.`);
      throw new SpaceError('secret_source_missing', `The environment variable ${'name' in asked.secret ? asked.secret.name : undefined} is not set for OpenChamber, so there is no key to give.`);
    }
    const window: ModelGrantWindow = { upstream, header, secret };
    const headers = known ? null : headersOf(definition);
    if (headers) window.headers = headers;
    const grant: Extract<SpaceGrant, { kind: 'model' }> = { kind: 'model', id: asked.provider, provider: asked.provider, upstream, header, source };
    return { grant, window };
  };

  const listCatalogProviders = async (directory: string | null) => ({
    providers: (await hostCatalog.list(directory)).map((provider) => ({ ...provider, supported: provider.supported || isProviderKnownByName(provider.id) })),
  });

  return { modelGrantOf, secretOf, catalogHeadersFor, catalogDefinitionsOf, listCatalogProviders };
}
