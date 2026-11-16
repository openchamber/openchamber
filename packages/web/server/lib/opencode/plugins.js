import { isRecord } from '../shared/guards.js';
import fs from 'fs';
import path from 'path';
import {
  AGENT_SCOPE,
  OPENCODE_CONFIG_DIR,
  getFolderConfigPaths,
  getLayerError,
  getProjectConfigCandidates,
  readConfigFile,
  readConfigLayer,
  readConfigLayers,
  writeConfig,
} from './shared.js';
import { isPluginControlSpec, parsedKindForSpec } from './plugin-spec.js';
import { isPluginDenialOverridden, pluginPolicyResource, pluginSwitchState } from './plugin-switches.js';
import { PLUGIN_SECTION, toPluginEntity, fromPluginEntity, readPluginList } from './config-v2.js';
import { toLoadablePluginSpec } from './loadable-plugin-spec.js';
import { canonicalPluginPath, resolveLocalPluginPath } from './plugin-paths.js';

// OpenCode 2 reads `plugins` (bare string or `{package, options}`) and still
// decodes the v1 `plugin` array with its `[spec, options]` tuples. OpenChamber
// reads both and always writes `plugins` with v2 entries.

const PLUGIN_FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-_.]*\.(js|ts|mjs|cjs)$/;

/**
 * @typedef {'user' | 'project'} PluginScope
 * @typedef {'control' | 'npm' | 'path' | 'git'} PluginParsedKind
 * @typedef {Object} PluginEntry
 * @property {string} id base64url encoded "config:scope:spec"
 * @property {string} spec
 * @property {Record<string, unknown>} [options]
 * @property {PluginScope} scope
 * @property {'config'} kind
 * @property {PluginParsedKind} parsedKind
 * @property {string} sourcePath absolute path to the config file
 * @property {string} [resolvedPath] canonical local target for display deduplication
 * @typedef {Object} PluginFile
 * @property {string} id base64url encoded "file:scope:fileName"
 * @property {string} fileName
 * @property {PluginScope} scope
 * @property {'file'} kind
 * @property {string} absolutePath
 * @property {string} [resolvedPath] canonical local target for display deduplication
 */

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateScope(scope) {
  if (scope !== AGENT_SCOPE.USER && scope !== AGENT_SCOPE.PROJECT) {
    throw codedError('Plugin scope must be user or project', 'INVALID_SCOPE');
  }
}

function validatePluginSpec(spec) {
  if (typeof spec !== 'string' || !spec.trim()) {
    throw codedError('Plugin spec must be a non-empty string', 'INVALID_SPEC');
  }
  if (spec.includes('\0')) {
    throw codedError('Plugin spec cannot contain null bytes', 'INVALID_SPEC');
  }
  return spec.trim();
}

function requireLoadablePluginSpec(spec) {
  const loadable = toLoadablePluginSpec(spec);
  if (loadable === null) {
    throw codedError(`OpenCode cannot load plugin "${spec}"`, 'UNLOADABLE_SPEC');
  }
  return loadable;
}

function hasOptions(options) {
  return isRecord(options) && Object.keys(options).length > 0;
}


/**
 * The configs OpenCode loads ahead of the layer that carries the switch denials,
 * earliest first. OpenCode lets the earliest-loaded policy win, so a matching
 * statement in one of them beats the denial. The managed file is
 * `OPENCODE_CONFIG`, right after the global files; when the user owns that
 * variable the denials go to `OPENCODE_CONFIG_CONTENT`, which loads after every
 * file.
 */
function configsAheadOfManagedLayer(layers, workingDirectory) {
  return layers.paths.customPath
    ? configSources(layers, workingDirectory).map((source) => source.config)
    : [layers.userConfig, layers.userOverrideConfig];
}

/** What a listing needs to report switches; null when this runtime has none. */
function readSwitchContext(switchStore, layers, workingDirectory) {
  if (!switchStore) return null;
  return { read: switchStore.read(), configsAhead: configsAheadOfManagedLayer(layers, workingDirectory) };
}

