import fs from 'fs';
import path from 'path';
import {
  getAncestors,
  findWorktreeRoot,
  CONFIG_FILE,
  OPENCODE_CONFIG_DIR,
  COMMAND_DIR,
  COMMAND_SCOPE,
  ensureDirs,
  parseMdFile,
  writeMdFile,
  readConfigLayers,
  writeConfig,
  getJsonEntrySource,
  isPromptFileReference,
  resolvePromptFilePath,
  writePromptFile,
} from './shared.js';
import {
  toCommandEntity,
  fromCommandEntity,
  isLegacyCommandFrontmatter,
  writeSectionEntry,
  deleteSectionEntry,
  parseModelSelection,
  formatModelSelection,
  isRecord,
} from './config-v2.js';

// ============== COMMAND SCOPE HELPERS ==============
//
// OpenCode 2 discovers commands from `command/` and `commands/`. OpenChamber
// reads both and writes only `commands/`; a command already living in the v1
// directory is rewritten at its own path in v2 shape.

const USER_COMMAND_DIRS = [COMMAND_DIR, path.join(OPENCODE_CONFIG_DIR, 'command')];
const PROJECT_COMMAND_DIR_NAMES = ['commands', 'command'];

/** Ensure the v2 project command directory exists. */
function ensureProjectCommandDir(workingDirectory) {
  const projectCommandDir = path.join(workingDirectory, '.opencode', 'commands');
  if (!fs.existsSync(projectCommandDir)) {
    fs.mkdirSync(projectCommandDir, { recursive: true });
  }
  return projectCommandDir;
}

