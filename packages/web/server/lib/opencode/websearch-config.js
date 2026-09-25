import path from 'path';
import fs from 'fs';
import {
  AGENT_SCOPE,
  findWorktreeRoot,
  getAncestors,
  getJsonWriteTarget,
  readConfigFile,
  readConfigLayers,
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

const PROJECT_CONFIG_NAMES = [
  path.join('.opencode', 'opencode.jsonc'),
  path.join('.opencode', 'opencode.json'),
  'opencode.jsonc',
  'opencode.json',
];

/**
 * Every existing project config file OpenCode merges for `directory`, deepest
 * first, from the directory up to its worktree root. An unreadable file is
 * skipped: it can't be told apart from one without the key.
 */
function readProjectConfigFiles(directory) {
  if (!directory) return [];
  const root = findWorktreeRoot(directory) || path.resolve(directory);
  const files = [];
  for (const base of getAncestors(directory, root)) {
    for (const name of PROJECT_CONFIG_NAMES) {
      const filePath = path.join(base, name);
      if (!fs.existsSync(filePath)) continue;
      try {
        files.push({ path: filePath, config: readConfigFile(filePath) });
      } catch {
        // Skipped; see above.
      }
    }
  }
  return files;
}
