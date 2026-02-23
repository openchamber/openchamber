import fs from 'fs';
import path from 'path';
import {
  CONFIG_FILE,
  AGENT_DIR,
  AGENT_SCOPE,
  ensureDirs,
  parseMdFile,
  writeMdFile,
  readConfigLayers,
  readConfigFile,
  writeConfig,
  getJsonEntrySource,
  getJsonWriteTarget,
  isPromptFileReference,
  resolvePromptFilePath,
  writePromptFile,
} from './shared.js';

// ============== AGENT SCOPE HELPERS ==============

/**
 * Ensure project-level agent directory exists
 */
function ensureProjectAgentDir(workingDirectory) {
  const projectAgentDir = path.join(workingDirectory, '.opencode', 'agents');
  if (!fs.existsSync(projectAgentDir)) {
    fs.mkdirSync(projectAgentDir, { recursive: true });
  }
  const legacyProjectAgentDir = path.join(workingDirectory, '.opencode', 'agent');
  if (!fs.existsSync(legacyProjectAgentDir)) {
    fs.mkdirSync(legacyProjectAgentDir, { recursive: true });
  }
  return projectAgentDir;
}

/**
 * Get project-level agent path
 */
function getProjectAgentPath(workingDirectory, agentName) {
  const pluralPath = path.join(workingDirectory, '.opencode', 'agents', `${agentName}.md`);
  const legacyPath = path.join(workingDirectory, '.opencode', 'agent', `${agentName}.md`);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
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

  if (!fs.existsSync(AGENT_DIR)) return;

  const dirsToVisit = [AGENT_DIR];
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
 * Get user-level agent path — walks subfolders to support grouped layouts.
 * e.g. ~/.config/opencode/agents/business/ceo-diginno.md
 */
function getUserAgentPath(agentName, lookupCache = null) {
  // 1. Check flat path first (legacy / newly created agents)
  const pluralPath = path.join(AGENT_DIR, `${agentName}.md`);
  if (fs.existsSync(pluralPath)) return pluralPath;

  const legacyPath = path.join(AGENT_DIR, '..', 'agent', `${agentName}.md`);
  if (fs.existsSync(legacyPath)) return legacyPath;

  // 2. Lookup subfolders for grouped layout
  const cache = lookupCache || createAgentLookupCache();
  const found = getIndexedUserAgentPath(agentName, cache);
  if (found) return found;

  // 3. Return expected flat path as default (for new agent creation)
  return pluralPath;
}

/**
 * Determine agent scope based on where the .md file exists
 * Priority: project level > user level > null (built-in only)
 */
function getAgentScope(agentName, workingDirectory, lookupCache = null) {
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
      path: getProjectAgentPath(workingDirectory, agentName)
    };
  }

  return {
    scope: AGENT_SCOPE.USER,
    path: getUserAgentPath(agentName, lookupCache)
  };
}

/**
 * Detect where an agent's permission field is currently defined
 * Priority: project .md > user .md > project JSON > user JSON
 * Returns: { source: 'md'|'json'|null, scope: 'project'|'user'|null, path: string|null }
 */
function getAgentPermissionSource(agentName, workingDirectory, lookupCache = null) {
  // Check project-level .md first
  if (workingDirectory) {
    const projectMdPath = getProjectAgentPath(workingDirectory, agentName);
    if (fs.existsSync(projectMdPath)) {
      const { frontmatter } = parseMdFile(projectMdPath);
      if (frontmatter.permission !== undefined) {
        return { source: 'md', scope: AGENT_SCOPE.PROJECT, path: projectMdPath };
      }
    }
  }

  // Check user-level .md
  const userMdPath = getUserAgentPath(agentName, lookupCache);
  if (fs.existsSync(userMdPath)) {
    const { frontmatter } = parseMdFile(userMdPath);
    if (frontmatter.permission !== undefined) {
      return { source: 'md', scope: AGENT_SCOPE.USER, path: userMdPath };
    }
  }

  // Check JSON layers (project > user)
  const layers = readConfigLayers(workingDirectory);

  // Project opencode.json
  const projectJsonPermission = layers.projectConfig?.agent?.[agentName]?.permission;
  if (projectJsonPermission !== undefined && layers.paths.projectPath) {
    return { source: 'json', scope: AGENT_SCOPE.PROJECT, path: layers.paths.projectPath };
  }

  // User opencode.json
  const userJsonPermission = layers.userConfig?.agent?.[agentName]?.permission;
  if (userJsonPermission !== undefined) {
    return { source: 'json', scope: AGENT_SCOPE.USER, path: layers.paths.userPath };
  }

  // Custom config (env var)
  const customJsonPermission = layers.customConfig?.agent?.[agentName]?.permission;
  if (customJsonPermission !== undefined && layers.paths.customPath) {
    return { source: 'json', scope: 'custom', path: layers.paths.customPath };
  }

  return { source: null, scope: null, path: null };
}

