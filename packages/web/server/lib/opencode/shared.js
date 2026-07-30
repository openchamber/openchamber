import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import yaml from 'yaml';
import { parse as parseJsonc } from 'jsonc-parser';

// ============== PATH CONSTANTS ==============

const OPENCODE_CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME ? path.resolve(process.env.XDG_CONFIG_HOME) : path.join(os.homedir(), '.config'),
  'opencode',
);
const AGENT_DIR = path.join(OPENCODE_CONFIG_DIR, 'agents');
const COMMAND_DIR = path.join(OPENCODE_CONFIG_DIR, 'commands');
const SKILL_DIR = path.join(OPENCODE_CONFIG_DIR, 'skills');
const CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'config.json');
const CUSTOM_CONFIG_FILE = process.env.OPENCODE_CONFIG
  ? path.resolve(process.env.OPENCODE_CONFIG)
  : null;
const PROMPT_FILE_PATTERN = /^\{file:(.+)\}$/i;

// ============== SCOPE TYPE CONSTANTS ==============

const AGENT_SCOPE = {
  USER: 'user',
  PROJECT: 'project'
};

const COMMAND_SCOPE = {
  USER: 'user',
  PROJECT: 'project'
};

const SKILL_SCOPE = {
  USER: 'user',
  PROJECT: 'project'
};

// ============== DIRECTORY OPERATIONS ==============

function ensureDirs() {
  if (!fs.existsSync(OPENCODE_CONFIG_DIR)) {
    fs.mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });
  }
  if (!fs.existsSync(AGENT_DIR)) {
    fs.mkdirSync(AGENT_DIR, { recursive: true });
  }
  if (!fs.existsSync(COMMAND_DIR)) {
    fs.mkdirSync(COMMAND_DIR, { recursive: true });
  }
  if (!fs.existsSync(SKILL_DIR)) {
    fs.mkdirSync(SKILL_DIR, { recursive: true });
  }
}

// ============== MARKDOWN FILE OPERATIONS ==============

function parseMdFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  let frontmatter = {};
  try {
    frontmatter = yaml.parse(match[1]) || {};
  } catch (error) {
    console.warn(`Failed to parse markdown frontmatter ${filePath}, treating as empty:`, error);
    frontmatter = {};
  }

  const body = match[2].trim();
  return { frontmatter, body };
}

