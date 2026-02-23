import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'yaml';
import { parse as parseJsonc } from 'jsonc-parser';

const OPENCODE_CONFIG_DIR = path.join(os.homedir(), '.config', 'opencode');
const AGENT_DIR = path.join(OPENCODE_CONFIG_DIR, 'agents');
const COMMAND_DIR = path.join(OPENCODE_CONFIG_DIR, 'commands');
const CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');
const CUSTOM_CONFIG_FILE = process.env.OPENCODE_CONFIG
  ? path.resolve(process.env.OPENCODE_CONFIG)
  : null;
const PROMPT_FILE_PATTERN = /^\{file:(.+)\}$/i;

// Scope types (shared by agents and commands)
export const AGENT_SCOPE = {
  USER: 'user',
  PROJECT: 'project'
} as const;

export const COMMAND_SCOPE = {
  USER: 'user',
  PROJECT: 'project'
} as const;

export type AgentScope = typeof AGENT_SCOPE[keyof typeof AGENT_SCOPE];
export type CommandScope = typeof COMMAND_SCOPE[keyof typeof COMMAND_SCOPE];

export type ConfigSources = {
  md: { exists: boolean; path: string | null; fields: string[]; scope?: AgentScope | CommandScope | null };
  json: { exists: boolean; path: string; fields: string[]; scope?: AgentScope | CommandScope | null };
  projectMd?: { exists: boolean; path: string | null };
  userMd?: { exists: boolean; path: string | null };
};

const ensureDirs = () => {
  if (!fs.existsSync(OPENCODE_CONFIG_DIR)) fs.mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(AGENT_DIR)) fs.mkdirSync(AGENT_DIR, { recursive: true });
  if (!fs.existsSync(COMMAND_DIR)) fs.mkdirSync(COMMAND_DIR, { recursive: true });
};

// ============== AGENT SCOPE HELPERS ==============

const ensureProjectAgentDir = (workingDirectory: string): string => {
  const projectAgentDir = path.join(workingDirectory, '.opencode', 'agents');
  if (!fs.existsSync(projectAgentDir)) {
    fs.mkdirSync(projectAgentDir, { recursive: true });
  }
  const legacyProjectAgentDir = path.join(workingDirectory, '.opencode', 'agent');
  if (!fs.existsSync(legacyProjectAgentDir)) {
    fs.mkdirSync(legacyProjectAgentDir, { recursive: true });
  }
  return projectAgentDir;
};

const getProjectAgentPath = (workingDirectory: string, agentName: string): string => {
  const pluralPath = path.join(workingDirectory, '.opencode', 'agents', `${agentName}.md`);
  const legacyPath = path.join(workingDirectory, '.opencode', 'agent', `${agentName}.md`);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
};

const getUserAgentPath = (agentName: string): string => {
  const pluralPath = path.join(AGENT_DIR, `${agentName}.md`);
  const legacyPath = path.join(OPENCODE_CONFIG_DIR, 'agent', `${agentName}.md`);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
};

export const getAgentScope = (agentName: string, workingDirectory?: string): { scope: AgentScope | null; path: string | null } => {
  if (workingDirectory) {
    const projectPath = getProjectAgentPath(workingDirectory, agentName);
    if (fs.existsSync(projectPath)) {
      return { scope: AGENT_SCOPE.PROJECT, path: projectPath };
    }
  }
  
  const userPath = getUserAgentPath(agentName);
  if (fs.existsSync(userPath)) {
    return { scope: AGENT_SCOPE.USER, path: userPath };
  }
  
  return { scope: null, path: null };
};

const getAgentWritePath = (agentName: string, workingDirectory?: string, requestedScope?: AgentScope): { scope: AgentScope; path: string } => {
  const existing = getAgentScope(agentName, workingDirectory);
  if (existing.path) {
    return { scope: existing.scope!, path: existing.path };
  }
  
  const scope = requestedScope || AGENT_SCOPE.USER;
  if (scope === AGENT_SCOPE.PROJECT && workingDirectory) {
    return { 
      scope: AGENT_SCOPE.PROJECT, 
      path: getProjectAgentPath(workingDirectory, agentName) 
    };
  }
  
  return { 
    scope: AGENT_SCOPE.USER, 
    path: getUserAgentPath(agentName) 
  };
};

// ============== COMMAND SCOPE HELPERS ==============

const ensureProjectCommandDir = (workingDirectory: string): string => {
  const projectCommandDir = path.join(workingDirectory, '.opencode', 'commands');
  if (!fs.existsSync(projectCommandDir)) {
    fs.mkdirSync(projectCommandDir, { recursive: true });
  }
  const legacyProjectCommandDir = path.join(workingDirectory, '.opencode', 'command');
  if (!fs.existsSync(legacyProjectCommandDir)) {
    fs.mkdirSync(legacyProjectCommandDir, { recursive: true });
  }
  return projectCommandDir;
};

const getProjectCommandPath = (workingDirectory: string, commandName: string): string => {
  const pluralPath = path.join(workingDirectory, '.opencode', 'commands', `${commandName}.md`);
  const legacyPath = path.join(workingDirectory, '.opencode', 'command', `${commandName}.md`);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
};

const getUserCommandPath = (commandName: string): string => {
  const pluralPath = path.join(COMMAND_DIR, `${commandName}.md`);
  const legacyPath = path.join(OPENCODE_CONFIG_DIR, 'command', `${commandName}.md`);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
};

export const getCommandScope = (commandName: string, workingDirectory?: string): { scope: CommandScope | null; path: string | null } => {
  if (workingDirectory) {
    const projectPath = getProjectCommandPath(workingDirectory, commandName);
    if (fs.existsSync(projectPath)) {
      return { scope: COMMAND_SCOPE.PROJECT, path: projectPath };
    }
  }
  
  const userPath = getUserCommandPath(commandName);
  if (fs.existsSync(userPath)) {
    return { scope: COMMAND_SCOPE.USER, path: userPath };
  }
  
  return { scope: null, path: null };
};

const getCommandWritePath = (commandName: string, workingDirectory?: string, requestedScope?: CommandScope): { scope: CommandScope; path: string } => {
  const existing = getCommandScope(commandName, workingDirectory);
  if (existing.path) {
    return { scope: existing.scope!, path: existing.path };
  }
  
  const scope = requestedScope || COMMAND_SCOPE.USER;
  if (scope === COMMAND_SCOPE.PROJECT && workingDirectory) {
    return { 
      scope: COMMAND_SCOPE.PROJECT, 
      path: getProjectCommandPath(workingDirectory, commandName) 
    };
  }
  
  return { 
    scope: COMMAND_SCOPE.USER, 
    path: getUserCommandPath(commandName) 
  };
};

const isPromptFileReference = (value: unknown): value is string => {
  return typeof value === 'string' && PROMPT_FILE_PATTERN.test(value.trim());
};

const resolvePromptFilePath = (reference: string): string | null => {
  const match = reference.trim().match(PROMPT_FILE_PATTERN);
  if (!match?.[1]) return null;
  let target = match[1].trim();
  if (!target) return null;

  if (target.startsWith('./')) {
    target = path.join(OPENCODE_CONFIG_DIR, target.slice(2));
  } else if (!path.isAbsolute(target)) {
    target = path.join(OPENCODE_CONFIG_DIR, target);
  }

  return target;
};

const writePromptFile = (filePath: string, content: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};

/**
 * Get all possible project config paths in priority order
 * Priority: root > .opencode/, json > jsonc
 */
