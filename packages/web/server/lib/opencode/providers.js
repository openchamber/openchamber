import {
  CONFIG_FILE,
  readConfigLayers,
  isPlainObject,
  getConfigForPath,
  writeConfig,
} from './shared.js';

function getProviderSources(providerId, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const hasProvider = (config) => [config?.provider, config?.providers].some((providers) =>
    isPlainObject(providers) && Object.hasOwn(providers, providerId));
  const findSource = (scope) => [...(layers.sources || [])].reverse()
    .find((source) => source.scope === scope && hasProvider(source.config));
  const sourceInfo = (scope, fallbackConfig, fallbackPath) => {
    const source = findSource(scope);
    if (source) return { exists: true, path: source.filePath };
    return {
      exists: layers.sources ? false : hasProvider(fallbackConfig),
      path: fallbackPath ?? null,
    };
  };

  return {
    sources: {
      auth: { exists: false },
      user: sourceInfo('user', layers.userConfig, layers.paths.userPath),
      project: sourceInfo('project', layers.projectConfig, layers.paths.projectPath),
      custom: sourceInfo('custom', layers.customConfig, layers.paths.customPath),
      customDirectory: sourceInfo('custom-directory'),
      inline: sourceInfo('inline'),
      managed: sourceInfo('managed'),
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

export {
  getProviderSources,
  removeProviderConfig,
};