function validateFileName(fileName) {
  if (typeof fileName !== 'string' || !fileName) {
    throw codedError('Plugin file name is required', 'INVALID_FILENAME');
  }
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..') || !PLUGIN_FILE_NAME_PATTERN.test(fileName)) {
    throw codedError('Plugin file name must match /^[a-z0-9][a-z0-9-_.]*\\.(js|ts|mjs|cjs)$/ and cannot contain path traversal', 'INVALID_FILENAME');
  }
  return fileName;
}

function ensureProjectConfigPath(workingDirectory) {
  if (!workingDirectory) {
    throw codedError('Project scope requires working directory', 'INVALID_SCOPE');
  }
  const configDir = path.join(workingDirectory, '.opencode');
  fs.mkdirSync(configDir, { recursive: true });
  return path.join(configDir, 'opencode.json');
}

/**
 * Every config file OpenCode 2 takes plugins from, in its load order: the
 * global `opencode.json` and `opencode.jsonc`, then `OPENCODE_CONFIG`, then the
 * files found walking up from the project folder. Each file adds its own
 * entries; none replaces another's. A parent folder's file reaches every
 * project below it, so it counts as user scope, like the global file.
 */
function configSources(layers, workingDirectory) {
  const { userPath, userOverridePath, customPath } = layers.paths;
  const projectFiles = getProjectConfigCandidates(workingDirectory);
  const sources = [{ config: layers.userConfig, filePath: userPath, scope: AGENT_SCOPE.USER }];
  if (userOverridePath) {
    sources.push({ config: layers.userOverrideConfig, filePath: userOverridePath, scope: AGENT_SCOPE.USER });
  }
  if (customPath) {
    sources.push({ config: layers.customConfig, filePath: customPath, scope: AGENT_SCOPE.USER });
  }
  // A folder file that is also `OPENCODE_CONFIG` stays the user entry, so the
  // list, edits and duplicate checks all see one declaration.
  const seenFiles = new Set(sources.map((source) => canonicalPluginPath(source.filePath)));
  for (const filePath of getFolderConfigPaths(workingDirectory)) {
    if (seenFiles.has(canonicalPluginPath(filePath))) continue;
    sources.push({
      config: readConfigLayer(filePath).config,
      filePath,
      scope: projectFiles.includes(filePath) ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER,
    });
  }
  return sources;
}

function splitScopedValue(value) {
  const separator = value.indexOf(':');
  if (separator === -1) {
    throw codedError('Plugin id value must include scope', 'INVALID_SPEC');
  }
  return {
    scope: value.slice(0, separator),
    value: value.slice(separator + 1),
  };
}

function getPluginTarget(id, workingDirectory) {
  const decoded = decodePluginId(id);
  if (decoded.prefix !== 'config') {
    throw codedError('Plugin entry id must use config prefix', 'INVALID_SPEC');
  }
  const { scope, value: spec } = splitScopedValue(decoded.value);
  validateScope(scope);
  // Two files can both declare the spec; the later one is the entry the list
  // shows, so it is the one edited.
  const source = configSources(readConfigLayers(workingDirectory), workingDirectory).reverse().find((candidate) => (
    candidate.scope === scope
    && readPluginList(candidate.config).some((item) => item.entry.package === spec)
  ));
  if (!source) {
    return null;
  }
  const plugin = pluginArrayForWrite(source.config);
  const index = plugin.findIndex((raw) => parsePluginRaw(raw).spec === spec);
  if (index === -1) {
    return null;
  }
  return { source, plugin, index };
}

function pluginDirForScope(scope, workingDirectory) {
  validateScope(scope);
  if (scope === AGENT_SCOPE.PROJECT) {
    if (!workingDirectory) {
      throw codedError('Project scope requires working directory', 'INVALID_SCOPE');
    }
    return path.join(workingDirectory, '.opencode', 'plugins');
  }
  return path.join(OPENCODE_CONFIG_DIR, 'plugins');
}

/**
 * The directories OpenCode 2 scans for local plugins in a scope: `plugins/`
 * (where OpenChamber writes) and the v1 `plugin/`. Each holds `.ts`/`.js`
 * files and plugin package directories.
 */
const PLUGIN_DIR_KINDS = { v2: 'plugins', v1: 'plugin' };

/** One of the two plugin directories, by kind. An id names its kind, so a name
 * that exists in both directories still resolves to the row the user picked. */