const getProjectConfigCandidates = (workingDirectory?: string): string[] => {
  if (!workingDirectory) return [];
  return [
    path.join(workingDirectory, 'opencode.json'),
    path.join(workingDirectory, 'opencode.jsonc'),
    path.join(workingDirectory, '.opencode', 'opencode.json'),
    path.join(workingDirectory, '.opencode', 'opencode.jsonc'),
  ];
};

/**
 * Find existing project config file or return default path for new config
 */
const getProjectConfigPath = (workingDirectory?: string): string | null => {
  if (!workingDirectory) return null;

  const candidates = getProjectConfigCandidates(workingDirectory);

  // Return first existing config file
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Default to root opencode.json for new configs
  return candidates[0] || null;
};

const getConfigPaths = (workingDirectory?: string) => ({
  userPath: CONFIG_FILE,
  projectPath: getProjectConfigPath(workingDirectory),
  customPath: CUSTOM_CONFIG_FILE
});

const readConfigFile = (filePath?: string | null): Record<string, unknown> => {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const normalized = content.trim();
  if (!normalized) return {};
  return parseJsonc(normalized, [], { allowTrailingComma: true }) as Record<string, unknown>;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const mergeConfigs = (base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key in result) {
      const baseValue = result[key];
      if (isPlainObject(baseValue) && isPlainObject(value)) {
        result[key] = mergeConfigs(baseValue, value);
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
};

const readConfigLayers = (workingDirectory?: string) => {
  const { userPath, projectPath, customPath } = getConfigPaths(workingDirectory);
  const userConfig = readConfigFile(userPath);
  const projectConfig = readConfigFile(projectPath);
  const customConfig = readConfigFile(customPath);
  const mergedConfig = mergeConfigs(mergeConfigs(userConfig, projectConfig), customConfig);

  return {
    userConfig,
    projectConfig,
    customConfig,
    mergedConfig,
    paths: { userPath, projectPath, customPath }
  };
};

const readConfig = (workingDirectory?: string): Record<string, unknown> =>
  readConfigLayers(workingDirectory).mergedConfig;

const getAncestors = (startDir?: string, stopDir?: string): string[] => {
  if (!startDir) return [];
  const result: string[] = [];
  let current = path.resolve(startDir);
  const resolvedStop = stopDir ? path.resolve(stopDir) : null;

  while (true) {
    result.push(current);
    if (resolvedStop && current === resolvedStop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return result;
};

const findWorktreeRoot = (startDir?: string): string | null => {
  if (!startDir) return null;
  let current = path.resolve(startDir);

  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const walkSkillMdFiles = (rootDir?: string | null): string[] => {
  if (!rootDir || !fs.existsSync(rootDir)) return [];

  const results: string[] = [];
  const walkDir = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === 'SKILL.md') {
        results.push(fullPath);
      }
    }
  };

  walkDir(rootDir);
  return results;
};

const resolveSkillSearchDirectories = (workingDirectory?: string): string[] => {
  const directories: string[] = [];
  const pushDir = (dir?: string | null) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (!directories.includes(resolved)) {
      directories.push(resolved);
    }
  };

  pushDir(OPENCODE_CONFIG_DIR);

  if (workingDirectory) {
    const worktreeRoot = findWorktreeRoot(workingDirectory) || path.resolve(workingDirectory);
    const projectDirs = getAncestors(workingDirectory, worktreeRoot)
      .map((dir) => path.join(dir, '.opencode'));
    projectDirs.forEach(pushDir);
  }

  pushDir(path.join(os.homedir(), '.opencode'));
  pushDir(process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : null);

  return directories;
};

const getConfigForPath = (layers: ReturnType<typeof readConfigLayers>, targetPath?: string | null) => {
  if (!targetPath) return layers.userConfig;
  if (layers.paths.customPath && targetPath === layers.paths.customPath) return layers.customConfig;
  if (layers.paths.projectPath && targetPath === layers.paths.projectPath) return layers.projectConfig;
  return layers.userConfig;
};

const writeConfig = (config: Record<string, unknown>, filePath: string = CONFIG_FILE) => {
  if (fs.existsSync(filePath)) {
    const backupFile = `${filePath}.openchamber.backup`;
    try {
      fs.copyFileSync(filePath, backupFile);
    } catch {
      // ignore backup failures
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
};

export type McpLocalConfig = {
  type: 'local';
  command?: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
};

export type McpRemoteConfig = {
  type: 'remote';
  url?: string;
  environment?: Record<string, string>;
  enabled?: boolean;
};

export type McpConfigPayload = McpLocalConfig | McpRemoteConfig;

export type McpConfigEntry = {
  name: string;
  scope?: AgentScope | null;
  type: 'local' | 'remote';
  command?: string[];
  url?: string;
  environment?: Record<string, string>;
  enabled: boolean;
};

const resolveMcpScopeFromPath = (layers: ReturnType<typeof readConfigLayers>, sourcePath?: string | null): AgentScope | null => {
  if (!sourcePath) return null;
  return sourcePath === layers.paths.projectPath ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER;
};

const ensureProjectMcpConfigPath = (workingDirectory: string): string => {
  const projectConfigDir = path.join(workingDirectory, '.opencode');
  if (!fs.existsSync(projectConfigDir)) {
    fs.mkdirSync(projectConfigDir, { recursive: true });
  }
  return path.join(projectConfigDir, 'opencode.json');
};

const validateMcpName = (name: string): void => {
  if (!name || typeof name !== 'string') {
    throw new Error('MCP server name is required');
  }
  if (!/^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/.test(name)) {
    throw new Error('MCP server name must be lowercase alphanumeric with hyphens/underscores');
  }
};

const buildMcpEntry = (data: Record<string, unknown>): Omit<McpConfigEntry, 'name'> => {
  const entry: Omit<McpConfigEntry, 'name'> = {
    type: data.type === 'remote' ? 'remote' : 'local',
    enabled: data.enabled !== false,
  };

  if (entry.type === 'local') {
    if (Array.isArray(data.command) && data.command.length > 0) {
      entry.command = data.command.map((value) => String(value));
    }
  } else if (typeof data.url === 'string' && data.url.trim()) {
    entry.url = data.url.trim();
  }

  if (isPlainObject(data.environment)) {
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(data.environment)) {
      if (key && value != null) {
        cleaned[key] = String(value);
      }
    }
    if (Object.keys(cleaned).length > 0) {
      entry.environment = cleaned;
    }
  }

  return entry;
};

export const listMcpConfigs = (workingDirectory?: string): McpConfigEntry[] => {
  const layers = readConfigLayers(workingDirectory);
  const merged = (layers.mergedConfig as Record<string, unknown>) || {};
  const mcp = isPlainObject(merged.mcp) ? merged.mcp : {};
  return Object.entries(mcp)
    .filter(([, value]) => isPlainObject(value))
    .map(([name, value]) => {
      const source = getJsonEntrySource(layers, 'mcp', name);
      return {
        name,
        ...buildMcpEntry(value as Record<string, unknown>),
        scope: resolveMcpScopeFromPath(layers, source.path),
      };
    });
};

export const getMcpConfig = (name: string, workingDirectory?: string): McpConfigEntry | null => {
  const layers = readConfigLayers(workingDirectory);
  const merged = (layers.mergedConfig as Record<string, unknown>) || {};
  const mcp = isPlainObject(merged.mcp) ? merged.mcp : {};
  const entry = mcp[name];
  if (!isPlainObject(entry)) {
    return null;
  }
  const source = getJsonEntrySource(layers, 'mcp', name);
  return {
    name,
    ...buildMcpEntry(entry as Record<string, unknown>),
    scope: resolveMcpScopeFromPath(layers, source.path),
  };
};

export const createMcpConfig = (
  name: string,
  mcpConfig: Record<string, unknown>,
  workingDirectory?: string,
  scope?: AgentScope,
): void => {
  validateMcpName(name);

  const layers = readConfigLayers(workingDirectory);
  const source = getJsonEntrySource(layers, 'mcp', name);
  if (source.exists) {
    throw new Error(`MCP server "${name}" already exists`);
  }

  let targetPath = CONFIG_FILE;
  let config: Record<string, unknown> = {};

  if (scope === AGENT_SCOPE.PROJECT) {
    if (!workingDirectory) {
      throw new Error('Project scope requires working directory');
    }
    targetPath = ensureProjectMcpConfigPath(workingDirectory);
    config = readConfigFile(targetPath);
  } else {
    const jsonTarget = getJsonWriteTarget(layers, AGENT_SCOPE.USER);
    targetPath = jsonTarget.path || CONFIG_FILE;
    config = (jsonTarget.config || {}) as Record<string, unknown>;
  }

  const mcp = isPlainObject(config.mcp) ? { ...config.mcp } : {};

  const { name: _ignoredName, ...entryData } = mcpConfig;
  void _ignoredName;
  mcp[name] = buildMcpEntry(entryData);
  config.mcp = mcp;
  writeConfig(config, targetPath);
};

export const updateMcpConfig = (name: string, updates: Record<string, unknown>, workingDirectory?: string): void => {
  const layers = readConfigLayers(workingDirectory);
  const source = getJsonEntrySource(layers, 'mcp', name);
  const targetPath = source.path || CONFIG_FILE;
  const config = (source.config || readConfigFile(targetPath)) as Record<string, unknown>;
  const mcp = isPlainObject(config.mcp) ? { ...config.mcp } : {};
  const existing = isPlainObject(mcp[name]) ? mcp[name] : {};

  const { name: _ignoredName, ...updateData } = updates;
  void _ignoredName;
  mcp[name] = buildMcpEntry({ ...(existing as Record<string, unknown>), ...updateData });
  config.mcp = mcp;
  writeConfig(config, targetPath);
};

export const deleteMcpConfig = (name: string, workingDirectory?: string): void => {
  const layers = readConfigLayers(workingDirectory);
  const source = getJsonEntrySource(layers, 'mcp', name);
  const targetPath = source.path || CONFIG_FILE;
  const config = (source.config || readConfigFile(targetPath)) as Record<string, unknown>;
  const mcp = isPlainObject(config.mcp) ? { ...config.mcp } : {};

  if (mcp[name] === undefined) {
    throw new Error(`MCP server "${name}" not found`);
  }

  delete mcp[name];
  if (Object.keys(mcp).length === 0) {
    delete config.mcp;
  } else {
    config.mcp = mcp;
  }

  writeConfig(config, targetPath);
};

const getJsonEntrySource = (
  layers: ReturnType<typeof readConfigLayers>,
  sectionKey: 'agent' | 'command' | 'mcp',
  entryName: string
) => {
  const { userConfig, projectConfig, customConfig, paths } = layers;
  const customSection = (customConfig as Record<string, unknown>)?.[sectionKey] as Record<string, unknown> | undefined;
  if (customSection?.[entryName] !== undefined) {
    return { section: customSection[entryName], config: customConfig, path: paths.customPath, exists: true };
  }

  const projectSection = (projectConfig as Record<string, unknown>)?.[sectionKey] as Record<string, unknown> | undefined;
  if (projectSection?.[entryName] !== undefined) {
    return { section: projectSection[entryName], config: projectConfig, path: paths.projectPath, exists: true };
  }

  const userSection = (userConfig as Record<string, unknown>)?.[sectionKey] as Record<string, unknown> | undefined;
  if (userSection?.[entryName] !== undefined) {
    return { section: userSection[entryName], config: userConfig, path: paths.userPath, exists: true };
  }

  return { section: null, config: null, path: null, exists: false };
};

const getJsonWriteTarget = (
  layers: ReturnType<typeof readConfigLayers>,
  preferredScope: AgentScope | CommandScope
) => {
  const { userConfig, projectConfig, customConfig, paths } = layers;
  if (paths.customPath) {
    return { config: customConfig, path: paths.customPath };
  }
  if (preferredScope === AGENT_SCOPE.PROJECT && paths.projectPath) {
    return { config: projectConfig, path: paths.projectPath };
  }
  if (paths.projectPath) {
    return { config: projectConfig, path: paths.projectPath };
  }
  return { config: userConfig, path: paths.userPath };
};

const parseMdFile = (filePath: string): { frontmatter: Record<string, unknown>; body: string } => {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content.trim() };
  let frontmatter: Record<string, unknown> = {};
  try {
    frontmatter = (yaml.parse(match[1]) || {}) as Record<string, unknown>;
  } catch (error) {
    console.warn(`[OpenChamber][VSCode] Failed to parse frontmatter for ${filePath}, treating as empty:`, error);
    frontmatter = {};
  }
  return { frontmatter, body: (match[2] || '').trim() };
};

const writeMdFile = (filePath: string, frontmatter: Record<string, unknown>, body: string) => {
  // Filter out null/undefined values - OpenCode expects keys to be omitted rather than set to null
  const cleanedFrontmatter = Object.fromEntries(
    Object.entries(frontmatter ?? {}).filter(([, value]) => value != null)
  );
  const yamlStr = yaml.stringify(cleanedFrontmatter);
  const content = `---\n${yamlStr}---\n\n${body ?? ''}`.trimEnd();
  fs.writeFileSync(filePath, content, 'utf8');
};

export const getAgentSources = (agentName: string, workingDirectory?: string): ConfigSources => {
  // Check project level first (takes precedence)
  const projectPath = workingDirectory ? getProjectAgentPath(workingDirectory, agentName) : null;
  const projectExists = projectPath ? fs.existsSync(projectPath) : false;
  
  // Then check user level
  const userPath = getUserAgentPath(agentName);
  const userExists = fs.existsSync(userPath);
  
  // Determine which md file to use (project takes precedence)
  const mdPath = projectExists ? projectPath : (userExists ? userPath : null);
  const mdExists = !!mdPath;
  const mdScope = projectExists ? AGENT_SCOPE.PROJECT : (userExists ? AGENT_SCOPE.USER : null);

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'agent', agentName);
  const agentSection = jsonSource.section as Record<string, unknown> | undefined;
  const jsonPath = jsonSource.path || layers.paths.customPath || layers.paths.projectPath || layers.paths.userPath;
  const jsonScope = jsonSource.path === layers.paths.projectPath ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER;

  const sources: ConfigSources = {
    md: { exists: mdExists, path: mdPath, scope: mdScope, fields: [] },
    json: { exists: jsonSource.exists, path: jsonPath || CONFIG_FILE, scope: jsonSource.exists ? jsonScope : null, fields: [] },
    projectMd: { exists: projectExists, path: projectPath },
    userMd: { exists: userExists, path: userPath }
  };

  if (mdExists && mdPath) {
    const { frontmatter, body } = parseMdFile(mdPath);
    sources.md.fields = Object.keys(frontmatter);
    if (body) sources.md.fields.push('prompt');
  }

  if (agentSection) {
    sources.json.fields = Object.keys(agentSection);
  }

  return sources;
};

