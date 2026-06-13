import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AGENT_SCOPE,
  readConfigFile,
  writeConfig,
} from './shared.js';
import { isPathSpec, parseNpmSpec, parsePathSpec, isExactSemver } from './plugin-spec.js';
import { getNpmInfo } from './npm-registry.js';

const PLUGIN_FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-_.]*\.(js|ts|mjs|cjs)$/;

/**
 * @typedef {'user' | 'project'} PluginScope
 * @typedef {'npm' | 'path'} PluginParsedKind
 * @typedef {Object} PluginEntry
 * @property {string} id base64url encoded "config:scope:spec"
 * @property {string} spec
 * @property {Record<string, unknown>} [options]
 * @property {PluginScope} scope
 * @property {'config'} kind
 * @property {PluginParsedKind} parsedKind
 * @property {string} sourcePath absolute path to the config file
 * @typedef {Object} PluginFile
 * @property {string} id base64url encoded "file:scope:fileName"
 * @property {string} fileName
 * @property {PluginScope} scope
 * @property {'file'} kind
 * @property {string} absolutePath
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

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOptions(options) {
  return isRecord(options) && Object.keys(options).length > 0;
}

function parsedKindForSpec(spec) {
  // Path indicators must include Windows paths; scoped npm packages also contain '/'.
  // Do NOT use `includes(path.sep)` — scoped npm packages legitimately contain '/' (e.g. `@gitlab/opencode-gitlab-auth`).
  return isPathSpec(spec) ? 'path' : 'npm';
}

function getActiveOpencodeConfigDir() {
  const customConfigPath = process.env.OPENCODE_CONFIG;
  if (customConfigPath) {
    return path.dirname(path.resolve(customConfigPath));
  }
  return path.join(os.homedir(), '.config', 'opencode');
}

function getActiveUserConfigPaths() {
  const configDir = getActiveOpencodeConfigDir();
  return [
    path.join(configDir, 'config.json'),
    path.join(configDir, 'opencode.json'),
    path.join(configDir, 'opencode.jsonc'),
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
  return {
    userConfig: readConfigFile(userPath),
    projectConfig: readConfigFile(projectPath),
    customConfig: readConfigFile(customPath),
    paths: {
      userPath,
      projectPath,
      customPath,
    },
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

function configSources(layers) {
  const sources = [];
  if (layers.paths.customPath) {
    sources.push({ config: layers.customConfig, filePath: layers.paths.customPath, scope: AGENT_SCOPE.USER });
  } else {
    sources.push({ config: layers.userConfig, filePath: layers.paths.userPath, scope: AGENT_SCOPE.USER });
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
  const source = configSources(layers).find((candidate) => candidate.scope === scope);
  const plugin = Array.isArray(source?.config?.plugin) ? source.config.plugin : [];
  const index = plugin.findIndex((raw) => parsePluginRaw(raw).spec === spec);
  if (!source || index === -1) {
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
  return path.join(getActiveOpencodeConfigDir(), 'plugins');
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

function parsePluginRaw(raw) {
  if (typeof raw === 'string') {
    return { spec: validatePluginSpec(raw) };
  }
  if (Array.isArray(raw) && raw.length === 2 && isRecord(raw[1])) {
    return { spec: validatePluginSpec(raw[0]), options: { ...raw[1] } };
  }
  throw codedError('Plugin spec must be a string or [string, object]', 'INVALID_SPEC');
}

function serializePluginEntry(entry) {
  const spec = validatePluginSpec(entry?.spec);
  if (hasOptions(entry?.options)) {
    return [spec, { ...entry.options }];
  }
  return spec;
}

function listPluginEntries(workingDirectory) {
  const layers = readPluginConfigLayers(workingDirectory);
  return configSources(layers).flatMap((source) => {
    if (!Array.isArray(source.config?.plugin)) {
      return [];
    }
    return source.config.plugin.map((raw) => {
      const parsed = parsePluginRaw(raw);
      return {
        id: encodePluginId('config', `${source.scope}:${parsed.spec}`),
        spec: parsed.spec,
        ...(parsed.options !== undefined ? { options: parsed.options } : {}),
        scope: source.scope,
        kind: 'config',
        parsedKind: parsedKindForSpec(parsed.spec),
        sourcePath: source.filePath,
      };
    });
  });
}

function getPluginEntry(id, workingDirectory) {
  return listPluginEntries(workingDirectory).find((entry) => entry.id === id) || null;
}

function createPluginEntry(entry, workingDirectory) {
  const spec = validatePluginSpec(entry?.spec);
  const scope = entry?.scope || AGENT_SCOPE.USER;
  validateScope(scope);

  const layers = readPluginConfigLayers(workingDirectory);
  const existing = configSources(layers).find((source) => (
    source.scope === scope
    && Array.isArray(source.config?.plugin)
    && source.config.plugin.some((raw) => parsePluginRaw(raw).spec === spec)
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

  if (!Array.isArray(config.plugin)) {
    config.plugin = [];
  }
  config.plugin.push(serializePluginEntry({ spec, options: entry.options }));
  writeConfig(config, targetPath);
}

function updatePluginEntry(id, updates, workingDirectory) {
  const target = getPluginTarget(id, workingDirectory);
  if (!target) {
    throw codedError('Plugin entry not found', 'NOT_FOUND');
  }
  const existing = parsePluginRaw(target.plugin[target.index]);
  const nextSpec = updates?.spec === undefined ? existing.spec : validatePluginSpec(updates.spec);
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
    delete target.source.config.plugin;
  }
  writeConfig(target.source.config, target.source.filePath);
}

function listPluginDirFiles(workingDirectory) {
  const scopes = [AGENT_SCOPE.USER];
  if (workingDirectory) {
    scopes.push(AGENT_SCOPE.PROJECT);
  }
  return scopes.flatMap((scope) => {
    const dir = pluginDirForScope(scope, workingDirectory);
    if (!fs.existsSync(dir)) {
      return [];
    }
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && PLUGIN_FILE_NAME_PATTERN.test(entry.name) && !entry.name.includes('..'))
      .map((entry) => ({
        id: encodePluginId('file', `${scope}:${entry.name}`),
        fileName: entry.name,
        scope,
        kind: 'file',
        absolutePath: path.join(dir, entry.name),
      }));
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

/**
 * @typedef {Object} PluginStatusItem
 * @property {string} id
 * @property {string} name
 * @property {string} shortName
 * @property {'ok'|'warning'|'error'} status
 * @property {string} [error]
 * @property {string} command
 */