function pluginDirForKind(scope, workingDirectory, kind) {
  const v2Dir = pluginDirForScope(scope, workingDirectory);
  return kind === 'v1' ? path.join(path.dirname(v2Dir), PLUGIN_DIR_KINDS.v1) : v2Dir;
}

function pluginDirsForScope(scope, workingDirectory) {
  return [
    pluginDirForKind(scope, workingDirectory, 'v2'),
    pluginDirForKind(scope, workingDirectory, 'v1'),
  ];
}

function fileTargetFromId(id, workingDirectory) {
  const decoded = decodePluginId(id);
  if (decoded.prefix !== 'file') {
    throw codedError('Plugin file id must use file prefix', 'INVALID_FILENAME');
  }
  const { scope, value: fileName } = splitScopedValue(decoded.value);
  validateScope(scope);
  validateFileName(fileName);
  return {
    fileName,
    scope,
    absolutePath: path.join(pluginDirForScope(scope, workingDirectory), fileName),
  };
}

function encodePluginId(prefix, value) {
  return Buffer.from(`${prefix}:${value}`).toString('base64url');
}

function decodePluginId(id) {
  const decoded = Buffer.from(id, 'base64url').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) {
    throw codedError('Invalid plugin id', 'INVALID_SPEC');
  }
  return { prefix: decoded.slice(0, separator), value: decoded.slice(separator + 1) };
}

/** Accept a v1 string/tuple or a v2 `{package, options}` object. */
/** @public Exposed to tests that dynamically import the plugins module. */
export function parsePluginRaw(raw) {
  const entity = toPluginEntity(raw);
  if (!entity) {
    throw codedError('Plugin spec must be a string, [string, object], or {package, options}', 'INVALID_SPEC');
  }
  const parsed = { spec: validatePluginSpec(entity.package) };
  if (hasOptions(entity.options)) parsed.options = { ...entity.options };
  return parsed;
}

/** Always v2: a bare string, or `{package, options}`. Never a tuple. */
/** @public Exposed to tests that dynamically import the plugins module. */
export function serializePluginEntry(entry) {
  const spec = validatePluginSpec(entry?.spec);
  // OpenCode reads only a bare `-name` string as a control entry; written as
  // `{package, options}` it becomes a package to install.
  if (isPluginControlSpec(spec) && hasOptions(entry?.options)) {
    throw codedError(`Plugin control entry "${spec}" takes no options`, 'INVALID_SPEC');
  }
  const serialized = fromPluginEntity({ package: spec, options: hasOptions(entry?.options) ? entry.options : undefined });
  if (serialized === null) {
    throw codedError('Plugin spec must be a non-empty string', 'INVALID_SPEC');
  }
  return serialized;
}

function migratePluginRaw(raw) {
  try {
    return serializePluginEntry(parsePluginRaw(raw));
  } catch {
    return raw;
  }
}

/**
 * The plugin array a write should target. Prefer the v2 `plugins` key; when the
 * file only has the v1 `plugin` array, migrate the whole array into `plugins`
 * in place so the two spellings cannot disagree.
 */
function pluginArrayForWrite(config) {
  const legacy = Array.isArray(config[PLUGIN_SECTION.v1]) ? config[PLUGIN_SECTION.v1] : null;
  if (!Array.isArray(config[PLUGIN_SECTION.v2])) config[PLUGIN_SECTION.v2] = [];
  if (legacy) {
    config[PLUGIN_SECTION.v2] = [
      // An entry we cannot parse is carried over untouched rather than dropped:
      // it is the user's config, and losing it would be worse than leaving it
      // in a shape OpenCode already refuses.
      ...legacy.map((raw) => migratePluginRaw(raw)),
      ...config[PLUGIN_SECTION.v2],
    ];
    delete config[PLUGIN_SECTION.v1];
  }
  return config[PLUGIN_SECTION.v2];
}

