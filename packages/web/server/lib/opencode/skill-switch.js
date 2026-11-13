import {
  AGENT_SCOPE,
  getFolderConfigPaths,
  getJsonWriteTarget,
  readConfigFile,
  readConfigLayers,
  writeConfig,
} from './shared.js';
import { writeSkillDisabled } from './config-v2.js';

/**
 * Turns a skill off or back on for agents through OpenCode's own policy
 * config; OpenCode watches the files, so the change applies without a
 * restart. `id` passed `isSkillSwitchId`.
 *
 * Off writes one exact `skill:<id>` deny where the skill lives: the project
 * config of `directory` for a project skill, else the user's global config
 * (`OPENCODE_CONFIG` when set, like every other Settings write).
 *
 * On removes the exact deny for `id` from every config file OpenCode reads for
 * `directory`: the global files, `OPENCODE_CONFIG`, and each folder config from
 * the project up. A deny written by hand turns on the same way as one written
 * here; a wildcard or a Console policy stays, and the page names it. A file
 * that cannot be parsed is skipped rather than rewritten.
 *
 * Returns the files it changed.
 */
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
