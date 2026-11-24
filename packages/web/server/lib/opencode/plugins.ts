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
} from './config-files.js';
import { isPluginControlSpec, parsedKindForSpec } from './plugin-spec.js';
import { isPluginDenialOverridden, pluginPolicyResource, pluginSwitchState } from './plugin-switches.js';
import { PLUGIN_SECTION, toPluginEntity, fromPluginEntity, readPluginList } from './config-v2.js';
import { toLoadablePluginSpec } from './loadable-plugin-spec.js';
import { canonicalPluginPath, isExistingPluginFileName, pluginDirEntryKind, resolveLocalPluginPath } from './plugin-paths.js';
import { isString } from '../shared/object-guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { OpenCodeConfigLayer, OpenCodeConfigLayers } from './config-files.js';
import type { PluginSwitchStore, PluginSwitchState } from './plugin-switches.js';

export type PluginScope = 'user' | 'project';
export type PluginParsedKind = ReturnType<typeof parsedKindForSpec>;
export interface PluginEntry {
  id: string;
  spec: string;
  options?: JsonObject;
  scope: PluginScope;
  kind: 'config';
  parsedKind: PluginParsedKind;
  sourcePath: string;
  resolvedPath: string | undefined;
  legacy: boolean;
  policyResource?: string;
  switchState?: PluginSwitchState;
}
export interface PluginFile {
  id: string;
  fileName: string;
  scope: PluginScope;
  kind: 'file' | 'package';
  absolutePath: string;
  resolvedPath: string;
}
export interface PluginInput {
  spec?: JsonValue | undefined;
  options?: JsonValue | undefined;
  scope?: JsonValue | undefined;
}
export interface PluginFileInput {
  fileName?: JsonValue | undefined;
  scope?: JsonValue | undefined;
  content?: unknown;
}
interface ConfigSource {
  config: OpenCodeConfigLayer;
  filePath: string;
  scope: PluginScope;
}
export interface ParsedPlugin {
  spec: string;
  options?: JsonObject;
}

const PLUGIN_FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-_.]*\.(js|ts|mjs|cjs)$/;

function codedError(message: string, code: string) {
  const error: Error & { code?: string } = new Error(message);
  error.code = code;
  return error;
}

function validateScope(scope: JsonValue | undefined): asserts scope is PluginScope {
  if (scope !== AGENT_SCOPE.USER && scope !== AGENT_SCOPE.PROJECT) {
    throw codedError('Plugin scope must be user or project', 'INVALID_SCOPE');
  }
}

function validatePluginSpec(spec: JsonValue | undefined) {
  if (!isString(spec) || !spec.trim()) {
    throw codedError('Plugin spec must be a non-empty string', 'INVALID_SPEC');
  }
  if (spec.includes('\0')) {
    throw codedError('Plugin spec cannot contain null bytes', 'INVALID_SPEC');
  }
  return spec.trim();
}

function requireLoadablePluginSpec(spec: string) {
  const loadable = toLoadablePluginSpec(spec);
  if (loadable === null) {
    throw codedError(`OpenCode cannot load plugin "${spec}"`, 'UNLOADABLE_SPEC');
  }
  return loadable;
}

function hasOptions(options: JsonValue | undefined): options is JsonObject {
  return isRecord(options) && Object.keys(options).length > 0;
}


function configsAheadOfManagedLayer(layers: OpenCodeConfigLayers, workingDirectory?: string | null) {
  return layers.paths.customPath
    ? configSources(layers, workingDirectory).map((source) => source.config)
    : [layers.userConfig, layers.userOverrideConfig];
}

function readSwitchContext(switchStore: PluginSwitchStore | null | undefined, layers: OpenCodeConfigLayers, workingDirectory?: string | null) {
  if (!switchStore) return null;
  return { read: switchStore.read(), configsAhead: configsAheadOfManagedLayer(layers, workingDirectory) };
}