function mergePermissionWithNonWildcards(newPermission, permissionSource, agentName) {
  if (!permissionSource.source || !permissionSource.path) {
    return newPermission;
  }

  let existingPermission = null;
  if (permissionSource.source === 'md') {
    const { frontmatter } = parseMdFile(permissionSource.path);
    existingPermission = frontmatter.permission;
  } else if (permissionSource.source === 'json') {
    const config = readConfigFile(permissionSource.path);
    existingPermission = config?.agent?.[agentName]?.permission;
  }

  if (!existingPermission || typeof existingPermission === 'string') {
    return newPermission;
  }

  if (newPermission == null) {
    return null;
  }

  if (typeof newPermission === 'string') {
    return newPermission;
  }

  const nonWildcardPatterns = {};
  for (const [permKey, permValue] of Object.entries(existingPermission)) {
    if (permKey === '*') continue;

    if (typeof permValue === 'object' && permValue !== null && !Array.isArray(permValue)) {
      const nonWildcards = {};
      for (const [pattern, action] of Object.entries(permValue)) {
        if (pattern !== '*') {
          nonWildcards[pattern] = action;
        }
      }
      if (Object.keys(nonWildcards).length > 0) {
        nonWildcardPatterns[permKey] = nonWildcards;
      }
    }
  }

  if (Object.keys(nonWildcardPatterns).length === 0) {
    return newPermission;
  }

  const merged = { ...newPermission };
  for (const [permKey, patterns] of Object.entries(nonWildcardPatterns)) {
    const newValue = merged[permKey];
    if (typeof newValue === 'string') {
      merged[permKey] = { '*': newValue, ...patterns };
    } else if (typeof newValue === 'object' && newValue !== null) {
      merged[permKey] = { ...patterns, ...newValue };
    } else {
      const existingValue = existingPermission[permKey];
      if (typeof existingValue === 'object' && existingValue !== null) {
        const wildcard = existingValue['*'];
        merged[permKey] = wildcard ? { '*': wildcard, ...patterns } : patterns;
      }
    }
  }

  return merged;
}

function getAgentSources(agentName, workingDirectory, lookupCache = createAgentLookupCache()) {
  const projectPath = workingDirectory ? getProjectAgentPath(workingDirectory, agentName) : null;
  const projectExists = projectPath && fs.existsSync(projectPath);

  const userPath = getUserAgentPath(agentName, lookupCache);
  const userExists = fs.existsSync(userPath);

  const mdPath = projectExists ? projectPath : (userExists ? userPath : null);
  const mdExists = !!mdPath;
  const mdScope = projectExists ? AGENT_SCOPE.PROJECT : (userExists ? AGENT_SCOPE.USER : null);

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'agent', agentName);
  const jsonSection = jsonSource.section;
  const jsonPath = jsonSource.path || layers.paths.customPath || layers.paths.projectPath || layers.paths.userPath;
  const jsonScope = jsonSource.path === layers.paths.projectPath ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER;

  const sources = {
    md: {
      exists: mdExists,
      path: mdPath,
      scope: mdScope,
      fields: []
    },
    json: {
      exists: jsonSource.exists,
      path: jsonPath,
      scope: jsonSource.exists ? jsonScope : null,
      fields: []
    },
    projectMd: {
      exists: projectExists,
      path: projectPath
    },
    userMd: {
      exists: userExists,
      path: userPath
    }
  };

  if (mdExists) {
    const { frontmatter, body } = parseMdFile(mdPath);
    sources.md.fields = Object.keys(frontmatter);
    if (body) {
      sources.md.fields.push('prompt');
    }
  }

  if (jsonSection) {
    sources.json.fields = Object.keys(jsonSection);
  }

  return sources;
}

