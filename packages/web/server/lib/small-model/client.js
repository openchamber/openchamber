import { OpenCode } from '@opencode/client';
import { asNonEmptyString } from '../shared/guards.js';

let connection = null;

export function configureOpenCodeRuntimeProviders(next) {
  connection = next ?? null;
}

export function resetOpenCodeRuntimeProviders() {
  modelCache = null;
  modelCacheKey = '';
  modelCacheAt = 0;
}

const stripTrailingSlash = (value) => value.replace(/\/+$/, '');

export function getSmallModelClient(directory) {
  if (!connection) return null;
  let baseUrl;
  try {
    baseUrl = stripTrailingSlash(connection.buildOpenCodeUrl('', ''));
  } catch {
    return null;
  }
  const headers = { ...connection.getOpenCodeAuthHeaders() };
  const requested = typeof directory === 'string' ? directory.trim() : '';
  const scope = requested || connection.getDefaultDirectory?.() || null;
  if (scope) {
    headers['x-opencode-directory'] = encodeURIComponent(scope);
  }
  return OpenCode.make({
    baseUrl,
    headers,
    fetch: async (input, init) => {
      const response = await globalThis.fetch(input, init);
      if (response.status === 403) {
        const body = await response.clone().json().catch(() => null);
        const directory = asNonEmptyString(body?.directory);
        if (body?.code === 'opencode_trust_required' && directory) {
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
let modelCache = null;
let modelCacheKey = '';
let modelCacheAt = 0;

const unwrap = (payload) => (Array.isArray(payload?.data) ? payload.data : []);

export function getTrustRefusal(error) {
  if (error?.code === 'opencode_trust_required') return error;
  if (error?.cause?.code === 'opencode_trust_required') return error.cause;
  return null;
}

export async function listModelInfos(client, directory) {
  const key = typeof directory === 'string' ? directory : '';
  if (modelCache && modelCacheKey === key && Date.now() - modelCacheAt < MODEL_CACHE_TTL_MS) {
    return modelCache;
  }
  try {
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

export async function listProviderInfos(client) {
  try {
    return unwrap(await client.provider.list());
  } catch (error) {
    const refusal = getTrustRefusal(error);
    if (refusal) throw refusal;
    return [];
  }
}

export async function getDefaultModelInfo(client) {
  try {
    const payload = await client.model.default();
    const info = payload?.data ?? payload;
    return info && typeof info === 'object' && typeof info.id === 'string' ? info : null;
  } catch (error) {
    const refusal = getTrustRefusal(error);
    if (refusal) throw refusal;
    return null;
  }
}

export async function getConfiguredSmallModelRef(client) {
  try {
    const { model } = (await client.agent.get({ agentID: 'title' })).data;
    if (!model) return null;
    const ref = { providerID: model.providerID, modelID: model.id };
    const variant = asNonEmptyString(model.variant);
    if (variant) ref.variant = variant;
    return ref;
  } catch (error) {
    const refusal = getTrustRefusal(error);
    if (refusal) throw refusal;
    return null;
  }
}

export function findModelInfo(models, providerID, modelID) {
  const ofProvider = models.filter((model) => model?.providerID === providerID);
  return ofProvider.find((model) => model.id === modelID)
    ?? ofProvider.find((model) => model.modelID === modelID)
    ?? null;
}

/** @param {string | null} directory */
export async function readOpenCodeCatalog(directory) {
  const client = getSmallModelClient(directory);
  if (!client) throw new Error('OpenCode on this computer is not running');
  const [providers, models] = await Promise.all([client.provider.list(), client.model.list()]);
  if (!Array.isArray(providers?.data) || !Array.isArray(models?.data)) throw new Error('OpenCode answered no provider list');
  return { providers: providers.data, models: models.data };
}
