import {
  AGENT_SCOPE,
  getFolderConfigPaths,
  getJsonWriteTarget,
  readConfigFile,
  readConfigLayers,
  writeConfig,
} from './config-files.js';
import {
  findWebSearchProjectOverride,
  writeCompactionSettings,
  writeWarmingDuration,
  writeWarmingEnabled,
  writeWebSearchSelection,
} from './config-v2.js';

export function setWebSearchSelection(selection) {
  const layers = readConfigLayers(null);
  const target = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
  const changed = writeWebSearchSelection(target.config, selection);
  if (changed) writeConfig(target.config, target.path);
  return { path: target.path, changed };
}

export function setWarmingEnabled(enabled) {
  const layers = readConfigLayers(null);
  const target = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
  const changed = writeWarmingEnabled(target.config, enabled);
  if (changed) writeConfig(target.config, target.path);
  return { path: target.path, changed };
}

export function setWarmingDuration(minutes) {
  const layers = readConfigLayers(null);
  const target = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
  const changed = writeWarmingDuration(target.config, minutes);
  if (changed) writeConfig(target.config, target.path);
  return { path: target.path, changed };
}

export function setCompactionSettings(update) {
  const layers = readConfigLayers(null);
  const target = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
  const changed = writeCompactionSettings(target.config, update);
  if (changed) writeConfig(target.config, target.path);
  return { path: target.path, changed };
}

export function getWebSearchSource(directory) {
  return { projectPath: findWebSearchProjectOverride(readConfigLayers(directory), readProjectConfigFiles(directory)) };
}


function readProjectConfigFiles(directory) {
  const files = [];
  for (const filePath of getFolderConfigPaths(directory).reverse()) {
    try {
      files.push({ path: filePath, config: readConfigFile(filePath) });
    } catch {
      // Skipped; see above.
    }
  }
  return files;
}