function writeMdFile(filePath, frontmatter, body) {
  try {
    const cleanedFrontmatter = Object.fromEntries(
      Object.entries(frontmatter).filter(([, value]) => value != null)
    );
    const yamlStr = yaml.stringify(cleanedFrontmatter);
    const content = `---\n${yamlStr}---\n\n${body}`;
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Successfully wrote markdown file: ${filePath}`);
  } catch (error) {
    console.error(`Failed to write markdown file ${filePath}:`, error);
    throw new Error('Failed to write agent markdown file');
  }
}

// ============== CONFIG FILE OPERATIONS ==============

function getProjectConfigCandidates(workingDirectory) {
  if (!workingDirectory) return [];
  return [
    path.join(workingDirectory, 'opencode.json'),
    path.join(workingDirectory, 'opencode.jsonc'),
    path.join(workingDirectory, '.opencode', 'opencode.json'),
    path.join(workingDirectory, '.opencode', 'opencode.jsonc'),
  ];
}

function getExistingConfigPaths(directory, names = ['opencode.json', 'opencode.jsonc']) {
  if (!directory) return [];
  return names.map((name) => path.join(directory, name)).filter((filePath) => fs.existsSync(filePath));
}

function getManagedConfigDir() {
  if (process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR) {
    return path.resolve(process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR);
  }
  if (process.platform === 'darwin') return '/Library/Application Support/opencode';
  if (process.platform === 'win32') return path.join(process.env.ProgramData || 'C:\\ProgramData', 'opencode');
  return '/etc/opencode';
}

function getProjectConfigPath(workingDirectory) {
  if (!workingDirectory) return null;

  const candidates = getProjectConfigCandidates(workingDirectory);

  for (const candidate of candidates.toReversed()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function getConfigPaths(workingDirectory) {
  return {
    userPaths: [
      path.join(OPENCODE_CONFIG_DIR, 'config.json'),
      path.join(OPENCODE_CONFIG_DIR, 'opencode.json'),
      path.join(OPENCODE_CONFIG_DIR, 'opencode.jsonc'),
    ],
    projectPath: getProjectConfigPath(workingDirectory),
    customPath: CUSTOM_CONFIG_FILE
  };
}

function getPrimaryUserConfigPath(userPaths) {
  for (const userPath of userPaths.toReversed()) {
    if (fs.existsSync(userPath)) {
      return userPath;
    }
  }

  return CONFIG_FILE;
}

function resolveConfigString(value, sourceDirectory) {
  let resolved = value.replace(/\{env:([^}]+)\}/g, (_, name) => {
    const value = process.env[name];
    if (value === undefined) throw new Error('unavailable config variable');
    return value;
  });

  resolved = resolved.replace(/\{file:([^}]+)\}/g, (_, configuredPath) => {
    let filePath = configuredPath;
    if (filePath.startsWith('~/')) filePath = path.join(os.homedir(), filePath.slice(2));
    if (!path.isAbsolute(filePath)) filePath = path.resolve(sourceDirectory, filePath);
    return fs.readFileSync(filePath, 'utf8').trim();
  });
  return resolved;
}

function parseConfigContent(content) {
  try {
    const normalized = content.trim();
    if (!normalized) {
      return {};
    }
    const errors = [];
    const config = parseJsonc(normalized, errors, { allowTrailingComma: true });
    if (errors.length > 0 || !isPlainObject(config)) {
      throw new Error('invalid config');
    }
    for (const key of ['disabled_providers', 'enabled_providers']) {
      if (config[key] !== undefined
        && (!Array.isArray(config[key]) || config[key].some((value) => typeof value !== 'string'))) {
        throw new Error('invalid provider policy');
      }
    }
    if (config.provider !== undefined && !isPlainObject(config.provider)) {
      throw new Error('invalid providers');
    }
    for (const provider of Object.values(config.provider || {})) {
      if (!isPlainObject(provider)
        || (provider.options !== undefined && !isPlainObject(provider.options))) {
        throw new Error('invalid provider');
      }
    }
    return config;
  } catch {
    throw new Error('Failed to read OpenCode configuration');
  }
}

function readConfigFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    return parseConfigContent(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error('Failed to read OpenCode configuration');
  }
}

function readManagedPreferences() {
  if (process.platform !== 'darwin') return null;
  let username = 'user';
  try {
    username = os.userInfo().username || username;
  } catch {
    // Keep OpenCode's fallback username.
  }
  const candidates = [
    path.join('/Library/Managed Preferences', username, 'ai.opencode.managed.plist'),
    '/Library/Managed Preferences/ai.opencode.managed.plist',
  ];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const config = parseConfigContent(
        execFileSync('plutil', ['-convert', 'json', '-o', '-', filePath], { encoding: 'utf8' }),
      );
      for (const key of ['PayloadDisplayName', 'PayloadIdentifier', 'PayloadType', 'PayloadUUID', 'PayloadVersion', '_manualProfile']) {
        delete config[key];
      }
      return { config, filePath: `mobileconfig:${filePath}`, sourceDirectory: path.dirname(filePath), scope: 'managed', writable: false };
    } catch {
      throw new Error('Failed to read OpenCode configuration');
    }
  }
  return null;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfigs(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const result = { ...base };
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
}

function readConfigLayers(workingDirectory) {
  const { userPaths, projectPath, customPath } = getConfigPaths(workingDirectory);
  const userPath = getPrimaryUserConfigPath(userPaths);
  const worktreeRoot = workingDirectory ? findWorktreeRoot(workingDirectory) : null;
  const disableProjectConfig = ['true', '1'].includes(
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG?.toLowerCase(),
  );
  const projectDirectories = workingDirectory && !disableProjectConfig
    ? getAncestors(workingDirectory, worktreeRoot)
    : [];
  const customConfigDir = process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : null;
  const managedConfigDir = getManagedConfigDir();
  const sources = [];
  const addFile = (filePath, scope, writable = true) => {
    if (!filePath || !fs.existsSync(filePath)) return;
    sources.push({ config: readConfigFile(filePath), filePath, sourceDirectory: path.dirname(filePath), scope, writable });
  };

  userPaths.forEach((filePath) => addFile(filePath, 'user'));
  addFile(customPath, 'custom');
  projectDirectories.toReversed().forEach((directory) => {
    getExistingConfigPaths(directory).forEach((filePath) => addFile(filePath, 'project'));
  });
  projectDirectories.forEach((directory) => {
    getExistingConfigPaths(path.join(directory, '.opencode')).forEach((filePath) => addFile(filePath, 'project'));
  });
  getExistingConfigPaths(path.join(os.homedir(), '.opencode')).forEach((filePath) => addFile(filePath, 'user'));
  getExistingConfigPaths(customConfigDir).forEach((filePath) => addFile(filePath, 'custom-directory'));

  if (process.env.OPENCODE_CONFIG_CONTENT) {
    sources.push({
      config: parseConfigContent(process.env.OPENCODE_CONFIG_CONTENT),
      filePath: null,
      sourceDirectory: workingDirectory || process.cwd(),
      scope: 'inline',
      writable: false,
    });
  }
  getExistingConfigPaths(managedConfigDir).forEach((filePath) => addFile(filePath, 'managed', false));
  const managedPreferences = readManagedPreferences();
  if (managedPreferences) sources.push(managedPreferences);

  const mergeScope = (...scopes) => sources
    .filter((source) => scopes.includes(source.scope))
    .reduce((config, source) => mergeConfigs(config, source.config), {});
  const userConfig = mergeScope('user');
  const customConfig = mergeScope('custom', 'custom-directory');
  const projectConfig = mergeScope('project');
  const mergedConfig = sources.reduce((config, source) => mergeConfigs(config, source.config), {});

  return {
    userConfig,
    projectConfig,
    customConfig,
    mergedConfig,
    paths: { userPath, projectPath, customPath },
    sources,
  };
}

function readConfig(workingDirectory) {
  return readConfigLayers(workingDirectory).mergedConfig;
}

function resolveConfigValue(layers, key, workingDirectory) {
  const source = [...(layers.sources || [])].reverse()
    .find((candidate) => Object.hasOwn(candidate.config || {}, key));
  const value = source?.config?.[key];
  if (typeof value !== 'string') return value;
  try {
    return resolveConfigString(
      value,
      source.sourceDirectory || (source.filePath ? path.dirname(source.filePath) : workingDirectory || process.cwd()),
    );
  } catch {
    throw new Error('Failed to resolve OpenCode configuration');
  }
}

function getConfigForPath(layers, targetPath) {
  if (!targetPath) {
    return layers.userConfig;
  }
  const source = layers.sources?.find((candidate) => candidate.filePath === targetPath);
  if (source) return source.config;
  if (layers.paths.customPath && targetPath === layers.paths.customPath) {
    return layers.customConfig;
  }
  if (layers.paths.projectPath && targetPath === layers.paths.projectPath) {
    return layers.projectConfig;
  }
  return layers.userConfig;
}

function writeConfig(config, filePath = CONFIG_FILE) {
  try {
    const managedDir = getManagedConfigDir();
    if (path.resolve(filePath).startsWith(`${managedDir}${path.sep}`)) {
      throw new Error('managed config is read-only');
    }
    if (fs.existsSync(filePath)) {
      const backupFile = `${filePath}.openchamber.backup`;
      fs.copyFileSync(filePath, backupFile);
      console.log(`Created config backup: ${backupFile}`);
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
    console.log(`Successfully wrote config file: ${filePath}`);
  } catch (error) {
    console.error(`Failed to write config file: ${filePath}`, error);
    throw new Error('Failed to write OpenCode configuration');
  }
}

function getJsonEntrySource(layers, sectionKey, entryName) {
  const sources = layers.sources || [
    { config: layers.userConfig, filePath: layers.paths.userPath, scope: 'user', writable: true },
    { config: layers.customConfig, filePath: layers.paths.customPath, scope: 'custom', writable: true },
    { config: layers.projectConfig, filePath: layers.paths.projectPath, scope: 'project', writable: true },
  ];
  for (const source of [...sources].reverse()) {
    const section = source.config?.[sectionKey]?.[entryName];
    if (section !== undefined) {
      return {
        section,
        config: source.config,
        path: source.filePath,
        scope: source.scope,
        writable: source.writable !== false,
        exists: true,
      };
    }
  }

  return { section: null, config: null, path: null, exists: false };
}

function getJsonWriteTarget(layers, preferredScope) {
  const { userConfig, projectConfig, customConfig, paths } = layers;
  const configForTarget = (targetPath, fallback) => {
    if (!layers.sources) return fallback;
    return layers.sources.find((source) => source.filePath === targetPath)?.config || {};
  };
  if (preferredScope === AGENT_SCOPE.PROJECT && paths.projectPath) {
    return { config: configForTarget(paths.projectPath, projectConfig), path: paths.projectPath };
  }
  if (paths.customPath) {
    return { config: configForTarget(paths.customPath, customConfig), path: paths.customPath };
  }
  return { config: configForTarget(paths.userPath, userConfig), path: paths.userPath };
}

// ============== GIT/WORKTREE HELPERS ==============

function getAncestors(startDir, stopDir) {
  if (!startDir) return [];
  const result = [];
  let current = path.resolve(startDir);
  const resolvedStop = stopDir ? path.resolve(stopDir) : null;

  while (true) {
    result.push(current);
    if (resolvedStop && current === resolvedStop) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return result;
}

function findWorktreeRoot(startDir) {
  if (!startDir) return null;
  let current = path.resolve(startDir);

  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

// ============== PROMPT FILE HELPERS ==============

function isPromptFileReference(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return PROMPT_FILE_PATTERN.test(value.trim());
}

function resolvePromptFilePath(reference) {
  const match = typeof reference === 'string' ? reference.trim().match(PROMPT_FILE_PATTERN) : null;
  if (!match) {
    return null;
  }
  let target = match[1].trim();
  if (!target) {
    return null;
  }

  if (target.startsWith('./')) {
    target = target.slice(2);
    target = path.join(OPENCODE_CONFIG_DIR, target);
  } else if (!path.isAbsolute(target)) {
    target = path.join(OPENCODE_CONFIG_DIR, target);
  }

  return target;
}

function writePromptFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content ?? '', 'utf8');
  console.log(`Updated prompt file: ${filePath}`);
}

// ============== SKILL FILE OPERATIONS ==============

function walkSkillMdFiles(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];

  const results = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === 'SKILL.md') {
        results.push(fullPath);
      }
    }
  };

  walk(rootDir);
  return results;
}

function addSkillFromMdFile(skillsMap, skillMdPath, scope, source) {
  let parsed;
  try {
    parsed = parseMdFile(skillMdPath);
  } catch {
    return;
  }

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
}

function resolveSkillSearchDirectories(workingDirectory) {
  const directories = [];
  const pushDir = (dir) => {
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

  const customConfigDir = process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : null;
  pushDir(customConfigDir);

  return directories;
}

function listSkillSupportingFiles(skillDir) {
  if (!fs.existsSync(skillDir)) {
    return [];
  }

  const files = [];

  function walkDir(dir, relativePath = '') {
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
          fullPath: fullPath
        });
      }
    }
  }

  walkDir(skillDir);
  return files;
}

function assertPathWithinSkillDir(skillDir, relativePath) {
  const root = fs.realpathSync(skillDir);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  const isWithin = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));

  if (!isWithin) {
    const error = new Error('Access to file denied');
    error.code = 'EACCES';
    throw error;
  }

  return target;
}

function readSkillSupportingFile(skillDir, relativePath) {
  const fullPath = assertPathWithinSkillDir(skillDir, relativePath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return fs.readFileSync(fullPath, 'utf8');
}

function writeSkillSupportingFile(skillDir, relativePath, content) {
  const fullPath = assertPathWithinSkillDir(skillDir, relativePath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function deleteSkillSupportingFile(skillDir, relativePath) {
  const root = fs.realpathSync(skillDir);
  const fullPath = assertPathWithinSkillDir(skillDir, relativePath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
    let parentDir = path.dirname(fullPath);
    while (parentDir !== root) {
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
}

export {
  OPENCODE_CONFIG_DIR,
  AGENT_DIR,
  COMMAND_DIR,
  SKILL_DIR,
  CONFIG_FILE,
  AGENT_SCOPE,
  COMMAND_SCOPE,
  SKILL_SCOPE,
  ensureDirs,
  parseMdFile,
  writeMdFile,
  readConfigFile,
  isPlainObject,
  readConfigLayers,
  readConfig,
  resolveConfigValue,
  getConfigForPath,
  writeConfig,
  getJsonEntrySource,
  getJsonWriteTarget,
  getAncestors,
  findWorktreeRoot,
  isPromptFileReference,
  resolvePromptFilePath,
  writePromptFile,
  walkSkillMdFiles,
  addSkillFromMdFile,
  resolveSkillSearchDirectories,
  listSkillSupportingFiles,
  readSkillSupportingFile,
  writeSkillSupportingFile,
  deleteSkillSupportingFile,
};
