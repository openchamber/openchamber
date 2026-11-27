import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import nodePath from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { getModelsMetadata } from './models-metadata.js';
import { toModelModalities } from './model-modalities.js';
import type { IncomingMessage, ClientRequest } from 'node:http';
import type { JsonValue } from '../shared/json-values.js';
import type {} from './dependency-contracts.js';

export type DiscoveredModelLimit = { context?: number; output?: number };
export type DiscoveredModelCapabilities = { tools?: boolean; input?: string[]; output?: string[] };
export type DiscoveredModelMetadata = {
  providerID: string;
  modelID: string;
  name?: string;
  limit?: DiscoveredModelLimit;
  capabilities?: DiscoveredModelCapabilities;
};
export type DiscoveredModel = {
  id: string;
  name: string;
  limit?: DiscoveredModelLimit;
  capabilities?: DiscoveredModelCapabilities;
  metadataMatch?: 'exact' | 'ambiguous' | 'none' | 'unavailable';
  metadata?: DiscoveredModelMetadata;
  metadataCandidates?: DiscoveredModelMetadata[];
};
export type ProviderModelDiscoveryResult = {
  models: DiscoveredModel[];
  enrichment: { requested: boolean; available: boolean; stale?: boolean };
};
export interface ClientCertificate {
  cert: string;
  key: string;
  passphrase?: string;
}
export interface DiscoveryRequestInit {
  method: 'GET';
  headers: Record<string, string>;
  redirect: 'manual';
  signal: AbortSignal;
}
interface DiscoveryHeaders {
  Accept: string;
  [name: string]: string;
}
export interface DiscoverProviderModelsOptions {
  storedApiKey?: unknown;
  storedBaseURL?: unknown;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  fetchWithClientCertificate?: (url: URL, init: DiscoveryRequestInit, certificate: ClientCertificate) => Promise<Response>;
  getModelsMetadata?: () => Promise<{ metadata: object; stale?: boolean }>;
}
const hasFetchErrorFields = (value: unknown): value is { cause?: unknown } => value != null;
const fetchErrorFields = <Value>(value: Value) => hasFetchErrorFields(value) ? value : undefined;

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

