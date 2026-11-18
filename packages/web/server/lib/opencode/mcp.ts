import fs from 'fs';
import path from 'path';
import {
  CONFIG_FILE,
  AGENT_SCOPE,
  readConfigFile,
  readConfigLayer,
  readConfigLayers,
  getJsonWriteTarget,
  getLayerError,
  getProjectConfigCandidates,
  getFolderConfigPaths,
  writeConfig,
} from './config-files.js';
import {
  toMcpEntity,
  readMcpEntries,
  readLayeredMcpEntries,
  writeMcpEntry,
  deleteMcpEntry,
} from './config-v2.js';
import { isString } from '../shared/object-guards.js';
import type { ConfigLayerError, OpenCodeConfigLayer } from './config-files.js';

interface McpSource {
  path: string;
  config: OpenCodeConfigLayer;
  error: Pick<ConfigLayerError, 'code' | 'message'> | null;
  required: boolean;
}

function validateMcpName<Name>(name: Name): asserts name is Name & string {
  if (!name || !isString(name)) {
    throw new Error('MCP server name is required');
  }
  if (!/^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/.test(name)) {
    throw new Error('MCP server name must be lowercase alphanumeric with hyphens/underscores');
  }
}

function readMcpSources(workingDirectory: string | null): McpSource[] {
  const layers = readConfigLayers(workingDirectory);
  const { userPath, userOverridePath, customPath } = layers.paths;
  const required = (filePath: string, config: OpenCodeConfigLayer) => ({ path: filePath, config, error: getLayerError(layers, filePath), required: true });
  return [
    required(userPath, layers.userConfig),
    ...(userOverridePath ? [required(userOverridePath, layers.userOverrideConfig)] : []),
    ...(customPath ? [required(customPath, layers.customConfig)] : []),
    ...getFolderConfigPaths(workingDirectory).map((filePath) => ({ path: filePath, ...readConfigLayer(filePath), required: false })),
  ];
}

function findMcpSource(sources: McpSource[], name: string) {
  for (const source of [...sources].reverse()) {
    if (source.error) {
      if (source.required) throwIfLayerError(source.error);
      continue;
    }
    const entry = readMcpEntries(source.config).get(name);
    if (entry) {
      return { ...source, section: entry.value, sectionKey: entry.key, legacy: entry.legacy };
    }
  }
  return null;
}

function throwIfLayerError(sourceError: Pick<ConfigLayerError, 'code' | 'message'>): never {
  throw Object.assign(new Error(sourceError.message), { code: sourceError.code });
}

function toMcpConfigEntry(name: string, source: NonNullable<ReturnType<typeof findMcpSource>>, workingDirectory: string | null) {
  return {
    name,
    ...toMcpEntity(source.section),
    scope: !source.required && getProjectConfigCandidates(workingDirectory).includes(source.path)
      ? AGENT_SCOPE.PROJECT
      : AGENT_SCOPE.USER,
    sectionKey: source.sectionKey,
    legacy: source.legacy,
  };
}

function ensureProjectMcpConfigPath(workingDirectory: string) {
  const configDir = path.join(workingDirectory, '.opencode');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return path.join(configDir, 'opencode.json');
}

function listMcpConfigs(workingDirectory: string | null) {
  const sources = readMcpSources(workingDirectory);
  const names = readLayeredMcpEntries(sources.map((source) => source.config)).keys();
  return Array.from(names, (name) => {
    const source = findMcpSource(sources, name);
    if (!source) throw new TypeError("Cannot read properties of null (reading 'section')");
    return toMcpConfigEntry(name, source, workingDirectory);
  });
}

function getMcpConfig(name: string, workingDirectory: string | null) {
  const source = findMcpSource(readMcpSources(workingDirectory), name);
  return source ? toMcpConfigEntry(name, source, workingDirectory) : null;
}

function createMcpConfig(name: string, mcpConfig: OpenCodeConfigLayer | null | undefined, workingDirectory: string | null, scope?: string) {
  validateMcpName(name);

  if (findMcpSource(readMcpSources(workingDirectory), name)) {
    throw new Error(`MCP server "${name}" already exists`);
  }
  const layers = readConfigLayers(workingDirectory);

  let targetPath = CONFIG_FILE;
  let config = {};

  if (scope === AGENT_SCOPE.PROJECT) {
    if (!workingDirectory) {
      throw new Error('Project scope requires working directory');
    }
    targetPath = ensureProjectMcpConfigPath(workingDirectory);
    config = fs.existsSync(targetPath) ? readConfigFile(targetPath) : {};
  } else {
    const jsonTarget = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
    targetPath = jsonTarget.path || CONFIG_FILE;
    config = jsonTarget.config || {};
  }

  const { name: _ignoredName, scope: _ignoredScope, ...entryData } = mcpConfig || {};
  writeMcpEntry(config, name, toMcpEntity(entryData));

  writeConfig(config, targetPath);
  console.log(`Created MCP server config: ${name}`);
  return { path: targetPath };
}

function updateMcpConfig(name: string, updates: OpenCodeConfigLayer | null | undefined, workingDirectory: string | null) {
  const source = findMcpSource(readMcpSources(workingDirectory), name);

  if (!source) {
    throw new Error(`MCP server "${name}" not found`);
  }

  const existing = toMcpEntity(source.section);
  const { name: _ignoredName, scope: _ignoredScope, ...updateData } = updates || {};
  writeMcpEntry(source.config, name, toMcpEntity({ ...existing, ...updateData }));

  writeConfig(source.config, source.path);
  console.log(`Updated MCP server config: ${name} (${source.path})`);
  return { path: source.path };
}

function deleteMcpConfig(name: string, workingDirectory: string | null) {
  const source = findMcpSource(readMcpSources(workingDirectory), name);

  if (!source || !deleteMcpEntry(source.config, name)) {
    throw new Error(`MCP server "${name}" not found`);
  }

  writeConfig(source.config, source.path);
  console.log(`Deleted MCP server config: ${name} (${source.path})`);
  return { path: source.path };
}

export {
  listMcpConfigs,
  getMcpConfig,
  createMcpConfig,
  updateMcpConfig,
  deleteMcpConfig,
};