function listPluginEntries(workingDirectory, switchStore) {
  const layers = readConfigLayers(workingDirectory);
  const switches = readSwitchContext(switchStore, layers, workingDirectory);
  const sources = configSources(layers, workingDirectory);
  const entries = sources.flatMap((source) => (
    readPluginList(source.config).map((item) => {
      const entry = {
        id: encodePluginId('config', `${source.scope}:${item.entry.package}`),
        spec: item.entry.package,
        scope: source.scope,
        kind: 'config',
        parsedKind: parsedKindForSpec(item.entry.package),
        sourcePath: source.filePath,
        resolvedPath: resolveLocalPluginPath(item.entry.package, source.filePath),
        legacy: item.legacy,
      };
      if (item.entry.options !== undefined) entry.options = item.entry.options;
      const policyResource = pluginPolicyResource(item.entry.package, source.filePath);
      if (policyResource) {
        entry.policyResource = policyResource;
        if (switches) entry.switchState = pluginSwitchState(switches.read, policyResource, switches.configsAhead);
      }
      return entry;
    })
  ));
  // A spec in two files of one scope shares one id; the later file's entry is
  // listed, matching `getPluginTarget`.
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

function getPluginEntry(id, workingDirectory, switchStore) {
  return listPluginEntries(workingDirectory, switchStore).find((entry) => entry.id === id) || null;
}

/**
 * The plugin entries of the user's global config files (`opencode.json`, and
 * `opencode.jsonc` beside it), as the file new entries go to and the canonical
 * folder each local entry names. `OPENCODE_CONFIG` is left out: that file is
 * not the global config, whatever the plugins page's user scope treats it as.
 *
 * @returns {{ path: string, targets: string[] }}
 */
function readGlobalPluginEntries(layers = readConfigLayers(null)) {
  const sources = [{ config: layers.userConfig, filePath: layers.paths.userPath }];
  if (layers.paths.userOverridePath) sources.push({ config: layers.userOverrideConfig, filePath: layers.paths.userOverridePath });
  const targets = sources.flatMap((source) => readPluginList(source.config)
    .map((item) => resolveLocalPluginPath(item.entry.package, source.filePath))
    .filter((target) => typeof target === 'string'));
  return { path: layers.paths.userPath, targets };
}

/**
 * Write a local plugin folder into the user's global config, the file every
 * OpenCode on this machine reads and watches, whatever `OPENCODE_CONFIG` names.
 * The entry is the user's from then on: nothing here removes it. Idempotent:
 * a folder already listed in a global file is left as it is.
 *
 * @param {string} directory absolute plugin folder
 * @returns {{ path: string, added: boolean }}
 */
function addGlobalPluginEntry(directory) {
  const spec = requireLoadablePluginSpec(validatePluginSpec(directory));
  const layers = readConfigLayers(null);
  const targetPath = layers.paths.userPath;
  const failed = getLayerError(layers, targetPath);
  if (failed) throw codedError(failed.message, 'CONFIG_INVALID');
  if (readGlobalPluginEntries(layers).targets.includes(canonicalPluginPath(spec))) return { path: targetPath, added: false };
  pluginArrayForWrite(layers.userConfig).push(serializePluginEntry({ spec }));
  writeConfig(layers.userConfig, targetPath);
  return { path: targetPath, added: true };
}

function createPluginEntry(entry, workingDirectory) {
  const spec = requireLoadablePluginSpec(validatePluginSpec(entry?.spec));
  const scope = entry?.scope || AGENT_SCOPE.USER;
  validateScope(scope);

  const layers = readConfigLayers(workingDirectory);
  const existing = configSources(layers, workingDirectory).find((source) => (
    source.scope === scope
    && readPluginList(source.config).some((item) => item.entry.package === spec)
  ));
  if (existing) {
    throw codedError(`Plugin "${spec}" already exists`, 'ENTRY_EXISTS');
  }

  let targetPath;
  let config;
  if (scope === AGENT_SCOPE.PROJECT) {
    targetPath = ensureProjectConfigPath(workingDirectory);
    config = fs.existsSync(targetPath) ? readConfigFile(targetPath) : {};
  } else {
    targetPath = layers.paths.customPath || layers.paths.userPath;
    config = layers.paths.customPath ? layers.customConfig : layers.userConfig;
  }

  pluginArrayForWrite(config).push(serializePluginEntry({ spec, options: entry.options }));
  writeConfig(config, targetPath);
}

function updatePluginEntry(id, updates, workingDirectory) {
  const target = getPluginTarget(id, workingDirectory);
  if (!target) {
    throw codedError('Plugin entry not found', 'NOT_FOUND');
  }
  const existing = parsePluginRaw(target.plugin[target.index]);
  let nextSpec = updates?.spec === undefined ? existing.spec : validatePluginSpec(updates.spec);
  // An entry already in the config keeps its spec as written; only a changed
  // spec has to be one OpenCode loads.
  if (nextSpec !== existing.spec) nextSpec = requireLoadablePluginSpec(nextSpec);
  const nextOptions = updates?.options === undefined ? existing.options : updates.options;
  target.plugin[target.index] = serializePluginEntry({ spec: nextSpec, options: nextOptions });
  writeConfig(target.source.config, target.source.filePath);
}

function deletePluginEntry(id, workingDirectory) {
  const target = getPluginTarget(id, workingDirectory);
  if (!target) {
    throw codedError('Plugin entry not found', 'NOT_FOUND');
  }
  target.plugin.splice(target.index, 1);
  if (target.plugin.length === 0) {
    delete target.source.config[PLUGIN_SECTION.v2];
  }
  writeConfig(target.source.config, target.source.filePath);
}

/**
 * Record one switch in OpenChamber's own store. The managed config layer of the
 * OpenCode OpenChamber starts carries the deny; the user's config is not
 * written. A rule of theirs that would beat the deny refuses the change, so the
 * page never reports a plugin as off while OpenCode keeps loading it.
 */
function recordPluginSwitch(switchStore, resource, enabled, workingDirectory) {
  if (!enabled) {
    const configsAhead = configsAheadOfManagedLayer(readConfigLayers(workingDirectory), workingDirectory);
    if (isPluginDenialOverridden(resource, configsAhead)) {
      throw codedError('A rule in the OpenCode config allows this plugin, so OpenChamber cannot switch it off', 'SWITCH_OVERRIDDEN');
    }
  }
  return { enabled, resource, ...switchStore.set(resource, enabled) };
}

function setPluginEntryEnabled(id, enabled, workingDirectory, switchStore) {
  if (!switchStore) {
    throw codedError('Plugin switches are only available for the OpenCode OpenChamber starts', 'SWITCH_UNAVAILABLE');
  }
  const target = getPluginTarget(id, workingDirectory);
  if (!target) {
    throw codedError('Plugin entry not found', 'NOT_FOUND');
  }
  const entry = parsePluginRaw(target.plugin[target.index]);
  const resource = pluginPolicyResource(entry.spec, target.source.filePath);
  if (!resource) {
    throw codedError(`Plugin "${entry.spec}" has no policy target`, 'INVALID_SPEC');
  }
  return recordPluginSwitch(switchStore, resource, enabled, workingDirectory);
}

/**
 * A local plugin is switched off by its absolute path: OpenCode matches
 * `plugin:<absolute path>` for a plugin file or package directory.
 */
function pluginPathTargetFromId(id, workingDirectory) {
  const decoded = decodePluginId(id);
  const isLegacy = decoded.prefix === 'legacy' || decoded.prefix === 'legacyPackage';
  const isPackage = decoded.prefix === 'package' || decoded.prefix === 'legacyPackage';
  const isFile = decoded.prefix === 'file' || decoded.prefix === 'legacy';
  if (!isFile && !isPackage) {
    throw codedError('Plugin file id must use a file, package or legacy prefix', 'INVALID_FILENAME');
  }
  const { scope, value: name } = splitScopedValue(decoded.value);
  validateScope(scope);
  if (isFile) {
    validateFileName(name);
  } else if (!name || name.includes('..') || /[\\/]/.test(name)) {
    throw codedError('Plugin package name is invalid', 'INVALID_FILENAME');
  }
  // The prefix names the directory the row came from. Searching both would let
  // a name that exists in `plugins/` and `plugin/` deny the wrong one.
  const candidate = path.join(pluginDirForKind(scope, workingDirectory, isLegacy ? 'v1' : 'v2'), name);
  if (isPackage && !fs.existsSync(candidate)) {
    throw codedError(`Plugin file "${name}" not found`, 'NOT_FOUND');
  }
  return { scope, absolutePath: candidate };
}

function setPluginFileEnabled(id, enabled, workingDirectory, switchStore) {
  if (!switchStore) {
    throw codedError('Plugin switches are only available for the OpenCode OpenChamber starts', 'SWITCH_UNAVAILABLE');
  }
  const target = pluginPathTargetFromId(id, workingDirectory);
  return recordPluginSwitch(switchStore, `plugin:${target.absolutePath}`, enabled, workingDirectory);
}

function listPluginDirFiles(workingDirectory, switchStore) {
  const switches = readSwitchContext(switchStore, readConfigLayers(workingDirectory), workingDirectory);
  const scopes = [AGENT_SCOPE.USER];
  if (workingDirectory) {
    scopes.push(AGENT_SCOPE.PROJECT);
  }
  return scopes.flatMap((scope) => pluginDirsForScope(scope, workingDirectory).flatMap((dir) => {
    if (!fs.existsSync(dir)) {
      return [];
    }
    const editable = dir === pluginDirForScope(scope, workingDirectory);
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.includes('..') && !entry.name.startsWith('.'))
      .flatMap((entry) => {
        const absolutePath = path.join(dir, entry.name);
        if (entry.isFile() && PLUGIN_FILE_NAME_PATTERN.test(entry.name)) {
          // Only files in the v2 `plugins/` directory are editable through
          // the file id; a v1 `plugin/` file is listed for what it is.
          return editable
            ? [{ id: encodePluginId('file', `${scope}:${entry.name}`), fileName: entry.name, scope, kind: 'file', absolutePath, resolvedPath: canonicalPluginPath(absolutePath) }]
            : [{ id: encodePluginId('legacy', `${scope}:${entry.name}`), fileName: entry.name, scope, kind: 'package', absolutePath, resolvedPath: canonicalPluginPath(absolutePath) }];
        }
        if (entry.isDirectory()) {
          // A plugin package (a directory with its own entry point): OpenCode
          // loads it, OpenChamber only lists it.
          return [{ id: encodePluginId(editable ? 'package' : 'legacyPackage', `${scope}:${entry.name}`), fileName: entry.name, scope, kind: 'package', absolutePath, resolvedPath: canonicalPluginPath(absolutePath) }];
        }
        return [];
      });
  })).map((item) => {
    const policyResource = `plugin:${item.absolutePath}`;
    return switches
      ? { ...item, policyResource, switchState: pluginSwitchState(switches.read, policyResource, switches.configsAhead) }
      : { ...item, policyResource };
  });
}