export const createAgent = (agentName: string, config: Record<string, unknown>, workingDirectory?: string, scope?: AgentScope) => {
  ensureDirs();

  // Check if agent already exists at either level
  const projectPath = workingDirectory ? getProjectAgentPath(workingDirectory, agentName) : null;
  const userPath = getUserAgentPath(agentName);
  
  if (projectPath && fs.existsSync(projectPath)) {
    throw new Error(`Agent ${agentName} already exists as project-level .md file`);
  }
  
  if (fs.existsSync(userPath)) {
    throw new Error(`Agent ${agentName} already exists as user-level .md file`);
  }

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'agent', agentName);
  if (jsonSource.exists) throw new Error(`Agent ${agentName} already exists in opencode.json`);

  // Determine target path based on requested scope
  let targetPath: string;
  
  if (scope === AGENT_SCOPE.PROJECT && workingDirectory) {
    ensureProjectAgentDir(workingDirectory);
    targetPath = projectPath!;
  } else {
    targetPath = userPath;
  }

  // Extract scope and prompt from config - scope is only used for path determination, not written to file
  const { prompt, scope: _ignored, ...frontmatter } = config as Record<string, unknown> & { prompt?: unknown; scope?: unknown };
  void _ignored; // Scope is only used for path determination
  writeMdFile(targetPath, frontmatter, typeof prompt === 'string' ? prompt : '');
};

