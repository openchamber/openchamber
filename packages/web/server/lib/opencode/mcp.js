import fs from 'fs';
import path from 'path';
import {
  CONFIG_FILE,
  AGENT_SCOPE,
  readConfigFile,
  readConfigLayers,
  getJsonEntrySource,
  getJsonWriteTarget,
  writeConfig,
} from './shared.js';
import {
  toMcpEntity,
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

function resolveMcpScopeFromPath(layers, sourcePath) {
  if (!sourcePath) return null;
  return sourcePath === layers.paths.projectPath ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER;
}

function ensureProjectMcpConfigPath(workingDirectory) {
  const configDir = path.join(workingDirectory, '.opencode');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return path.join(configDir, 'opencode.json');
}

/** Same precedence as `getJsonEntrySource`: custom > project > user. */
function readMcpEntriesAcrossLayers(layers) {
  return readLayeredMcpEntries([layers?.userConfig, layers?.projectConfig, layers?.customConfig]);
}

function listMcpConfigs(workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  return Array.from(readMcpEntriesAcrossLayers(layers).entries()).map(([name, entry]) => {
    const source = getJsonEntrySource(layers, 'mcp', name);
    return {
      name,
      ...toMcpEntity(entry.value),
      scope: resolveMcpScopeFromPath(layers, source.path),
      sectionKey: source.sectionKey,
      legacy: Boolean(source.legacy),
    };
  });
}

/**
 * Get a single MCP server config by name
 */
function getMcpConfig(name, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const entry = readMcpEntriesAcrossLayers(layers).get(name);

  if (!entry) {
    return null;
  }
  const source = getJsonEntrySource(layers, 'mcp', name);
  return {
    name,
    ...toMcpEntity(entry.value),
    scope: resolveMcpScopeFromPath(layers, source.path),
    sectionKey: source.sectionKey,
    legacy: Boolean(source.legacy),
  };
}

/**
 * Create a new MCP server config entry
 */
function createMcpConfig(name, mcpConfig, workingDirectory, scope) {
  validateMcpName(name);

  const layers = readConfigLayers(workingDirectory);
  if (getJsonEntrySource(layers, 'mcp', name).exists) {
    throw new Error(`MCP server "${name}" already exists`);
  }

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
 * Update an existing MCP server config entry. A server still stored under the
 * v1 `mcp.<name>` key is rewritten into `mcp.servers` in the same file.
 */
function updateMcpConfig(name, updates, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const source = getJsonEntrySource(layers, 'mcp', name);

  if (!source.exists) {
    throw new Error(`MCP server "${name}" not found`);
  }

  const targetPath = source.path || CONFIG_FILE;
  const config = source.config || (fs.existsSync(targetPath) ? readConfigFile(targetPath) : {});

  const existing = toMcpEntity(source.section);
  const { name: _ignoredName, scope: _ignoredScope, ...updateData } = updates || {};
  writeMcpEntry(config, name, toMcpEntity({ ...existing, ...updateData }));

  writeConfig(config, targetPath);
  console.log(`Updated MCP server config: ${name} (${targetPath})`);
  return { path: targetPath };
}

/**
 * Delete an MCP server config entry
 */
function deleteMcpConfig(name, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const source = getJsonEntrySource(layers, 'mcp', name);
  const targetPath = source.path || CONFIG_FILE;
  const config = source.config || (fs.existsSync(targetPath) ? readConfigFile(targetPath) : {});

  if (!deleteMcpEntry(config, name)) {
    throw new Error(`MCP server "${name}" not found`);
  }

  writeConfig(config, targetPath);
  console.log(`Deleted MCP server config: ${name}`);
  return { path: targetPath };
}

export {
  listMcpConfigs,
  getMcpConfig,
  createMcpConfig,
  updateMcpConfig,
  deleteMcpConfig,
};
