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

// ============== MCP CONFIG HELPERS ==============

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

/**
 * List all MCP server configs from user-level opencode.json
 */
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

function listMcpConfigs(workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const mcp = layers?.mergedConfig?.mcp || {};

  return Object.entries(mcp)
    .filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(([name, entry]) => {
      const source = getJsonEntrySource(layers, 'mcp', name);
      return {
        name,
        ...buildMcpEntry(entry),
        scope: resolveMcpScopeFromPath(layers, source.path),
      };
    });
}

/**
 * Get a single MCP server config by name
 */
function getMcpConfig(name, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const entry = layers?.mergedConfig?.mcp?.[name];

  if (!entry) {
    return null;
  }
  const source = getJsonEntrySource(layers, 'mcp', name);
  return {
    name,
    ...buildMcpEntry(entry),
    scope: resolveMcpScopeFromPath(layers, source.path),
  };
}

/**
 * Create a new MCP server config entry
 */
function createMcpConfig(name, mcpConfig, workingDirectory, scope) {
  validateMcpName(name);

  const layers = readConfigLayers(workingDirectory);
  const source = getJsonEntrySource(layers, 'mcp', name);
  if (source.exists) {
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

  if (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp)) {
    config.mcp = {};
  }

  const { name: _ignoredName, ...entryData } = mcpConfig;
  config.mcp[name] = buildMcpEntry(entryData);

  writeConfig(config, targetPath);
  console.log(`Created MCP server config: ${name}`);
}

/**
 * Update an existing MCP server config entry
 */
function updateMcpConfig(name, updates, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const source = getJsonEntrySource(layers, 'mcp', name);
  const targetPath = source.path || CONFIG_FILE;
  const config = source.config || (fs.existsSync(targetPath) ? readConfigFile(targetPath) : {});

  if (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp)) {
    config.mcp = {};
  }

  const existing = config.mcp[name] ?? {};
  const { name: _ignoredName, ...updateData } = updates;

  config.mcp[name] = buildMcpEntry({ ...existing, ...updateData });

  writeConfig(config, targetPath);
  console.log(`Updated MCP server config: ${name}`);
}

/**
 * Delete an MCP server config entry
 */
function deleteMcpConfig(name, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const source = getJsonEntrySource(layers, 'mcp', name);
  const targetPath = source.path || CONFIG_FILE;
  const config = source.config || (fs.existsSync(targetPath) ? readConfigFile(targetPath) : {});

  if (!config.mcp || typeof config.mcp !== 'object' || config.mcp[name] === undefined) {
    throw new Error(`MCP server "${name}" not found`);
  }

  delete config.mcp[name];

  if (Object.keys(config.mcp).length === 0) {
    delete config.mcp;
  }

  writeConfig(config, targetPath);
  console.log(`Deleted MCP server config: ${name}`);
}

/**
 * Build a clean MCP entry object, omitting undefined/null values
 */
function buildMcpEntry(data) {
  const entry = {};

  // type is required
  entry.type = data.type === 'remote' ? 'remote' : 'local';

  if (entry.type === 'local') {
    // command must be a non-empty array of strings
    if (Array.isArray(data.command) && data.command.length > 0) {
      entry.command = data.command.map(String);
    }
  } else {
    // remote: url required
    if (data.url && typeof data.url === 'string') {
      entry.url = data.url.trim();
    }
  }

  // environment: flat Record<string, string>
  if (data.environment && typeof data.environment === 'object' && !Array.isArray(data.environment)) {
    const cleaned = {};
    for (const [k, v] of Object.entries(data.environment)) {
      if (k && v !== undefined && v !== null) {
        cleaned[k] = String(v);
      }
    }
    if (Object.keys(cleaned).length > 0) {
      entry.environment = cleaned;
    }
  }

  // enabled defaults to true
  entry.enabled = data.enabled !== false;

  return entry;
}

export {
  listMcpConfigs,
  getMcpConfig,
  createMcpConfig,
  updateMcpConfig,
  deleteMcpConfig,
};
