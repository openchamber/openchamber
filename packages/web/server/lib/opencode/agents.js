import fs from 'fs';
import path from 'path';
import {
  getAncestors,
  findWorktreeRoot,
  CONFIG_FILE,
  AGENT_DIR,
  OPENCODE_CONFIG_DIR,
  AGENT_SCOPE,
  getSystemConfigDir,
  ensureDirs,
  parseMdFile,
  writeMdFile,
  readConfigLayers,
  readConfigFile,
  writeConfig,
  getJsonEntrySource,
  isPromptFileReference,
  resolvePromptFilePath,
  writePromptFile,
} from './shared.js';
import {
  toAgentEntity,
  fromAgentEntity,
  isLegacyAgentFrontmatter,
  readSectionEntry,
  writeSectionEntry,
  deleteSectionEntry,
  effectiveAgentRules,
  readGlobalPermissionRules,
  normalizePermissionRules,
  parseModelSelection,
  formatModelSelection,
  isRecord,
} from './config-v2.js';

// ============== AGENT SCOPE HELPERS ==============
//
// OpenCode 2 discovers agents from `agent/`, `agents/`, `mode/` and `modes/`.
// OpenChamber reads every one of those and WRITES only to `agents/`. An agent
// that already lives in a v1 directory is rewritten in place (v2 fields, same
// path) so no file silently moves out from under the user.

const USER_AGENT_DIRS = ['agents', 'agent', 'modes', 'mode'].map((name) => path.join(OPENCODE_CONFIG_DIR, name));
const PROJECT_AGENT_DIR_NAMES = ['agents', 'agent', 'modes', 'mode'];
const SYSTEM_AGENT_DIR_NAMES = ['agents', 'agent', 'modes', 'mode'];

// ============== SYSTEM SCOPE ==============
//
// OpenCode loads the system configuration directory
// (`ConfigDiscovery.systemDirectory()`: `/etc/opencode` and platform
// equivalents) last, so an agent defined there outranks the project and user
// definitions of the same name. It is read-only here: nothing in this module
// writes under it, and mutations of a system-scoped agent are rejected.

