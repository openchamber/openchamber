
import { readBoundedResponseText } from '../shared/response-body.js';
import { isString } from '../shared/object-guards.js';

export interface ModelsMetadataOptions {
  url?: string;
  ttlMs?: number;
  timeoutMs?: number;
}
export type ModelsMetadataCatalog = object;

const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;

// The models.dev catalog is several megabytes; the cap is generous on purpose
// (16 MiB): the deadline bounds time, the cap bounds memory, and an over-cap
// body throws like a fetch failure so the stale-cache fallback applies.
export const MODELS_DEV_CATALOG_MAX_BYTES = 16 * 1024 * 1024;

let cachedMetadata: ModelsMetadataCatalog | null = null;
let cachedAt = 0;
let inflight: Promise<ModelsMetadataCatalog> | null = null;

const fetchCatalog = async (url: string, timeoutMs: number) => {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`models.dev responded with status ${response.status}`);
  }
  const bounded = await readBoundedResponseText(response, MODELS_DEV_CATALOG_MAX_BYTES);
  if (bounded.tooLarge) {
    throw new Error('models.dev response exceeded size limit');
  }
  let metadata;
  try {
    metadata = JSON.parse(bounded.text);
  } catch {
    throw new Error('models.dev returned invalid JSON');
  }
  if (!isCatalog(metadata)) {
    throw new Error('models.dev returned an unexpected payload');
  }
  return metadata;
};

export async function getModelsMetadata({
  url = MODELS_DEV_API_URL,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ModelsMetadataOptions = {}) {
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

/**
 * The catalog this process already holds (fresh or stale), or null when it
 * has not fetched one yet. Never fetches and never waits: latency-critical
 * readers (the provider off-state route, which provider loading awaits)
 * enrich from this copy only, so models.dev availability cannot stall them.
 */
export function peekModelsMetadata() {
  return cachedMetadata;
}

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
] as const;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCatalog = (value: unknown): value is ModelsMetadataCatalog => Boolean(value && typeof value === 'object');

export interface ClientModelMetadata {
  id?: unknown;
  name?: unknown;
  tool_call?: unknown;
  reasoning?: unknown;
  temperature?: unknown;
  attachment?: unknown;
  structured_output?: unknown;
  modalities?: unknown;
  cost?: unknown;
  limit?: unknown;
  knowledge?: unknown;
  release_date?: unknown;
  last_updated?: unknown;
}
export type ClientModelsMetadata = Record<string, { id?: string; models: Record<string, ClientModelMetadata> }>;
const projections = new WeakMap<object, ClientModelsMetadata>();

export function toClientModelsMetadata<Metadata>(metadata: Metadata) {
  if (!isObject(metadata)) return {};
  const cached = projections.get(metadata);
  if (cached) return cached;
  const result: ClientModelsMetadata = {};
  for (const [providerKey, provider] of Object.entries(metadata)) {
    if (!isObject(provider) || !isObject(provider.models)) continue;
    const models: Record<string, ClientModelMetadata> = {};
    for (const [modelKey, model] of Object.entries(provider.models)) {
      if (!isObject(model)) continue;
      const projected: ClientModelMetadata = {};
      for (const field of CLIENT_MODEL_FIELDS) {
        if (model[field] !== undefined) projected[field] = model[field];
      }
      models[modelKey] = projected;
    }
    result[providerKey] = isString(provider.id) ? { id: provider.id, models } : { models };
  }
  projections.set(metadata, result);
  return result;
}
