import { z } from 'zod';
import {
  CONFIG_FILE,
  readConfigLayers,
  isPlainObject,
  getConfigForPath,
  writeConfig,
} from './shared.js';
import {
  readSectionEntry,
  writeSectionEntry,
  deleteSectionEntry,
  toModelVariants,
  toProviderEntity,
  readStoredProviderEntry,
  toProviderPackage,
} from './config-v2.js';

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


function providerExistsIn(config, providerId) {
  return readSectionEntry(config, 'providers', providerId).value !== undefined;
}

function getUserProviderPath(layers, providerId) {
  const { userPath, userOverridePath } = layers.paths;
  return userOverridePath && providerExistsIn(layers.userOverrideConfig, providerId) ? userOverridePath : userPath;
}

function getProviderSources(providerId, workingDirectory) {
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

function validateCustomProviderConfig(providerId, config, options = {}) {
  if (!providerId || typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
    return { ok: false, error: 'Provider ID must match /^[a-z0-9][a-z0-9-_]*$/' };
  }

  if (!isPlainObject(config)) {
    return { ok: false, error: 'Provider config must be an object' };
  }

  const name = typeof config.name === 'string' ? config.name.trim() : '';
  if (!name) {
    return { ok: false, error: 'Provider name is required' };
  }

  const packageName = toProviderPackage(config.package ?? config.npm) || OPENAI_COMPATIBLE_PACKAGE;
  if (!CUSTOM_PROVIDER_PACKAGES.has(packageName)) {
    return { ok: false, error: 'Custom providers must use @ai-sdk/openai-compatible, @ai-sdk/openai, @ai-sdk/anthropic, or a supported built-in OpenCode adapter' };
  }

  const settingsBlock = isPlainObject(config.settings)
    ? config.settings
    : (isPlainObject(config.options) ? config.options : null);
  if (!settingsBlock) {
    return { ok: false, error: 'Provider settings are required' };
  }

  const baseURL = typeof settingsBlock.baseURL === 'string' ? settingsBlock.baseURL.trim() : '';
  if (!baseURL) {
    return { ok: false, error: 'Base URL is required' };
  }
  if (!BASE_URL_PATTERN.test(baseURL)) {
    return { ok: false, error: 'Base URL must start with http:// or https://' };
  }

  const models = isPlainObject(config.models) ? config.models : null;
  if (!models || Object.keys(models).length === 0) {
    return { ok: false, error: 'At least one model is required' };
  }

  const normalizedModels = {};
  for (const [modelId, modelValue] of Object.entries(models)) {
    const trimmedId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!trimmedId) {
      return { ok: false, error: 'Model id is required' };
    }
    if (!isPlainObject(modelValue)) {
      return { ok: false, error: `Model "${trimmedId}" must be an object` };
    }
    const modelName = typeof modelValue.name === 'string' ? modelValue.name.trim() : '';
    if (!modelName) {
      return { ok: false, error: `Model "${trimmedId}" requires a name` };
    }
    normalizedModels[trimmedId] = { modelID: trimmedId, name: modelName };
    const modelType = MODEL_TYPE_SCHEMA.safeParse(modelValue.type).data;
    if (modelType) normalizedModels[trimmedId].type = modelType;
    if (isPlainObject(modelValue.limit)) {
      const context = modelValue.limit.context;
      const output = modelValue.limit.output;
      if (context !== undefined && (!Number.isSafeInteger(context) || context <= 0)) {
        return { ok: false, error: `Model "${trimmedId}" context limit must be a positive integer` };
      }
      if (output !== undefined && (!Number.isSafeInteger(output) || output <= 0)) {
        return { ok: false, error: `Model "${trimmedId}" output limit must be a positive integer` };
      }
      const limit = {};
      if (context !== undefined) limit.context = context;
      if (output !== undefined) limit.output = output;
      if (Object.keys(limit).length > 0) normalizedModels[trimmedId].limit = limit;
    }
    if (isPlainObject(modelValue.capabilities)) {
      const input = modelValue.capabilities.input;
      const output = modelValue.capabilities.output;
      const tools = modelValue.capabilities.tools;
      if (input !== undefined && (!Array.isArray(input) || input.some((value) => !MODEL_CAPABILITIES.has(value)))) {
        return { ok: false, error: `Model "${trimmedId}" input capabilities are invalid` };
      }
      if (output !== undefined && (!Array.isArray(output) || output.some((value) => !MODEL_CAPABILITIES.has(value)))) {
        return { ok: false, error: `Model "${trimmedId}" output capabilities are invalid` };
      }
      if (tools !== undefined && typeof tools !== 'boolean') {
        return { ok: false, error: `Model "${trimmedId}" tools capability must be a boolean` };
      }
      normalizedModels[trimmedId].capabilities = {
        tools: typeof tools === 'boolean' ? tools : true,
        input: input ?? ['text'],
        output: output ?? ['text'],
      };
    }
    if (Array.isArray(modelValue.variants)) {
      normalizedModels[trimmedId].variants = toModelVariants(modelValue.variants);
    }
  }

  const tls = validateClientCertificate(settingsBlock.tls);
  if (!tls.ok) return tls;

  const normalized = {
    package: packageName,
    name,
    settings: { baseURL },
    models: normalizedModels,
  };
  if (tls.value !== undefined) normalized.settings.tls = tls.value;

  let env = [];
  if (Array.isArray(config.env)) {
    env = config.env
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
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

  const headerSource = isPlainObject(config.headers) ? config.headers : settingsBlock.headers;
  if (isPlainObject(headerSource)) {
    const headers = {};
    for (const [headerKey, headerValue] of Object.entries(headerSource)) {
      if (typeof headerKey !== 'string' || !headerKey.trim()) {
        continue;
      }
      if (typeof headerValue !== 'string' || !headerValue.trim()) {
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

function validateClientCertificate(value) {
  if (value === undefined || value === null) return { ok: true, value };
  const parsed = CLIENT_CERTIFICATE_SCHEMA.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'A client certificate needs both the certificate and the key' };
  const certificate = { cert: parsed.data.cert, key: parsed.data.key };
  if (parsed.data.passphrase?.trim()) certificate.passphrase = parsed.data.passphrase;
  return { ok: true, value: certificate };
}

function mergeCustomProviderConfig(existingValue, normalizedConfig) {
  const existing = toProviderEntity(existingValue);
  const mergedSettings = { ...(existing.settings ?? {}), ...(normalizedConfig.settings ?? {}) };
  if (mergedSettings.tls === null) delete mergedSettings.tls;

  const existingModels = isPlainObject(existing.models) ? existing.models : {};
  const normalizedModels = isPlainObject(normalizedConfig.models) ? normalizedConfig.models : {};
  const mergedModels = Object.fromEntries(
    Object.entries(normalizedModels).map(([modelId, normalizedModel]) => {
      const existingModel = isPlainObject(existingModels[modelId]) ? existingModels[modelId] : {};
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

function upsertProviderConfig(providerId, config, workingDirectory, scope = 'user', options = {}) {
  const validated = validateCustomProviderConfig(providerId, config, options);
  if (!validated.ok) {
    const error = new Error(validated.error);
    error.statusCode = 400;
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

function removeProviderConfig(providerId, workingDirectory, scope = 'user') {
  if (!providerId || typeof providerId !== 'string') {
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

function readDisabledProviders(workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const config = getConfigForPath(layers, layers.paths.userPath);
  return Array.isArray(config.disabled_providers)
    ? config.disabled_providers.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : [];
}

function setProviderDisabled(providerId, disabled, workingDirectory) {
  if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
    const error = new Error('Invalid provider ID');
    error.statusCode = 400;
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