export const updateAgent = (agentName: string, updates: Record<string, unknown>, workingDirectory?: string) => {
  ensureDirs();

  // Determine correct path: project level takes precedence
  const { path: mdPath } = getAgentWritePath(agentName, workingDirectory);
  const mdExists = mdPath ? fs.existsSync(mdPath) : false;
  
  // Check if agent exists in opencode.json across all config layers
  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'agent', agentName);
  const jsonSection = jsonSource.section as Record<string, unknown> | undefined;
  const hasJsonFields = Boolean(jsonSource.exists && jsonSection && Object.keys(jsonSection).length > 0);
  const jsonTarget = jsonSource.exists
    ? { config: jsonSource.config, path: jsonSource.path }
    : getJsonWriteTarget(layers, workingDirectory ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER);
  const config = (jsonTarget.config || {}) as Record<string, unknown>;
  
  // Determine if we should create a new md file:
  // Only for built-in agents (no md file AND no json config)
  const isBuiltinOverride = !mdExists && !hasJsonFields;
  
  let targetPath = mdPath;
  
  if (!mdExists && isBuiltinOverride) {
    // Built-in agent override - create at user level
    targetPath = getUserAgentPath(agentName);
  }

  // Only create md data for existing md files or built-in overrides
  const mdData = mdExists && mdPath ? parseMdFile(mdPath) : (isBuiltinOverride ? { frontmatter: {} as Record<string, unknown>, body: '' } : null);

  let mdModified = false;
  let jsonModified = false;
  // Only create new md if it's a built-in override
  const creatingNewMd = isBuiltinOverride;

  for (const [field, value] of Object.entries(updates || {})) {
    if (field === 'prompt') {
      const normalizedValue = typeof value === 'string' ? value : value == null ? '' : String(value);

      if (mdExists || creatingNewMd) {
        if (mdData) {
          mdData.body = normalizedValue;
          mdModified = true;
        }
        continue;
      }

      if (isPromptFileReference(jsonSection?.prompt)) {
        const promptFilePath = resolvePromptFilePath(jsonSection.prompt);
        if (!promptFilePath) throw new Error(`Invalid prompt file reference for agent ${agentName}`);
        writePromptFile(promptFilePath, normalizedValue);
        continue;
      }

      // For JSON-only agents, store prompt inline in JSON
      if (!config.agent) config.agent = {};
      const current = ((config.agent as Record<string, unknown>)[agentName] as Record<string, unknown> | undefined) ?? {};
      (config.agent as Record<string, unknown>)[agentName] = { ...current, prompt: normalizedValue };
      jsonModified = true;
      continue;
    }

    const hasMdField = Boolean(mdData?.frontmatter?.[field] !== undefined);
    const hasJsonField = Boolean(jsonSection?.[field] !== undefined);

    // JSON takes precedence over md, so update JSON first if field exists there
    if (hasJsonField) {
      if (!config.agent) config.agent = {};
      const current = ((config.agent as Record<string, unknown>)[agentName] as Record<string, unknown> | undefined) ?? {};
      (config.agent as Record<string, unknown>)[agentName] = { ...current, [field]: value };
      jsonModified = true;
      continue;
    }

    if (hasMdField || creatingNewMd) {
      if (mdData) {
        mdData.frontmatter[field] = value;
        mdModified = true;
      }
      continue;
    }

    // New field - add to appropriate location based on agent source
    if ((mdExists || creatingNewMd) && mdData) {
      mdData.frontmatter[field] = value;
      mdModified = true;
    } else {
      if (!config.agent) config.agent = {};
      const current = ((config.agent as Record<string, unknown>)[agentName] as Record<string, unknown> | undefined) ?? {};
      (config.agent as Record<string, unknown>)[agentName] = { ...current, [field]: value };
      jsonModified = true;
    }
  }

  if (mdModified && mdData && targetPath) {
    writeMdFile(targetPath, mdData.frontmatter, mdData.body);
  }

  if (jsonModified) {
    writeConfig(config, jsonTarget.path || CONFIG_FILE);
  }
};

export const deleteAgent = (agentName: string, workingDirectory?: string) => {
  let deleted = false;

  // Check project level first (takes precedence)
  if (workingDirectory) {
    const projectPath = getProjectAgentPath(workingDirectory, agentName);
    if (fs.existsSync(projectPath)) {
      fs.unlinkSync(projectPath);
      deleted = true;
    }
  }

  // Then check user level
  const userPath = getUserAgentPath(agentName);
  if (fs.existsSync(userPath)) {
    fs.unlinkSync(userPath);
    deleted = true;
  }

  // Also check json config (highest precedence entry only)
  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'agent', agentName);
  if (jsonSource.exists && jsonSource.config && jsonSource.path) {
    const targetConfig = jsonSource.config as Record<string, unknown>;
    const agentMap = (targetConfig.agent as Record<string, unknown> | undefined) ?? {};
    delete agentMap[agentName];
    targetConfig.agent = agentMap;
    writeConfig(targetConfig, jsonSource.path);
    deleted = true;
  }

  // If nothing was deleted (built-in agent), disable it in highest-precedence config
  if (!deleted) {
    const jsonTarget = getJsonWriteTarget(layers, workingDirectory ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER);
    const targetConfig = (jsonTarget.config || {}) as Record<string, unknown>;
    const agentMap = (targetConfig.agent as Record<string, unknown> | undefined) ?? {};
    agentMap[agentName] = { disable: true };
    targetConfig.agent = agentMap;
    writeConfig(targetConfig, jsonTarget.path || CONFIG_FILE);
  }
};

