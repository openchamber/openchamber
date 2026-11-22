import fs from 'fs';
import path from 'path';
import {
  CONFIG_FILE,
  AGENT_SCOPE,
  readConfigFile,
  readConfigLayers,
  readConfigSources,
  getJsonWriteTarget,
  getProjectConfigCandidates,
  writeConfig,
} from './shared.js';
import {
  toMcpEntity,
  readMcpEntries,
  readLayeredMcpEntries,
  writeMcpEntry,
  deleteMcpEntry,
} from './config-v2.js';

// ============== MCP CONFIG HELPERS ==============
//
// OpenCode 2 keeps servers under `mcp.servers`; v1 kept them directly under
// `mcp`. OpenChamber reads both and always writes `mcp.servers` with the v2
// entry shape (`disabled`, `timeout: {catalog, execution}`, snake_case OAuth,
// required `type`).

/**
 * Validate MCP server name
 */
function validateMcpName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('MCP server name is required');
  }
  if (!/^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/.test(name)) {
    throw new Error('MCP server name must be lowercase alphanumeric with hyphens/underscores');
  }
}

/** The file whose definition of `name` OpenCode uses, or null. */
function findMcpSource(sources, name) {
  for (const source of [...sources].reverse()) {
    if (source.error) {
      if (source.required) throwIfLayerError(source);
      continue;
    }
    const entry = readMcpEntries(source.config).get(name);
    if (entry) {
      return { ...source, section: entry.value, sectionKey: entry.key, legacy: entry.legacy };
    }
  }
  return null;
}

function throwIfLayerError(source) {
  const error = new Error(source.error.message);
  error.code = source.error.code;
  throw error;
}

function toMcpConfigEntry(name, source, workingDirectory) {
  return {
    name,
    ...toMcpEntity(source.section),
    // Only the project folder's own files are "this project"; a parent
    // folder's file reaches every project below it, like the global file.
    scope: !source.required && getProjectConfigCandidates(workingDirectory).includes(source.path)
      ? AGENT_SCOPE.PROJECT
      : AGENT_SCOPE.USER,
    sectionKey: source.sectionKey,
    legacy: source.legacy,
  };
}

function ensureProjectMcpConfigPath(workingDirectory) {
  const configDir = path.join(workingDirectory, '.opencode');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return path.join(configDir, 'opencode.json');
}

function listMcpConfigs(workingDirectory) {
  const sources = readConfigSources(workingDirectory);
  const names = readLayeredMcpEntries(sources.map((source) => source.config)).keys();
  return Array.from(names, (name) => toMcpConfigEntry(name, findMcpSource(sources, name), workingDirectory));
}

/**
 * Get a single MCP server config by name
 */
function getMcpConfig(name, workingDirectory) {
  const source = findMcpSource(readConfigSources(workingDirectory), name);
  return source ? toMcpConfigEntry(name, source, workingDirectory) : null;
}

/**
 * Create a new MCP server config entry
 */
function createMcpConfig(name, mcpConfig, workingDirectory, scope) {
  validateMcpName(name);

  if (findMcpSource(readConfigSources(workingDirectory), name)) {
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

/**
 * Update an existing MCP server config entry in the file OpenCode reads it
 * from, which may be a parent folder's config. A server still stored under the
 * v1 `mcp.<name>` key is rewritten into `mcp.servers` in the same file.
 */
function updateMcpConfig(name, updates, workingDirectory) {
  const source = findMcpSource(readConfigSources(workingDirectory), name);

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

/**
 * Delete an MCP server config entry from the file OpenCode reads it from.
 */
function deleteMcpConfig(name, workingDirectory) {
  const source = findMcpSource(readConfigSources(workingDirectory), name);

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