function validateFileName(fileName: JsonValue | undefined) {
  if (!isString(fileName) || !fileName) {
    throw codedError('Plugin file name is required', 'INVALID_FILENAME');
  }
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..') || !PLUGIN_FILE_NAME_PATTERN.test(fileName)) {
    throw codedError('Plugin file name must match /^[a-z0-9][a-z0-9-_.]*\\.(js|ts|mjs|cjs)$/ and cannot contain path traversal', 'INVALID_FILENAME');
  }
  return fileName;
}

function validateExistingFileName(fileName: JsonValue | undefined) {
  if (!isExistingPluginFileName(fileName)) {
    throw codedError('Plugin file name is invalid', 'INVALID_FILENAME');
  }
  return fileName;
}

function ensureProjectConfigPath(workingDirectory?: string | null) {
  if (!workingDirectory) {
    throw codedError('Project scope requires working directory', 'INVALID_SCOPE');
  }
  const configDir = path.join(workingDirectory, '.opencode');
  fs.mkdirSync(configDir, { recursive: true });
  return path.join(configDir, 'opencode.json');
}

function configSources(layers: OpenCodeConfigLayers, workingDirectory?: string | null) {
  const { userPath, userOverridePath, customPath } = layers.paths;
  const projectFiles = getProjectConfigCandidates(workingDirectory);
  const sources: ConfigSource[] = [{ config: layers.userConfig, filePath: userPath, scope: AGENT_SCOPE.USER }];
  if (userOverridePath) {
    sources.push({ config: layers.userOverrideConfig, filePath: userOverridePath, scope: AGENT_SCOPE.USER });
  }
  if (customPath) {
    sources.push({ config: layers.customConfig, filePath: customPath, scope: AGENT_SCOPE.USER });
  }
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

function splitScopedValue(value: string) {
  const separator = value.indexOf(':');
  if (separator === -1) {
    throw codedError('Plugin id value must include scope', 'INVALID_SPEC');
  }
  return {
    scope: value.slice(0, separator),
    value: value.slice(separator + 1),
  };
}

function getPluginTarget(id: string, workingDirectory?: string | null) {
  const decoded = decodePluginId(id);
  if (decoded.prefix !== 'config') {
    throw codedError('Plugin entry id must use config prefix', 'INVALID_SPEC');
  }
  const { scope, value: spec } = splitScopedValue(decoded.value);
  validateScope(scope);
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

function pluginDirForScope(scope: JsonValue | undefined, workingDirectory?: string | null) {
  validateScope(scope);
  if (scope === AGENT_SCOPE.PROJECT) {
    if (!workingDirectory) {
      throw codedError('Project scope requires working directory', 'INVALID_SCOPE');
    }
    return path.join(workingDirectory, '.opencode', 'plugins');
  }
  return path.join(OPENCODE_CONFIG_DIR, 'plugins');
}

const PLUGIN_DIR_KINDS = { v2: 'plugins', v1: 'plugin' };

function pluginDirForKind(scope: JsonValue | undefined, workingDirectory: string | null | undefined, kind: 'v1' | 'v2') {
  const v2Dir = pluginDirForScope(scope, workingDirectory);
  return kind === 'v1' ? path.join(path.dirname(v2Dir), PLUGIN_DIR_KINDS.v1) : v2Dir;
}

function pluginDirsForScope(scope: JsonValue | undefined, workingDirectory?: string | null) {
  return [
    pluginDirForKind(scope, workingDirectory, 'v2'),
    pluginDirForKind(scope, workingDirectory, 'v1'),
  ];
}

function fileTargetFromId(id: string, workingDirectory?: string | null) {
  const decoded = decodePluginId(id);
  if (decoded.prefix !== 'file') {
    throw codedError('Plugin file id must use file prefix', 'INVALID_FILENAME');
  }
  const { scope, value: fileName } = splitScopedValue(decoded.value);
  validateScope(scope);
  validateExistingFileName(fileName);
  return {
    fileName,
    scope,
    absolutePath: path.join(pluginDirForScope(scope, workingDirectory), fileName),
  };
}

function encodePluginId(prefix: string, value: string) {
  return Buffer.from(`${prefix}:${value}`).toString('base64url');
}

function decodePluginId(id: string) {
  const decoded = Buffer.from(id, 'base64url').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) {
    throw codedError('Invalid plugin id', 'INVALID_SPEC');
  }
  return { prefix: decoded.slice(0, separator), value: decoded.slice(separator + 1) };
}

export function parsePluginRaw(raw: JsonValue | undefined) {
  const entity = toPluginEntity(raw);
  if (!entity) {
    throw codedError('Plugin spec must be a string, [string, object], or {package, options}', 'INVALID_SPEC');
  }
  const parsed: ParsedPlugin = { spec: validatePluginSpec(entity.package) };
  if (hasOptions(entity.options)) parsed.options = { ...entity.options };
  return parsed;
}

export function serializePluginEntry(entry: PluginInput | null | undefined) {
  const spec = validatePluginSpec(entry?.spec);
  if (isPluginControlSpec(spec) && hasOptions(entry?.options)) {
    throw codedError(`Plugin control entry "${spec}" takes no options`, 'INVALID_SPEC');
  }
  const serialized = fromPluginEntity({ package: spec, options: hasOptions(entry?.options) ? entry.options : undefined });
  if (serialized === null) {
    throw codedError('Plugin spec must be a non-empty string', 'INVALID_SPEC');
  }
  return serialized;
}

function migratePluginRaw(raw: JsonValue) {
  try {
    return serializePluginEntry(parsePluginRaw(raw));
  } catch {
    return raw;
  }
}

function pluginArrayForWrite(config: OpenCodeConfigLayer) {
  const legacyValue = config[PLUGIN_SECTION.v1];
  const legacy = Array.isArray(legacyValue) ? legacyValue : null;
  if (!Array.isArray(config[PLUGIN_SECTION.v2])) config[PLUGIN_SECTION.v2] = [];
  if (legacy) {
    config[PLUGIN_SECTION.v2] = [
      ...legacy.map((raw) => migratePluginRaw(raw)),
      ...retainedPluginArray(config),
    ];
    delete config[PLUGIN_SECTION.v1];
  }
  return retainedPluginArray(config);
}

function retainedPluginArray(config: OpenCodeConfigLayer) {
  const entries = config[PLUGIN_SECTION.v2];
  if (!Array.isArray(entries)) throw new Error('Missing plugin array after initialization');
  return entries;
}

function listPluginEntries(workingDirectory?: string | null, switchStore?: PluginSwitchStore | null) {
  const layers = readConfigLayers(workingDirectory);
  const switches = readSwitchContext(switchStore, layers, workingDirectory);
  const sources = configSources(layers, workingDirectory);
  const entries = sources.flatMap((source) => (
    readPluginList(source.config).map((item) => {
      const entry: PluginEntry = {
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
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

function getPluginEntry(id: string, workingDirectory?: string | null, switchStore?: PluginSwitchStore | null) {
  return listPluginEntries(workingDirectory, switchStore).find((entry) => entry.id === id) || null;
}

function globalPluginListFile(layers: OpenCodeConfigLayers) {
  const overridePath = layers.paths.userOverridePath;
  const intoOverride = overridePath !== null
    && !getLayerError(layers, layers.paths.userPath)
    && readPluginList(layers.userConfig).length === 0
    && readPluginList(layers.userOverrideConfig).length > 0;
  return intoOverride
    ? { path: overridePath, config: layers.userOverrideConfig }
    : { path: layers.paths.userPath, config: layers.userConfig };
}

function readGlobalPluginEntries(layers: OpenCodeConfigLayers = readConfigLayers(null)) {
  const sources = [{ config: layers.userConfig, filePath: layers.paths.userPath }];
  if (layers.paths.userOverridePath) sources.push({ config: layers.userOverrideConfig, filePath: layers.paths.userOverridePath });
  const targets = sources.flatMap((source) => readPluginList(source.config)
    .map((item) => resolveLocalPluginPath(item.entry.package, source.filePath))
    .filter((target) => target !== undefined));
  return { path: globalPluginListFile(layers).path, targets };
}

function addGlobalPluginEntry(directory: string) {
  const spec = requireLoadablePluginSpec(validatePluginSpec(directory));
  const layers = readConfigLayers(null);
  const { path: targetPath, config: targetConfig } = globalPluginListFile(layers);
  const failed = getLayerError(layers, targetPath);
  if (failed) throw codedError(failed.message, 'CONFIG_INVALID');
  if (readGlobalPluginEntries(layers).targets.includes(canonicalPluginPath(spec))) return { path: targetPath, added: false };
  pluginArrayForWrite(targetConfig).push(serializePluginEntry({ spec }));
  writeConfig(targetConfig, targetPath);
  return { path: targetPath, added: true };
}

function removeGlobalPluginEntry(directory: string) {
  const spec = validatePluginSpec(directory);
  const canonicalTarget = canonicalPluginPath(spec);
  const layers = readConfigLayers(null);
  const sources = [{ config: layers.userConfig, filePath: layers.paths.userPath }];
  if (layers.paths.userOverridePath) {
    sources.push({ config: layers.userOverrideConfig, filePath: layers.paths.userOverridePath });
  }
  let removedFromPath: string | null = null;
  for (const source of sources) {
    const failed = getLayerError(layers, source.filePath);
    if (failed) throw codedError(failed.message, 'CONFIG_INVALID');
    const existing = readPluginList(source.config);
    const hasMatch = existing.some((item) => resolveLocalPluginPath(item.entry.package, source.filePath) === canonicalTarget);
    if (!hasMatch) continue;
    const list = pluginArrayForWrite(source.config);
    const kept = list.filter((raw) => {
      const parsed = parsePluginRaw(raw);
      return resolveLocalPluginPath(parsed.spec, source.filePath) !== canonicalTarget;
    });
    if (kept.length === list.length) continue;
    if (kept.length === 0) {
      delete source.config[PLUGIN_SECTION.v2];
    } else {
      source.config[PLUGIN_SECTION.v2] = kept;
    }
    writeConfig(source.config, source.filePath);
    removedFromPath = source.filePath;
  }
  if (!removedFromPath) return { path: layers.paths.userPath, removed: false };
  return { path: removedFromPath, removed: true };
}

function createPluginEntry(entry: PluginInput, workingDirectory?: string | null) {
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

function updatePluginEntry(id: string, updates: PluginInput | null | undefined, workingDirectory?: string | null) {
  const target = getPluginTarget(id, workingDirectory);
  if (!target) {
    throw codedError('Plugin entry not found', 'NOT_FOUND');
  }
  const existing = parsePluginRaw(target.plugin[target.index]);
  let nextSpec = updates?.spec === undefined ? existing.spec : validatePluginSpec(updates.spec);
  if (nextSpec !== existing.spec) nextSpec = requireLoadablePluginSpec(nextSpec);
  const nextOptions = updates?.options === undefined ? existing.options : updates.options;
  target.plugin[target.index] = serializePluginEntry({ spec: nextSpec, options: nextOptions });
  writeConfig(target.source.config, target.source.filePath);
}

function deletePluginEntry(id: string, workingDirectory?: string | null) {
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

function recordPluginSwitch(switchStore: PluginSwitchStore, resource: string, enabled: boolean, workingDirectory?: string | null) {
  if (!enabled) {
    const configsAhead = configsAheadOfManagedLayer(readConfigLayers(workingDirectory), workingDirectory);
    if (isPluginDenialOverridden(resource, configsAhead)) {
      throw codedError('A rule in the OpenCode config allows this plugin, so OpenChamber cannot switch it off', 'SWITCH_OVERRIDDEN');
    }
  }
  return { enabled, resource, ...switchStore.set(resource, enabled) };
}

function setPluginEntryEnabled(id: string, enabled: boolean, workingDirectory?: string | null, switchStore?: PluginSwitchStore | null) {
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

function pluginPathTargetFromId(id: string, workingDirectory?: string | null) {
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
    validateExistingFileName(name);
  } else if (!name || name.includes('..') || /[\\/]/.test(name)) {
    throw codedError('Plugin package name is invalid', 'INVALID_FILENAME');
  }
  const candidate = path.join(pluginDirForKind(scope, workingDirectory, isLegacy ? 'v1' : 'v2'), name);
  if (isPackage && !fs.existsSync(candidate)) {
    throw codedError(`Plugin file "${name}" not found`, 'NOT_FOUND');
  }
  return { scope, absolutePath: candidate };
}

function setPluginFileEnabled(id: string, enabled: boolean, workingDirectory?: string | null, switchStore?: PluginSwitchStore | null) {
  if (!switchStore) {
    throw codedError('Plugin switches are only available for the OpenCode OpenChamber starts', 'SWITCH_UNAVAILABLE');
  }
  const target = pluginPathTargetFromId(id, workingDirectory);
  return recordPluginSwitch(switchStore, `plugin:${target.absolutePath}`, enabled, workingDirectory);
}

function listPluginDirFiles(workingDirectory?: string | null, switchStore?: PluginSwitchStore | null) {
  const switches = readSwitchContext(switchStore, readConfigLayers(workingDirectory), workingDirectory);
  const scopes: PluginScope[] = [AGENT_SCOPE.USER];
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
      .flatMap((entry): PluginFile[] => {
        const absolutePath = path.join(dir, entry.name);
        const entryKind = pluginDirEntryKind(entry, absolutePath);
        if (entryKind === 'file' && isExistingPluginFileName(entry.name)) {
          return editable
            ? [{ id: encodePluginId('file', `${scope}:${entry.name}`), fileName: entry.name, scope, kind: 'file', absolutePath, resolvedPath: canonicalPluginPath(absolutePath) }]
            : [{ id: encodePluginId('legacy', `${scope}:${entry.name}`), fileName: entry.name, scope, kind: 'package', absolutePath, resolvedPath: canonicalPluginPath(absolutePath) }];
        }
        if (entryKind === 'directory') {
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

function readPluginDirFile(id: string, workingDirectory?: string | null) {
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

function writePluginDirFile(file: PluginFileInput | null | undefined, workingDirectory?: string | null, opts: { overwrite?: boolean } = {}) {
  const fileName = opts.overwrite ? validateExistingFileName(file?.fileName) : validateFileName(file?.fileName);
  const scope = file?.scope || AGENT_SCOPE.USER;
  validateScope(scope);
  const dir = pluginDirForScope(scope, workingDirectory);
  const absolutePath = path.join(dir, fileName);
  if (!opts.overwrite && fs.existsSync(absolutePath)) {
    throw codedError(`Plugin file "${fileName}" already exists`, 'FILE_EXISTS');
  }
  fs.mkdirSync(dir, { recursive: true });
  const content = file?.content ?? '';
  if (isString(content)) {
    fs.writeFileSync(absolutePath, content, 'utf8');
  } else if (ArrayBuffer.isView(content)) {
    fs.writeFileSync(absolutePath, new Uint8Array(content.buffer, content.byteOffset, content.byteLength));
  } else {
    throw new TypeError('Plugin file content must be text or bytes');
  }
}

function deletePluginDirFile(id: string, workingDirectory?: string | null) {
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
  removeGlobalPluginEntry,
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