export const getCommandSources = (commandName: string, workingDirectory?: string): ConfigSources => {
  // Check project level first (takes precedence)
  const projectPath = workingDirectory ? getProjectCommandPath(workingDirectory, commandName) : null;
  const projectExists = projectPath ? fs.existsSync(projectPath) : false;
  
  // Then check user level
  const userPath = getUserCommandPath(commandName);
  const userExists = fs.existsSync(userPath);
  
  // Determine which md file to use (project takes precedence)
  const mdPath = projectExists ? projectPath : (userExists ? userPath : null);
  const mdExists = !!mdPath;
  const mdScope = projectExists ? COMMAND_SCOPE.PROJECT : (userExists ? COMMAND_SCOPE.USER : null);

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'command', commandName);
  const commandSection = jsonSource.section as Record<string, unknown> | undefined;
  const jsonPath = jsonSource.path || layers.paths.customPath || layers.paths.projectPath || layers.paths.userPath;
  const jsonScope = jsonSource.path === layers.paths.projectPath ? COMMAND_SCOPE.PROJECT : COMMAND_SCOPE.USER;

  const sources: ConfigSources = {
    md: { exists: mdExists, path: mdPath, scope: mdScope, fields: [] },
    json: { exists: jsonSource.exists, path: jsonPath || CONFIG_FILE, scope: jsonSource.exists ? jsonScope : null, fields: [] },
    projectMd: { exists: projectExists, path: projectPath },
    userMd: { exists: userExists, path: userPath }
  };

  if (mdExists && mdPath) {
    const { frontmatter, body } = parseMdFile(mdPath);
    sources.md.fields = Object.keys(frontmatter);
    if (body) sources.md.fields.push('template');
  }

  if (commandSection) {
    sources.json.fields = Object.keys(commandSection);
  }

  return sources;
};

export const createCommand = (commandName: string, config: Record<string, unknown>, workingDirectory?: string, scope?: CommandScope) => {
  ensureDirs();

  // Check if command already exists at either level
  const projectPath = workingDirectory ? getProjectCommandPath(workingDirectory, commandName) : null;
  const userPath = getUserCommandPath(commandName);
  
  if (projectPath && fs.existsSync(projectPath)) {
    throw new Error(`Command ${commandName} already exists as project-level .md file`);
  }
  
  if (fs.existsSync(userPath)) {
    throw new Error(`Command ${commandName} already exists as user-level .md file`);
  }

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'command', commandName);
  if (jsonSource.exists) throw new Error(`Command ${commandName} already exists in opencode.json`);

  // Determine target path based on requested scope
  let targetPath: string;
  
  if (scope === COMMAND_SCOPE.PROJECT && workingDirectory) {
    ensureProjectCommandDir(workingDirectory);
    targetPath = projectPath!;
  } else {
    targetPath = userPath;
  }

  // Extract scope from config - it's only used for path determination, not written to file
  const { template, scope: _ignored, ...frontmatter } = config as Record<string, unknown> & { template?: unknown; scope?: unknown };
  void _ignored; // Scope is only used for path determination
  writeMdFile(targetPath, frontmatter, typeof template === 'string' ? template : '');
};

export const updateCommand = (commandName: string, updates: Record<string, unknown>, workingDirectory?: string) => {
  ensureDirs();

  // Determine correct path: project level takes precedence
  const { path: mdPath } = getCommandWritePath(commandName, workingDirectory);
  const mdExists = mdPath ? fs.existsSync(mdPath) : false;

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'command', commandName);
  const jsonSection = jsonSource.section as Record<string, unknown> | undefined;
  const hasJsonFields = Boolean(jsonSource.exists && jsonSection && Object.keys(jsonSection).length > 0);
  const jsonTarget = jsonSource.exists
    ? { config: jsonSource.config, path: jsonSource.path }
    : getJsonWriteTarget(layers, workingDirectory ? COMMAND_SCOPE.PROJECT : COMMAND_SCOPE.USER);
  const config = (jsonTarget.config || {}) as Record<string, unknown>;

  // Only create a new md file for built-in overrides (no md + no json)
  const isBuiltinOverride = !mdExists && !hasJsonFields;

  let targetPath = mdPath;
  if (!mdExists && isBuiltinOverride) {
    // Built-in command override - create at user level
    targetPath = getUserCommandPath(commandName);
  }

  const mdData = mdExists && mdPath ? parseMdFile(mdPath) : (isBuiltinOverride ? { frontmatter: {} as Record<string, unknown>, body: '' } : null);

  let mdModified = false;
  let jsonModified = false;
  const creatingNewMd = isBuiltinOverride;

  for (const [field, value] of Object.entries(updates || {})) {
    if (field === 'template') {
      const normalizedValue = typeof value === 'string' ? value : value == null ? '' : String(value);

      if (mdExists || creatingNewMd) {
        if (mdData) {
          mdData.body = normalizedValue;
          mdModified = true;
        }
        continue;
      }

      if (isPromptFileReference(jsonSection?.template)) {
        const templateFilePath = resolvePromptFilePath(jsonSection.template);
        if (!templateFilePath) throw new Error(`Invalid template file reference for command ${commandName}`);
        writePromptFile(templateFilePath, normalizedValue);
        continue;
      }

      // For JSON-only commands, store template inline in JSON
      if (!config.command) config.command = {};
      const current = ((config.command as Record<string, unknown>)[commandName] as Record<string, unknown> | undefined) ?? {};
      (config.command as Record<string, unknown>)[commandName] = { ...current, template: normalizedValue };
      jsonModified = true;
      continue;
    }

    const hasMdField = Boolean(mdData?.frontmatter?.[field] !== undefined);
    const hasJsonField = Boolean(jsonSection?.[field] !== undefined);

    // JSON takes precedence over md, so update JSON first if field exists there
    if (hasJsonField) {
      if (!config.command) config.command = {};
      const current = ((config.command as Record<string, unknown>)[commandName] as Record<string, unknown> | undefined) ?? {};
      (config.command as Record<string, unknown>)[commandName] = { ...current, [field]: value };
      jsonModified = true;
      continue;
    }

    if (hasMdField || creatingNewMd) {
      if (mdData) {
        mdData.frontmatter[field] = value;
        mdModified = true;
      }
      continue;
    }

    // New field - add to appropriate location based on command source
    if ((mdExists || creatingNewMd) && mdData) {
      mdData.frontmatter[field] = value;
      mdModified = true;
    } else {
      if (!config.command) config.command = {};
      const current = ((config.command as Record<string, unknown>)[commandName] as Record<string, unknown> | undefined) ?? {};
      (config.command as Record<string, unknown>)[commandName] = { ...current, [field]: value };
      jsonModified = true;
    }
  }

  if (mdModified && mdData && targetPath) {
    writeMdFile(targetPath, mdData.frontmatter, mdData.body);
  }

  if (jsonModified) {
    writeConfig(config, jsonTarget.path || CONFIG_FILE);
  }
};

