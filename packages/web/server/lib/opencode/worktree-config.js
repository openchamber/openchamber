import fs from 'fs';
import os from 'os';
import {
  AGENT_SCOPE,
  collectProjectConfigFiles,
  getJsonWriteTarget,
  isInvalidJsoncError,
  readConfigLayers,
  writeConfig,
} from './shared.js';
import {
  isRecord,
  parseWorktreeDirectory,
  resolveWorktreeDirectoryPath,
  writeWorktreeDirectory,
} from './config-v2.js';

/**
 * The effective `worktree.directory` for the project `directory` belongs to,
 * where that value comes from, and where a Settings write for that directory
 * would land.
 *
 * OpenCode merges global config < every `opencode.json(c)` and
 * `.opencode/opencode.json(c)` from the project root up to the filesystem root,
 * nearest first < `OPENCODE_CONFIG`, so the folder is looked up in that order
 * over the documents `readConfigLayers` and `collectProjectConfigFiles` already
 * found. Only the `directory` leaf is compared: nothing else under `worktree`
 * can change what a relative folder resolves against.
 */
export function readWorktreeDirectoryConfig(directory) {
  const layers = readConfigLayers(directory);
  const projectFiles = collectProjectConfigFiles(directory, null);

  const custom = readDirectoryValue(layers.customConfig);
  if (custom) {
    return describe(custom, 'custom', layers.paths.customPath, layers);
  }

  for (const file of projectFiles) {
    const value = readProjectFileDirectory(file);
    if (value) {
      return describe(value, 'project', file.path, layers);
    }
  }

  const globalOverride = readDirectoryValue(layers.userOverrideConfig);
  if (globalOverride) {
    return describe(globalOverride, 'global', layers.paths.userOverridePath, layers);
  }

  const global = readDirectoryValue(layers.userConfig);
  if (global) {
    return describe(global, 'global', layers.paths.userPath, layers);
  }

  return describe(null, null, null, layers);
}

/**
 * Where new worktrees for the project behind `primaryWorktree` go: OpenCode's
 * `worktree.directory` when it is set, otherwise `null` so the caller keeps the
 * managed data directory OpenChamber has always used. A configured relative
 * folder resolves against `primaryWorktree` rather than the directory the
 * request arrived from, which is what keeps `../worktrees` landing in one place
 * whether that was a nested directory or a linked worktree of the same project.
 * Throws instead of returning `null` when a config file exists but could not be
 * read, so a configured destination is never silently swapped for the default.
 */
export function resolveWorktreeRoot(primaryWorktree) {
  const config = readWorktreeDirectoryConfig(primaryWorktree);
  if (!config.directory) {
    return null;
  }
  return resolveWorktreeDirectoryPath(config.directory, primaryWorktree, os.homedir());
}

/**
 * Writes the `worktree.directory` key into the file Settings owns for
 * `directory`. OpenCode watches it, so the change applies without a restart.
 * `value` comes from `parseWorktreeDirectory`: a string to write, or `null` to
 * drop the key so the inherited value applies again.
 */
export function setWorktreeDirectory(value, directory) {
  const layers = readConfigLayers(directory);
  const target = getJsonWriteTarget(layers, worktreeWriteScope(layers));
  const changed = writeWorktreeDirectory(target.config, value);
  if (changed) writeConfig(target.config, target.path);
  return { path: target.path, changed };
}

function describe(directory, source, path, layers) {
  const writePath = worktreeWritePath(layers);
  return {
    directory,
    source,
    path,
    writePath,
    // A project config Settings cannot write (one above the project root, say)
    // decides the value, so a write would look like it did nothing.
    locked: Boolean(path) && path !== writePath,
  };
}

/**
 * The file `setWorktreeDirectory` would write, resolved like
 * `getJsonWriteTarget` but without its layer-error check. Reading the effective
 * value has to tolerate a malformed document the way OpenCode does, and a write
 * is not happening during a read.
 */
function worktreeWritePath(layers) {
  if (layers.paths.customPath) {
    return layers.paths.customPath;
  }
  if (worktreeWriteScope(layers) === AGENT_SCOPE.PROJECT && layers.paths.projectPath) {
    return layers.paths.projectPath;
  }
  return layers.paths.userPath;
}

/**
 * Settings edits a project config that is already there rather than creating
 * one, so setting a folder never drops a new tracked file into the repository.
 * Without a project config the global file is the one OpenChamber owns.
 */
function worktreeWriteScope(layers) {
  if (layers.paths.projectPath && fs.existsSync(layers.paths.projectPath)) {
    return AGENT_SCOPE.PROJECT;
  }
  return AGENT_SCOPE.USER;
}

/** The folder one config document decides, or `undefined` when it decides none. */
function readDirectoryValue(config) {
  const worktree = config?.worktree;
  if (!isRecord(worktree)) {
    return undefined;
  }
  return parseWorktreeDirectory(worktree.directory);
}

/**
 * The folder one project config file decides, or `null` when it decides none.
 * A file OpenCode itself drops for malformed JSONC decides nothing, so a typo
 * elsewhere in the project does not move worktrees. Any other read failure
 * leaves the destination genuinely unknown, and quietly falling back to the
 * default there is worse than an error.
 *
 * A global or `OPENCODE_CONFIG` layer that cannot be read needs no check here:
 * `readConfigLayers` rethrows anything that is not malformed JSONC.
 */
function readProjectFileDirectory(file) {
  if (file.error) {
    if (isInvalidJsoncError(file.error)) {
      return null;
    }
    throw new Error(`Failed to read OpenCode configuration: ${file.path}`);
  }
  return readDirectoryValue(file.config) || null;
}