function getProjectCommandPath(workingDirectory, commandName) {
  const preferred = path.join(workingDirectory, '.opencode', 'commands', `${commandName}.md`);
  // Same walk as agents: every `.opencode` from the working directory up to
  // the project root is a source; nested names (`team/review`) map onto paths.
  const worktreeRoot = findWorktreeRoot(workingDirectory) || path.resolve(workingDirectory);
  for (const base of getAncestors(workingDirectory, worktreeRoot)) {
    for (const dirName of PROJECT_COMMAND_DIR_NAMES) {
      const candidate = path.join(base, '.opencode', dirName, `${commandName}.md`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return preferred;
}

function getUserCommandPath(commandName) {
  const preferred = path.join(COMMAND_DIR, `${commandName}.md`);
  for (const dir of USER_COMMAND_DIRS) {
    const candidate = path.join(dir, `${commandName}.md`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return preferred;
}

/**
 * Determine command scope based on where the .md file exists
 * Priority: project level > user level > null (built-in only)
 */
function getCommandScope(commandName, workingDirectory) {
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
}

/**
 * Get the path where a command should be written based on scope
 */
function getCommandWritePath(commandName, workingDirectory, requestedScope) {
  const existing = getCommandScope(commandName, workingDirectory);
  if (existing.path) {
    return existing;
  }

  const scope = requestedScope || COMMAND_SCOPE.USER;
  if (scope === COMMAND_SCOPE.PROJECT && workingDirectory) {
    return {
      scope: COMMAND_SCOPE.PROJECT,
      path: getProjectCommandPath(workingDirectory, commandName),
    };
  }

  return {
    scope: COMMAND_SCOPE.USER,
    path: getUserCommandPath(commandName),
  };
}

// ============== READ ==============

function getCommandSources(commandName, workingDirectory) {
  const projectPath = workingDirectory ? getProjectCommandPath(workingDirectory, commandName) : null;
  const projectExists = Boolean(projectPath) && fs.existsSync(projectPath);

  const userPath = getUserCommandPath(commandName);
  const userExists = fs.existsSync(userPath);

  const mdPath = projectExists ? projectPath : (userExists ? userPath : null);
  const mdExists = Boolean(mdPath);
  const mdScope = projectExists ? COMMAND_SCOPE.PROJECT : (userExists ? COMMAND_SCOPE.USER : null);

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'commands', commandName);
  const jsonPath = jsonSource.path || layers.paths.customPath || layers.paths.projectPath || layers.paths.userPath;
  const jsonScope = jsonSource.path === layers.paths.projectPath ? COMMAND_SCOPE.PROJECT : COMMAND_SCOPE.USER;

  const sources = {
    md: {
      exists: mdExists,
      path: mdPath,
      scope: mdScope,
      legacy: false,
      fields: [],
    },
    json: {
      exists: jsonSource.exists,
      path: jsonPath,
      scope: jsonSource.exists ? jsonScope : null,
      sectionKey: jsonSource.sectionKey,
      legacy: Boolean(jsonSource.legacy),
      fields: [],
    },
    projectMd: {
      exists: projectExists,
      path: projectPath,
    },
    userMd: {
      exists: userExists,
      path: userPath,
    },
  };

  if (mdExists) {
    const { frontmatter, body } = parseMdFile(mdPath);
    sources.md.legacy = isLegacyCommandFrontmatter(frontmatter);
    sources.md.fields = Object.keys(toCommandEntity(frontmatter, body));
  }

  if (jsonSource.exists) {
    sources.json.fields = Object.keys(toCommandEntity(jsonSource.section));
  }

  return sources;
}

/** Canonical v2 command entity plus where it came from. */
function getCommandConfig(commandName, workingDirectory) {
  const { path: mdPath, scope } = getCommandScope(commandName, workingDirectory);
  if (mdPath) {
    const { frontmatter, body } = parseMdFile(mdPath);
    return {
      source: 'md',
      scope,
      path: mdPath,
      legacy: isLegacyCommandFrontmatter(frontmatter),
      config: toCommandEntity(frontmatter, body),
    };
  }

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'commands', commandName);
  if (jsonSource.exists) {
    return {
      source: 'json',
      scope: jsonSource.path === layers.paths.projectPath ? COMMAND_SCOPE.PROJECT : COMMAND_SCOPE.USER,
      path: jsonSource.path,
      legacy: Boolean(jsonSource.legacy),
      config: toCommandEntity(jsonSource.section),
    };
  }

  return { source: 'none', scope: null, path: null, legacy: false, config: {} };
}

// ============== WRITE ==============

function writeCommandMd(targetPath, entity) {
  const { fields, template } = fromCommandEntity(entity);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  writeMdFile(targetPath, fields, template);
}

function createCommand(commandName, config, workingDirectory, scope) {
  ensureDirs();

  const projectPath = workingDirectory ? getProjectCommandPath(workingDirectory, commandName) : null;
  const userPath = getUserCommandPath(commandName);

  if (projectPath && fs.existsSync(projectPath)) {
    throw new Error(`Command ${commandName} already exists as project-level .md file`);
  }

  if (fs.existsSync(userPath)) {
    throw new Error(`Command ${commandName} already exists as user-level .md file`);
  }

  const layers = readConfigLayers(workingDirectory);
  if (getJsonEntrySource(layers, 'commands', commandName).exists) {
    throw new Error(`Command ${commandName} already exists in opencode.json`);
  }

  let targetPath;
  let targetScope;

  if (scope === COMMAND_SCOPE.PROJECT && workingDirectory) {
    ensureProjectCommandDir(workingDirectory);
    targetPath = projectPath;
    targetScope = COMMAND_SCOPE.PROJECT;
  } else {
    targetPath = userPath;
    targetScope = COMMAND_SCOPE.USER;
  }

  const { scope: _ignoredScope, ...entity } = isRecord(config) ? config : {};
  writeCommandMd(targetPath, entity);
  console.log(`Created new command: ${commandName} (scope: ${targetScope}, path: ${targetPath})`);
  return { scope: targetScope, path: targetPath };
}

// Clearing a v1 field has to reach its v2 location: `subtask` is `subagent`,
// and `variant` is the suffix on `model`.
function deleteCommandField(entity, field) {
  if (field === 'variant') {
    const parsed = parseModelSelection(entity.model);
    if (!parsed) return;
    const stripped = formatModelSelection({ providerID: parsed.providerID, modelID: parsed.modelID });
    if (stripped) entity.model = stripped;
    return;
  }
  delete entity[field === 'subtask' ? 'subagent' : field];
}

function applyCommandUpdates(entity, updates) {
  const next = { ...entity };
  for (const [field, value] of Object.entries(isRecord(updates) ? updates : {})) {
    if (field === 'scope' || value === undefined) continue;
    if (value === null) {
      deleteCommandField(next, field);
      continue;
    }
    // `subtask` is the v1 spelling of `subagent`; accept it from older clients.
    next[field === 'subtask' ? 'subagent' : field] = value;
  }
  return toCommandEntity(next);
}

function updateCommand(commandName, updates, workingDirectory) {
  ensureDirs();

  const current = getCommandConfig(commandName, workingDirectory);
  const entity = applyCommandUpdates(current.config, updates);

  if (current.source === 'md') {
    writeCommandMd(current.path, entity);
    console.log(`Updated command: ${commandName} (md: ${current.path})`);
    return { source: 'md', scope: current.scope, path: current.path };
  }

  if (current.source === 'json') {
    const layers = readConfigLayers(workingDirectory);
    const jsonSource = getJsonEntrySource(layers, 'commands', commandName);
    const config = jsonSource.config || {};
    const rawTemplate = jsonSource.section?.template;
    if (isPromptFileReference(rawTemplate)) {
      const templateFilePath = resolvePromptFilePath(rawTemplate);
      if (!templateFilePath) {
        throw new Error(`Invalid template file reference for command ${commandName}`);
      }
      if (entity.template !== current.config.template) {
        writePromptFile(templateFilePath, entity.template ?? '');
      }
      entity.template = rawTemplate;
    }
    writeSectionEntry(config, 'commands', commandName, entity);
    const targetPath = jsonSource.path || CONFIG_FILE;
    writeConfig(config, targetPath);
    console.log(`Updated command: ${commandName} (json: ${targetPath})`);
    return { source: 'json', scope: current.scope, path: targetPath };
  }

  // Built-in override: materialize a user-level v2 markdown command.
  const { scope, path: targetPath } = getCommandWritePath(commandName, workingDirectory, COMMAND_SCOPE.USER);
  writeCommandMd(targetPath, entity);
  console.log(`Created command override: ${commandName} (scope: ${scope}, path: ${targetPath})`);
  return { source: 'md', scope, path: targetPath };
}

function deleteCommand(commandName, workingDirectory) {
  let deleted = false;

  if (workingDirectory) {
    const projectPath = getProjectCommandPath(workingDirectory, commandName);
    if (fs.existsSync(projectPath)) {
      fs.unlinkSync(projectPath);
      console.log(`Deleted project-level command .md file: ${projectPath}`);
      deleted = true;
    }
  }

  const userPath = getUserCommandPath(commandName);
  if (fs.existsSync(userPath)) {
    fs.unlinkSync(userPath);
    console.log(`Deleted user-level command .md file: ${userPath}`);
    deleted = true;
  }

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'commands', commandName);
  if (jsonSource.exists && jsonSource.config && jsonSource.path
    && deleteSectionEntry(jsonSource.config, 'commands', commandName)) {
    writeConfig(jsonSource.config, jsonSource.path);
    console.log(`Removed command from opencode.json: ${commandName}`);
    deleted = true;
  }

  if (!deleted) {
    throw new Error(`Command "${commandName}" not found`);
  }
}

export {
  getCommandSources,
  getCommandConfig,
  createCommand,
  updateCommand,
  deleteCommand,
};
