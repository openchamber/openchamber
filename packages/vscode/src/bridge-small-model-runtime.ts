import { OpenCode, type ModelSettings } from '@opencode/client';
import { z } from 'zod';
import { waitForLocationPlugins } from '../../web/server/lib/opencode/location-plugins.js';
import type { BridgeResponse } from './bridge';
import type { OpenCodeManager } from './opencode';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type CatalogProvider = { id: string };
type CatalogModel = { providerID: string; enabled?: boolean; settings?: ModelSettings };
type SmallModelCatalog = { providers: CatalogProvider[]; models: CatalogModel[] };

const SmallModelRequest = z.object({ directory: z.string().optional() });

type OpenCodeConnection = Pick<OpenCodeManager, 'getApiUrl' | 'getOpenCodeAuthHeaders'>;

const isAnonymousZenModel = (model: CatalogModel): boolean => model.providerID === 'opencode'
  && model.settings?.apiKey === 'public';

const listAuthenticatedProviders = ({ providers, models }: SmallModelCatalog): string[] => {
  const enabled = new Set<string>();
  for (const model of models) {
    if (model.enabled === false || isAnonymousZenModel(model)) continue;
    if (model.providerID) enabled.add(model.providerID);
  }
  const ids = new Set<string>();
  for (const provider of providers) {
    if (enabled.has(provider.id)) ids.add(provider.id);
  }
  for (const id of enabled) ids.add(id);
  return Array.from(ids);
};

export const readOpenCodeSmallModelCatalog = async (
  connection: OpenCodeConnection | undefined,
  directory: string | undefined,
): Promise<SmallModelCatalog> => {
  const apiUrl = connection?.getApiUrl();
  if (!apiUrl) throw new Error('OpenCode API unavailable');
  const headers = Object.assign({}, connection?.getOpenCodeAuthHeaders());
  if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
  const client = OpenCode.make({ baseUrl: apiUrl.replace(/\/+$/, ''), headers });
  const signal = AbortSignal.timeout(8_000);
  await waitForLocationPlugins(client, signal);
  const [providers, models] = await Promise.all([
    client.provider.list(undefined, { signal }),
    client.model.list(undefined, { signal }),
  ]);
  return { providers: providers.data, models: models.data };
};

export async function handleSmallModelBridgeMessage(
  message: BridgeMessageInput,
  readCatalog: (directory: string | undefined) => Promise<SmallModelCatalog>,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;
  if (type !== 'api:small-model:get') return null;

  const directory = SmallModelRequest.safeParse(payload).data?.directory || undefined;
  try {
    const catalog = await readCatalog(directory);
    return { id, type, success: true, data: { authenticatedProviders: listAuthenticatedProviders(catalog) } };
  } catch (error) {
    return { id, type, success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
