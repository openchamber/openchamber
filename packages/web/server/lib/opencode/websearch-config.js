import {
  AGENT_SCOPE,
  getFolderConfigPaths,
  getJsonWriteTarget,
  readConfigFile,
  readConfigLayers,
  writeConfig,
} from './shared.js';
import {
  findWebSearchProjectOverride,
  writeCompactionSettings,
  writeWarmingDuration,
  writeWarmingEnabled,
  writeWebSearchSelection,
} from './config-v2.js';

/**
 * Writes the `websearch` choice into the config OpenCode reads last among the
 * files OpenChamber owns a write to: `OPENCODE_CONFIG` when the user set one,
 * else the user's global `opencode.json`. OpenCode watches both, so the choice
 * applies without a restart. `selection` comes from `parseWebSearchSelection`.
 * The file is left untouched when the choice is already there.
 */
export function setWebSearchSelection(selection) {
  const layers = readConfigLayers(null);
  const target = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
  const changed = writeWebSearchSelection(target.config, selection);
  if (changed) writeConfig(target.config, target.path);
  return { path: target.path, changed };
}

/**
 * Turns session warming on or off in the same file the web search choice goes
 * to; OpenCode watches it, so the change applies without a restart.
 */
export function setWarmingEnabled(enabled) {
  const layers = readConfigLayers(null);
  const target = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
  const changed = writeWarmingEnabled(target.config, enabled);
  if (changed) writeConfig(target.config, target.path);
  return { path: target.path, changed };
}

/** Sets OpenCode's warm duration in the same file, while its warming is on there. */
export function setWarmingDuration(minutes) {
  const layers = readConfigLayers(null);
  const target = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
  const changed = writeWarmingDuration(target.config, minutes);
  if (changed) writeConfig(target.config, target.path);
  return { path: target.path, changed };
}

/**
 * Writes the compaction settings (`compaction.buffer`, `compaction.keep.tokens`,
 * `experimental.background_compaction`) to the same file; `update` comes from
 * `compactionUpdateSchema`.
 */
export function setCompactionSettings(update) {
  const layers = readConfigLayers(null);
  const target = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
  const changed = writeCompactionSettings(target.config, update);
  if (changed) writeConfig(target.config, target.path);
  return { path: target.path, changed };
}

/**
 * Where the effective `websearch` value for `directory` comes from, as far as
 * a Settings write is concerned: `projectPath` is the project config that
 * overrides whatever Settings writes, or `null` when a Settings write applies.
 */
export function getWebSearchSource(directory) {
  return { projectPath: findWebSearchProjectOverride(readConfigLayers(directory), readProjectConfigFiles(directory)) };
}


/**
 * Every project config file OpenCode merges for `directory`, up to the
 * filesystem root, the one that wins first (`getFolderConfigPaths` gives them
 * in load order). An unreadable file is skipped: it can't be told apart from
 * one without the key.
 */
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
