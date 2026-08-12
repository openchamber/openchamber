import {
  CONFIG_FILE,
  readConfigLayers,
  isPlainObject,
  getConfigForPath,
  writeConfig,
} from './shared.js';

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const BASE_URL_PATTERN = /^https?:\/\//;
const OPENAI_COMPATIBLE_NPM = '@ai-sdk/openai-compatible';
const CUSTOM_PROVIDER_NPMS = new Set([
  OPENAI_COMPATIBLE_NPM,
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
]);
const MODEL_MODALITIES = new Set(['text', 'audio', 'image', 'video', 'pdf']);
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setOwnProperty(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function normalizeModelConfig(modelValue) {
  const normalized = {
    name: modelValue.name.trim(),
  };

  for (const key of ['reasoning', 'attachment', 'tool_call']) {
    if (typeof modelValue[key] === 'boolean') {
      setOwnProperty(normalized, key, modelValue[key]);
    }
  }

  if (isPlainObject(modelValue.modalities)) {
    const modalities = {};
    for (const direction of ['input', 'output']) {
      if (!Array.isArray(modelValue.modalities[direction])) continue;
      const values = modelValue.modalities[direction].filter(
        (value) => typeof value === 'string' && MODEL_MODALITIES.has(value),
      );
      if (values.length > 0) setOwnProperty(modalities, direction, [...new Set(values)]);
    }
    if (Object.keys(modalities).length > 0) setOwnProperty(normalized, 'modalities', modalities);
  }

  if (isPlainObject(modelValue.limit)) {
    const limit = {};
    for (const key of ['context', 'input', 'output']) {
      const value = modelValue.limit[key];
      if (Number.isSafeInteger(value) && value > 0) setOwnProperty(limit, key, value);
    }
    if (Object.keys(limit).length > 0) setOwnProperty(normalized, 'limit', limit);
  }

  if (isPlainObject(modelValue.variants)) {
    const variants = {};
    for (const [variantId, variantValue] of Object.entries(modelValue.variants)) {
      if (!variantId.trim() || UNSAFE_OBJECT_KEYS.has(variantId.trim()) || !isPlainObject(variantValue)) continue;
      const cleanVariant = normalizeJsonRecord(variantValue);
      if (cleanVariant) setOwnProperty(variants, variantId.trim(), cleanVariant);
    }
    if (Object.keys(variants).length > 0) setOwnProperty(normalized, 'variants', variants);
  }

  return normalized;
}

function normalizeJsonRecord(value) {
  if (!isPlainObject(value)) return null;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || UNSAFE_OBJECT_KEYS.has(key)) continue;
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') {
      setOwnProperty(result, key, entry);
      continue;
    }
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      setOwnProperty(result, key, entry);
      continue;
    }
    if (Array.isArray(entry)) {
      const array = entry.map((item) => normalizeJsonValue(item)).filter((item) => item !== undefined);
      if (array.length === entry.length) setOwnProperty(result, key, array);
      continue;
    }
    const nested = normalizeJsonRecord(entry);
    if (nested) setOwnProperty(result, key, nested);
  }
  return result;
}

function normalizeJsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const result = value.map((item) => normalizeJsonValue(item));
    return result.every((item) => item !== undefined) ? result : undefined;
  }
  return normalizeJsonRecord(value) ?? undefined;
}

function getProviderSources(providerId, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const { userConfig, projectConfig, customConfig, paths } = layers;

  const customProviders = isPlainObject(customConfig?.provider) ? customConfig.provider : {};
  const customProvidersAlias = isPlainObject(customConfig?.providers) ? customConfig.providers : {};
  const projectProviders = isPlainObject(projectConfig?.provider) ? projectConfig.provider : {};
  const projectProvidersAlias = isPlainObject(projectConfig?.providers) ? projectConfig.providers : {};
  const userProviders = isPlainObject(userConfig?.provider) ? userConfig.provider : {};
  const userProvidersAlias = isPlainObject(userConfig?.providers) ? userConfig.providers : {};

  const customExists =
    Object.prototype.hasOwnProperty.call(customProviders, providerId) ||
    Object.prototype.hasOwnProperty.call(customProvidersAlias, providerId);
  const projectExists =
    Object.prototype.hasOwnProperty.call(projectProviders, providerId) ||
    Object.prototype.hasOwnProperty.call(projectProvidersAlias, providerId);
  const userExists =
    Object.prototype.hasOwnProperty.call(userProviders, providerId) ||
    Object.prototype.hasOwnProperty.call(userProvidersAlias, providerId);

  return {
    sources: {
      auth: { exists: false },
      user: { exists: userExists, path: paths.userPath },
      project: { exists: projectExists, path: paths.projectPath || null },
      custom: { exists: customExists, path: paths.customPath }
    }
  };
}