/**
 * Truncate a name to at most 24 characters, adding ellipsis if truncated.
 * @param {string} name
 * @returns {string}
 */
function truncateShortName(name) {
  if (name.length <= 24) return name;
  return name.slice(0, 24) + '\u2026';
}

/**
 * Build an investigation command string for a plugin status item.
 * @param {string} name
 * @param {string} id
 * @param {'ok'|'warning'|'error'} status
 * @param {string} [error]
 * @returns {string}
 */
function buildInvestigateCommand(name, id, status, error) {
  const errorPart = error ? `. Error: ${error}` : '';
  return `Investigate plugin '${name}' (id: ${id}). Status: ${status}${errorPart}.`;
}

/**
 * Build a PluginStatusItem result object.
 * @param {string} id
 * @param {string} name
 * @param {'ok'|'warning'|'error'} status
 * @param {string|undefined} error
 * @returns {PluginStatusItem}
 */
function buildPluginStatusResult(id, name, status, error) {
  return {
    id,
    name,
    shortName: truncateShortName(name),
    status,
    ...(error !== undefined ? { error } : {}),
    command: buildInvestigateCommand(name, id, status, error),
  };
}

/**
 * Derive status for a single plugin entry.
 * @param {PluginEntry} entry
 * @param {string|null} directory
 * @returns {Promise<PluginStatusItem>}
 */
async function getStatusForEntry(entry, directory) {
  const { id, spec, parsedKind } = entry;
  let name = spec;
  let status = 'ok';
  let error = undefined;

  if (parsedKind === 'npm') {
    try {
      const parsed = parseNpmSpec(spec);
      if (parsed.malformed) {
        status = 'error';
        error = 'Spec syntax is malformed';
        name = spec;
      } else {
        name = parsed.name;
        const info = await getNpmInfo(parsed.name);
        if (!info.ok) {
          status = 'error';
          error = info.error || `Registry lookup failed (status ${info.status})`;
        } else if (parsed.version !== null && !isExactSemver(parsed.version)) {
          status = 'warning';
          error = 'Version spec is not exact semver';
        } else if (parsed.version !== null && isExactSemver(parsed.version) && !info.versions.includes(parsed.version)) {
          status = 'error';
          error = `Version ${parsed.version} not found in registry`;
        }
      }
    } catch (e) {
      status = 'error';
      error = String(e?.message ?? e);
    }
    return buildPluginStatusResult(id, name, status, error);
  }

  if (parsedKind === 'path') {
    try {
      const { absolutePath } = parsePathSpec(spec, {
        homedir: os.homedir(),
        cwd: directory || os.homedir(),
      });

      try {
        await fs.promises.access(absolutePath, fs.constants.R_OK);
      } catch {
        const basename = path.basename(absolutePath);
        const ext = path.extname(absolutePath);
        name = ext ? basename.slice(0, -ext.length) : basename;
        return buildPluginStatusResult(
          id, name, 'error',
          `File not found or not readable: ${basename}`,
        );
      }

      try {
        const content = await fs.promises.readFile(absolutePath, 'utf8');
        let pluginMeta;
        try {
          pluginMeta = JSON.parse(content);
        } catch {
          // File exists and is readable but not JSON (e.g. JS/TS plugin file).
          // Treat as ok — cannot validate JSON-only fields like name/type.
          const basename = path.basename(absolutePath);
          const ext = path.extname(absolutePath);
          name = ext ? basename.slice(0, -ext.length) : basename;
          return buildPluginStatusResult(id, name, 'ok');
        }

        name = typeof pluginMeta.name === 'string' && pluginMeta.name
          ? pluginMeta.name
          : path.basename(absolutePath).replace(path.extname(absolutePath), '');

        if (!pluginMeta.name || typeof pluginMeta.name !== 'string' || !pluginMeta.type || typeof pluginMeta.type !== 'string') {
          status = 'error';
          error = 'Plugin file missing required fields (name or type)';
        } else if (pluginMeta.deprecated) {
          status = 'warning';
          error = 'Plugin uses deprecated field';
        }
      } catch (e) {
        status = 'error';
        error = String(e?.message ?? e);
      }
    } catch (e) {
      status = 'error';
      error = String(e?.message ?? e);
    }
    return buildPluginStatusResult(id, name, status, error);
  }

  // Unknown kind
  return buildPluginStatusResult(
    id,
    spec,
    'error',
    `Unknown plugin kind: ${parsedKind}`,
  );
}

/**
 * Get status health check for every plugin entry.
 * Validates npm specs against the registry, checks path specs for file existence
 * and metadata completeness. Never throws — returns error status per item.
 *
 * @param {string|null} directory working directory
 * @returns {Promise<Array<PluginStatusItem>>}
 */
export async function getPluginStatus(directory) {
  const entries = listPluginEntries(directory);
  const results = await Promise.all(
    entries.map((entry) => getStatusForEntry(entry, directory)),
  );
  return results;
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
  decodePluginId,
  parsePluginRaw,
  serializePluginEntry,
};