function readPluginDirFile(id, workingDirectory) {
  const target = fileTargetFromId(id, workingDirectory);
  if (!fs.existsSync(target.absolutePath)) {
    return null;
  }
  return {
    fileName: target.fileName,
    scope: target.scope,
    content: fs.readFileSync(target.absolutePath, 'utf8'),
  };
}

function writePluginDirFile(file, workingDirectory, opts = {}) {
  const fileName = validateFileName(file?.fileName);
  const scope = file?.scope || AGENT_SCOPE.USER;
  validateScope(scope);
  const dir = pluginDirForScope(scope, workingDirectory);
  const absolutePath = path.join(dir, fileName);
  if (!opts.overwrite && fs.existsSync(absolutePath)) {
    throw codedError(`Plugin file "${fileName}" already exists`, 'FILE_EXISTS');
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(absolutePath, file?.content ?? '', 'utf8');
}

function deletePluginDirFile(id, workingDirectory) {
  const target = fileTargetFromId(id, workingDirectory);
  if (!fs.existsSync(target.absolutePath)) {
    throw codedError(`Plugin file "${target.fileName}" not found`, 'NOT_FOUND');
  }
  fs.unlinkSync(target.absolutePath);
}

export {
  listPluginEntries,
  getPluginEntry,
  readGlobalPluginEntries,
  addGlobalPluginEntry,
  createPluginEntry,
  updatePluginEntry,
  deletePluginEntry,
  setPluginEntryEnabled,
  setPluginFileEnabled,
  listPluginDirFiles,
  readPluginDirFile,
  writePluginDirFile,
  deletePluginDirFile,
  encodePluginId,
  decodePluginId
};