/**
 * Validate a custom OpenAI/Anthropic provider config payload before persistence.
 * Returns { ok: true, value } or { ok: false, error }.
 *
 * Credentials: either config.env contains a variable name, or hasStoredAuth is true
 * (auth.json already has a key — typically after auth.set, or when editing).
 */
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

  const npm = typeof config.npm === 'string' ? config.npm.trim() : OPENAI_COMPATIBLE_NPM;
  if (!CUSTOM_PROVIDER_NPMS.has(npm)) {
    return { ok: false, error: 'Custom provider npm package is not supported' };
  }

  const optionsBlock = isPlainObject(config.options) ? config.options : null;
  if (!optionsBlock) {
    return { ok: false, error: 'Provider options are required' };
  }

  const baseURL = typeof optionsBlock.baseURL === 'string' ? optionsBlock.baseURL.trim() : '';
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
    setOwnProperty(normalizedModels, trimmedId, normalizeModelConfig(modelValue));
  }

  const normalized = {
    npm,
    name,
    options: {
      baseURL,
    },
    models: normalizedModels,
  };

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

  if (isPlainObject(optionsBlock.headers)) {
    const headers = {};
    for (const [headerKey, headerValue] of Object.entries(optionsBlock.headers)) {
      if (typeof headerKey !== 'string' || !headerKey.trim()) {
        continue;
      }
      if (typeof headerValue !== 'string' || !headerValue.trim()) {
        return { ok: false, error: `Header "${headerKey}" requires a non-empty value` };
      }
      setOwnProperty(headers, headerKey.trim(), headerValue.trim());
    }
    if (Object.keys(headers).length > 0) {
      normalized.options.headers = headers;
    }
  }

  return { ok: true, value: { providerId, config: normalized } };
}

/**
 * Persist (create or update) a custom provider block in OpenCode user/project/custom config.
 * Does not write secrets — API keys remain in auth.json via the OpenCode auth API.
 */
function upsertProviderConfig(providerId, config, workingDirectory, scope = 'user', options = {}) {
  const validated = validateCustomProviderConfig(providerId, config, options);
  if (!validated.ok) {
    const error = new Error(validated.error);
    error.statusCode = 400;
    throw error;
  }

  const layers = readConfigLayers(workingDirectory);
  let targetPath = layers.paths.userPath;

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = layers.paths.projectPath || targetPath;
  } else if (scope === 'custom') {
    if (!layers.paths.customPath) {
      throw new Error('Custom config path (OPENCODE_CONFIG) is not set');
    }
    targetPath = layers.paths.customPath;
  } else if (scope !== 'user') {
    throw new Error('Invalid scope');
  }

  const targetConfig = getConfigForPath(layers, targetPath);
  const providerConfig = isPlainObject(targetConfig.provider) ? { ...targetConfig.provider } : {};
  providerConfig[validated.value.providerId] = validated.value.config;
  targetConfig.provider = providerConfig;

  if (Array.isArray(targetConfig.disabled_providers)) {
    targetConfig.disabled_providers = targetConfig.disabled_providers.filter(
      (entry) => entry !== validated.value.providerId,
    );
  }

  const writePath = targetPath || CONFIG_FILE;
  writeConfig(targetConfig, writePath);

  return {
    providerId: validated.value.providerId,
    path: writePath,
    config: validated.value.config,
  };
}

function removeProviderConfig(providerId, workingDirectory, scope = 'user') {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }

  const layers = readConfigLayers(workingDirectory);
  let targetPath = layers.paths.userPath;

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = layers.paths.projectPath || targetPath;
  } else if (scope === 'custom') {
    if (!layers.paths.customPath) {
      return false;
    }
    targetPath = layers.paths.customPath;
  }

  const targetConfig = getConfigForPath(layers, targetPath);
  const providerConfig = isPlainObject(targetConfig.provider) ? targetConfig.provider : {};
  const providersConfig = isPlainObject(targetConfig.providers) ? targetConfig.providers : {};
  const removedProvider = Object.prototype.hasOwnProperty.call(providerConfig, providerId);
  const removedProviders = Object.prototype.hasOwnProperty.call(providersConfig, providerId);

  if (!removedProvider && !removedProviders) {
    return false;
  }

  if (removedProvider) {
    delete providerConfig[providerId];
    if (Object.keys(providerConfig).length === 0) {
      delete targetConfig.provider;
    } else {
      targetConfig.provider = providerConfig;
    }
  }

  if (removedProviders) {
    delete providersConfig[providerId];
    if (Object.keys(providersConfig).length === 0) {
      delete targetConfig.providers;
    } else {
      targetConfig.providers = providersConfig;
    }
  }

  writeConfig(targetConfig, targetPath || CONFIG_FILE);
  console.log(`Removed provider ${providerId} from config: ${targetPath}`);
  return true;
}

export {
  getProviderSources,
  removeProviderConfig,
  upsertProviderConfig,
  validateCustomProviderConfig,
};
