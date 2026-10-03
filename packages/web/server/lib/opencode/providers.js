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
  toNpmPackage,
} from './config-v2.js';

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const BASE_URL_PATTERN = /^https?:\/\//;
const OPENAI_COMPATIBLE_NPM = '@ai-sdk/openai-compatible';
const CUSTOM_PROVIDER_NPM_PACKAGES = new Set([
  OPENAI_COMPATIBLE_NPM,
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
]);

// OpenCode 2 keeps providers under `providers` with `package: "aisdk:<npm>"`,
// `settings.baseURL`, and `models.<id>.modelID`. The v1 `provider` map with
// `npm`/`api`/`options` is still decoded, so reads accept it; every write is v2.

function providerExistsIn(config, providerId) {
  return readSectionEntry(config, 'providers', providerId).value !== undefined;
}

function getProviderSources(providerId, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const { userConfig, projectConfig, customConfig, paths } = layers;

  return {
    sources: {
      auth: { exists: false },
      user: { exists: providerExistsIn(userConfig, providerId), path: paths.userPath },
      project: { exists: providerExistsIn(projectConfig, providerId), path: paths.projectPath || null },
      custom: { exists: providerExistsIn(customConfig, providerId), path: paths.customPath },
    },
    // Same precedence as the edit scope: custom > project > user.
    config: readStoredProviderEntry([customConfig, projectConfig, userConfig], providerId),
  };
}

/**
 * Validate a custom provider config payload before persistence.
 * Returns { ok: true, value } or { ok: false, error }.
 *
 * Accepts the v2 spelling (`package`, `settings.baseURL`) and the v1 spelling
 * (`npm`, `options.baseURL`); the normalized value is always v2.
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

  const npm = toNpmPackage(config.package ?? config.npm) || OPENAI_COMPATIBLE_NPM;
  if (!CUSTOM_PROVIDER_NPM_PACKAGES.has(npm)) {
    return { ok: false, error: 'Custom providers must use @ai-sdk/openai-compatible, @ai-sdk/openai, or @ai-sdk/anthropic' };
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
    // Present means the caller owns the levels; an empty list removes them.
    if (Array.isArray(modelValue.variants)) {
      normalizedModels[trimmedId].variants = toModelVariants(modelValue.variants);
    }
  }

  const normalized = {
    package: toProviderPackage(npm),
    name,
    settings: { baseURL },
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

function mergeCustomProviderConfig(existingValue, normalizedConfig) {
  // Read the existing entry through the v2 projection so a legacy
  // `npm`/`api`/`options` block is carried forward in native shape.
  const existing = toProviderEntity(existingValue);
  const mergedSettings = { ...(existing.settings ?? {}), ...(normalizedConfig.settings ?? {}) };

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
  // Headers and env are explicit removals when the form omits them.
  if (!Object.prototype.hasOwnProperty.call(normalizedConfig, 'headers')) {
    delete merged.headers;
  }
  if (!Object.prototype.hasOwnProperty.call(normalizedConfig, 'env')) {
    delete merged.env;
  }
  return toProviderEntity(merged);
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
  const existing = readSectionEntry(targetConfig, 'providers', validated.value.providerId).value;
  const mergedConfig = mergeCustomProviderConfig(existing, validated.value.config);
  // Writes `providers`; a legacy `provider.<id>` in the same file is dropped so
  // the two spellings cannot disagree.
  writeSectionEntry(targetConfig, 'providers', validated.value.providerId, mergedConfig);

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
    config: mergedConfig,
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
  if (!deleteSectionEntry(targetConfig, 'providers', providerId)) {
    return false;
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
