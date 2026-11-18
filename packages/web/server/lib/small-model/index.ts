import fs from 'fs';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'os';
import path from 'path';
import type { JsonValue, ModelInfo } from '@opencode/client';
import type { SmallModelRef } from './client.js';
import type { ForwardedGenerationInput } from './contracts.js';
import { readMergedSettingsSync } from '../settings/settings-files.js';
import { asNonEmptyString } from '../shared/guards.js';
import {
  findModelInfo,
  getConfiguredSmallModelRef,
  getDefaultModelInfo,
  getSmallModelClient,
  getTrustRefusal,
  listModelInfos,
  listProviderInfos,
} from './client.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export interface GenerationOptions {
  prompt: unknown;
  system?: unknown;
  maxOutputTokens?: unknown;
  model?: unknown;
  variant?: unknown;
  directory?: unknown;
  preferredProviderID?: unknown;
  preferredModelID?: unknown;
  responseSchema?: JsonValue | undefined;
  timeoutMs?: unknown;
  signal?: AbortSignal | undefined;
  onOverflow?: 'truncate' | 'error';
  sessionID?: string | undefined;
}

export interface ModelLimits {
  contextTokens: number;
  outputTokenLimit: number | null;
}

export interface DescribeOptions {
  directory?: unknown;
  preferredProviderID?: unknown;
  preferredModelID?: unknown;
  outputReserveTokens?: number | ((limits: ModelLimits) => number) | undefined;
  overrideModel?: unknown;
  overrideVariant?: unknown;
}

interface ResolutionOptions {
  client: NonNullable<ReturnType<typeof getSmallModelClient>>;
  directory: string | undefined;
  model?: unknown;
  variant?: unknown;
  preferredProviderID?: unknown;
  preferredModelID?: unknown;
}

interface ResolvedModel {
  providerID: unknown;
  modelID: unknown;
  variant?: string;
  source: 'request' | 'settings' | 'config' | 'session-model' | 'session-provider-small' | 'default';
}

export interface GeneratedTextResult {
  text: string;
  providerID: unknown;
  modelID: unknown;
  source: ResolvedModel['source'];
  inputTruncated?: true;
}

type TextModelCandidate = Partial<Omit<ModelInfo, 'id'>> & { id: unknown };

const isString = (value: unknown): value is string => typeof value === 'string';
const hasCatalogErrorFields = (value: unknown): value is {
  _tag?: unknown;
  providerID?: unknown;
  modelID?: unknown;
  service?: unknown;
} => value !== null && value !== undefined;
const hasProviderFields = (value: unknown): value is { providerID?: unknown; settings?: unknown } =>
  value !== null && value !== undefined;
const hasAPIKey = (value: unknown): value is { apiKey?: unknown } =>
  value !== null && value !== undefined;

const TIMEOUT_PER_TOKEN_MS = 40;
const TIMEOUT_MAX_MS = 900_000;

export const generationBudgetMs = (promptChars: number) => Math.min(
  TIMEOUT_MAX_MS,
  DEFAULT_TIMEOUT_MS + Math.max(0, Math.ceil(Number(promptChars) / 4)) * TIMEOUT_PER_TOKEN_MS,
);

const UNAVAILABLE_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000];
let unavailableRetryDelaysMs = UNAVAILABLE_RETRY_DELAYS_MS;

const isCatalogNotReady = (cause: unknown, model: ResolvedModel) => hasCatalogErrorFields(cause) && (
  (cause?._tag === 'ModelNotFoundError'
    && cause.providerID === model.providerID && cause.modelID === model.modelID)
  || (cause?._tag === 'ServiceUnavailableError' && cause.service === 'plugin')
);

export const setUnavailableRetryDelaysForTest = (delays = UNAVAILABLE_RETRY_DELAYS_MS) => {
  unavailableRetryDelaysMs = delays;
};

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

