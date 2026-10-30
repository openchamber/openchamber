import { isRecord } from '../shared/guards.js';
import fs from 'fs';
import path from 'path';
import {
  AGENT_SCOPE,
  OPENCODE_CONFIG_DIR,
  readConfigFile,
  readConfigLayer,
  writeConfig,
} from './shared.js';
import { isPluginControlSpec, parsedKindForSpec } from './plugin-spec.js';
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


// `OPENCODE_CONFIG` is one more file OpenCode reads on top of the global
// config; the global config folder stays where it is, and OpenCode never scans
// a `plugins/` folder next to the `OPENCODE_CONFIG` file.
function getActiveUserConfigPaths() {
  return [
    path.join(OPENCODE_CONFIG_DIR, 'opencode.json'),
    path.join(OPENCODE_CONFIG_DIR, 'opencode.jsonc'),
  ];
}

function getActiveCustomConfigPath() {
  return process.env.OPENCODE_CONFIG ? path.resolve(process.env.OPENCODE_CONFIG) : null;
}

function getPrimaryUserConfigPath() {
  const [defaultPath, ...fallbackPaths] = getActiveUserConfigPaths();
  for (const userPath of [defaultPath, ...fallbackPaths]) {
    if (fs.existsSync(userPath)) {
      return userPath;
    }
  }
  return defaultPath;
}

function getProjectConfigPath(workingDirectory) {
  if (!workingDirectory) return null;
  const candidates = [
    path.join(workingDirectory, 'opencode.json'),
    path.join(workingDirectory, 'opencode.jsonc'),
    path.join(workingDirectory, '.opencode', 'opencode.json'),
    path.join(workingDirectory, '.opencode', 'opencode.jsonc'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function readPluginConfigLayers(workingDirectory) {
  const customPath = getActiveCustomConfigPath();
  const userPath = getPrimaryUserConfigPath();
  const projectPath = getProjectConfigPath(workingDirectory);
  const userLayer = readConfigLayer(userPath);
  const projectLayer = readConfigLayer(projectPath);
  const customLayer = readConfigLayer(customPath);
  return {
    userConfig: userLayer.config,
    projectConfig: projectLayer.config,
    customConfig: customLayer.config,
    paths: {
      userPath,
      projectPath,
      customPath,
    },
    layerErrors: [
      userLayer.error && { path: userPath, code: userLayer.error.code, message: userLayer.error.message },
      projectLayer.error && projectPath && { path: projectPath, code: projectLayer.error.code, message: projectLayer.error.message },
      customLayer.error && customPath && { path: customPath, code: customLayer.error.code, message: customLayer.error.message },
    ].filter(Boolean),
  };
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
 * The config files OpenCode 2 takes plugins from, in its load order: the global
 * file, then `OPENCODE_CONFIG`, then the project file. Each one adds its own
 * entries; `OPENCODE_CONFIG` replaces none of the global ones.
 */
function configSources(layers) {
  const sources = [{ config: layers.userConfig, filePath: layers.paths.userPath, scope: AGENT_SCOPE.USER }];
  if (layers.paths.customPath) {
    sources.push({ config: layers.customConfig, filePath: layers.paths.customPath, scope: AGENT_SCOPE.USER });
  }
  if (layers.paths.projectPath) {
    sources.push({ config: layers.projectConfig, filePath: layers.paths.projectPath, scope: AGENT_SCOPE.PROJECT });
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
  const layers = readPluginConfigLayers(workingDirectory);
  // Two user files can both declare the spec; the later one is the entry the
  // list shows, so it is the one edited.
  const source = configSources(layers).reverse().find((candidate) => (
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
function pluginDirsForScope(scope, workingDirectory) {
  const preferred = pluginDirForScope(scope, workingDirectory);
  return [preferred, path.join(path.dirname(preferred), 'plugin')];
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

function listPluginEntries(workingDirectory) {
  const layers = readPluginConfigLayers(workingDirectory);
  const seenSources = new Set();
  const entries = configSources(layers).flatMap((source) => {
    const sourcePath = canonicalPluginPath(source.filePath);
    if (source.scope === AGENT_SCOPE.PROJECT && seenSources.has(sourcePath)) return [];
    seenSources.add(sourcePath);
    return readPluginList(source.config).map((item) => {
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
      return entry;
    });
  });
  // A spec in both the global file and `OPENCODE_CONFIG` shares one id; the
  // `OPENCODE_CONFIG` entry is listed, matching `getPluginTarget`.
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

function getPluginEntry(id, workingDirectory) {
  return listPluginEntries(workingDirectory).find((entry) => entry.id === id) || null;
}

function createPluginEntry(entry, workingDirectory) {
  const spec = requireLoadablePluginSpec(validatePluginSpec(entry?.spec));
  const scope = entry?.scope || AGENT_SCOPE.USER;
  validateScope(scope);

  const layers = readPluginConfigLayers(workingDirectory);
  const existing = configSources(layers).find((source) => (
    source.scope === scope
    && readPluginList(source.config).some((item) => item.entry.package === spec)
  ));
  if (existing) {
    throw codedError(`Plugin "${spec}" already exists`, 'ENTRY_EXISTS');
  }

  let targetPath = getPrimaryUserConfigPath();
  let config = {};
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

function listPluginDirFiles(workingDirectory) {
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
          return [{ id: encodePluginId('package', `${scope}:${entry.name}`), fileName: entry.name, scope, kind: 'package', absolutePath, resolvedPath: canonicalPluginPath(absolutePath) }];
        }
        return [];
      });
  }));
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
  createPluginEntry,
  updatePluginEntry,
  deletePluginEntry,
  listPluginDirFiles,
  readPluginDirFile,
  writePluginDirFile,
  deletePluginDirFile,
  encodePluginId,
  decodePluginId
};