export const getProviderSources = (providerId: string, workingDirectory?: string) => {
  const layers = readConfigLayers(workingDirectory);
  const customProviders = isPlainObject((layers.customConfig as Record<string, unknown>)?.provider)
    ? (layers.customConfig as Record<string, unknown>).provider as Record<string, unknown>
    : {};
  const customProvidersAlias = isPlainObject((layers.customConfig as Record<string, unknown>)?.providers)
    ? (layers.customConfig as Record<string, unknown>).providers as Record<string, unknown>
    : {};
  const projectProviders = isPlainObject((layers.projectConfig as Record<string, unknown>)?.provider)
    ? (layers.projectConfig as Record<string, unknown>).provider as Record<string, unknown>
    : {};
  const projectProvidersAlias = isPlainObject((layers.projectConfig as Record<string, unknown>)?.providers)
    ? (layers.projectConfig as Record<string, unknown>).providers as Record<string, unknown>
    : {};
  const userProviders = isPlainObject((layers.userConfig as Record<string, unknown>)?.provider)
    ? (layers.userConfig as Record<string, unknown>).provider as Record<string, unknown>
    : {};
  const userProvidersAlias = isPlainObject((layers.userConfig as Record<string, unknown>)?.providers)
    ? (layers.userConfig as Record<string, unknown>).providers as Record<string, unknown>
    : {};

  const customExists = Object.prototype.hasOwnProperty.call(customProviders, providerId)
    || Object.prototype.hasOwnProperty.call(customProvidersAlias, providerId);
  const projectExists = Object.prototype.hasOwnProperty.call(projectProviders, providerId)
    || Object.prototype.hasOwnProperty.call(projectProvidersAlias, providerId);
  const userExists = Object.prototype.hasOwnProperty.call(userProviders, providerId)
    || Object.prototype.hasOwnProperty.call(userProvidersAlias, providerId);

  return {
    auth: { exists: false },
    user: { exists: userExists, path: layers.paths.userPath },
    project: { exists: projectExists, path: layers.paths.projectPath ?? null },
    custom: { exists: customExists, path: layers.paths.customPath },
  };
};

export const removeProviderConfig = (providerId: string, workingDirectory?: string, scope: 'user' | 'project' | 'custom' = 'user') => {
  if (!providerId) throw new Error('Provider ID is required');

  const layers = readConfigLayers(workingDirectory);
  let targetPath: string | null | undefined = layers.paths.userPath;

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = layers.paths.projectPath ?? targetPath;
  }

  if (scope === 'custom') {
    if (!layers.paths.customPath) {
      return false;
    }
    targetPath = layers.paths.customPath;
  }

  const targetConfig = getConfigForPath(layers, targetPath);
  const providerConfig = isPlainObject((targetConfig as Record<string, unknown>).provider)
    ? (targetConfig as Record<string, unknown>).provider as Record<string, unknown>
    : {};
  const providersConfig = isPlainObject((targetConfig as Record<string, unknown>).providers)
    ? (targetConfig as Record<string, unknown>).providers as Record<string, unknown>
    : {};

  const removedProvider = Object.prototype.hasOwnProperty.call(providerConfig, providerId);
  const removedProviders = Object.prototype.hasOwnProperty.call(providersConfig, providerId);

  if (!removedProvider && !removedProviders) {
    return false;
  }

  if (removedProvider) {
    delete providerConfig[providerId];
    if (Object.keys(providerConfig).length === 0) {
      delete (targetConfig as Record<string, unknown>).provider;
    } else {
      (targetConfig as Record<string, unknown>).provider = providerConfig;
    }
  }

  if (removedProviders) {
    delete providersConfig[providerId];
    if (Object.keys(providersConfig).length === 0) {
      delete (targetConfig as Record<string, unknown>).providers;
    } else {
      (targetConfig as Record<string, unknown>).providers = providersConfig;
    }
  }

  writeConfig(targetConfig as Record<string, unknown>, targetPath || CONFIG_FILE);
  return true;
};

export const deleteCommand = (commandName: string, workingDirectory?: string) => {
  let deleted = false;

  // Check project level first (takes precedence)
  if (workingDirectory) {
    const projectPath = getProjectCommandPath(workingDirectory, commandName);
    if (fs.existsSync(projectPath)) {
      fs.unlinkSync(projectPath);
      deleted = true;
    }
  }

  // Then check user level
  const userPath = getUserCommandPath(commandName);
  if (fs.existsSync(userPath)) {
    fs.unlinkSync(userPath);
    deleted = true;
  }

  // Also check json config (highest precedence entry only)
  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'command', commandName);
  if (jsonSource.exists && jsonSource.config && jsonSource.path) {
    const targetConfig = jsonSource.config as Record<string, unknown>;
    const commandMap = (targetConfig.command as Record<string, unknown> | undefined) ?? {};
    delete commandMap[commandName];
    targetConfig.command = commandMap;
    writeConfig(targetConfig, jsonSource.path);
    deleted = true;
  }

  if (!deleted) {
    throw new Error(`Command "${commandName}" not found`);
  }
};

// ============== SKILL SCOPE HELPERS ==============

const SKILL_DIR = path.join(OPENCODE_CONFIG_DIR, 'skills');

export const SKILL_SCOPE = {
  USER: 'user',
  PROJECT: 'project'
} as const;

export type SkillScope = typeof SKILL_SCOPE[keyof typeof SKILL_SCOPE];
export type SkillSource = 'opencode' | 'claude' | 'agents';

export type SupportingFile = {
  name: string;
  path: string;
  fullPath: string;
};

export type SkillConfigSources = {
  md: {
    exists: boolean;
    path: string | null;
    dir: string | null;
    fields: string[];
    scope?: SkillScope | null;
    source?: SkillSource | null;
    supportingFiles: SupportingFile[];
  };
  projectMd?: { exists: boolean; path: string | null };
  claudeMd?: { exists: boolean; path: string | null };
  userMd?: { exists: boolean; path: string | null };
};

export type DiscoveredSkill = {
  name: string;
  path: string;
  scope: SkillScope;
  source: SkillSource;
  description?: string;
};

const addSkillFromMdFile = (
  skillsMap: Map<string, DiscoveredSkill>,
  skillMdPath: string,
  scope: SkillScope,
  source: SkillSource
) => {
  try {
    const parsed = parseMdFile(skillMdPath);
    const name = typeof parsed.frontmatter?.name === 'string'
      ? parsed.frontmatter.name.trim()
      : '';
    const description = typeof parsed.frontmatter?.description === 'string'
      ? parsed.frontmatter.description
      : '';

    if (!name) {
      return;
    }

    skillsMap.set(name, {
      name,
      path: skillMdPath,
      scope,
      source,
      description,
    });
  } catch {
    // Ignore invalid SKILL.md entries.
  }
};

const ensureSkillDirs = () => {
  if (!fs.existsSync(SKILL_DIR)) {
    fs.mkdirSync(SKILL_DIR, { recursive: true });
  }
};

const getUserSkillDir = (skillName: string): string => {
  const pluralPath = path.join(SKILL_DIR, skillName);
  const legacyPath = path.join(OPENCODE_CONFIG_DIR, 'skill', skillName);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
};

const getUserSkillPath = (skillName: string): string => {
  const pluralPath = path.join(SKILL_DIR, skillName, 'SKILL.md');
  const legacyPath = path.join(OPENCODE_CONFIG_DIR, 'skill', skillName, 'SKILL.md');
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
};

const getProjectSkillDir = (workingDirectory: string, skillName: string): string => {
  const pluralPath = path.join(workingDirectory, '.opencode', 'skills', skillName);
  const legacyPath = path.join(workingDirectory, '.opencode', 'skill', skillName);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
};

const getProjectSkillPath = (workingDirectory: string, skillName: string): string => {
  const pluralPath = path.join(workingDirectory, '.opencode', 'skills', skillName, 'SKILL.md');
  const legacyPath = path.join(workingDirectory, '.opencode', 'skill', skillName, 'SKILL.md');
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
};

const getClaudeSkillDir = (workingDirectory: string, skillName: string): string => {
  return path.join(workingDirectory, '.claude', 'skills', skillName);
};

const getClaudeSkillPath = (workingDirectory: string, skillName: string): string => {
  return path.join(getClaudeSkillDir(workingDirectory, skillName), 'SKILL.md');
};