const readSmallModelSettingsOverride = () => {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: OPENCHAMBER_SETTINGS_FILE });
  if (settings.smallModelUseDefault !== false) return null;
  const model = parseModelRef(asNonEmptyString(settings.smallModelOverride));
  if (!model) return null;
  const variant = asNonEmptyString(settings.smallModelVariant);
  if (variant) model.variant = variant;
  return model;
};

export function parseModelRef(value: string | null | undefined): SmallModelRef | null {
  if (!isString(value)) return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

const resolveModelVariant = (modelInfo: ModelInfo | null, variant: string | undefined) => {
  const normalized = asNonEmptyString(variant);
  if (!normalized) return undefined;
  if (!modelInfo) return normalized;
  const variants = Array.isArray(modelInfo.variants) ? modelInfo.variants : [];
  return variants.some((entry) => entry?.id === normalized) ? normalized : undefined;
};

const DEFAULT_CONTEXT_TOKENS = 64_000;
const OUTPUT_RESERVE_TOKENS = 4_000;

export const getModelInputCharBudget = ({ modelInfo, outputReserveTokens }: {
  modelInfo: ModelInfo | null;
  outputReserveTokens?: number | undefined;
}) => {
  const context = Number(modelInfo?.limit?.context);
  const known = context > 0;
  const contextTokens = known ? context : DEFAULT_CONTEXT_TOKENS;
  const reserve = Number(outputReserveTokens) > 0 ? Number(outputReserveTokens) : OUTPUT_RESERVE_TOKENS;
  const inputBudgetTokens = Math.max(1_000, contextTokens - reserve);
  return { maxChars: inputBudgetTokens * 4, contextTokens, contextKnown: known };
};

const resolveOutputTokens = ({ modelInfo, maxOutputTokens }: {
  modelInfo: ModelInfo | null;
  maxOutputTokens: unknown;
}) => {
  const requested = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : 0;
  if (!requested) return undefined;
  const limit = Number(modelInfo?.limit?.output);
  return limit > 0 ? Math.min(requested, limit) : requested;
};

const clampPromptToModelLimit = ({ prompt, modelInfo, providerID, modelID, onOverflow, outputReserveTokens }: {
  prompt: string;
  modelInfo: ModelInfo | null;
  providerID: unknown;
  modelID: unknown;
  onOverflow: GenerationOptions['onOverflow'];
  outputReserveTokens: number | undefined;
}) => {
  const { maxChars } = getModelInputCharBudget({ modelInfo, outputReserveTokens });
  if (prompt.length <= maxChars) {
    return { prompt, truncated: false };
  }
  if (onOverflow === 'error') {
    throw Object.assign(
      new Error(`Input is too large for ${providerID}/${modelID}: ${prompt.length} characters exceeds the ${maxChars} the model's context allows`),
      { statusCode: 413, code: 'context-too-small', providerID, modelID, requiredChars: prompt.length, availableChars: maxChars },
    );
  }
  return { prompt: `${prompt.slice(0, maxChars)}…`, truncated: true };
};

const noClientError = () => Object.assign(
  new Error('No small model available — OpenCode is not reachable'),
  { statusCode: 404 },
);

export const SMALL_MODEL_TIER_PRIORITY = ['flash-lite', 'flash', 'luna', 'haiku'];

export const smallModelTierOf = (model: Pick<TextModelCandidate, 'family' | 'id'> | null | undefined) => {
  const name = `${model?.family ?? ''} ${model?.id ?? ''}`.toLowerCase().replaceAll('_', '-');
  return SMALL_MODEL_TIER_PRIORITY.find((tier) => name.includes(tier)) ?? null;
};

export const pickSmallModelInProvider = <ProviderID>(models: ModelInfo[], providerID: ProviderID) => pickSmallModel(models, (model) => model.providerID === providerID);

const ZEN_ANONYMOUS_API_KEY = 'public';
const isAnonymousZenModel = (model: unknown): model is { providerID: 'opencode'; settings: { apiKey: 'public' } } => {
  if (!hasProviderFields(model) || model.providerID !== 'opencode') return false;
  const settings = model.settings;
  return hasAPIKey(settings) && settings.apiKey === ZEN_ANONYMOUS_API_KEY;
};

const isUsableTextModel = (model: TextModelCandidate) => model.enabled !== false
  && !isAnonymousZenModel(model)
  && (model.status === undefined || model.status === 'active')
  && (model.capabilities?.input ?? ['text']).some((item) => String(item).startsWith('text'))
  && (model.capabilities?.output ?? ['text']).some((item) => String(item).startsWith('text'));

const pickSmallModel = (models: ModelInfo[], accept: (model: ModelInfo) => boolean) => {
  const candidates = models
    .filter((model) => model && accept(model) && isUsableTextModel(model))
    .sort((a, b) => (Number(b.time?.released) || 0) - (Number(a.time?.released) || 0));
  for (const tier of SMALL_MODEL_TIER_PRIORITY) {
    const found = candidates.find((model) => smallModelTierOf(model) === tier);
    if (found) return { providerID: found.providerID, modelID: found.id };
  }
  return null;
};

const resolveSmallModel = async ({ client, directory, model, variant, preferredProviderID, preferredModelID }: ResolutionOptions): Promise<ResolvedModel | null> => {
  const models = await listModelInfos(client, directory);
  const isCallable = ({ providerID, modelID }: { providerID: unknown; modelID: unknown }) => !isAnonymousZenModel(findModelInfo(models, providerID, modelID));

  const explicit = parseModelRef(isString(model) ? model : undefined);
  if (explicit && isCallable(explicit)) {
    const explicitVariant = asNonEmptyString(variant);
    if (explicitVariant) explicit.variant = explicitVariant;
    return { ...explicit, source: 'request' };
  }

  const fromSettings = readSmallModelSettingsOverride();
  if (fromSettings && isCallable(fromSettings)) return { ...fromSettings, source: 'settings' };

  const fromConfig = await getConfiguredSmallModelRef(client);
  if (fromConfig) {
    const info = findModelInfo(models, fromConfig.providerID, fromConfig.modelID);
    if (info?.enabled !== false && isCallable(fromConfig)) return { ...fromConfig, source: 'config' };
  }

  if (preferredProviderID) {
    if (preferredModelID) {
      const sessionModel = findModelInfo(models, preferredProviderID, preferredModelID) ?? { id: preferredModelID };
      if (smallModelTierOf(sessionModel) && isUsableTextModel(sessionModel)) {
        return { providerID: preferredProviderID, modelID: preferredModelID, source: 'session-model' };
      }
    }
    const small = pickSmallModelInProvider(models, preferredProviderID);
    if (small) return { ...small, source: 'session-provider-small' };
    if (preferredModelID && isCallable({ providerID: preferredProviderID, modelID: preferredModelID })) {
      return { providerID: preferredProviderID, modelID: preferredModelID, source: 'session-model' };
    }
  }

  const fallback = await getDefaultModelInfo(client);
  if (!fallback || isAnonymousZenModel(fallback)) return null;
  if (preferredProviderID && (hasProviderFields(fallback) ? fallback.providerID : undefined) !== preferredProviderID) return null;
  return { providerID: hasProviderFields(fallback) ? fallback.providerID : undefined, modelID: fallback.id, source: 'default' };
};

const LOCAL_NETWORKS = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 32], ['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10]] satisfies [string, number][]) {
  LOCAL_NETWORKS.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] satisfies [string, number][]) {
  LOCAL_NETWORKS.addSubnet(address, prefix, 'ipv6');
}
const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.lan', '.internal', '.home.arpa'];

