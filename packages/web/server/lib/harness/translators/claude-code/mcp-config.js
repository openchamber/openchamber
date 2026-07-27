/**
 * Bridge OpenChamber / OpenCode MCP configs into Claude Agent SDK mcpServers.
 * Never logs secrets (env/headers values).
 */

import { listMcpConfigs } from '../../../opencode/mcp.js';

/**
 * @param {unknown} entry
 * @returns {Record<string, unknown> | null}
 */
export function convertOpenCodeMcpEntryToClaude(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (entry.enabled === false) return null;

  const type = entry.type === 'remote' ? 'remote' : 'local';

  if (type === 'local') {
    const commandParts = Array.isArray(entry.command)
      ? entry.command.map(String).filter((part) => part.trim().length > 0)
      : [];
    if (commandParts.length === 0) return null;
    const [command, ...args] = commandParts;
    /** @type {Record<string, unknown>} */
    const config = {
      type: 'stdio',
      command,
      args,
    };
    if (entry.environment && typeof entry.environment === 'object' && !Array.isArray(entry.environment)) {
      /** @type {Record<string, string>} */
      const env = {};
      for (const [key, value] of Object.entries(entry.environment)) {
        if (!key || value === undefined || value === null) continue;
        env[String(key)] = String(value);
      }
      if (Object.keys(env).length > 0) config.env = env;
    }
    return config;
  }

  const url = typeof entry.url === 'string' ? entry.url.trim() : '';
  if (!url) return null;

  // Claude programmatic config uses "http" / "sse". Prefer http for remote URLs;
  // callers can still override via an explicit transport hint later.
  /** @type {Record<string, unknown>} */
  const config = {
    type: 'http',
    url,
  };
  if (entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)) {
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [key, value] of Object.entries(entry.headers)) {
      if (!key || value === undefined || value === null) continue;
      headers[String(key)] = String(value);
    }
    if (Object.keys(headers).length > 0) config.headers = headers;
  }
  return config;
}

/**
 * Build Claude Agent SDK `mcpServers` from OpenChamber MCP configs for a cwd.
 *
 * @param {string} directory
 * @param {{ listConfigs?: typeof listMcpConfigs }} [deps]
 * @returns {Record<string, Record<string, unknown>>}
 */
export function buildClaudeMcpServersFromOpenChamber(directory, deps = {}) {
  const list = typeof deps.listConfigs === 'function' ? deps.listConfigs : listMcpConfigs;
  const cwd = typeof directory === 'string' ? directory.trim() : '';
  if (!cwd) return {};

  let configs;
  try {
    configs = list(cwd);
  } catch {
    // Config read failure must not block Claude prompts — native .mcp.json
    // may still load via SDK settingSources defaults.
    return {};
  }

  if (!Array.isArray(configs)) return {};

  /** @type {Record<string, Record<string, unknown>>} */
  const servers = {};
  for (const entry of configs) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    const converted = convertOpenCodeMcpEntryToClaude(entry);
    if (!converted) continue;
    servers[name] = converted;
  }
  return servers;
}

/**
 * Build allowedTools wildcards for bridged MCP servers so connected tools are
 * usable. PermissionMode acceptEdits does not auto-approve MCP; wildcards in
 * allowedTools grant exactly those servers. Note: bare tool names (no `(`)
 * auto-approve in the Agent SDK and shadow `canUseTool` — keep patterns only.
 *
 * @param {Record<string, unknown>} mcpServers
 * @returns {string[]}
 */
export function buildMcpAllowedToolPatterns(mcpServers) {
  if (!mcpServers || typeof mcpServers !== 'object') return [];
  return Object.keys(mcpServers)
    .filter((name) => typeof name === 'string' && name.trim())
    .map((name) => `mcp__${name.trim()}__*`);
}
