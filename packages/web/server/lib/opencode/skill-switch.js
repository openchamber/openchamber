import {
  AGENT_SCOPE,
  getFolderConfigPaths,
  getJsonWriteTarget,
  readConfigFile,
  readConfigLayers,
  writeConfig,
} from './shared.js';
import { writeSkillDisabled } from './config-v2.js';

export function setSkillEnabled({ id, enabled, scope, directory }) {
  const layers = readConfigLayers(directory);

  if (!enabled) {
    const target = getJsonWriteTarget(layers, scope === 'project' ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER);
    const changed = writeSkillDisabled(target.config, id, true);
    if (changed) writeConfig(target.config, target.path);
    return { changed: changed ? [target.path] : [] };
  }

  const { userPath, userOverridePath, customPath } = layers.paths;
  const files = [...new Set([customPath, userPath, userOverridePath, ...getFolderConfigPaths(directory)].filter(Boolean))];
  const changed = [];
  for (const filePath of files) {
    let config;
    try {
      config = readConfigFile(filePath);
    } catch (error) {
      console.warn(`[skills] could not read ${filePath} to switch a skill on:`, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!writeSkillDisabled(config, id, false)) continue;
    writeConfig(config, filePath);
    changed.push(filePath);
  }
  return { changed };
}