const isLocalModelEndpoint = (modelInfo: ModelInfo | null) => {
  const endpoint = modelInfo?.settings?.baseURL ?? modelInfo?.settings?.endpoint;
  if (!isString(endpoint) || !endpoint) return false;
  let host;
  try {
    host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  const family = net.isIP(host);
  if (family) return LOCAL_NETWORKS.check(host, family === 6 ? 'ipv6' : 'ipv4');
  return host === 'localhost' || !host.includes('.') || LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
};

const JSON_FENCE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;

const buildSchemaInstruction = (responseSchema: JsonValue) =>
  `Reply with JSON matching this schema and nothing else: ${JSON.stringify(responseSchema)}`;

const extractJsonText = (raw: string) => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fenced = JSON_FENCE.exec(trimmed);
  const candidate = (fenced ? fenced[1] ?? '' : trimmed).trim();
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
};

const requestOptions = ({ timeoutMs, promptChars, signal }: {
  timeoutMs: unknown;
  promptChars: number;
  signal: AbortSignal | undefined;
}) => {
  const budgetMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : generationBudgetMs(promptChars);
  const deadline = AbortSignal.timeout(budgetMs);
  return {
    budgetMs,
    deadline,
    signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
  };
};

export async function generateSmallModelText({ prompt, system, maxOutputTokens, model, variant: requestVariant, directory: rawDirectory, preferredProviderID, preferredModelID, responseSchema, timeoutMs, signal, onOverflow = 'truncate' }: GenerationOptions) {
  if (!isString(prompt) || !prompt.trim()) {
    throw Object.assign(new Error('prompt is required'), { statusCode: 400 });
  }

  const directory = isString(rawDirectory) ? rawDirectory : undefined;
  const client = getSmallModelClient(directory);
  if (!client) throw noClientError();

  const resolved = await resolveSmallModel({
    client,
    directory,
    model,
    variant: requestVariant,
    preferredProviderID,
    preferredModelID,
  });

  if (!resolved) {
    throw Object.assign(
      new Error(preferredProviderID
        ? 'No small model available within the session provider'
        : 'No small model available — OpenCode reports no default model'),
      { statusCode: 404 },
    );
  }

  const models = await listModelInfos(client, directory);
  const modelInfo = findModelInfo(models, resolved.providerID, resolved.modelID);
  const variant = resolveModelVariant(modelInfo, resolved.variant);

  const outputTokens = resolveOutputTokens({ modelInfo, maxOutputTokens });

  const clamped = clampPromptToModelLimit({
    prompt: prompt.trim(),
    modelInfo,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    onOverflow,
    outputReserveTokens: outputTokens,
  });

  const sections = [];
  if (isString(system) && system.trim()) sections.push(system.trim());
  sections.push(clamped.prompt);
  if (responseSchema) sections.push(buildSchemaInstruction(responseSchema));
  const fullPrompt = sections.join('\n\n');

  const generationOptions = requestOptions({ timeoutMs, promptChars: fullPrompt.length, signal });
  const unavailableMessage = `Model unavailable: ${resolved.providerID}/${resolved.modelID}`;

  const deadlineError = (cause: unknown) => Object.assign(
    new Error(`${resolved.providerID}/${resolved.modelID} did not finish within the ${Math.round(generationOptions.budgetMs / 1000)}s budget for this prompt size`, { cause }),
    { statusCode: 504, code: 'generation-timeout', providerID: resolved.providerID, modelID: resolved.modelID },
  );

  const send = async () => {
    const model: NonNullable<ForwardedGenerationInput['model']> = { id: resolved.modelID, providerID: resolved.providerID };
    if (variant) model.variant = variant;
    const result = await client.experimental.generate.text(
      { prompt: fullPrompt, model },
      generationOptions,
    );
    return isString(result?.text) ? result.text : '';
  };

  const sendWithCatalogRetry = async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        if (generationOptions.deadline.aborted) throw deadlineError(error);
        const refusal = getTrustRefusal(error);
        if (refusal) throw refusal;
        if (!isCatalogNotReady(error, resolved)) throw error;
        if (attempt < unavailableRetryDelaysMs.length) {
          await delay(unavailableRetryDelaysMs[attempt], undefined, { signal: generationOptions.signal })
            .catch((delayError) => {
              throw generationOptions.deadline.aborted ? deadlineError(delayError) : delayError;
            });
          continue;
        }
        throw Object.assign(new Error(unavailableMessage), {
          statusCode: 503,
          code: 'small-model-unavailable',
        });
      }
    }
  };

  let text = await sendWithCatalogRetry();

  if (responseSchema) {
    let json = extractJsonText(text);
    if (json === null) {
      text = await sendWithCatalogRetry();
      json = extractJsonText(text);
    }
    if (json === null) {
      throw Object.assign(
        new Error(`${resolved.providerID}/${resolved.modelID} did not return JSON matching the requested schema`),
        { statusCode: 422, code: 'structured-output-unsupported', providerID: resolved.providerID, modelID: resolved.modelID },
      );
    }
    text = json;
  }

  const result: GeneratedTextResult = {
    text: text.trim(),
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    source: resolved.source,
  };
  if (clamped.truncated) result.inputTruncated = true;
  return result;
}