function getAgentConfig(agentName, workingDirectory, lookupCache = createAgentLookupCache()) {
  const projectPath = workingDirectory ? getProjectAgentPath(workingDirectory, agentName) : null;
  const projectExists = projectPath && fs.existsSync(projectPath);

  const userPath = getUserAgentPath(agentName, lookupCache);
  const userExists = fs.existsSync(userPath);

  if (projectExists || userExists) {
    const mdPath = projectExists ? projectPath : userPath;
    const { frontmatter, body } = parseMdFile(mdPath);

    return {
      source: 'md',
      scope: projectExists ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER,
      config: {
        ...frontmatter,
        ...(typeof body === 'string' && body.length > 0 ? { prompt: body } : {}),
      },
    };
  }

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'agent', agentName);

  if (jsonSource.exists && jsonSource.section) {
    const scope = jsonSource.path === layers.paths.projectPath ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER;
    return {
      source: 'json',
      scope,
      config: { ...jsonSource.section },
    };
  }

  return {
    source: 'none',
    scope: null,
    config: {},
  };
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
  const jsonSource = getJsonEntrySource(layers, 'agent', agentName);
  if (jsonSource.exists) {
    throw new Error(`Agent ${agentName} already exists in opencode.json`);
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

  const { prompt, scope: _scopeFromConfig, ...frontmatter } = config;

  writeMdFile(targetPath, frontmatter, prompt || '');
  console.log(`Created new agent: ${agentName} (scope: ${targetScope}, path: ${targetPath})`);
}

function updateAgent(agentName, updates, workingDirectory) {
  ensureDirs();
  const lookupCache = createAgentLookupCache();

  const { scope, path: mdPath } = getAgentWritePath(agentName, workingDirectory, undefined, lookupCache);
  const mdExists = mdPath && fs.existsSync(mdPath);

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'agent', agentName);
  const jsonSection = jsonSource.section;
  const hasJsonFields = jsonSource.exists && jsonSection && Object.keys(jsonSection).length > 0;
  const jsonTarget = jsonSource.exists
    ? { config: jsonSource.config, path: jsonSource.path }
    : getJsonWriteTarget(layers, AGENT_SCOPE.USER);
  let config = jsonTarget.config || {};

  const isBuiltinOverride = !mdExists && !hasJsonFields;

  let targetPath = mdPath;
  let targetScope = scope;

  if (!mdExists && isBuiltinOverride) {
    targetPath = getUserAgentPath(agentName, lookupCache);
    targetScope = AGENT_SCOPE.USER;
  }

  let mdData = mdExists ? parseMdFile(mdPath) : (isBuiltinOverride ? { frontmatter: {}, body: '' } : null);

  let mdModified = false;
  let jsonModified = false;
  const creatingNewMd = isBuiltinOverride;

  for (const [field, value] of Object.entries(updates)) {
    if (field === 'prompt') {
      const normalizedValue = typeof value === 'string' ? value : (value == null ? '' : String(value));

      if (mdExists || creatingNewMd) {
        if (mdData) {
          mdData.body = normalizedValue;
          mdModified = true;
        }
        continue;
      } else if (isPromptFileReference(jsonSection?.prompt)) {
        const promptFilePath = resolvePromptFilePath(jsonSection.prompt);
        if (!promptFilePath) {
          throw new Error(`Invalid prompt file reference for agent ${agentName}`);
        }
        writePromptFile(promptFilePath, normalizedValue);
        continue;
      } else if (isPromptFileReference(normalizedValue)) {
        if (!config.agent) config.agent = {};
        if (!config.agent[agentName]) config.agent[agentName] = {};
        config.agent[agentName].prompt = normalizedValue;
        jsonModified = true;
        continue;
      }

      if (!config.agent) config.agent = {};
      if (!config.agent[agentName]) config.agent[agentName] = {};
      config.agent[agentName].prompt = normalizedValue;
      jsonModified = true;
      continue;
    }

    if (field === 'permission') {
      const permissionSource = getAgentPermissionSource(agentName, workingDirectory, lookupCache);
      const newPermission = mergePermissionWithNonWildcards(value, permissionSource, agentName);

      if (permissionSource.source === 'md') {
        const existingMdData = parseMdFile(permissionSource.path);
        existingMdData.frontmatter.permission = newPermission;
        writeMdFile(permissionSource.path, existingMdData.frontmatter, existingMdData.body);
        console.log(`Updated permission in .md file: ${permissionSource.path}`);
      } else if (permissionSource.source === 'json') {
        const existingConfig = readConfigFile(permissionSource.path);
        if (!existingConfig.agent) existingConfig.agent = {};
        if (!existingConfig.agent[agentName]) existingConfig.agent[agentName] = {};
        existingConfig.agent[agentName].permission = newPermission;
        writeConfig(existingConfig, permissionSource.path);
        console.log(`Updated permission in JSON: ${permissionSource.path}`);
      } else {
        if ((mdExists || creatingNewMd) && mdData) {
          mdData.frontmatter.permission = newPermission;
          mdModified = true;
        } else if (hasJsonFields) {
          if (!config.agent) config.agent = {};
          if (!config.agent[agentName]) config.agent[agentName] = {};
          config.agent[agentName].permission = newPermission;
          jsonModified = true;
        } else {
          const writeTarget = workingDirectory
            ? { config: layers.projectConfig || {}, path: layers.paths.projectPath || layers.paths.userPath }
            : { config: layers.userConfig || {}, path: layers.paths.userPath };
          if (!writeTarget.config.agent) writeTarget.config.agent = {};
          if (!writeTarget.config.agent[agentName]) writeTarget.config.agent[agentName] = {};
          writeTarget.config.agent[agentName].permission = newPermission;
          writeConfig(writeTarget.config, writeTarget.path);
          console.log(`Created permission in JSON: ${writeTarget.path}`);
        }
      }
      continue;
    }

    const inMd = mdData?.frontmatter?.[field] !== undefined;
    const inJson = jsonSection?.[field] !== undefined;

    if (value === null) {
      if (mdData && inMd) {
        delete mdData.frontmatter[field];
        mdModified = true;
      }

      if (inJson && config.agent?.[agentName]) {
        delete config.agent[agentName][field];

        if (Object.keys(config.agent[agentName]).length === 0) {
          delete config.agent[agentName];
        }
        if (Object.keys(config.agent).length === 0) {
          delete config.agent;
        }

        jsonModified = true;
      }

      continue;
    }

    if (inJson) {
      if (!config.agent) config.agent = {};
      if (!config.agent[agentName]) config.agent[agentName] = {};
      config.agent[agentName][field] = value;
      jsonModified = true;
    } else if (inMd || creatingNewMd) {
      if (mdData) {
        mdData.frontmatter[field] = value;
        mdModified = true;
      }
    } else {
      if ((mdExists || creatingNewMd) && mdData) {
        mdData.frontmatter[field] = value;
        mdModified = true;
      } else {
        if (!config.agent) config.agent = {};
        if (!config.agent[agentName]) config.agent[agentName] = {};
        config.agent[agentName][field] = value;
        jsonModified = true;
      }
    }
  }

  if (mdModified && mdData) {
    writeMdFile(targetPath, mdData.frontmatter, mdData.body);
  }

  if (jsonModified) {
    writeConfig(config, jsonTarget.path || CONFIG_FILE);
  }

  console.log(`Updated agent: ${agentName} (scope: ${targetScope}, md: ${mdModified}, json: ${jsonModified})`);
}