const discoveryError = (message: string, statusCode = 400, code = 'invalid_request') => {
  const error: Error & { statusCode?: number; code?: string } = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const trimmedString = z.string().trim().min(1);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const stringList = z.array(z.unknown()).transform((items) => items.filter((item): item is string => z.string().safeParse(item).success));

const requestSchema = z.object({
  baseURL: z.unknown(),
  modelsPath: z.unknown().optional(),
  apiKey: z.unknown().optional(),
  headers: z.unknown().optional(),
  tls: z.unknown().optional(),
  enrich: z.unknown().optional(),
  metadataProviderID: z.unknown().optional(),
});
const headersSchema = z.record(z.string(), z.unknown());

const providerModelSchema = z.union([
  trimmedString.transform((id) => ({ id })),
  z.object({
    id: trimmedString,
    name: z.unknown().optional(),
    limit: z.object({ context: z.unknown().optional(), output: z.unknown().optional() }).passthrough().optional().catch(undefined),
    context_window: z.unknown().optional(),
    contextWindow: z.unknown().optional(),
    context_length: z.unknown().optional(),
    max_input_tokens: z.unknown().optional(),
    max_output_tokens: z.unknown().optional(),
    max_completion_tokens: z.unknown().optional(),
    maxOutputTokens: z.unknown().optional(),
    modalities: z.object({ input: z.unknown().optional(), output: z.unknown().optional() }).passthrough().optional().catch(undefined),
    input_modalities: z.array(z.unknown()).optional().catch(undefined),
    supports_tool_call: z.unknown().optional(),
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

const firstPositive = <Value>(...values: Value[]) => {
  for (const value of values) {
    const parsed = positiveInteger.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
};
const optionalString = <Value>(value: Value) => {
  const parsed = trimmedString.safeParse(value);
  return parsed.success ? parsed.data : null;
};
const optionalStringList = <Value>(value: Value) => {
  const parsed = stringList.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
const optionalBoolean = <Value>(value: Value) => {
  const parsed = z.boolean().safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const buildLimit = (context: number | undefined, output: number | undefined) => {
  if (!context && !output) return undefined;
  const limit: DiscoveredModelLimit = {};
  if (context) limit.context = context;
  if (output) limit.output = output;
  return limit;
};

const buildCapabilities = (input: string[] | undefined, output: string[] | undefined, tools: boolean | undefined) => {
  if (!input && !output && tools === undefined) return undefined;
  const capabilities: DiscoveredModelCapabilities = {};
  withOptional(capabilities, 'tools', tools);
  withOptional(capabilities, 'input', input === undefined ? undefined : toModelModalities(input));
  withOptional(capabilities, 'output', output === undefined ? undefined : toModelModalities(output));
  return capabilities;
};

const withOptional = <Target, Key extends keyof Target>(target: Target, key: Key, value: Target[Key]) => {
  if (value !== undefined) target[key] = value;
  return target;
};

const resolveEnvReference = (value: string, env: NodeJS.ProcessEnv) => {
  const match = value.match(ENV_REFERENCE);
  if (!match) return value;
  const name = (match[1] ?? '').trim();
  if (!name || !env[name]) throw discoveryError(`Environment variable ${name || '(empty)'} is not set`, 400, 'credential_unavailable');
  return env[name];
};

const resolveApiKey = <Value>(value: Value, env: NodeJS.ProcessEnv) => {
  const key = optionalString(value);
  return key ? resolveEnvReference(key, env) : null;
};

const FILE_REFERENCE = /^\{file:([^}]+)\}$/;

const hasTlsText = (value: unknown): value is string => trimmedString.safeParse(value).success;

const resolveTlsValue = async <Value>(value: Value, env: NodeJS.ProcessEnv, field: string) => {
  if (!hasTlsText(value)) return undefined;
  const text = value.trim();
  const file = text.match(FILE_REFERENCE)?.[1]?.trim();
  if (!file) return ENV_REFERENCE.test(text) ? resolveEnvReference(text, env) : value;
  const filePath = file.startsWith('~/') ? nodePath.join(os.homedir(), file.slice(2)) : file;
  try {
    return (await fs.readFile(filePath, 'utf8')).trim();
  } catch {
    throw discoveryError(`Cannot read the client certificate ${field} file ${file}`, 400, 'client_certificate');
  }
};

const tlsSchema = z.object({ cert: z.unknown(), key: z.unknown(), passphrase: z.unknown().optional() });

const resolveClientCertificate = async <Value>(value: Value, env: NodeJS.ProcessEnv) => {
  if (value === undefined || value === null) return null;
  const parsed = tlsSchema.safeParse(value);
  if (!parsed.success) throw discoveryError('Client certificate settings must be an object');
  const cert = await resolveTlsValue(parsed.data.cert, env, 'certificate');
  const key = await resolveTlsValue(parsed.data.key, env, 'key');
  if (!cert || !key) throw discoveryError('A client certificate needs both the certificate and the key', 400, 'client_certificate');
  const passphrase = await resolveTlsValue(parsed.data.passphrase, env, 'passphrase');
  const certificate: ClientCertificate = { cert, key };
  if (passphrase) certificate.passphrase = passphrase;
  return certificate;
};

const fetchWithClientCertificate = (url: URL, init: DiscoveryRequestInit, certificate: ClientCertificate) => new Promise<Response>((resolve, reject) => {
  let request: ClientRequest;
  try {
    request = https.request(url, { method: 'GET', headers: init.headers, signal: init.signal, agent: false, ...certificate }, onResponse);
  } catch (error) {
    reject(discoveryError(
      `The client certificate cannot be used: ${error instanceof Error ? error.message : String(error)}. Check that both files are PEM and that the passphrase matches the key.`,
      400,
      'client_certificate',
    ));
    return;
  }
  function onResponse(response: IncomingMessage) {
    const status = response.statusCode ?? 502;
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const bodyless = status === 204 || status === 205 || status === 304;
    if (bodyless) response.resume();
    resolve(new Response(bodyless ? null : Readable.toWeb(response), { status, headers }));
  }
  request.on('error', (error) => reject(discoveryError(`Provider model endpoint failed: ${error.message}`, 502, 'provider_error')));
  request.end();
});

const resolveHeaderValue = <Value>(value: Value, env: NodeJS.ProcessEnv, name: string) => {
  const headerValue = optionalString(value);
  if (!headerValue) throw discoveryError(`Header "${name}" requires a value`);
  return resolveEnvReference(headerValue, env);
};

const buildModelsUrl = <Base, ModelsPath = string>(baseURL: Base, modelsPath: ModelsPath | string = '/models') => {
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

const buildHeaders = <HeadersInput>(headers: HeadersInput, apiKey: string | null | undefined, env: NodeJS.ProcessEnv = process.env) => {
  const result: DiscoveryHeaders = { Accept: 'application/json' };
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

const readBoundedJson = async (response: Response, maxBytes: number) => {
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
    const value: JsonValue = JSON.parse(new TextDecoder().decode(bytes));
    return value;
  } catch {
    throw discoveryError('Provider returned invalid JSON', 502, 'invalid_provider_response');
  }
};

const normalizeProviderModel = <Value>(value: Value) => {
  const parsed = providerModelSchema.safeParse(value);
  if (!parsed.success) return null;
  const raw: Extract<z.infer<typeof providerModelSchema>, { name?: unknown }> = parsed.data;
  const model: DiscoveredModel = { id: raw.id, name: optionalString(raw.name) ?? raw.id };
  withOptional(model, 'limit', buildLimit(
    firstPositive(raw.limit?.context, raw.context_window, raw.contextWindow, raw.context_length, raw.max_input_tokens),
    firstPositive(raw.limit?.output, raw.max_output_tokens, raw.max_completion_tokens, raw.maxOutputTokens),
  ));
  withOptional(model, 'capabilities', buildCapabilities(
    optionalStringList(raw.capabilities?.input) ?? optionalStringList(raw.modalities?.input) ?? optionalStringList(raw.input_modalities),
    optionalStringList(raw.capabilities?.output) ?? optionalStringList(raw.modalities?.output),
    optionalBoolean(raw.capabilities?.tools) ?? optionalBoolean(raw.supports_tool_call),
  ));
  return model;
};

const normalizeProviderResponse = <Payload>(payload: Payload) => {
  const parsed = providerResponseSchema.safeParse(payload);
  if (!parsed.success) throw discoveryError('Provider response must contain a data array', 502, 'invalid_provider_response');
  const byId = new Map<string, DiscoveredModel>();
  for (const rawModel of parsed.data) {
    const model = normalizeProviderModel(rawModel);
    if (model && !byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
};

const normalizeModelId = (modelID: string) => {
  const withoutProvider = modelID.includes('/') ? modelID.slice(modelID.lastIndexOf('/') + 1) : modelID;
  return withoutProvider
    .toLowerCase()
    .replace(/[-_.](?:deployment|deploy|region|prod|production|latest)$/i, '')
    .replace(/[-_.](?:eastus|westus|us|eu|apac)\d*$/i, '');
};

export interface CatalogEntry {
  providerID: string;
  modelID: string;
  value: z.infer<typeof catalogModelSchema>;
}

const modelEntries = <Catalog>(catalog: Catalog) => {
  const parsedCatalog = catalogSchema.safeParse(catalog);
  if (!parsedCatalog.success) return [];
  const entries: CatalogEntry[] = [];
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

const metadataFromCatalogEntry = (entry: CatalogEntry) => {
  const metadata: DiscoveredModelMetadata = { providerID: entry.providerID, modelID: entry.modelID };
  withOptional(metadata, 'name', optionalString(entry.value.name) ?? undefined);
  withOptional(metadata, 'limit', buildLimit(firstPositive(entry.value.limit?.context), firstPositive(entry.value.limit?.output)));
  withOptional(metadata, 'capabilities', buildCapabilities(
    optionalStringList(entry.value.modalities?.input),
    optionalStringList(entry.value.modalities?.output),
    optionalBoolean(entry.value.tool_call),
  ));
  return metadata;
};

const enrichModels = <Catalog>(models: DiscoveredModel[], catalog: Catalog, metadataProviderID: string): DiscoveredModel[] => {
  const entries = modelEntries(catalog);
  return models.map((model) => {
    const exactProviderMatches = metadataProviderID
      ? entries.filter((entry) => entry.providerID === metadataProviderID && entry.modelID === model.id)
      : [];
    const exactModelMatches = exactProviderMatches.length > 0
      ? exactProviderMatches
      : entries.filter((entry) => entry.modelID === model.id);
    const exactMatch = exactModelMatches[0];
    if (exactModelMatches.length === 1 && exactMatch) {
      return { ...model, metadata: metadataFromCatalogEntry(exactMatch), metadataMatch: 'exact' };
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

const endpointKey = <Value>(value: Value) => {
  try {
    const url = new URL(String(value ?? '').trim());
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
};

const isSameEndpoint = <Left, Right>(left: Left, right: Right) => {
  const leftKey = endpointKey(left);
  return leftKey !== null && leftKey === endpointKey(right);
};

export async function discoverProviderModels<Input>(input: Input, options: DiscoverProviderModelsOptions = {}): Promise<ProviderModelDiscoveryResult> {
  const request = requestSchema.safeParse(input);
  if (!request.success) throw discoveryError('Request body is required');
  const body = request.data;
  const endpoint = buildModelsUrl(body.baseURL, body.modelsPath);
  const env = options.env ?? process.env;
  const requestedApiKey = resolveApiKey(body.apiKey, env);
  const storedApiKey = isSameEndpoint(options.storedBaseURL, body.baseURL)
    ? optionalString(options.storedApiKey)
    : null;
  const apiKey = requestedApiKey ?? resolveApiKey(storedApiKey, env);
  const certificate = endpoint.protocol === 'https:' ? await resolveClientCertificate(body.tls, env) : null;
  const init: DiscoveryRequestInit = {
    method: 'GET',
    headers: buildHeaders(body.headers, apiKey, env),
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
  const response = certificate
    ? await (options.fetchWithClientCertificate ?? fetchWithClientCertificate)(endpoint, init, certificate)
    : await (options.fetch ?? fetch)(endpoint, init).catch((error) => {
       const cause = fetchErrorFields(error)?.cause;
       const reason = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
      throw discoveryError(`Provider model endpoint failed: ${reason}`, 502, 'provider_error');
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

export const modelDiscoveryInternals = { buildModelsUrl, buildHeaders, normalizeProviderResponse, enrichModels, resolveClientCertificate };