export async function listAuthenticatedProviders(directory?: string | null) {
  const client = getSmallModelClient(directory);
  if (!client) return [];
  try {
    const [providers, models] = await Promise.all([
      listProviderInfos(client),
      listModelInfos(client, directory),
    ]);
    const enabled = new Set<string>();
    for (const model of models) {
      if (model?.enabled === false || isAnonymousZenModel(model)) continue;
      if (isString(model?.providerID) && model.providerID) enabled.add(model.providerID);
    }
    const ids = new Set<string>();
    for (const provider of providers) {
      if (isString(provider?.id) && enabled.has(provider.id)) ids.add(provider.id);
    }
    for (const id of enabled) ids.add(id);
    return Array.from(ids);
  } catch (error) {
    const refusal = getTrustRefusal(error);
    if (refusal) throw refusal;
    return [];
  }
}

const isReserveResolver = (value: DescribeOptions['outputReserveTokens']): value is (limits: ModelLimits) => number =>
  typeof value === 'function';

const resolveReserveTokens = (outputReserveTokens: DescribeOptions['outputReserveTokens'], limits: ModelLimits) => (
  isReserveResolver(outputReserveTokens) ? outputReserveTokens(limits) : outputReserveTokens
);

export async function describeSmallModel({ directory: rawDirectory, preferredProviderID, preferredModelID, outputReserveTokens, overrideModel, overrideVariant }: DescribeOptions = {}) {
  const directory = isString(rawDirectory) ? rawDirectory : undefined;
  const client = getSmallModelClient(directory);
  if (!client) return null;

  const resolved = await resolveSmallModel({
    client,
    directory,
    model: overrideModel,
    variant: overrideVariant,
    preferredProviderID,
    preferredModelID,
  });
  if (!resolved) return null;

  const models = await listModelInfos(client, directory);
  const modelInfo = findModelInfo(models, resolved.providerID, resolved.modelID);
  const variant = resolveModelVariant(modelInfo, resolved.variant);
  const outputTokenLimit = Number(modelInfo?.limit?.output) > 0 ? Number(modelInfo?.limit?.output) : null;

  const { contextTokens, contextKnown } = getModelInputCharBudget({ modelInfo });
  const reserveTokens = resolveReserveTokens(outputReserveTokens, { contextTokens, outputTokenLimit });
  const { maxChars } = getModelInputCharBudget({ modelInfo, outputReserveTokens: reserveTokens });

  const hasLogin = modelInfo ? modelInfo.enabled !== false : true;

  return {
    ...resolved,
    variant,
    hasLogin,
    localEndpoint: isLocalModelEndpoint(modelInfo),
    inputCharBudget: maxChars,
    contextTokens,
    contextKnown,
    outputTokens: Number(reserveTokens) > 0 ? Number(reserveTokens) : null,
    structuredOutput: null,
    outputTokenLimit,
  };
}