const getUserAgentsSkillDir = (skillName: string): string => {
  return path.join(os.homedir(), '.agents', 'skills', skillName);
};

const getProjectAgentsSkillDir = (workingDirectory: string, skillName: string): string => {
  return path.join(workingDirectory, '.agents', 'skills', skillName);
};

export const getSkillScope = (skillName: string, workingDirectory?: string): { 
  scope: SkillScope | null; 
  path: string | null; 
  source: SkillSource | null;
} => {
  const discovered = discoverSkills(workingDirectory).find((skill) => skill.name === skillName);
  if (discovered?.path) {
    return { scope: discovered.scope, path: discovered.path, source: discovered.source };
  }

  if (workingDirectory) {
    // Check .opencode/skill first
    const projectPath = getProjectSkillPath(workingDirectory, skillName);
    if (fs.existsSync(projectPath)) {
      return { scope: SKILL_SCOPE.PROJECT, path: projectPath, source: 'opencode' };
    }
    
    // Check .claude/skills (claude-compat)
    const claudePath = getClaudeSkillPath(workingDirectory, skillName);
    if (fs.existsSync(claudePath)) {
      return { scope: SKILL_SCOPE.PROJECT, path: claudePath, source: 'claude' };
    }
  }
  
  const userPath = getUserSkillPath(skillName);
  if (fs.existsSync(userPath)) {
    return { scope: SKILL_SCOPE.USER, path: userPath, source: 'opencode' };
  }
  
  return { scope: null, path: null, source: null };
};

const listSupportingFiles = (skillDir: string): SupportingFile[] => {
  if (!fs.existsSync(skillDir)) return [];
  
  const files: SupportingFile[] = [];
  
  const walkDir = (dir: string, relativePath: string = '') => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;
      
      if (entry.isDirectory()) {
        walkDir(fullPath, relPath);
      } else if (entry.name !== 'SKILL.md') {
        files.push({
          name: entry.name,
          path: relPath,
          fullPath
        });
      }
    }
  };
  
  walkDir(skillDir);
  return files;
};

export const discoverSkills = (workingDirectory?: string): DiscoveredSkill[] => {
  const skills = new Map<string, DiscoveredSkill>();

  // 1) External global (.claude, .agents)
  for (const externalRootName of ['.claude', '.agents']) {
    const source: SkillSource = externalRootName === '.agents' ? 'agents' : 'claude';
    const homeRoot = path.join(os.homedir(), externalRootName, 'skills');
    for (const skillMdPath of walkSkillMdFiles(homeRoot)) {
      addSkillFromMdFile(skills, skillMdPath, SKILL_SCOPE.USER, source);
    }
  }

  // 2) External project ancestors (.claude, .agents)
  if (workingDirectory) {
    const worktreeRoot = findWorktreeRoot(workingDirectory) || path.resolve(workingDirectory);
    const ancestors = getAncestors(workingDirectory, worktreeRoot);
    for (const ancestor of ancestors) {
      for (const externalRootName of ['.claude', '.agents']) {
        const source: SkillSource = externalRootName === '.agents' ? 'agents' : 'claude';
        const externalSkillsRoot = path.join(ancestor, externalRootName, 'skills');
        for (const skillMdPath of walkSkillMdFiles(externalSkillsRoot)) {
          addSkillFromMdFile(skills, skillMdPath, SKILL_SCOPE.PROJECT, source);
        }
      }
    }
  }

  // 3) Config directories: {skill,skills}/**/SKILL.md
  const configDirectories = resolveSkillSearchDirectories(workingDirectory);
  const homeOpencodeDir = path.resolve(path.join(os.homedir(), '.opencode'));
  const customConfigDir = process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : null;
  for (const dir of configDirectories) {
    for (const subDir of ['skill', 'skills']) {
      const root = path.join(dir, subDir);
      for (const skillMdPath of walkSkillMdFiles(root)) {
        const isUserConfigDir = dir === OPENCODE_CONFIG_DIR
          || dir === homeOpencodeDir
          || (customConfigDir && dir === customConfigDir);
        const scope = isUserConfigDir ? SKILL_SCOPE.USER : SKILL_SCOPE.PROJECT;
        addSkillFromMdFile(skills, skillMdPath, scope, 'opencode');
      }
    }
  }

  // 4) Additional config.skills.paths
  let configuredPaths: unknown[] = [];
  try {
    const config = readConfig(workingDirectory);
    const skillsConfig = isPlainObject(config.skills) ? config.skills : null;
    configuredPaths = Array.isArray(skillsConfig?.paths) ? skillsConfig.paths : [];
  } catch {
    configuredPaths = [];
  }
  for (const skillPath of configuredPaths) {
    if (typeof skillPath !== 'string' || !skillPath.trim()) continue;
    const expanded = skillPath.startsWith('~/')
      ? path.join(os.homedir(), skillPath.slice(2))
      : skillPath;
    const resolved = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(workingDirectory || process.cwd(), expanded);
    for (const skillMdPath of walkSkillMdFiles(resolved)) {
      addSkillFromMdFile(skills, skillMdPath, SKILL_SCOPE.PROJECT, 'opencode');
    }
  }

  // 5) Cached skills from config.skills.urls pulls (best-effort, no network)
  const cacheCandidates: string[] = [];
  if (process.env.XDG_CACHE_HOME) {
    cacheCandidates.push(path.join(process.env.XDG_CACHE_HOME, 'opencode', 'skills'));
  }
  cacheCandidates.push(path.join(os.homedir(), '.cache', 'opencode', 'skills'));
  cacheCandidates.push(path.join(os.homedir(), 'Library', 'Caches', 'opencode', 'skills'));

  for (const cacheRoot of cacheCandidates) {
    if (!fs.existsSync(cacheRoot)) continue;
    const entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillRoot = path.join(cacheRoot, entry.name);
      for (const skillMdPath of walkSkillMdFiles(skillRoot)) {
        addSkillFromMdFile(skills, skillMdPath, SKILL_SCOPE.USER, 'opencode');
      }
    }
  }

  return Array.from(skills.values());
};

