import { z } from 'zod';
import { getModelsMetadata } from './models-metadata.js';

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const BLOCKED_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'host',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const ENV_REFERENCE = /^\{env:([^}]+)\}$/;

const discoveryError = (message, statusCode = 400, code = 'invalid_request') => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const trimmedString = z.string().trim().min(1);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const stringList = z.array(z.unknown()).transform((items) => items.filter((item) => z.string().safeParse(item).success));

const requestSchema = z.object({
  baseURL: z.unknown(),
  modelsPath: z.unknown().optional(),
  apiKey: z.unknown().optional(),
  headers: z.unknown().optional(),
  enrich: z.unknown().optional(),
  metadataProviderID: z.unknown().optional(),
});
const headersSchema = z.record(z.string(), z.unknown());

/** One entry of an OpenAI-style `/models` list: a bare id or an object. */
const providerModelSchema = z.union([
  trimmedString.transform((id) => ({ id })),
  z.object({
    id: trimmedString,
    name: z.unknown().optional(),
    limit: z.object({ context: z.unknown().optional(), output: z.unknown().optional() }).passthrough().optional().catch(undefined),
    context_window: z.unknown().optional(),
    contextWindow: z.unknown().optional(),
    max_output_tokens: z.unknown().optional(),
    maxOutputTokens: z.unknown().optional(),
    modalities: z.object({ input: z.unknown().optional(), output: z.unknown().optional() }).passthrough().optional().catch(undefined),
    capabilities: z.object({
      input: z.unknown().optional(),
      output: z.unknown().optional(),
      tools: z.unknown().optional(),
    }).passthrough().optional().catch(undefined),
  }).passthrough(),
]);
const providerResponseSchema = z.union([
  z.array(z.unknown()),
  z.object({ data: z.array(z.unknown()) }).passthrough().transform((payload) => payload.data),
]);

const catalogModelSchema = z.object({
  name: z.unknown().optional(),
  limit: z.object({ context: z.unknown().optional(), output: z.unknown().optional() }).passthrough().optional().catch(undefined),
  modalities: z.object({ input: z.unknown().optional(), output: z.unknown().optional() }).passthrough().optional().catch(undefined),
  tool_call: z.unknown().optional(),
}).passthrough();
const catalogProviderSchema = z.object({
  id: z.unknown().optional(),
  models: z.record(z.string(), z.unknown()),
}).passthrough();
const catalogSchema = z.record(z.string(), z.unknown());

