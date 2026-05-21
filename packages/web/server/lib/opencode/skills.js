import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  SKILL_DIR,
  OPENCODE_CONFIG_DIR,
  SKILL_SCOPE,
  ensureDirs,
  parseMdFile,
  writeMdFile,
  readConfigLayers,
  readConfig,
  walkSkillMdFiles,
  addSkillFromMdFile,
  resolveSkillSearchDirectories,
  listSkillSupportingFiles,
  readSkillSupportingFile,
  writeSkillSupportingFile,
  deleteSkillSupportingFile,
  getAncestors,
  findWorktreeRoot,
} from './shared.js';

function ensureProjectSkillDir(workingDirectory) {
  const projectSkillDir = path.join(workingDirectory, '.opencode', 'skills');
  if (!fs.existsSync(projectSkillDir)) {
    fs.mkdirSync(projectSkillDir, { recursive: true });
  }
  const legacyProjectSkillDir = path.join(workingDirectory, '.opencode', 'skill');
  if (!fs.existsSync(legacyProjectSkillDir)) {
    fs.mkdirSync(legacyProjectSkillDir, { recursive: true });
  }
  return projectSkillDir;
}

function getProjectSkillDir(workingDirectory, skillName) {
  const pluralPath = path.join(workingDirectory, '.opencode', 'skills', skillName);
  const legacyPath = path.join(workingDirectory, '.opencode', 'skill', skillName);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
}

function getProjectSkillPath(workingDirectory, skillName) {
  const pluralPath = path.join(workingDirectory, '.opencode', 'skills', skillName, 'SKILL.md');
  const legacyPath = path.join(workingDirectory, '.opencode', 'skill', skillName, 'SKILL.md');
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
}

function getUserSkillDir(skillName) {
  const pluralPath = path.join(SKILL_DIR, skillName);
  const legacyPath = path.join(OPENCODE_CONFIG_DIR, 'skill', skillName);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
}

function getUserSkillPath(skillName) {
  const pluralPath = path.join(SKILL_DIR, skillName, 'SKILL.md');
  const legacyPath = path.join(OPENCODE_CONFIG_DIR, 'skill', skillName, 'SKILL.md');
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
}

function getClaudeSkillDir(workingDirectory, skillName) {
  return path.join(workingDirectory, '.claude', 'skills', skillName);
}

function getClaudeSkillPath(workingDirectory, skillName) {
  return path.join(getClaudeSkillDir(workingDirectory, skillName), 'SKILL.md');
}

function getUserClaudeSkillDir(skillName) {
  return path.join(os.homedir(), '.claude', 'skills', skillName);
}

function getUserClaudeSkillPath(skillName) {
  return path.join(getUserClaudeSkillDir(skillName), 'SKILL.md');
}

function getUserAgentsSkillDir(skillName) {
  return path.join(os.homedir(), '.agents', 'skills', skillName);
}

function getUserAgentsSkillPath(skillName) {
  return path.join(getUserAgentsSkillDir(skillName), 'SKILL.md');
}

function getProjectAgentsSkillDir(workingDirectory, skillName) {
  return path.join(workingDirectory, '.agents', 'skills', skillName);
}

function getProjectAgentsSkillPath(workingDirectory, skillName) {
  return path.join(getProjectAgentsSkillDir(workingDirectory, skillName), 'SKILL.md');
}

function getSkillScope(skillName, workingDirectory) {
  const discovered = discoverSkills(workingDirectory).find((skill) => skill.name === skillName);
  if (discovered?.path) {
    return { scope: discovered.scope || null, path: discovered.path, source: discovered.source || null };
  }

  if (workingDirectory) {
    const projectPath = getProjectSkillPath(workingDirectory, skillName);
    if (fs.existsSync(projectPath)) {
      return { scope: SKILL_SCOPE.PROJECT, path: projectPath, source: 'opencode' };
    }
    
    const claudePath = getClaudeSkillPath(workingDirectory, skillName);
    if (fs.existsSync(claudePath)) {
      return { scope: SKILL_SCOPE.PROJECT, path: claudePath, source: 'claude' };
    }
  }
  
  const userPath = getUserSkillPath(skillName);
  if (fs.existsSync(userPath)) {
    return { scope: SKILL_SCOPE.USER, path: userPath, source: 'opencode' };
  }

  const userClaudePath = getUserClaudeSkillPath(skillName);
  if (fs.existsSync(userClaudePath)) {
    return { scope: SKILL_SCOPE.USER, path: userClaudePath, source: 'claude' };
  }

  const userAgentsPath = getUserAgentsSkillPath(skillName);
  if (fs.existsSync(userAgentsPath)) {
    return { scope: SKILL_SCOPE.USER, path: userAgentsPath, source: 'agents' };
  }
  
  return { scope: null, path: null, source: null };
}