function isFileEntry(targetPath) {
  try {
    return fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

/** First `<dir>/…/<agentName>.md` under one system agent directory, direct file first. */
function findSystemAgentFile(directory, agentName) {
  const direct = path.join(directory, `${agentName}.md`);
  if (isFileEntry(direct)) {
    return direct;
  }
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findSystemAgentFile(path.join(directory, entry.name), agentName);
    if (found) {
      return found;
    }
  }
  return null;
}

/** The system layer's markdown file for one agent, or null when it defines none. */
function getSystemAgentPath(agentName) {
  const systemDir = getSystemConfigDir();
  for (const dirName of SYSTEM_AGENT_DIR_NAMES) {
    const found = findSystemAgentFile(path.join(systemDir, dirName), agentName);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * The system layer's stored entry for one agent, or null when the system
 * layer does not define it. OpenCode applies a layer's `opencode.json(c)`
 * agents section before the layer's markdown files, so where both exist the
 * markdown fields win per field and the two permissions lists accumulate.
 */
function getSystemAgentEntry(agentName, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const json = readSectionEntry(layers.systemConfig, 'agents', agentName);
  const jsonExists = json.value !== undefined;
  let jsonPath = null;
  if (jsonExists) {
    const primary = readSectionEntry(readConfigFile(layers.paths.systemPath), 'agents', agentName);
    jsonPath = primary.value !== undefined ? layers.paths.systemPath : layers.paths.systemOverridePath;
  }
  const mdPath = getSystemAgentPath(agentName);
  if (!jsonExists && !mdPath) {
    return null;
  }
  const jsonEntity = jsonExists ? toAgentEntity(json.value) : null;
  if (!mdPath) {
    return {
      mdPath: null,
      jsonPath,
      legacy: Boolean(json.legacy),
      config: jsonEntity,
      jsonEntity,
    };
  }
  const md = readMdAgent(mdPath);
  return {
    mdPath,
    jsonPath,
    legacy: md.legacy,
    config: jsonEntity ? mergeAgentEntities(jsonEntity, md.entity) : md.entity,
    jsonEntity,
  };
}

/** Overlay the markdown entity over the JSON entry, field by field as OpenCode does. */
function mergeAgentEntities(base, overlay) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    if (key === 'permissions' && Array.isArray(value)) {
      merged.permissions = [...(Array.isArray(base.permissions) ? base.permissions : []), ...value];
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/** Ensure the v2 project agent directory exists. */
function ensureProjectAgentDir(workingDirectory) {
  const projectAgentDir = path.join(workingDirectory, '.opencode', 'agents');
  if (!fs.existsSync(projectAgentDir)) {
    fs.mkdirSync(projectAgentDir, { recursive: true });
  }
  return projectAgentDir;
}

/**
 * Project-level agent path: an existing v1 file keeps its path, otherwise the
 * v2 `agents/` location.
 */
function getProjectAgentPath(workingDirectory, agentName) {
  const preferred = path.join(workingDirectory, '.opencode', 'agents', `${agentName}.md`);
  // OpenCode 2 discovers `.opencode` from the working directory up to the
  // project root, so a definition in a parent directory of a monorepo
  // package counts; nested ids (`team/reviewer`) map onto the path.
  const worktreeRoot = findWorktreeRoot(workingDirectory) || path.resolve(workingDirectory);
  for (const base of getAncestors(workingDirectory, worktreeRoot)) {
    for (const dirName of PROJECT_AGENT_DIR_NAMES) {
      const candidate = path.join(base, '.opencode', dirName, `${agentName}.md`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return preferred;
}

/**
 * Create a per-request lookup cache for user-level agent path resolution.
 */
function createAgentLookupCache() {
  return {
    userAgentIndexByName: new Map(),
    userAgentLookupByName: new Map(),
    userAgentIndexReady: false,
  };
}

function buildUserAgentIndex(cache) {
  if (cache.userAgentIndexReady) return;
  cache.userAgentIndexReady = true;

  const dirsToVisit = USER_AGENT_DIRS.filter((dir) => fs.existsSync(dir));
  while (dirsToVisit.length > 0) {
    const dir = dirsToVisit.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const agentName = entry.name.slice(0, -3);
      if (!cache.userAgentIndexByName.has(agentName)) {
        cache.userAgentIndexByName.set(agentName, path.join(dir, entry.name));
      }
    }

    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.isDirectory()) {
        dirsToVisit.push(path.join(dir, entry.name));
      }
    }
  }
}

function getIndexedUserAgentPath(agentName, cache) {
  if (cache.userAgentLookupByName.has(agentName)) {
    return cache.userAgentLookupByName.get(agentName);
  }

  buildUserAgentIndex(cache);
  const found = cache.userAgentIndexByName.get(agentName) || null;
  cache.userAgentLookupByName.set(agentName, found);
  return found;
}

/**
 * User-level agent path — walks subfolders to support grouped layouts
 * (e.g. `~/.config/opencode/agents/business/ceo.md`) and the v1 `agent/` dir.
 * New agents land flat in the v2 `agents/` directory.
 */
function getUserAgentPath(agentName, lookupCache = null) {
  const preferred = path.join(AGENT_DIR, `${agentName}.md`);
  for (const dir of USER_AGENT_DIRS) {
    const candidate = path.join(dir, `${agentName}.md`);
    if (fs.existsSync(candidate)) return candidate;
  }

  const cache = lookupCache || createAgentLookupCache();
  const found = getIndexedUserAgentPath(agentName, cache);
  if (found) return found;

  return preferred;
}

/**
 * Determine agent scope based on where the .md file exists
 * Priority: system level > project level > user level > null (built-in only)
 */
function getAgentScope(agentName, workingDirectory, lookupCache = null) {
  // The system layer outranks everything OpenCode loads after it.
  const systemPath = getSystemAgentPath(agentName);
  if (systemPath) {
    return { scope: AGENT_SCOPE.SYSTEM, path: systemPath };
  }

  if (workingDirectory) {
    const projectPath = getProjectAgentPath(workingDirectory, agentName);
    if (fs.existsSync(projectPath)) {
      return { scope: AGENT_SCOPE.PROJECT, path: projectPath };
    }
  }

  const userPath = getUserAgentPath(agentName, lookupCache);
  if (fs.existsSync(userPath)) {
    return { scope: AGENT_SCOPE.USER, path: userPath };
  }

  return { scope: null, path: null };
}

/**
 * Get the path where an agent should be written based on scope
 */
function getAgentWritePath(agentName, workingDirectory, requestedScope, lookupCache = null) {
  // For updates: check existing location first (project takes precedence)
  const existing = getAgentScope(agentName, workingDirectory, lookupCache);
  if (existing.path) {
    return existing;
  }

  // For new agents or built-in overrides: use requested scope or default to user
  const scope = requestedScope || AGENT_SCOPE.USER;
  if (scope === AGENT_SCOPE.PROJECT && workingDirectory) {
    return {
      scope: AGENT_SCOPE.PROJECT,
      path: getProjectAgentPath(workingDirectory, agentName),
    };
  }

  return {
    scope: AGENT_SCOPE.USER,
    path: getUserAgentPath(agentName, lookupCache),
  };
}

// ============== READ ==============

function readMdAgent(mdPath) {
  const { frontmatter, body } = parseMdFile(mdPath);
  return {
    entity: toAgentEntity(frontmatter, body),
    frontmatter,
    body,
    legacy: isLegacyAgentFrontmatter(frontmatter),
  };
}

function getAgentSources(agentName, workingDirectory, lookupCache = createAgentLookupCache()) {
  const systemEntry = getSystemAgentEntry(agentName, workingDirectory);
  const projectPath = workingDirectory ? getProjectAgentPath(workingDirectory, agentName) : null;
  const projectExists = Boolean(projectPath) && fs.existsSync(projectPath);

  const userPath = getUserAgentPath(agentName, lookupCache);
  const userExists = fs.existsSync(userPath);

  // The system layer wins over project and user, as in OpenCode's load order.
  const mdPath = systemEntry?.mdPath ?? (projectExists ? projectPath : (userExists ? userPath : null));
  const mdExists = Boolean(mdPath);
  const mdScope = systemEntry?.mdPath
    ? AGENT_SCOPE.SYSTEM
    : (projectExists ? AGENT_SCOPE.PROJECT : (userExists ? AGENT_SCOPE.USER : null));

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'agents', agentName);
  const jsonPath = jsonSource.path || layers.paths.customPath || layers.paths.projectPath || layers.paths.userPath;
  const jsonScope = jsonSource.path === layers.paths.projectPath ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER;

  const systemJsonExists = Boolean(systemEntry?.jsonEntity);
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
    systemJson: {
      exists: systemJsonExists,
      path: systemJsonExists ? systemEntry.jsonPath : null,
      scope: systemJsonExists ? AGENT_SCOPE.SYSTEM : null,
      sectionKey: systemJsonExists ? 'agents' : null,
      legacy: systemJsonExists ? Boolean(systemEntry.legacy) : false,
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
    // The scope the agent actually resolves to, and whether Settings may edit it.
    scope: systemEntry ? AGENT_SCOPE.SYSTEM : (mdExists ? mdScope : (jsonSource.exists ? jsonScope : null)),
    readOnly: Boolean(systemEntry),
  };

  if (mdExists) {
    const md = readMdAgent(mdPath);
    sources.md.legacy = md.legacy;
    sources.md.fields = Object.keys(md.entity);
  }

  if (jsonSource.exists) {
    sources.json.fields = Object.keys(toAgentEntity(jsonSource.section));
  }

  if (systemJsonExists) {
    sources.systemJson.fields = Object.keys(systemEntry.jsonEntity);
  }

  return sources;
}

/**
 * Canonical v2 agent entity plus where it came from. `config.system` is the
 * markdown body for .md agents; `config.permissions` is always the ordered v2
 * rule array, even when the file still uses a v1 `permission` map.
 */
function getAgentConfig(agentName, workingDirectory, lookupCache = createAgentLookupCache()) {
  // The system layer outranks the project and user layers in OpenCode's load
  // order, so it is resolved first and cannot be written to.
  const systemEntry = getSystemAgentEntry(agentName, workingDirectory);
  if (systemEntry) {
    return {
      source: systemEntry.mdPath ? 'md' : 'json',
      scope: AGENT_SCOPE.SYSTEM,
      path: systemEntry.mdPath ?? systemEntry.jsonPath,
      legacy: systemEntry.legacy,
      config: systemEntry.config,
    };
  }

  const projectPath = workingDirectory ? getProjectAgentPath(workingDirectory, agentName) : null;
  const projectExists = Boolean(projectPath) && fs.existsSync(projectPath);

  const userPath = getUserAgentPath(agentName, lookupCache);
  const userExists = fs.existsSync(userPath);

  if (projectExists || userExists) {
    const mdPath = projectExists ? projectPath : userPath;
    const md = readMdAgent(mdPath);
    return {
      source: 'md',
      scope: projectExists ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER,
      path: mdPath,
      legacy: md.legacy,
      config: md.entity,
    };
  }

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'agents', agentName);

  if (jsonSource.exists) {
    const scope = jsonSource.path === layers.paths.projectPath ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER;
    return {
      source: 'json',
      scope,
      path: jsonSource.path,
      legacy: Boolean(jsonSource.legacy),
      config: toAgentEntity(jsonSource.section),
    };
  }

  return {
    source: 'none',
    scope: null,
    path: null,
    legacy: false,
    config: {},
  };
}

/**
 * The permission rules that apply to an agent, in evaluation order (global
 * rules first, agent rules last; last match wins). Answers the editor question
 * "what applies to this agent".
 */
function getAgentPermissions(agentName, workingDirectory, lookupCache = createAgentLookupCache()) {
  const layers = readConfigLayers(workingDirectory);
  const global = [
    ...readGlobalPermissionRules(layers.userConfig),
    ...readGlobalPermissionRules(layers.projectConfig),
    ...readGlobalPermissionRules(layers.customConfig),
    // The system layer's global rules apply at runtime too (it loads last).
    ...readGlobalPermissionRules(layers.systemConfig),
  ];
  const agent = getAgentConfig(agentName, workingDirectory, lookupCache);
  return {
    global,
    agent: agent.config.permissions ?? [],
    effective: effectiveAgentRules(global, agent.config.permissions ?? []),
    source: agent.source,
    path: agent.path,
  };
}

// ============== WRITE ==============

function writeAgentMd(targetPath, entity) {
  const { fields, system } = fromAgentEntity(entity);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  // Native keys only: a single legacy key routes the whole file through
  // OpenCode's v1 decoder, which would drop the `permissions` array.
  writeMdFile(targetPath, fields, system);
}

function createAgent(agentName, config, workingDirectory, scope) {
  ensureDirs();
  const lookupCache = createAgentLookupCache();

  const projectPath = workingDirectory ? getProjectAgentPath(workingDirectory, agentName) : null;
  const userPath = getUserAgentPath(agentName, lookupCache);

  if (projectPath && fs.existsSync(projectPath)) {
    throw new Error(`Agent ${agentName} already exists as project-level .md file`);
  }

  if (fs.existsSync(userPath)) {
    throw new Error(`Agent ${agentName} already exists as user-level .md file`);
  }

  const layers = readConfigLayers(workingDirectory);
  if (getJsonEntrySource(layers, 'agents', agentName).exists) {
    throw new Error(`Agent ${agentName} already exists in opencode.json`);
  }

  // A user-level copy of a system-defined agent would never take effect:
  // OpenCode applies the system layer last, so it would shadow this one.
  if (getSystemAgentEntry(agentName, workingDirectory)) {
    throw new Error(`Agent ${agentName} already exists in the system configuration (read-only)`);
  }

  let targetPath;
  let targetScope;

  if (scope === AGENT_SCOPE.PROJECT && workingDirectory) {
    ensureProjectAgentDir(workingDirectory);
    targetPath = projectPath;
    targetScope = AGENT_SCOPE.PROJECT;
  } else {
    targetPath = userPath;
    targetScope = AGENT_SCOPE.USER;
  }

  const { scope: _ignoredScope, ...entity } = isRecord(config) ? config : {};
  writeAgentMd(targetPath, entity);
  console.log(`Created new agent: ${agentName} (scope: ${targetScope}, path: ${targetPath})`);
  return { scope: targetScope, path: targetPath };
}

// v1 agent fields that do not exist at the top level of a v2 entity any more.
// A client clearing one of them names the v1 field, so deletion has to reach
// the v2 location instead of removing a key that was never there.
const AGENT_REQUEST_BODY_FIELDS = ['temperature', 'top_p'];

function deleteRequestBodyField(entity, key) {
  if (!isRecord(entity.request) || !isRecord(entity.request.body)) return;
  delete entity.request.body[key];
  if (Object.keys(entity.request.body).length === 0) delete entity.request.body;
  if (Object.keys(entity.request).length === 0) delete entity.request;
}

/** Drop the `#variant` suffix, keeping the provider and model. */
function stripModelVariant(entity) {
  const parsed = parseModelSelection(entity.model);
  if (!parsed) return;
  const stripped = formatModelSelection({ providerID: parsed.providerID, modelID: parsed.modelID });
  if (stripped) entity.model = stripped;
}

function deleteAgentField(entity, field) {
  if (field === 'permission' || field === 'permissions') {
    delete entity.permissions;
    return;
  }
  if (field === 'variant') {
    stripModelVariant(entity);
    return;
  }
  if (AGENT_REQUEST_BODY_FIELDS.includes(field)) {
    deleteRequestBodyField(entity, field);
    return;
  }
  delete entity[field === 'prompt' ? 'system' : field];
}

/**
 * Merge a partial update into a canonical entity. `null` removes a field,
 * `undefined` leaves it alone.
 */
function applyAgentUpdates(entity, updates) {
  // `request` is copied so clearing one overlay field cannot mutate the entity
  // the caller still holds.
  const next = { ...entity };
  if (isRecord(next.request)) {
    const request = { ...next.request };
    if (isRecord(request.body)) request.body = { ...request.body };
    if (isRecord(request.headers)) request.headers = { ...request.headers };
    next.request = request;
  }
  for (const [field, value] of Object.entries(isRecord(updates) ? updates : {})) {
    if (field === 'scope' || value === undefined) continue;
    if (value === null) {
      deleteAgentField(next, field);
      continue;
    }
    if (field === 'permission' || field === 'permissions') {
      const rules = normalizePermissionRules(value);
      if (rules.length === 0) delete next.permissions;
      else next.permissions = rules;
      continue;
    }
    // `prompt` is the v1 spelling of `system`; accept it so older clients keep working.
    next[field === 'prompt' ? 'system' : field] = value;
  }
  return toAgentEntity(next);
}

function updateAgent(agentName, updates, workingDirectory) {
  ensureDirs();
  const lookupCache = createAgentLookupCache();

  const current = getAgentConfig(agentName, workingDirectory, lookupCache);
  if (current.scope === AGENT_SCOPE.SYSTEM) {
    throw new Error(`Agent ${agentName} is defined in the system configuration and is read-only`);
  }
  const entity = applyAgentUpdates(current.config, updates);

  if (current.source === 'md') {
    writeAgentMd(current.path, entity);
    console.log(`Updated agent: ${agentName} (md: ${current.path})`);
    return { source: 'md', scope: current.scope, path: current.path };
  }

  if (current.source === 'json') {
    const layers = readConfigLayers(workingDirectory);
    const jsonSource = getJsonEntrySource(layers, 'agents', agentName);
    const config = jsonSource.config || {};
    const rawSystem = jsonSource.section?.system ?? jsonSource.section?.prompt;
    // `{file:...}` substitution still works in OpenCode 2, so an agent whose
    // system prompt lives in a file keeps the reference and the file is edited.
    if (isPromptFileReference(rawSystem)) {
      const promptFilePath = resolvePromptFilePath(rawSystem);
      if (!promptFilePath) {
        throw new Error(`Invalid prompt file reference for agent ${agentName}`);
      }
      if (entity.system !== current.config.system) {
        writePromptFile(promptFilePath, entity.system ?? '');
      }
      entity.system = rawSystem;
    }
    writeSectionEntry(config, 'agents', agentName, entity);
    const targetPath = jsonSource.path || CONFIG_FILE;
    writeConfig(config, targetPath);
    console.log(`Updated agent: ${agentName} (json: ${targetPath})`);
    return { source: 'json', scope: current.scope, path: targetPath };
  }

  // Built-in override: materialize a user-level v2 markdown agent.
  const { scope, path: targetPath } = getAgentWritePath(agentName, workingDirectory, AGENT_SCOPE.USER, lookupCache);
  writeAgentMd(targetPath, entity);
  console.log(`Created agent override: ${agentName} (scope: ${scope}, path: ${targetPath})`);
  return { source: 'md', scope, path: targetPath };
}

function deleteAgent(agentName, workingDirectory, scope) {
  const lookupCache = createAgentLookupCache();
  const requestedScope = scope === AGENT_SCOPE.PROJECT || scope === AGENT_SCOPE.USER ? scope : null;

  // A system-defined agent cannot be removed from here: the system layer is
  // not writable, and deleting a lower-layer copy would change nothing the
  // daemon runs (the system definition still applies).
  if (getAgentConfig(agentName, workingDirectory, lookupCache).scope === AGENT_SCOPE.SYSTEM) {
    throw new Error(`Agent ${agentName} is defined in the system configuration and is read-only`);
  }

  if ((!requestedScope || requestedScope === AGENT_SCOPE.PROJECT) && workingDirectory) {
    const projectPath = getProjectAgentPath(workingDirectory, agentName);
    if (fs.existsSync(projectPath)) {
      fs.unlinkSync(projectPath);
      console.log(`Deleted project-level agent .md file: ${projectPath}`);
      return;
    }
  }

  if (!requestedScope || requestedScope === AGENT_SCOPE.USER) {
    const userPath = getUserAgentPath(agentName, lookupCache);
    if (fs.existsSync(userPath)) {
      fs.unlinkSync(userPath);
      console.log(`Deleted user-level agent .md file: ${userPath}`);
      return;
    }
  }

  const layers = readConfigLayers(workingDirectory);

  if (requestedScope === AGENT_SCOPE.PROJECT) {
    if (layers.paths.projectPath && deleteSectionEntry(layers.projectConfig, 'agents', agentName)) {
      writeConfig(layers.projectConfig, layers.paths.projectPath);
      console.log(`Removed project-level agent from opencode.json: ${agentName}`);
      return;
    }
    throw new Error(`Project agent ${agentName} not found`);
  }

  if (requestedScope === AGENT_SCOPE.USER) {
    const userJsonPath = layers.paths.customPath || layers.paths.userPath;
    const userJsonConfig = layers.paths.customPath ? layers.customConfig : layers.userConfig;
    if (userJsonPath && deleteSectionEntry(userJsonConfig, 'agents', agentName)) {
      writeConfig(userJsonConfig, userJsonPath);
      console.log(`Removed user-level agent from opencode.json: ${agentName}`);
      return;
    }
    throw new Error(`User agent ${agentName} not found`);
  }

  const jsonSource = getJsonEntrySource(layers, 'agents', agentName);
  if (jsonSource.exists && jsonSource.config && jsonSource.path
    && deleteSectionEntry(jsonSource.config, 'agents', agentName)) {
    writeConfig(jsonSource.config, jsonSource.path);
    console.log(`Removed agent from opencode.json: ${agentName}`);
    return;
  }

  throw new Error(`Agent ${agentName} is built-in or not deletable`);
}

// ============== DISABLED ==============

/** Agent ids under one agents directory, nested ones as `group/name`. */
function collectAgentIds(dir, prefix, ids) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      collectAgentIds(path.join(dir, entry.name), `${prefix}${entry.name}/`, ids);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      ids.add(`${prefix}${entry.name.slice(0, -3)}`);
    }
  }
}

