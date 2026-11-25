import { OpenCode } from '@opencode/client';
import type { ModelInfo, OpenCodeClient } from '@opencode/client';
import type { SmallModelClient } from './contracts.js';
import { asNonEmptyString } from '../shared/guards.js';
import { readLocationCatalog, waitForLocationPlugins } from '../opencode/location-plugins.js';

export interface OpenCodeRuntimeProviders {
  buildOpenCodeUrl: (requestPath: string, query: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  getDefaultDirectory?: () => string | null | Promise<string | null>;
}

export interface SmallModelRef {
  providerID: string;
  modelID: string;
  variant?: string;
}

interface TrustRefusal {
  code: 'opencode_trust_required';
  message?: unknown;
  directory?: unknown;
}

const isTrustRefusal = (value: unknown): value is TrustRefusal =>
  value !== null && (typeof value === 'object' || typeof value === 'function')
  && 'code' in value && value.code === 'opencode_trust_required';

const hasCause = (value: unknown): value is { cause?: unknown } =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

const isDirectory = (value: unknown): value is string => typeof value === 'string';

const hasModelId = <T>(value: T): value is T & { id: string } =>
  Boolean(value) && typeof value === 'object' && value !== null
  && 'id' in value && typeof value.id === 'string';

const isTrustResponse = (value: unknown): value is { code?: unknown; directory?: unknown } =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

let connection: OpenCodeRuntimeProviders | null = null;

export function configureOpenCodeRuntimeProviders(next: OpenCodeRuntimeProviders | null) {
  connection = next ?? null;
}

export function resetOpenCodeRuntimeProviders() {
  modelCache = null;
  modelCacheKey = '';
  modelCacheAt = 0;
}

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, '');

export function getSmallModelClient(directory?: string | null): SmallModelClient | null {
  if (!connection) return null;
  let baseUrl;
  try {
    baseUrl = stripTrailingSlash(connection.buildOpenCodeUrl('', ''));
  } catch {
    return null;
  }
  const headers = { ...connection.getOpenCodeAuthHeaders() };
  const requested = isDirectory(directory) ? directory.trim() : '';
  const { getDefaultDirectory } = connection;
  return OpenCode.make({
    baseUrl,
    headers,
    fetch: async (input, init) => {
      const scope = requested || await getDefaultDirectory?.() || null;
      const scopedHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (scope) scopedHeaders.set('x-opencode-directory', encodeURIComponent(scope));
      const response = await globalThis.fetch(input, { ...init, headers: scopedHeaders });
      if (response.status === 403) {
        const body: unknown = await response.clone().json().catch(() => null);
        const directory = asNonEmptyString(isTrustResponse(body) ? body.directory : undefined);
        if (isTrustResponse(body) && body.code === 'opencode_trust_required' && directory) {
          throw Object.assign(
            new Error(`OpenCode is paused for ${directory}. Open the folder in OpenChamber and trust its configuration before trying again.`),
            { statusCode: 403, code: body.code, directory },
          );
        }
      }
      return response;
    },
  });
}

const MODEL_CACHE_TTL_MS = 30_000;
let modelCache: ModelInfo[] | null = null;
let modelCacheKey = '';
let modelCacheAt = 0;

const unwrap = <T>(payload: { data: T[] }) => (Array.isArray(payload?.data) ? payload.data : []);

export function getTrustRefusal(cause: unknown) {
  if (isTrustRefusal(cause)) return cause;
  if (hasCause(cause) && isTrustRefusal(cause.cause)) return cause.cause;
  return null;
}

export async function listModelInfos(client: OpenCodeClient, directory?: string | null) {
  const key = isDirectory(directory) ? directory : '';
  if (modelCache && modelCacheKey === key && Date.now() - modelCacheAt < MODEL_CACHE_TTL_MS) {
    return modelCache;
  }
  try {
    await waitForLocationPlugins(client);
    const models = unwrap(await client.model.list());
    if (models.length === 0) return models;
    modelCache = models;
    modelCacheKey = key;
    modelCacheAt = Date.now();
    return models;
  } catch (error) {
    const refusal = getTrustRefusal(error);
    if (refusal) throw refusal;
    return modelCacheKey === key && modelCache ? modelCache : [];
  }
}

export async function listProviderInfos(client: OpenCodeClient) {
  try {
    await waitForLocationPlugins(client);
    return unwrap(await client.provider.list());
  } catch (error) {
    const refusal = getTrustRefusal(error);
    if (refusal) throw refusal;
    return [];
  }
}

export async function getDefaultModelInfo(client: OpenCodeClient) {
  try {
    const payload = await client.model.default();
    const info = payload?.data ?? payload;
    return hasModelId(info) ? info : null;
  } catch (error) {
    const refusal = getTrustRefusal(error);
    if (refusal) throw refusal;
    return null;
  }
}

export async function getConfiguredSmallModelRef(client: OpenCodeClient) {
  try {
    const { model } = (await client.agent.get({ agentID: 'title' })).data;
    if (!model) return null;
    const ref: SmallModelRef = { providerID: model.providerID, modelID: model.id };
    const variant = asNonEmptyString(model.variant);
    if (variant) ref.variant = variant;
    return ref;
  } catch (error) {
    const refusal = getTrustRefusal(error);
    if (refusal) throw refusal;
    return null;
  }
}

export function findModelInfo<ProviderID, ModelID>(models: ModelInfo[], providerID: ProviderID, modelID: ModelID) {
  const ofProvider = models.filter((model) => model?.providerID === providerID);
  return ofProvider.find((model) => model.id === modelID)
    ?? ofProvider.find((model) => model.modelID === modelID)
    ?? null;
}

export async function readOpenCodeCatalog(directory: string | null) {
  const client = getSmallModelClient(directory);
  if (!client) throw new Error('OpenCode on this computer is not running');
  const [models, providers] = await readLocationCatalog(client);
  if (!Array.isArray(providers?.data) || !Array.isArray(models?.data)) throw new Error('OpenCode answered no provider list');
  return { providers: providers.data, models: models.data };
}
