import { z } from 'zod';

const BEARER_ROOTS = [
  'openai', 'openai-compatible', 'openai-compatible-responses', 'opencode', 'xai', 'venice', 'baseten', 'cerebras',
  'cohere', 'deepinfra', 'deepseek', 'digitalocean', 'fireworks', 'groq', 'meta', 'minimax', 'mistral', 'moonshot',
  'openrouter', 'togetherai', 'vercel-ai-gateway', 'zai', 'zai-coding-plan',
];
const HEADER_BY_ROOT = new Map([
  ...BEARER_ROOTS.map((root) => [root, 'authorization']),
  ['anthropic', 'x-api-key'],
  ['anthropic-compatible', 'x-api-key'],
  ['google', 'x-goog-api-key'],
]);
const PACKAGE_PATTERN = /^@opencode\/ai\/providers\/([a-z0-9-]+)(?:\/[a-z0-9/-]+)?$/;
const BEARER_GATEWAYS = new Set(['opencode-go']);
const REFUSED_PROVIDERS = new Set(['opencode']);

const text = z.string().min(1);
const providerSchema = z.object({
  id: text,
  name: z.string().optional().catch(undefined),
  integrationID: text.optional().catch(undefined),
  package: z.string().optional().catch(undefined),
  settings: z.object({ baseURL: z.string().optional().catch(undefined) }).passthrough().optional().catch(undefined),
  headers: z.record(z.string(), z.string()).optional().catch(undefined),
}).passthrough();
const modelSchema = z.object({
  id: text,
  providerID: text,
  package: z.string().optional().catch(undefined),
  settings: z.object({ baseURL: z.string().optional().catch(undefined) }).passthrough().optional().catch(undefined),
}).passthrough();

/** @param {string | undefined} packageName */
export const headerOfCatalogPackage = (packageName) => {
  const match = PACKAGE_PATTERN.exec(packageName ?? '');
  return match ? HEADER_BY_ROOT.get(match[1]) ?? null : null;
};

const httpsUrlOf = (value) => {
  const url = URL.canParse(value) ? new URL(value) : null;
  return url?.protocol === 'https:' && url.search === '' && url.hash === '' && url.username === '' && url.password === '' ? url : null;
};

/** @param {{ id: string, package?: string, baseURL: string | null, models: Array<{ package?: string, baseURL: string | null }> }} definition */
export const catalogWindowOf = ({ id, package: providerPackage, baseURL, models }) => {
  if (REFUSED_PROVIDERS.has(id)) return null;
  const addresses = [baseURL, ...models.map((model) => model.baseURL)].filter((value) => value !== null);
  const urls = addresses.map(httpsUrlOf);
  if (urls.length === 0 || urls.some((url) => url === null) || new Set(urls.map((url) => url.origin)).size !== 1) return null;
  const headers = new Set([providerPackage, ...models.map((model) => model.package)].filter((value) => value !== undefined).map(headerOfCatalogPackage));
  const header = BEARER_GATEWAYS.has(id) ? (headers.has(null) ? null : 'authorization') : headers.size === 1 ? [...headers][0] : null;
  if (!header) return null;
  const paths = urls.map((url) => url.pathname.replace(/\/?$/, '/'));
  let prefix = paths[0];
  for (const path of paths) while (!path.startsWith(prefix)) prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf('/') + 1);
  return { upstream: `${urls[0].origin}${prefix}`, header };
};

/** @param {string} address @param {string} upstream @param {string} windowUrl */
export const addressThroughWindow = (address, upstream, windowUrl) => {
  const url = httpsUrlOf(address);
  const path = url?.pathname.replace(/\/?$/, '/');
  if (!url || !`${url.origin}${path}`.startsWith(upstream)) return null;
  return `${windowUrl.replace(/\/$/, '')}/${path.slice(new URL(upstream).pathname.length)}`.replace(/\/$/, '');
};

/** @param {{ readCatalog: (directory: string | null) => Promise<{ providers: unknown[], models: unknown[] }>, readStoredKey?: (integration: string) => Promise<string | null> }} dependencies */
export function createHostCatalog({ readCatalog, readStoredKey = async () => null }) {
  const definitionOf = (provider, models) => {
    const definition = {
      id: provider.id,
      name: provider.name || provider.id,
      integration: provider.integrationID ?? provider.id,
      package: provider.package,
      baseURL: provider.settings?.baseURL ?? null,
      headers: provider.headers ?? {},
      models: models.filter((model) => model.providerID === provider.id).map((model) => ({ id: model.id, package: model.package, baseURL: model.settings?.baseURL ?? null })),
    };
    return { ...definition, window: catalogWindowOf(definition) };
  };

  const parsedCatalog = async (directory) => {
    const { providers, models } = await readCatalog(directory);
    return {
      providers: providers.flatMap((entry) => providerSchema.safeParse(entry).data ?? []),
      models: models.flatMap((entry) => modelSchema.safeParse(entry).data ?? []),
    };
  };

  const read = async (providerId, directory) => {
    const { providers, models } = await parsedCatalog(directory);
    const provider = providers.find((entry) => entry.id === providerId);
    return provider ? definitionOf(provider, models) : null;
  };

  const hasStoredKey = async (integration) => text.safeParse(await readStoredKey(integration).catch(() => null)).success;

  const list = async (directory) => {
    const { providers, models } = await parsedCatalog(directory);
    return Promise.all(providers.map(async (provider) => {
      const definition = definitionOf(provider, models);
      return { id: definition.id, name: definition.name, supported: definition.window !== null, storedKey: await hasStoredKey(definition.integration) };
    }));
  };

  return { read, list, readStoredKey };
}
