import {
  AGENT_SCOPE,
  getJsonWriteTarget,
  readConfigLayers,
  readProjectConfigFiles,
  writeConfig,
} from './shared.js';
import { findWebSearchProjectOverride, writeWarmingEnabled, writeWebSearchSelection } from './config-v2.js';

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

/**
 * Where the effective `websearch` value for `directory` comes from, as far as
 * a Settings write is concerned: `projectPath` is the project config that
 * overrides whatever Settings writes, or `null` when a Settings write applies.
 */
export function getWebSearchSource(directory) {
  return { projectPath: findWebSearchProjectOverride(readConfigLayers(directory), readProjectConfigFiles(directory)) };
}
