const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;

// Shared in-process cache of the models.dev catalog. Used by the
// /api/openchamber/models-metadata route and the small-model resolver so the
// server fetches the catalog once, not per consumer.
let cachedMetadata = null;
let cachedAt = 0;
let inflight = null;

const fetchCatalog = async (url, timeoutMs) => {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`models.dev responded with status ${response.status}`);
  }
  const metadata = await response.json();
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('models.dev returned an unexpected payload');
  }
  return metadata;
};

/**
 * Returns the models.dev catalog, serving the in-memory copy while fresh.
 * On fetch failure a stale cached copy is returned when available; otherwise
 * the error propagates.
 */
export async function getModelsMetadata({
  url = MODELS_DEV_API_URL,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const now = Date.now();
  if (cachedMetadata && now - cachedAt < ttlMs) {
    return { metadata: cachedMetadata, fromCache: true };
  }

  if (!inflight) {
    inflight = fetchCatalog(url, timeoutMs).finally(() => {
      inflight = null;
    });
  }

  try {
    const metadata = await inflight;
    cachedMetadata = metadata;
    cachedAt = Date.now();
    return { metadata, fromCache: false };
  } catch (error) {
    if (cachedMetadata) {
      return { metadata: cachedMetadata, fromCache: true, stale: true };
    }
    throw error;
  }
}

// The model fields the UI reads (packages/ui stores/useConfigStore.ts,
// transformModelsDevResponse). The full catalog is several megabytes; the
// browser needs only these, so the route sends nothing else.
const CLIENT_MODEL_FIELDS = [
  'id',
  'name',
  'tool_call',
  'reasoning',
  'temperature',
  'attachment',
  'structured_output',
  'modalities',
  'cost',
  'limit',
  'knowledge',
  'release_date',
  'last_updated',
];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// The catalog object is reused until the next fetch, so its projection is too.
const projections = new WeakMap();

/** Projects the models.dev catalog to the provider ids and model fields the UI reads. */
export function toClientModelsMetadata(metadata) {
  if (!isObject(metadata)) return {};
  const cached = projections.get(metadata);
  if (cached) return cached;
  const result = {};
  for (const [providerKey, provider] of Object.entries(metadata)) {
    if (!isObject(provider) || !isObject(provider.models)) continue;
    const models = {};
    for (const [modelKey, model] of Object.entries(provider.models)) {
      if (!isObject(model)) continue;
      const projected = {};
      for (const field of CLIENT_MODEL_FIELDS) {
        if (model[field] !== undefined) projected[field] = model[field];
      }
      models[modelKey] = projected;
    }
    result[providerKey] = typeof provider.id === 'string' ? { id: provider.id, models } : { models };
  }
  projections.set(metadata, result);
  return result;
}
