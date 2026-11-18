import { z } from 'zod';
import {
  CONFIG_FILE,
  readConfigLayers,
  getConfigForPath,
  writeConfig,
} from './config-files.js';
import {
  readSectionEntry,
  writeSectionEntry,
  deleteSectionEntry,
  toModelVariants,
  toProviderEntity,
  readStoredProviderEntry,
  toProviderPackage,
} from './config-v2.js';
import { isBoolean, isRecord, isString } from '../shared/object-guards.js';
import type { OpenCodeConfigLayers } from './config-files.js';
import type { ProviderEntity, ProviderModelEntity } from './config-v2.js';

export interface CustomProviderConfig {
  package: string;
  name: string;
  settings: { baseURL: string; tls?: ClientCertificate | null };
  headers?: Record<string, string>;
  models: Record<string, CustomProviderModel>;
  env?: string[];
}

export type CustomProviderModel = ProviderModelEntity & { modelID: string; name: string };
export type CustomProviderValidation =
  | { ok: false; error: string }
  | { ok: true; value: { providerId: string; config: CustomProviderConfig } };

interface ClientCertificate {
  cert: string;
  key: string;
  passphrase?: string;
}

interface ProviderValidationOptions {
  hasStoredAuth?: boolean;
}

const MODEL_TYPE_SCHEMA = z.string().trim().min(1);
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const BASE_URL_PATTERN = /^https?:\/\//;
const OPENAI_COMPATIBLE_PACKAGE = 'aisdk:@ai-sdk/openai-compatible';
const CUSTOM_PROVIDER_PACKAGES = new Set([
  OPENAI_COMPATIBLE_PACKAGE,
  'aisdk:@ai-sdk/openai',
  'aisdk:@ai-sdk/anthropic',
  '@opencode/ai/providers/openai-compatible',
  '@opencode/ai/providers/openai-compatible/responses',
  '@opencode/ai/providers/openai-compatible-responses',
  '@opencode/ai/providers/openai',
  '@opencode/ai/providers/openai/chat',
  '@opencode/ai/providers/openai/responses',
  '@opencode/ai/providers/anthropic',
  '@opencode/ai/providers/anthropic-compatible',
]);
const MODEL_CAPABILITIES = new Set(['text', 'image', 'audio', 'video', 'pdf']);

const isPositiveSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

const isModelCapabilityList = (value: unknown): value is string[] =>
  Array.isArray(value) && !value.some((entry) => !isString(entry) || !MODEL_CAPABILITIES.has(entry));

function providerExistsIn(config: OpenCodeConfigLayers['userConfig'], providerId: string) {
  return readSectionEntry(config, 'providers', providerId).value !== undefined;
}

function getUserProviderPath(layers: OpenCodeConfigLayers, providerId: string) {
  const { userPath, userOverridePath } = layers.paths;
  return userOverridePath && providerExistsIn(layers.userOverrideConfig, providerId) ? userOverridePath : userPath;
}

function getProviderSources(providerId: string, workingDirectory: string | null) {
  const layers = readConfigLayers(workingDirectory);
  const { userConfig, userOverrideConfig, projectConfig, customConfig, paths } = layers;
  const userPath = getUserProviderPath(layers, providerId);

  return {
    sources: {
      auth: { exists: false },
      user: { exists: providerExistsIn(getConfigForPath(layers, userPath), providerId), path: userPath },
      project: { exists: providerExistsIn(projectConfig, providerId), path: paths.projectPath || null },
      custom: { exists: providerExistsIn(customConfig, providerId), path: paths.customPath },
    },
    config: readStoredProviderEntry([customConfig, projectConfig, userOverrideConfig, userConfig], providerId),
  };
}