/**
 * Agents switched off with `disabled: true`. OpenCode drops them from its
 * agent list, so Settings learns about them here to offer turning them back
 * on. Every agent defined in a file or a config section is read the way the
 * editor reads it and kept when its own config says disabled.
 */
function listDisabledAgents(workingDirectory) {
  const lookupCache = createAgentLookupCache();
  const names = new Set();

  buildUserAgentIndex(lookupCache);
  for (const name of lookupCache.userAgentIndexByName.keys()) names.add(name);

  if (workingDirectory) {
    const worktreeRoot = findWorktreeRoot(workingDirectory) || path.resolve(workingDirectory);
    for (const base of getAncestors(workingDirectory, worktreeRoot)) {
      for (const dirName of PROJECT_AGENT_DIR_NAMES) {
        collectAgentIds(path.join(base, '.opencode', dirName), '', names);
      }
    }
  }

  const { mergedConfig } = readConfigLayers(workingDirectory);
  for (const sectionKey of ['agents', 'agent', 'mode']) {
    const section = mergedConfig?.[sectionKey];
    if (isRecord(section)) for (const name of Object.keys(section)) names.add(name);
  }

  const disabled = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const entry = getAgentConfig(name, workingDirectory, lookupCache);
    // A system-scoped agent cannot be switched back on from here: its
    // `disabled` flag lives in the read-only system layer.
    if (entry.scope === AGENT_SCOPE.SYSTEM) continue;
    if (entry.config.disabled !== true) continue;
    disabled.push({
      name,
      scope: entry.scope,
      path: entry.path,
      ...(typeof entry.config.description === 'string' ? { description: entry.config.description } : {}),
    });
  }
  return disabled;
}

export {
  listDisabledAgents,
  getAgentSources,
  getAgentConfig,
  getAgentPermissions,
  createAgent,
  updateAgent,
  deleteAgent,
};