function getSkillWritePath(skillName, workingDirectory, requestedScope) {
  const existing = getSkillScope(skillName, workingDirectory);
  if (existing.path) {
    return existing;
  }
  
  const scope = requestedScope || SKILL_SCOPE.USER;
  if (scope === SKILL_SCOPE.PROJECT && workingDirectory) {
    return { 
      scope: SKILL_SCOPE.PROJECT, 
      path: getProjectSkillPath(workingDirectory, skillName),
      source: 'opencode'
    };
  }
  
  return { 
    scope: SKILL_SCOPE.USER, 
    path: getUserSkillPath(skillName),
    source: 'opencode'
  };
}

function discoverSkills(workingDirectory) {
  const skills = new Map();

  for (const externalRootName of ['.claude', '.agents']) {
    const homeRoot = path.join(os.homedir(), externalRootName, 'skills');
    const source = externalRootName === '.agents' ? 'agents' : 'claude';
    for (const skillMdPath of walkSkillMdFiles(homeRoot)) {
      addSkillFromMdFile(skills, skillMdPath, SKILL_SCOPE.USER, source);
    }
  }

  if (workingDirectory) {
    const worktreeRoot = findWorktreeRoot(workingDirectory) || path.resolve(workingDirectory);
    const ancestors = getAncestors(workingDirectory, worktreeRoot);
    for (const ancestor of ancestors) {
      for (const externalRootName of ['.claude', '.agents']) {
        const source = externalRootName === '.agents' ? 'agents' : 'claude';
        const externalSkillsRoot = path.join(ancestor, externalRootName, 'skills');
        for (const skillMdPath of walkSkillMdFiles(externalSkillsRoot)) {
          addSkillFromMdFile(skills, skillMdPath, SKILL_SCOPE.PROJECT, source);
        }
      }
    }
  }

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

  let configuredPaths = [];
  try {
    const config = readConfig(workingDirectory);
    configuredPaths = Array.isArray(config?.skills?.paths) ? config.skills.paths : [];
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

  const cacheCandidates = [];
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
}

function getSkillSources(skillName, workingDirectory, discoveredSkill = null) {
  const projectPath = workingDirectory ? getProjectSkillPath(workingDirectory, skillName) : null;
  const projectExists = projectPath && fs.existsSync(projectPath);
  const projectDir = projectExists ? path.dirname(projectPath) : null;
  
  const claudePath = workingDirectory ? getClaudeSkillPath(workingDirectory, skillName) : null;
  const claudeExists = claudePath && fs.existsSync(claudePath);
  const claudeDir = claudeExists ? path.dirname(claudePath) : null;
  const userClaudePath = getUserClaudeSkillPath(skillName);
  const userClaudeExists = fs.existsSync(userClaudePath);
  const userClaudeDir = userClaudeExists ? path.dirname(userClaudePath) : null;
  
  const userPath = getUserSkillPath(skillName);
  const userExists = fs.existsSync(userPath);
  const userDir = userExists ? path.dirname(userPath) : null;

  const userAgentsPath = getUserAgentsSkillPath(skillName);
  const userAgentsExists = fs.existsSync(userAgentsPath);
  const userAgentsDir = userAgentsExists ? path.dirname(userAgentsPath) : null;

  const matchedDiscovered = discoveredSkill && discoveredSkill.name === skillName
    ? discoveredSkill
    : discoverSkills(workingDirectory).find((skill) => skill.name === skillName);
  
  let mdPath = null;
  let mdScope = null;
  let mdSource = null;
  let mdDir = null;
  
  if (matchedDiscovered?.path) {
    mdPath = matchedDiscovered.path;
    mdScope = matchedDiscovered.scope || null;
    mdSource = matchedDiscovered.source || null;
    mdDir = path.dirname(matchedDiscovered.path);
  } else if (projectExists) {
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
  } else if (userClaudeExists) {
    mdPath = userClaudePath;
    mdScope = SKILL_SCOPE.USER;
    mdSource = 'claude';
    mdDir = userClaudeDir;
  } else if (userAgentsExists) {
    mdPath = userAgentsPath;
    mdScope = SKILL_SCOPE.USER;
    mdSource = 'agents';
    mdDir = userAgentsDir;
  }
  
  const mdExists = !!mdPath && fs.existsSync(mdPath);
  if (!mdExists) {
    mdPath = null;
    mdDir = null;
  }

  const sources = {
    md: {
      exists: mdExists,
      path: mdPath,
      dir: mdDir,
      scope: mdScope,
      source: mdSource,
      fields: [],
      supportingFiles: []
    },
    projectMd: {
      exists: projectExists,
      path: projectPath,
      dir: projectDir
    },
    claudeMd: {
      exists: claudeExists,
      path: claudePath,
      dir: claudeDir
    },
    userMd: {
      exists: userExists,
      path: userPath,
      dir: userDir
    },
    userClaudeMd: {
      exists: userClaudeExists,
      path: userClaudePath,
      dir: userClaudeDir
    },
    userAgentsMd: {
      exists: userAgentsExists,
      path: userAgentsPath,
      dir: userAgentsDir
    }
  };

  if (mdExists && mdDir) {
    const { frontmatter, body } = parseMdFile(mdPath);
    sources.md.fields = Object.keys(frontmatter);
    sources.md.description = frontmatter.description || '';
    sources.md.name = frontmatter.name || skillName;
    if (body) {
      sources.md.fields.push('instructions');
      sources.md.instructions = body;
    } else {
      sources.md.instructions = '';
    }
    sources.md.supportingFiles = listSkillSupportingFiles(mdDir);
  }

  return sources;
}

function createSkill(skillName, config, workingDirectory, scope) {
  ensureDirs();

  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(skillName) || skillName.length > 64) {
    throw new Error(`Invalid skill name "${skillName}". Must be 1-64 lowercase alphanumeric characters with hyphens, cannot start or end with hyphen.`);
  }

  const existing = getSkillScope(skillName, workingDirectory);
  if (existing.path) {
    throw new Error(`Skill ${skillName} already exists at ${existing.path}`);
  }

  let targetDir;
  let targetPath;
  let targetScope;
  
  const requestedScope = scope === SKILL_SCOPE.PROJECT ? SKILL_SCOPE.PROJECT : SKILL_SCOPE.USER;
  const requestedSource = config?.source === 'agents' ? 'agents' : 'opencode';

  if (requestedScope === SKILL_SCOPE.PROJECT && workingDirectory) {
    ensureProjectSkillDir(workingDirectory);
    if (requestedSource === 'agents') {
      targetDir = getProjectAgentsSkillDir(workingDirectory, skillName);
      targetPath = getProjectAgentsSkillPath(workingDirectory, skillName);
    } else {
      targetDir = getProjectSkillDir(workingDirectory, skillName);
      targetPath = getProjectSkillPath(workingDirectory, skillName);
    }
    targetScope = SKILL_SCOPE.PROJECT;
  } else {
    if (requestedSource === 'agents') {
      targetDir = getUserAgentsSkillDir(skillName);
      targetPath = getUserAgentsSkillPath(skillName);
    } else {
      targetDir = getUserSkillDir(skillName);
      targetPath = getUserSkillPath(skillName);
    }
    targetScope = SKILL_SCOPE.USER;
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const { instructions, scope: _scopeFromConfig, source: _sourceFromConfig, supportingFiles, ...frontmatter } = config;
  void _scopeFromConfig;
  void _sourceFromConfig;

  if (!frontmatter.name) {
    frontmatter.name = skillName;
  }
  if (!frontmatter.description) {
    throw new Error('Skill description is required');
  }

  writeMdFile(targetPath, frontmatter, instructions || '');
  
  if (supportingFiles && Array.isArray(supportingFiles)) {
    for (const file of supportingFiles) {
      if (file.path && file.content !== undefined) {
        writeSkillSupportingFile(targetDir, file.path, file.content);
      }
    }
  }
  
  console.log(`Created new skill: ${skillName} (scope: ${targetScope}, path: ${targetPath})`);
}

function updateSkill(skillName, updates, workingDirectory, targetPath = null) {
  ensureDirs();

  const requestedPath = typeof targetPath === 'string' && targetPath.trim()
    ? path.resolve(targetPath.trim())
    : null;
  const existing = requestedPath && fs.existsSync(requestedPath)
    ? { scope: null, path: requestedPath, source: null }
    : getSkillScope(skillName, workingDirectory);
  if (!existing.path) {
    throw new Error(`Skill "${skillName}" not found`);
  }
  if (path.basename(existing.path) !== 'SKILL.md') {
    throw new Error(`Skill "${skillName}" target must be a SKILL.md file`);
  }
  
  const mdPath = existing.path;
  const mdDir = path.dirname(mdPath);
  const mdData = parseMdFile(mdPath);
  const frontmatterName = typeof mdData.frontmatter?.name === 'string' ? mdData.frontmatter.name : skillName;
  if (frontmatterName !== skillName) {
    throw new Error(`Skill "${skillName}" does not match ${mdPath}`);
  }

  let mdModified = false;

  for (const [field, value] of Object.entries(updates)) {
    if (field === 'scope' || field === 'source' || field === 'targetPath') {
      continue;
    }
    
    if (field === 'instructions') {
      const normalizedValue = typeof value === 'string' ? value : (value == null ? '' : String(value));
      mdData.body = normalizedValue;
      mdModified = true;
      continue;
    }

    if (field === 'supportingFiles') {
      if (Array.isArray(value)) {
        for (const file of value) {
          if (file.delete && file.path) {
            deleteSkillSupportingFile(mdDir, file.path);
          } else if (file.path && file.content !== undefined) {
            writeSkillSupportingFile(mdDir, file.path, file.content);
          }
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

  console.log(`Updated skill: ${skillName} (path: ${mdPath})`);
}

function deleteSkill(skillName, workingDirectory) {
  let deleted = false;

  if (workingDirectory) {
    const projectDir = getProjectSkillDir(workingDirectory, skillName);
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
      console.log(`Deleted project-level skill directory: ${projectDir}`);
      deleted = true;
    }
    
    const claudeDir = getClaudeSkillDir(workingDirectory, skillName);
    if (fs.existsSync(claudeDir)) {
      fs.rmSync(claudeDir, { recursive: true, force: true });
      console.log(`Deleted claude-compat skill directory: ${claudeDir}`);
      deleted = true;
    }

    const projectAgentsDir = getProjectAgentsSkillDir(workingDirectory, skillName);
    if (fs.existsSync(projectAgentsDir)) {
      fs.rmSync(projectAgentsDir, { recursive: true, force: true });
      console.log(`Deleted project-level agents skill directory: ${projectAgentsDir}`);
      deleted = true;
    }
  }

  const userDir = getUserSkillDir(skillName);
  if (fs.existsSync(userDir)) {
    fs.rmSync(userDir, { recursive: true, force: true });
    console.log(`Deleted user-level skill directory: ${userDir}`);
    deleted = true;
  }

  const userAgentsDir = getUserAgentsSkillDir(skillName);
  if (fs.existsSync(userAgentsDir)) {
    fs.rmSync(userAgentsDir, { recursive: true, force: true });
    console.log(`Deleted user-level agents skill directory: ${userAgentsDir}`);
    deleted = true;
  }

  const userClaudeDir = getUserClaudeSkillDir(skillName);
  if (fs.existsSync(userClaudeDir)) {
    fs.rmSync(userClaudeDir, { recursive: true, force: true });
    console.log(`Deleted user-level claude skill directory: ${userClaudeDir}`);
    deleted = true;
  }

  if (!deleted) {
    throw new Error(`Skill "${skillName}" not found`);
  }
}

export {
  getSkillSources,
  getSkillScope,
  getSkillWritePath,
  discoverSkills,
  createSkill,
  updateSkill,
  deleteSkill,
};