function validateCustomProviderConfig<Config>(providerId: string, config: Config, options: ProviderValidationOptions = {}): CustomProviderValidation {
  if (!providerId || !isString(providerId) || !PROVIDER_ID_PATTERN.test(providerId)) {
    return { ok: false, error: 'Provider ID must match /^[a-z0-9][a-z0-9-_]*$/' };
  }

  if (!isRecord(config)) {
    return { ok: false, error: 'Provider config must be an object' };
  }

  const name = isString(config.name) ? config.name.trim() : '';
  if (!name) {
    return { ok: false, error: 'Provider name is required' };
  }

  const packageName = toProviderPackage(config.package ?? config.npm) || OPENAI_COMPATIBLE_PACKAGE;
  if (!CUSTOM_PROVIDER_PACKAGES.has(packageName)) {
    return { ok: false, error: 'Custom providers must use @ai-sdk/openai-compatible, @ai-sdk/openai, @ai-sdk/anthropic, or a supported built-in OpenCode adapter' };
  }

  const settingsBlock = isRecord(config.settings)
    ? config.settings
    : (isRecord(config.options) ? config.options : null);
  if (!settingsBlock) {
    return { ok: false, error: 'Provider settings are required' };
  }

  const baseURL = isString(settingsBlock.baseURL) ? settingsBlock.baseURL.trim() : '';
  if (!baseURL) {
    return { ok: false, error: 'Base URL is required' };
  }
  if (!BASE_URL_PATTERN.test(baseURL)) {
    return { ok: false, error: 'Base URL must start with http:// or https://' };
  }

  const models = isRecord(config.models) ? config.models : null;
  if (!models || Object.keys(models).length === 0) {
    return { ok: false, error: 'At least one model is required' };
  }

  const normalizedModels: CustomProviderConfig['models'] = {};
  for (const [modelId, modelValue] of Object.entries(models)) {
    const trimmedId = modelId.trim();
    if (!trimmedId) {
      return { ok: false, error: 'Model id is required' };
    }
    if (!isRecord(modelValue)) {
      return { ok: false, error: `Model "${trimmedId}" must be an object` };
    }
    const modelName = isString(modelValue.name) ? modelValue.name.trim() : '';
    if (!modelName) {
      return { ok: false, error: `Model "${trimmedId}" requires a name` };
    }
    const normalizedModel: CustomProviderModel = { modelID: trimmedId, name: modelName };
    normalizedModels[trimmedId] = normalizedModel;
    const modelType = MODEL_TYPE_SCHEMA.safeParse(modelValue.type).data;
    if (modelType) normalizedModel.type = modelType;
    if (isRecord(modelValue.limit)) {
      const context = modelValue.limit.context;
      const output = modelValue.limit.output;
      if (context !== undefined && !isPositiveSafeInteger(context)) {
        return { ok: false, error: `Model "${trimmedId}" context limit must be a positive integer` };
      }
      if (output !== undefined && !isPositiveSafeInteger(output)) {
        return { ok: false, error: `Model "${trimmedId}" output limit must be a positive integer` };
      }
      const limit: Record<string, number> = {};
      if (context !== undefined) limit.context = context;
      if (output !== undefined) limit.output = output;
      if (Object.keys(limit).length > 0) normalizedModel.limit = limit;
    }
    if (isRecord(modelValue.capabilities)) {
      const input = modelValue.capabilities.input;
      const output = modelValue.capabilities.output;
      const tools = modelValue.capabilities.tools;
      if (input !== undefined && !isModelCapabilityList(input)) {
        return { ok: false, error: `Model "${trimmedId}" input capabilities are invalid` };
      }
      if (output !== undefined && !isModelCapabilityList(output)) {
        return { ok: false, error: `Model "${trimmedId}" output capabilities are invalid` };
      }
      if (tools !== undefined && !isBoolean(tools)) {
        return { ok: false, error: `Model "${trimmedId}" tools capability must be a boolean` };
      }
      normalizedModel.capabilities = {
        tools: isBoolean(tools) ? tools : true,
        input: input ?? ['text'],
        output: output ?? ['text'],
      };
    }
    if (Array.isArray(modelValue.variants)) {
      normalizedModel.variants = toModelVariants(modelValue.variants);
    }
  }

  const tls = validateClientCertificate(settingsBlock.tls);
  if (!tls.ok) return tls;

  const normalized: CustomProviderConfig = {
    package: packageName,
    name,
    settings: { baseURL },
    models: normalizedModels,
  };
  if (tls.value !== undefined) normalized.settings.tls = tls.value;

  let env: string[] = [];
  if (Array.isArray(config.env)) {
    env = config.env
      .filter((entry: unknown): entry is string => isString(entry) && entry.trim().length > 0)
      .map((entry) => entry.trim());
    if (env.length > 0) {
      normalized.env = env;
    }
  }

  const hasStoredAuth = Boolean(options.hasStoredAuth);
  if (env.length === 0 && !hasStoredAuth) {
    return {
      ok: false,
      error: 'API key or {env:VAR} credentials are required',
    };
  }

  const headerSource = isRecord(config.headers) ? config.headers : settingsBlock.headers;
  if (isRecord(headerSource)) {
    const headers: Record<string, string> = {};
    for (const [headerKey, headerValue] of Object.entries(headerSource)) {
      if (!headerKey.trim()) {
        continue;
      }
      if (!isString(headerValue) || !headerValue.trim()) {
        return { ok: false, error: `Header "${headerKey}" requires a non-empty value` };
      }
      headers[headerKey.trim()] = headerValue.trim();
    }
    if (Object.keys(headers).length > 0) {
      normalized.headers = headers;
    }
  }

  return { ok: true, value: { providerId, config: normalized } };
}

