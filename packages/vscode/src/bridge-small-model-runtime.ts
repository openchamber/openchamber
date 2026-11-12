import { OpenCode, type ModelSettings } from '@opencode/client';
import { z } from 'zod';
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

// The webview sends `{ directory }`; any other shape reads as no directory.
const SmallModelRequest = z.object({ directory: z.string().optional() });

type OpenCodeConnection = Pick<OpenCodeManager, 'getApiUrl' | 'getOpenCodeAuthHeaders'>;

// Without a zen login OpenCode gives zen this placeholder instead of a key;
// its free models then serve OpenCode's own sessions only.
const isAnonymousZenModel = (model: CatalogModel): boolean => model.providerID === 'opencode'
  && model.settings?.apiKey === 'public';

/**
 * Provider ids that have at least one enabled model other than zen's free
 * ones without a login, providers in OpenCode's own order first. Mirrors
 * `listAuthenticatedProviders` in the web server's `lib/small-model/index.js`,
 * which answers the same route there.
 */
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

// Model lists are directory-scoped: without the header OpenCode answers for
// its own working directory, which need not hold the project's models.
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
  const [providers, models] = await Promise.all([
    client.provider.list(undefined, { signal }),
    client.model.list(undefined, { signal }),
  ]);
  return { providers: providers.data, models: models.data };
};

/**
 * `GET /api/small-model` for the VS Code runtime, which has no OpenChamber
 * server to answer it. Only `authenticatedProviders` is computed: the Small
 * Model and walkthrough pickers read it to list models. `available` is left
 * out, so the availability store keeps "unknown" as it did before this route
 * existed here. A failed read is an error, never an empty list, so the picker
 * keeps its previous answer.
 */
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
