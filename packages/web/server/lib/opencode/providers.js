import {
  CONFIG_FILE,
  readConfigLayers,
  isPlainObject,
  getConfigForPath,
  writeConfig,
} from './shared.js';

const normalizePositiveIntegerLimit = (value, fieldName) => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(value)) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
};

const readUserProviderModelEntry = (userConfig, providerId, modelId) => {
  const providers = isPlainObject(userConfig.provider) ? userConfig.provider : {};
  const provider = isPlainObject(providers[providerId]) ? providers[providerId] : null;
  const models = provider && isPlainObject(provider.models) ? provider.models : {};
  return isPlainObject(models[modelId]) ? models[modelId] : null;
};

const cleanupEmptyModelOverride = (provider, modelId) => {
  if (!isPlainObject(provider.models)) return;
  const modelEntry = provider.models[modelId];
  if (isPlainObject(modelEntry) && Object.keys(modelEntry).length === 0) {
    delete provider.models[modelId];
  }
  if (Object.keys(provider.models).length === 0) {
    delete provider.models;
  }
};

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

function getUserProviderModelContextLimits(providerId) {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }

  const layers = readConfigLayers(null);
  const providers = isPlainObject(layers.userConfig.provider) ? layers.userConfig.provider : {};
  const provider = isPlainObject(providers[providerId]) ? providers[providerId] : null;
  const models = provider && isPlainObject(provider.models) ? provider.models : {};
  const result = {};

  for (const [modelId, modelEntry] of Object.entries(models)) {
    if (!isPlainObject(modelEntry) || !isPlainObject(modelEntry.limit)) {
      continue;
    }
    const context = modelEntry.limit.context;
    if (typeof context !== 'number' || !Number.isFinite(context)) {
      continue;
    }
    const output = modelEntry.limit.output;
    result[modelId] = {
      context,
      ...(typeof output === 'number' && Number.isFinite(output) ? { output } : {}),
    };
  }

  return {
    providerId,
    models: result,
    source: {
      scope: 'user',
      path: layers.paths.userPath,
    },
  };
}

function updateUserProviderModelContextLimit(providerId, modelId, contextLimit, outputLimit, maxContextLimit) {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }
  if (!modelId || typeof modelId !== 'string') {
    throw new Error('Model ID is required');
  }

  const normalizedContext = normalizePositiveIntegerLimit(contextLimit, 'Context limit');
  const normalizedOutput = normalizePositiveIntegerLimit(outputLimit, 'Output limit');
  const normalizedMaxContext = normalizePositiveIntegerLimit(maxContextLimit, 'Maximum context limit');

  if (normalizedContext !== null && normalizedMaxContext !== null && normalizedContext > normalizedMaxContext) {
    throw new Error(`Context limit cannot exceed advertised context limit (${normalizedMaxContext})`);
  }

  const layers = readConfigLayers(null);
  const targetConfig = layers.userConfig;
  const targetPath = layers.paths.userPath || CONFIG_FILE;

  if (!isPlainObject(targetConfig.provider)) {
    targetConfig.provider = {};
  }

  const providers = targetConfig.provider;
  const provider = isPlainObject(providers[providerId]) ? providers[providerId] : {};
  providers[providerId] = provider;

  if (!isPlainObject(provider.models)) {
    provider.models = {};
  }

  const models = provider.models;
  const existingModel = readUserProviderModelEntry(targetConfig, providerId, modelId) || {};
  const modelEntry = { ...existingModel };
  models[modelId] = modelEntry;

  if (normalizedContext === null) {
    if (isPlainObject(modelEntry.limit)) {
      delete modelEntry.limit;
    }
    cleanupEmptyModelOverride(provider, modelId);
    if (Object.keys(provider).length === 0) {
      delete providers[providerId];
    }
    if (Object.keys(providers).length === 0) {
      delete targetConfig.provider;
    }
    writeConfig(targetConfig, targetPath);
    return { providerId, modelId, context: null, source: { scope: 'user', path: targetPath } };
  }

  const existingLimit = isPlainObject(modelEntry.limit) ? { ...modelEntry.limit } : {};
  const nextLimit = {
    ...existingLimit,
    context: normalizedContext,
  };

  if (normalizedOutput !== null) {
    nextLimit.output = normalizedOutput;
  }

  if (typeof nextLimit.output !== 'number' || !Number.isFinite(nextLimit.output)) {
    throw new Error('Output limit is required to set a context cap');
  }

  modelEntry.limit = nextLimit;
  writeConfig(targetConfig, targetPath);

  return {
    providerId,
    modelId,
    context: normalizedContext,
    output: nextLimit.output,
    source: { scope: 'user', path: targetPath },
  };
}

export {
  getProviderSources,
  removeProviderConfig,
  getUserProviderModelContextLimits,
  updateUserProviderModelContextLimit,
};