const CLIENT_CERTIFICATE_SCHEMA = z.object({
  cert: z.string().trim().min(1),
  key: z.string().trim().min(1),
  passphrase: z.string().optional(),
});

function validateClientCertificate(value: Parameters<typeof CLIENT_CERTIFICATE_SCHEMA.safeParse>[0]): { ok: true; value: ClientCertificate | null | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value };
  const parsed = CLIENT_CERTIFICATE_SCHEMA.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'A client certificate needs both the certificate and the key' };
  const certificate: ClientCertificate = { cert: parsed.data.cert, key: parsed.data.key };
  if (parsed.data.passphrase?.trim()) certificate.passphrase = parsed.data.passphrase;
  return { ok: true, value: certificate };
}

function mergeCustomProviderConfig(existingValue: Parameters<typeof toProviderEntity>[0], normalizedConfig: CustomProviderConfig): ProviderEntity {
  const existing = toProviderEntity(existingValue);
  const mergedSettings = { ...(existing.settings ?? {}), ...(normalizedConfig.settings ?? {}) } satisfies ProviderEntity['settings'];
  if (mergedSettings.tls === null) delete mergedSettings.tls;

  const existingModels: NonNullable<ProviderEntity['models']> = isRecord(existing.models) ? existing.models : {};
  const normalizedModels = isRecord(normalizedConfig.models) ? normalizedConfig.models : {};
  const mergedModels = Object.fromEntries(
    Object.entries(normalizedModels).map(([modelId, normalizedModel]) => {
      const existingModel = isRecord(existingModels[modelId]) ? existingModels[modelId] : {};
      const mergedModel = { ...existingModel, ...normalizedModel };
      if (Array.isArray(mergedModel.variants) && mergedModel.variants.length === 0) {
        delete mergedModel.variants;
      }
      return [modelId, mergedModel];
    }),
  );

  const merged = {
    ...existing,
    ...normalizedConfig,
    settings: mergedSettings,
    models: mergedModels,
  };
  if (!Object.prototype.hasOwnProperty.call(normalizedConfig, 'headers')) {
    delete merged.headers;
  }
  if (!Object.prototype.hasOwnProperty.call(normalizedConfig, 'env')) {
    delete merged.env;
  }
  return toProviderEntity(merged);
}