const firstPositive = (...values) => {
  for (const value of values) {
    const parsed = positiveInteger.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
};
const optionalString = (value) => {
  const parsed = trimmedString.safeParse(value);
  return parsed.success ? parsed.data : null;
};
const optionalStringList = (value) => {
  const parsed = stringList.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
const optionalBoolean = (value) => {
  const parsed = z.boolean().safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/** `{ context, output }` with only the limits that are known, or undefined. */
const buildLimit = (context, output) => {
  if (!context && !output) return undefined;
  const limit = {};
  if (context) limit.context = context;
  if (output) limit.output = output;
  return limit;
};

/** Capabilities when anything describes them; text in and out, with tools, fills the gaps. */
const buildCapabilities = (input, output, tools) => {
  if (!input && !output && tools === undefined) return undefined;
  return { tools: tools ?? true, input: input ?? ['text'], output: output ?? ['text'] };
};

const withOptional = (target, key, value) => {
  if (value !== undefined) target[key] = value;
  return target;
};

/** `{env:NAME}` reads that variable; anything else is the literal value. */
const resolveEnvReference = (value, env) => {
  const match = value.match(ENV_REFERENCE);
  if (!match) return value;
  const name = match[1].trim();
  if (!name || !env[name]) throw discoveryError(`Environment variable ${name || '(empty)'} is not set`, 400, 'credential_unavailable');
  return env[name];
};

const resolveApiKey = (value, env) => {
  const key = optionalString(value);
  return key ? resolveEnvReference(key, env) : null;
};

const resolveHeaderValue = (value, env, name) => {
  const headerValue = optionalString(value);
  if (!headerValue) throw discoveryError(`Header "${name}" requires a value`);
  return resolveEnvReference(headerValue, env);
};

const buildModelsUrl = (baseURL, modelsPath = '/models') => {
  let base;
  try {
    base = new URL(String(baseURL));
  } catch {
    throw discoveryError('Base URL is invalid');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw discoveryError('Base URL must use http or https');
  }
  const path = z.string().safeParse(modelsPath);
  if (!path.success || !path.data.startsWith('/') || path.data.startsWith('//')) {
    throw discoveryError('Models path must start with one slash');
  }
  if (path.data.includes('?') || path.data.includes('#')) {
    throw discoveryError('Models path cannot contain a query or fragment');
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  base.pathname = `${basePath}${path.data}`.replace(/\/{2,}/g, '/');
  base.search = '';
  base.hash = '';
  return base;
};

const buildHeaders = (headers, apiKey, env = process.env) => {
  const result = { Accept: 'application/json' };
  const parsed = headers === undefined ? { success: true, data: {} } : headersSchema.safeParse(headers);
  if (!parsed.success) throw discoveryError('Headers must be an object');
  for (const [rawName, rawValue] of Object.entries(parsed.data)) {
    const name = rawName.trim();
    if (!name || BLOCKED_HEADERS.has(name.toLowerCase())) continue;
    const value = resolveHeaderValue(rawValue, env, name);
    if (/\r|\n/.test(name) || /\r|\n/.test(value)) throw discoveryError(`Header "${name}" is invalid`);
    result[name] = value;
  }
  if (apiKey) result.Authorization = `Bearer ${apiKey}`;
  return result;
};

const readBoundedJson = async (response, maxBytes) => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw discoveryError('Provider model response is too large', 502, 'response_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw discoveryError('Provider returned an empty response', 502, 'invalid_provider_response');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw discoveryError('Provider model response is too large', 502, 'response_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw discoveryError('Provider returned invalid JSON', 502, 'invalid_provider_response');
  }
};

const normalizeProviderModel = (value) => {
  const parsed = providerModelSchema.safeParse(value);
  if (!parsed.success) return null;
  const raw = parsed.data;
  const model = { id: raw.id, name: optionalString(raw.name) ?? raw.id };
  withOptional(model, 'limit', buildLimit(
    firstPositive(raw.limit?.context, raw.context_window, raw.contextWindow),
    firstPositive(raw.limit?.output, raw.max_output_tokens, raw.maxOutputTokens),
  ));
  withOptional(model, 'capabilities', buildCapabilities(
    optionalStringList(raw.capabilities?.input) ?? optionalStringList(raw.modalities?.input),
    optionalStringList(raw.capabilities?.output) ?? optionalStringList(raw.modalities?.output),
    optionalBoolean(raw.capabilities?.tools),
  ));
  return model;
};

const normalizeProviderResponse = (payload) => {
  const parsed = providerResponseSchema.safeParse(payload);
  if (!parsed.success) throw discoveryError('Provider response must contain a data array', 502, 'invalid_provider_response');
  const byId = new Map();
  for (const rawModel of parsed.data) {
    const model = normalizeProviderModel(rawModel);
    if (model && !byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
};

const normalizeModelId = (modelID) => {
  const withoutProvider = modelID.includes('/') ? modelID.slice(modelID.lastIndexOf('/') + 1) : modelID;
  return withoutProvider
    .toLowerCase()
    .replace(/[-_.](?:deployment|deploy|region|prod|production|latest)$/i, '')
    .replace(/[-_.](?:eastus|westus|us|eu|apac)\d*$/i, '');
};

const modelEntries = (catalog) => {
  const parsedCatalog = catalogSchema.safeParse(catalog);
  if (!parsedCatalog.success) return [];
  const entries = [];
  for (const [providerKey, providerValue] of Object.entries(parsedCatalog.data)) {
    const provider = catalogProviderSchema.safeParse(providerValue);
    if (!provider.success) continue;
    const providerID = optionalString(provider.data.id) ?? providerKey;
    for (const [modelID, modelValue] of Object.entries(provider.data.models)) {
      const model = catalogModelSchema.safeParse(modelValue);
      if (model.success) entries.push({ providerID, modelID, value: model.data });
    }
  }
  return entries;
};

const metadataFromCatalogEntry = (entry) => {
  const metadata = { providerID: entry.providerID, modelID: entry.modelID };
  withOptional(metadata, 'name', optionalString(entry.value.name) ?? undefined);
  withOptional(metadata, 'limit', buildLimit(firstPositive(entry.value.limit?.context), firstPositive(entry.value.limit?.output)));
  withOptional(metadata, 'capabilities', buildCapabilities(
    optionalStringList(entry.value.modalities?.input),
    optionalStringList(entry.value.modalities?.output),
    optionalBoolean(entry.value.tool_call),
  ));
  return metadata;
};

const enrichModels = (models, catalog, metadataProviderID) => {
  const entries = modelEntries(catalog);
  return models.map((model) => {
    const exactProviderMatches = metadataProviderID
      ? entries.filter((entry) => entry.providerID === metadataProviderID && entry.modelID === model.id)
      : [];
    const exactModelMatches = exactProviderMatches.length > 0
      ? exactProviderMatches
      : entries.filter((entry) => entry.modelID === model.id);
    if (exactModelMatches.length === 1) {
      return { ...model, metadata: metadataFromCatalogEntry(exactModelMatches[0]), metadataMatch: 'exact' };
    }
    const normalizedModelID = normalizeModelId(model.id);
    const suggestions = exactModelMatches.length > 1
      ? exactModelMatches
      : entries.filter((entry) => normalizeModelId(entry.modelID) === normalizedModelID);
    if (suggestions.length === 0) return { ...model, metadataMatch: 'none' };
    return {
      ...model,
      metadataMatch: 'ambiguous',
      metadataCandidates: suggestions.slice(0, 20).map(metadataFromCatalogEntry),
    };
  });
};

const endpointKey = (value) => {
  try {
    const url = new URL(String(value ?? '').trim());
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
};

const isSameEndpoint = (left, right) => {
  const leftKey = endpointKey(left);
  return leftKey !== null && leftKey === endpointKey(right);
};

export async function discoverProviderModels(input, options = {}) {
  const request = requestSchema.safeParse(input);
  if (!request.success) throw discoveryError('Request body is required');
  const body = request.data;
  const endpoint = buildModelsUrl(body.baseURL, body.modelsPath);
  const env = options.env ?? process.env;
  const requestedApiKey = resolveApiKey(body.apiKey, env);
  // The saved key goes only to the saved endpoint: a form whose base URL was
  // changed must not carry the stored credential to the new host.
  const storedApiKey = isSameEndpoint(options.storedBaseURL, body.baseURL)
    ? optionalString(options.storedApiKey)
    : null;
  const apiKey = requestedApiKey ?? storedApiKey;
  const response = await (options.fetch ?? fetch)(endpoint, {
    method: 'GET',
    headers: buildHeaders(body.headers, apiKey, env),
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    throw discoveryError('Provider model endpoint redirected', 502, 'provider_redirect');
  }
  if (!response.ok) {
    const statusCode = response.status === 401 || response.status === 403 ? 401 : 502;
    throw discoveryError(
      statusCode === 401 ? 'Provider rejected the credentials' : `Provider model endpoint responded with ${response.status}`,
      statusCode,
      statusCode === 401 ? 'provider_auth' : 'provider_error',
    );
  }
  const models = normalizeProviderResponse(await readBoundedJson(response, options.maxResponseBytes ?? MAX_RESPONSE_BYTES));
  if (body.enrich === false || models.length === 0) {
    return { models, enrichment: { requested: false, available: false } };
  }
  try {
    const { metadata, stale = false } = await (options.getModelsMetadata ?? getModelsMetadata)();
    return {
      models: enrichModels(models, metadata, optionalString(body.metadataProviderID) ?? ''),
      enrichment: { requested: true, available: true, stale },
    };
  } catch {
    return {
      models: models.map((model) => ({ ...model, metadataMatch: 'unavailable' })),
      enrichment: { requested: true, available: false },
    };
  }
}

export const modelDiscoveryInternals = { buildModelsUrl, buildHeaders, normalizeProviderResponse, enrichModels };