function deleteAgent(agentName, workingDirectory) {
  const lookupCache = createAgentLookupCache();
  let deleted = false;

  if (workingDirectory) {
    const projectPath = getProjectAgentPath(workingDirectory, agentName);
    if (fs.existsSync(projectPath)) {
      fs.unlinkSync(projectPath);
      console.log(`Deleted project-level agent .md file: ${projectPath}`);
      deleted = true;
    }
  }

  const userPath = getUserAgentPath(agentName, lookupCache);
  if (fs.existsSync(userPath)) {
    fs.unlinkSync(userPath);
    console.log(`Deleted user-level agent .md file: ${userPath}`);
    deleted = true;
  }

  const layers = readConfigLayers(workingDirectory);
  const jsonSource = getJsonEntrySource(layers, 'agent', agentName);
  if (jsonSource.exists && jsonSource.config && jsonSource.path) {
    if (!jsonSource.config.agent) jsonSource.config.agent = {};
    delete jsonSource.config.agent[agentName];
    writeConfig(jsonSource.config, jsonSource.path);
    console.log(`Removed agent from opencode.json: ${agentName}`);
    deleted = true;
  }

  if (!deleted) {
    const jsonTarget = getJsonWriteTarget(layers, workingDirectory ? AGENT_SCOPE.PROJECT : AGENT_SCOPE.USER);
    const targetConfig = jsonTarget.config || {};
    if (!targetConfig.agent) targetConfig.agent = {};
    targetConfig.agent[agentName] = { disable: true };
    writeConfig(targetConfig, jsonTarget.path || CONFIG_FILE);
    console.log(`Disabled built-in agent: ${agentName}`);
  }
}

export {
  ensureProjectAgentDir,
  getProjectAgentPath,
  getUserAgentPath,
  getAgentScope,
  getAgentWritePath,
  getAgentPermissionSource,
  getAgentSources,
  getAgentConfig,
  createAgent,
  updateAgent,
  deleteAgent,
};
