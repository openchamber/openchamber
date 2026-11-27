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
  writeMcpSkillsEnabled,
  writeWarmingDuration,
  writeWarmingEnabled,
  writeWebSearchSelection,
} from './config-v2.js';
import type { CompactionUpdate, WebSearchSelection } from './config-v2.js';
import type { OpenCodeConfigLayer } from './config-files.js';

export function setWebSearchSelection(selection: WebSearchSelection) {
  const layers = readConfigLayers(null);
  const target = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
  const changed = writeWebSearchSelection(target.config, selection);
  if (changed) writeConfig(target.config, target.path);
  return { path: target.path, changed };
}

export function setWarmingEnabled(enabled: boolean) {
  const layers = readConfigLayers(null);
  const target = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
  const changed = writeWarmingEnabled(target.config, enabled);
  if (changed) writeConfig(target.config, target.path);
  return { path: target.path, changed };
}

export function setWarmingDuration(minutes: number) {
  const layers = readConfigLayers(null);
  const target = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
  const changed = writeWarmingDuration(target.config, minutes);
  if (changed) writeConfig(target.config, target.path);
  return { path: target.path, changed };
}

export function setCompactionSettings(update: CompactionUpdate) {
  const layers = readConfigLayers(null);
  const target = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
  const changed = writeCompactionSettings(target.config, update);
  if (changed) writeConfig(target.config, target.path);
  return { path: target.path, changed };
}

export function setMcpSkillsEnabled(enabled: boolean) {
  const layers = readConfigLayers(null);
  const target = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
  const changed = writeMcpSkillsEnabled(target.config, enabled);
  if (changed) writeConfig(target.config, target.path);
  return { path: target.path, changed };
}

export function getWebSearchSource(directory: string | null) {
  return { projectPath: findWebSearchProjectOverride(readConfigLayers(directory), readProjectConfigFiles(directory)) };
}


function readProjectConfigFiles(directory: string | null) {
  const files: Array<{ path: string; config: OpenCodeConfigLayer }> = [];
  for (const filePath of getFolderConfigPaths(directory).reverse()) {
    try {
      files.push({ path: filePath, config: readConfigFile(filePath) });
    } catch {
      continue;
    }
  }
  return files;
}