function upsertProviderConfig<Config>(providerId: string, config: Config, workingDirectory: string | null, scope: string = 'user', options: ProviderValidationOptions = {}) {
  const validated = validateCustomProviderConfig(providerId, config, options);
  if (!validated.ok) {
    const error = Object.assign(new Error(validated.error), { statusCode: 400 });
    throw error;
  }

  const layers = readConfigLayers(workingDirectory);
  let targetPath = getUserProviderPath(layers, validated.value.providerId);

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = layers.paths.projectPath || layers.paths.userPath;
  } else if (scope === 'custom') {
    if (!layers.paths.customPath) {
      throw new Error('Custom config path (OPENCODE_CONFIG) is not set');
    }
    targetPath = layers.paths.customPath;
  } else if (scope !== 'user') {
    throw new Error('Invalid scope');
  }

  const targetConfig = getConfigForPath(layers, targetPath);
  const existing = readSectionEntry(targetConfig, 'providers', validated.value.providerId).value;
  const mergedConfig = mergeCustomProviderConfig(existing, validated.value.config);
  writeSectionEntry(targetConfig, 'providers', validated.value.providerId, mergedConfig);

  if (Array.isArray(targetConfig.disabled_providers)) {
    targetConfig.disabled_providers = targetConfig.disabled_providers.filter(
      (entry) => entry !== validated.value.providerId,
    );
  }

  const writePath = targetPath || CONFIG_FILE;
  writeConfig(targetConfig, writePath);

  const { userConfig } = layers;
  if (writePath === layers.paths.userOverridePath
    && Array.isArray(userConfig.disabled_providers)
    && userConfig.disabled_providers.includes(validated.value.providerId)) {
    userConfig.disabled_providers = userConfig.disabled_providers.filter(
      (entry) => entry !== validated.value.providerId,
    );
    writeConfig(userConfig, layers.paths.userPath);
  }

  return {
    providerId: validated.value.providerId,
    path: writePath,
    config: mergedConfig,
  };
}

function removeProviderConfig(providerId: string, workingDirectory: string | null, scope: string = 'user') {
  if (!providerId || !isString(providerId)) {
    throw new Error('Provider ID is required');
  }

  const layers = readConfigLayers(workingDirectory);
  let targetPath = getUserProviderPath(layers, providerId);

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = layers.paths.projectPath || layers.paths.userPath;
  } else if (scope === 'custom') {
    if (!layers.paths.customPath) {
      return false;
    }
    targetPath = layers.paths.customPath;
  }

  const targetConfig = getConfigForPath(layers, targetPath);
  if (!deleteSectionEntry(targetConfig, 'providers', providerId)) {
    return false;
  }

  writeConfig(targetConfig, targetPath || CONFIG_FILE);
  console.log(`Removed provider ${providerId} from config: ${targetPath}`);
  return true;
}

function readDisabledProviders(workingDirectory: string | null): string[] {
  const layers = readConfigLayers(workingDirectory);
  const config = getConfigForPath(layers, layers.paths.userPath);
  return Array.isArray(config.disabled_providers)
    ? config.disabled_providers.filter((entry): entry is string => isString(entry) && entry.length > 0)
    : [];
}

function setProviderDisabled(providerId: string, disabled: boolean, workingDirectory: string | null) {
  if (!isString(providerId) || !PROVIDER_ID_PATTERN.test(providerId)) {
    const error = Object.assign(new Error('Invalid provider ID'), { statusCode: 400 });
    throw error;
  }
  const layers = readConfigLayers(workingDirectory);
  const targetPath = layers.paths.userPath;
  const config = getConfigForPath(layers, targetPath);
  const current = Array.isArray(config.disabled_providers)
    ? config.disabled_providers.filter((entry) => entry !== providerId)
    : [];
  const next = disabled ? [...current, providerId] : current;
  if (next.length > 0) config.disabled_providers = next;
  else delete config.disabled_providers;
  writeConfig(config, targetPath || CONFIG_FILE);
  return next;
}

export {
  getProviderSources,
  mergeCustomProviderConfig,
  readDisabledProviders,
  setProviderDisabled,
  removeProviderConfig,
  upsertProviderConfig,
  validateCustomProviderConfig,
};