export const getSkillSources = (
  skillName: string,
  workingDirectory?: string,
  discoveredSkill?: DiscoveredSkill | null
): SkillConfigSources => {
  ensureSkillDirs();
  
  // Check all possible locations
  const projectPath = workingDirectory ? getProjectSkillPath(workingDirectory, skillName) : null;
  const projectExists = projectPath ? fs.existsSync(projectPath) : false;
  const projectDir = projectExists && workingDirectory ? getProjectSkillDir(workingDirectory, skillName) : null;
  
  const claudePath = workingDirectory ? getClaudeSkillPath(workingDirectory, skillName) : null;
  const claudeExists = claudePath ? fs.existsSync(claudePath) : false;
  const claudeDir = claudeExists && workingDirectory ? getClaudeSkillDir(workingDirectory, skillName) : null;
  
  const userPath = getUserSkillPath(skillName);
  const userExists = fs.existsSync(userPath);
  const userDir = userExists ? getUserSkillDir(skillName) : null;

  const matchedDiscovered = discoveredSkill?.name === skillName
    ? discoveredSkill
    : discoverSkills(workingDirectory).find((skill) => skill.name === skillName);
  
  // Determine which md file to use (priority: project > claude > user)
  let mdPath: string | null = null;
  let mdScope: SkillScope | null = null;
  let mdSource: SkillSource | null = null;
  let mdDir: string | null = null;
  
  if (projectExists) {
    mdPath = projectPath;
    mdScope = SKILL_SCOPE.PROJECT;
    mdSource = 'opencode';
    mdDir = projectDir;
  } else if (claudeExists) {
    mdPath = claudePath;
    mdScope = SKILL_SCOPE.PROJECT;
    mdSource = 'claude';
    mdDir = claudeDir;
  } else if (userExists) {
    mdPath = userPath;
    mdScope = SKILL_SCOPE.USER;
    mdSource = 'opencode';
    mdDir = userDir;
  } else if (matchedDiscovered?.path) {
    mdPath = matchedDiscovered.path;
    mdScope = matchedDiscovered.scope;
    mdSource = matchedDiscovered.source;
    mdDir = path.dirname(matchedDiscovered.path);
  }
  
  const mdExists = !!mdPath;
  let mdFields: string[] = [];
  let supportingFiles: SupportingFile[] = [];
  
  if (mdExists && mdPath) {
    const { frontmatter, body } = parseMdFile(mdPath);
    mdFields = Object.keys(frontmatter);
    if (body) mdFields.push('instructions');
    if (mdDir) {
      supportingFiles = listSupportingFiles(mdDir);
    }
  }
  
  return {
    md: {
      exists: mdExists,
      path: mdPath,
      dir: mdDir,
      fields: mdFields,
      scope: mdScope,
      source: mdSource,
      supportingFiles
    },
    projectMd: { exists: projectExists, path: projectPath },
    claudeMd: { exists: claudeExists, path: claudePath },
    userMd: { exists: userExists, path: userPath }
  };
};

export const readSkillSupportingFile = (skillDir: string, relativePath: string): string | null => {
  const fullPath = path.join(skillDir, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, 'utf8');
};

export const writeSkillSupportingFile = (skillDir: string, relativePath: string, content: string): void => {
  const fullPath = path.join(skillDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
};

export const deleteSkillSupportingFile = (skillDir: string, relativePath: string): void => {
  const fullPath = path.join(skillDir, relativePath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
    // Clean up empty parent directories
    let parentDir = path.dirname(fullPath);
    while (parentDir !== skillDir) {
      try {
        const entries = fs.readdirSync(parentDir);
        if (entries.length === 0) {
          fs.rmdirSync(parentDir);
          parentDir = path.dirname(parentDir);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }
};

const validateSkillName = (skillName: string): void => {
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(skillName) || skillName.length > 64) {
    throw new Error(`Invalid skill name "${skillName}". Must be 1-64 lowercase alphanumeric characters with hyphens, cannot start or end with hyphen.`);
  }
};

export const createSkill = (skillName: string, config: Record<string, unknown>, workingDirectory?: string, scope?: SkillScope): void => {
  ensureSkillDirs();
  validateSkillName(skillName);
  
  // Check if skill already exists
  const existing = getSkillScope(skillName, workingDirectory);
  if (existing.path) {
    throw new Error(`Skill ${skillName} already exists at ${existing.path}`);
  }
  
  // Determine target directory
  let targetDir: string;
  
  const requestedScope = scope === SKILL_SCOPE.PROJECT ? SKILL_SCOPE.PROJECT : SKILL_SCOPE.USER;
  const requestedSource: SkillSource = config.source === 'agents' ? 'agents' : 'opencode';

  if (requestedScope === SKILL_SCOPE.PROJECT && workingDirectory) {
    targetDir = requestedSource === 'agents'
      ? getProjectAgentsSkillDir(workingDirectory, skillName)
      : getProjectSkillDir(workingDirectory, skillName);
  } else {
    targetDir = requestedSource === 'agents'
      ? getUserAgentsSkillDir(skillName)
      : getUserSkillDir(skillName);
  }
  
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, 'SKILL.md');
  
  // Extract fields
  const { instructions, scope: _ignored, source: _sourceIgnored, supportingFiles: supportingFilesData, ...frontmatter } = config as Record<string, unknown> & { 
    instructions?: unknown; 
    scope?: unknown; 
    source?: unknown;
    supportingFiles?: Array<{ path: string; content: string }>;
  };
  void _ignored;
  void _sourceIgnored;
  
  // Ensure required fields
  if (!frontmatter.name) {
    frontmatter.name = skillName;
  }
  if (!frontmatter.description) {
    throw new Error('Skill description is required');
  }
  
  writeMdFile(targetPath, frontmatter, typeof instructions === 'string' ? instructions : '');
  
  // Write supporting files if provided
  if (supportingFilesData && Array.isArray(supportingFilesData)) {
    for (const file of supportingFilesData) {
      if (file.path && file.content !== undefined) {
        writeSkillSupportingFile(targetDir, file.path, file.content);
      }
    }
  }
};

export const updateSkill = (skillName: string, updates: Record<string, unknown>, workingDirectory?: string): void => {
  const existing = getSkillScope(skillName, workingDirectory);
  if (!existing.path) {
    throw new Error(`Skill "${skillName}" not found`);
  }
  
  const mdPath = existing.path;
  const mdDir = path.dirname(mdPath);
  const mdData = parseMdFile(mdPath);
  let mdModified = false;
  
  for (const [field, value] of Object.entries(updates || {})) {
    if (field === 'scope') continue;
    
    if (field === 'instructions') {
      const normalizedValue = typeof value === 'string' ? value : value == null ? '' : String(value);
      mdData.body = normalizedValue;
      mdModified = true;
      continue;
    }
    
    if (field === 'supportingFiles' && Array.isArray(value)) {
      for (const file of value as Array<{ delete?: boolean; path?: string; content?: string }>) {
        if (file.delete && file.path) {
          deleteSkillSupportingFile(mdDir, file.path);
        } else if (file.path && file.content !== undefined) {
          writeSkillSupportingFile(mdDir, file.path, file.content);
        }
      }
      continue;
    }
    
    mdData.frontmatter[field] = value;
    mdModified = true;
  }
  
  if (mdModified) {
    writeMdFile(mdPath, mdData.frontmatter, mdData.body);
  }
};

export const deleteSkill = (skillName: string, workingDirectory?: string): void => {
  let deleted = false;
  
  // Check and delete from all locations
  if (workingDirectory) {
    // Project level .opencode/skill/
    const projectDir = getProjectSkillDir(workingDirectory, skillName);
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
      deleted = true;
    }
    
    // Claude-compat .claude/skills/
    const claudeDir = getClaudeSkillDir(workingDirectory, skillName);
    if (fs.existsSync(claudeDir)) {
      fs.rmSync(claudeDir, { recursive: true, force: true });
      deleted = true;
    }

    const projectAgentsDir = getProjectAgentsSkillDir(workingDirectory, skillName);
    if (fs.existsSync(projectAgentsDir)) {
      fs.rmSync(projectAgentsDir, { recursive: true, force: true });
      deleted = true;
    }
  }
  
  // User level
  const userDir = getUserSkillDir(skillName);
  if (fs.existsSync(userDir)) {
    fs.rmSync(userDir, { recursive: true, force: true });
    deleted = true;
  }

  const userAgentsDir = getUserAgentsSkillDir(skillName);
  if (fs.existsSync(userAgentsDir)) {
    fs.rmSync(userAgentsDir, { recursive: true, force: true });
    deleted = true;
  }
  
  if (!deleted) {
    throw new Error(`Skill "${skillName}" not found`);
  }
};
