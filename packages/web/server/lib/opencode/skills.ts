import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  SKILL_DIR,
  OPENCODE_CONFIG_DIR,
  SKILL_SCOPE,
  ensureDirs,
  readConfig,
  getAncestors,
  findWorktreeRoot,
  isPlainObject,
} from './config-files.js';
import { parseMdFile, parseMdFileAsync, writeMdFile } from './markdown-files.js';
import { isString } from '../shared/guards.js';
import type { MarkdownDocument } from './markdown-files.js';
import type { DiscoveredSkill, SkillSupportingFile } from './skill-files.js';
import {
  walkSkillMdFiles,
  addSkillFromMdFile,
  resolveSkillSearchDirectories,
  listSkillSupportingFiles,
  writeSkillSupportingFile,
  deleteSkillSupportingFile,
  pathExists,
} from './skill-files.js';

const BUILT_IN_SKILL_LOCATION = '<built-in>';

type Scope = DiscoveredSkill['scope'];
type Source = DiscoveredSkill['source'];
type Directory = string | null;
export interface ListedSkill extends DiscoveredSkill { id?: string; content?: string }
export type ParsedSkillFiles = Map<string, MarkdownDocument | null>;
interface SkillLocation { scope: Scope; source: Source }
interface SkillSelection { scope: Scope | null; path: string | null; source: Source | null }
type MarkdownFields = { name?: unknown; description?: unknown; metadata?: unknown; 'disable-model-invocation'?: unknown };
interface SkillConfig extends MarkdownFields {
  source?: unknown;
  scope?: unknown;
  instructions?: unknown;
  supportingFiles?: unknown;
  disableModelInvocation?: unknown;
}
interface SkillSourceOptions { includeSupportingFiles?: boolean; parsedFiles?: ParsedSkillFiles }
interface FoundSkillFile {
  exists: boolean | null;
  path: string | null;
  dir: string | null;
}
interface SkillMarkdownSource extends FoundSkillFile {
  scope: Scope | null;
  source: Source | null;
  fields: string[];
  name: unknown;
  description: unknown;
  instructions: string;
  disableModelInvocation: boolean;
  supportingFiles?: SkillSupportingFile[];
}
export interface SkillSources {
  md: SkillMarkdownSource;
  projectMd: FoundSkillFile;
  claudeMd: FoundSkillFile;
  userMd: FoundSkillFile;
  userClaudeMd: FoundSkillFile;
  userAgentsMd: FoundSkillFile;
}
const hasMarkdownFields = (value: unknown): value is MarkdownFields => value != null;
const hasSupportingFields = (value: unknown): value is { path?: unknown; content?: unknown; delete?: unknown } => value != null;
const hasErrorCode = (value: unknown): value is { code?: unknown } => value != null;
const hasSkillPaths = (value: unknown): value is { paths?: unknown } => value != null;
const isMutableFrontmatter = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function');
const isUnknownList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

function ensureProjectSkillDir(workingDirectory: string) {
  const projectSkillDir = path.join(workingDirectory, '.opencode', 'skills');
  if (!fs.existsSync(projectSkillDir)) {
    fs.mkdirSync(projectSkillDir, { recursive: true });
  }
  return projectSkillDir;
}

function getProjectSkillDir(workingDirectory: string, skillName: string) {
  const pluralPath = path.join(workingDirectory, '.opencode', 'skills', skillName);
  const legacyPath = path.join(workingDirectory, '.opencode', 'skill', skillName);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
}

async function getProjectSkillPath(workingDirectory: string, skillName: string) {
  const pluralPath = path.join(workingDirectory, '.opencode', 'skills', skillName, 'SKILL.md');
  const legacyPath = path.join(workingDirectory, '.opencode', 'skill', skillName, 'SKILL.md');
  if (await pathExists(legacyPath) && !(await pathExists(pluralPath))) return legacyPath;
  return pluralPath;
}

function getUserSkillDir(skillName: string) {
  const pluralPath = path.join(SKILL_DIR, skillName);
  const legacyPath = path.join(OPENCODE_CONFIG_DIR, 'skill', skillName);
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
}

async function getUserSkillPath(skillName: string) {
  const pluralPath = path.join(SKILL_DIR, skillName, 'SKILL.md');
  const legacyPath = path.join(OPENCODE_CONFIG_DIR, 'skill', skillName, 'SKILL.md');
  if (await pathExists(legacyPath) && !(await pathExists(pluralPath))) return legacyPath;
  return pluralPath;
}

function getClaudeSkillDir(workingDirectory: string, skillName: string) {
  return path.join(workingDirectory, '.claude', 'skills', skillName);
}

function getClaudeSkillPath(workingDirectory: string, skillName: string) {
  return path.join(getClaudeSkillDir(workingDirectory, skillName), 'SKILL.md');
}

function getUserClaudeSkillDir(skillName: string) {
  return path.join(os.homedir(), '.claude', 'skills', skillName);
}

function getUserClaudeSkillPath(skillName: string) {
  return path.join(getUserClaudeSkillDir(skillName), 'SKILL.md');
}

function getUserAgentsSkillDir(skillName: string) {
  return path.join(os.homedir(), '.agents', 'skills', skillName);
}

function getUserAgentsSkillPath(skillName: string) {
  return path.join(getUserAgentsSkillDir(skillName), 'SKILL.md');
}

function getProjectAgentsSkillDir(workingDirectory: string, skillName: string) {
  return path.join(workingDirectory, '.agents', 'skills', skillName);
}

function getProjectAgentsSkillPath(workingDirectory: string, skillName: string) {
  return path.join(getProjectAgentsSkillDir(workingDirectory, skillName), 'SKILL.md');
}

async function getSkillScope(skillName: string, workingDirectory: Directory): Promise<SkillSelection> {
  const discovered = (await discoverSkills(workingDirectory)).find((skill) => skill.name === skillName);
  if (discovered?.path) {
    return { scope: discovered.scope || null, path: discovered.path, source: discovered.source || null };
  }

  if (workingDirectory) {
    const projectPath = await getProjectSkillPath(workingDirectory, skillName);
    if (fs.existsSync(projectPath)) {
      return { scope: SKILL_SCOPE.PROJECT, path: projectPath, source: 'opencode' };
    }
    
    const claudePath = getClaudeSkillPath(workingDirectory, skillName);
    if (fs.existsSync(claudePath)) {
      return { scope: SKILL_SCOPE.PROJECT, path: claudePath, source: 'claude' };
    }
  }
  
  const userPath = await getUserSkillPath(skillName);
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

async function discoverSkills(workingDirectory: Directory, { parsedFiles = new Map() }: Pick<SkillSourceOptions, 'parsedFiles'> = {}) {
  const skills = new Map<string, ListedSkill>();

  const walkedRoots = new Map<string, ReturnType<typeof walkSkillMdFiles>>();
  const walkRoot = (root: string) => {
    const key = path.resolve(root);
    const walked = walkedRoots.get(key);
    if (walked) return walked;
    const files = walkSkillMdFiles(root);
    walkedRoots.set(key, files);
    return files;
  };
  const addSkills = async (root: string, scope: Scope, source: Source) => {
    for (const skillMdPath of await walkRoot(root)) {
      if (!parsedFiles.has(skillMdPath)) {
        parsedFiles.set(skillMdPath, await parseMdFileAsync(skillMdPath).catch(() => null));
      }
      addSkillFromMdFile(skills, skillMdPath, parsedFiles.get(skillMdPath), scope, source);
    }
  };

  for (const externalRootName of ['.claude', '.agents']) {
    const homeRoot = path.join(os.homedir(), externalRootName, 'skills');
    const source = externalRootName === '.agents' ? 'agents' : 'claude';
    await addSkills(homeRoot, SKILL_SCOPE.USER, source);
  }

  if (workingDirectory) {
    const worktreeRoot = findWorktreeRoot(workingDirectory) || path.resolve(workingDirectory);
    const ancestors = getAncestors(workingDirectory, worktreeRoot);
    for (const ancestor of ancestors) {
      for (const externalRootName of ['.claude', '.agents']) {
        const source = externalRootName === '.agents' ? 'agents' : 'claude';
        const externalSkillsRoot = path.join(ancestor, externalRootName, 'skills');
        await addSkills(externalSkillsRoot, SKILL_SCOPE.PROJECT, source);
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
      const isUserConfigDir = dir === OPENCODE_CONFIG_DIR
        || dir === homeOpencodeDir
        || (customConfigDir && dir === customConfigDir);
      const scope = isUserConfigDir ? SKILL_SCOPE.USER : SKILL_SCOPE.PROJECT;
      await addSkills(root, scope, 'opencode');
    }
  }

  let configuredPaths: readonly unknown[] = [];
  try {
    const config = readConfig(workingDirectory);
    const configured = config?.skills;
    configuredPaths = isUnknownList(configured)
      ? configured
      : (hasSkillPaths(configured) && isUnknownList(configured.paths) ? configured.paths : []);
  } catch {
    configuredPaths = [];
  }
  for (const skillPath of configuredPaths) {
    if (!isString(skillPath) || !skillPath.trim()) continue;
    if (/^https?:\/\//i.test(skillPath.trim())) continue;
    const expanded = skillPath.startsWith('~/')
      ? path.join(os.homedir(), skillPath.slice(2))
      : skillPath;
    const resolved = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(workingDirectory || process.cwd(), expanded);
    await addSkills(resolved, SKILL_SCOPE.PROJECT, 'opencode');
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
      await addSkills(skillRoot, SKILL_SCOPE.USER, 'opencode');
    }
  }

  return Array.from(skills.values());
}

function mergeDiscoveredSkills(primarySkills: readonly ListedSkill[] = [], fallbackSkills: readonly ListedSkill[] = []) {
  const merged: ListedSkill[] = [];
  const seenNames = new Set<string>();

  const appendSkill = (skill: ListedSkill) => {
    const name = isString(skill?.name) ? skill.name.trim() : '';
    if (!name || seenNames.has(name)) {
      return;
    }
    seenNames.add(name);
    merged.push(skill);
  };

  for (const skill of primarySkills || []) {
    appendSkill(skill);
  }
  for (const skill of fallbackSkills || []) {
    appendSkill(skill);
  }

  return merged;
}

const DISABLE_MODEL_INVOCATION_KEY = 'disable-model-invocation';
const AUTOINVOKE_METADATA_KEY = 'opencode/autoinvoke';

const FRONTMATTER_BOOLEANS = new Map([
  ['true', true], ['yes', true], ['on', true], ['1', true],
  ['false', false], ['no', false], ['off', false], ['0', false],
]);

function parseFrontmatterBoolean(value: MarkdownFields['metadata']) {
  if (value == null || isPlainObject(value) || Array.isArray(value)) return undefined;
  return FRONTMATTER_BOOLEANS.get(String(value).trim().toLowerCase());
}

function isModelInvocationDisabled(frontmatter: MarkdownFields) {
  const autoinvoke = isPlainObject(frontmatter.metadata)
    ? parseFrontmatterBoolean(frontmatter.metadata[AUTOINVOKE_METADATA_KEY])
    : undefined;
  if (autoinvoke !== undefined) return !autoinvoke;
  return parseFrontmatterBoolean(frontmatter[DISABLE_MODEL_INVOCATION_KEY]) === true;
}

function applyModelInvocation(frontmatter: MarkdownFields, disabled: boolean) {
  const metadata = isPlainObject(frontmatter.metadata) ? { ...frontmatter.metadata } : null;
  if (disabled) {
    frontmatter[DISABLE_MODEL_INVOCATION_KEY] = true;
    frontmatter.metadata = { ...metadata, [AUTOINVOKE_METADATA_KEY]: false };
    return;
  }
  delete frontmatter[DISABLE_MODEL_INVOCATION_KEY];
  if (!metadata) return;
  delete metadata[AUTOINVOKE_METADATA_KEY];
  if (Object.keys(metadata).length > 0) {
    frontmatter.metadata = metadata;
  } else {
    delete frontmatter.metadata;
  }
}

async function getSkillSources(skillName: string, workingDirectory: Directory, discoveredSkill: ListedSkill | null = null, { includeSupportingFiles = true, parsedFiles = new Map() }: SkillSourceOptions = {}): Promise<SkillSources> {
  const isReadableFile = async (filePath: string | null) => {
    if (!filePath) return false;
    try {
      return (await fs.promises.stat(filePath)).isFile();
    } catch {
      return false;
    }
  };

  const projectPath = workingDirectory ? await getProjectSkillPath(workingDirectory, skillName) : null;
  const projectExists = projectPath === null ? null : await pathExists(projectPath);
  const projectDir = projectExists && projectPath !== null ? path.dirname(projectPath) : null;
  
  const claudePath = workingDirectory ? getClaudeSkillPath(workingDirectory, skillName) : null;
  const claudeExists = claudePath === null ? null : await pathExists(claudePath);
  const claudeDir = claudeExists && claudePath !== null ? path.dirname(claudePath) : null;
  const userClaudePath = getUserClaudeSkillPath(skillName);
  const userClaudeExists = await pathExists(userClaudePath);
  const userClaudeDir = userClaudeExists ? path.dirname(userClaudePath) : null;
  
  const userPath = await getUserSkillPath(skillName);
  const userExists = await pathExists(userPath);
  const userDir = userExists ? path.dirname(userPath) : null;

  const userAgentsPath = getUserAgentsSkillPath(skillName);
  const userAgentsExists = await pathExists(userAgentsPath);
  const userAgentsDir = userAgentsExists ? path.dirname(userAgentsPath) : null;

  const matchedDiscovered = discoveredSkill && discoveredSkill.name === skillName
    ? discoveredSkill
    : (await discoverSkills(workingDirectory, { parsedFiles })).find((skill) => skill.name === skillName);
  const discoveredDescription =
    matchedDiscovered && isString(matchedDiscovered.description)
      ? matchedDiscovered.description
      : '';
  const discoveredContent =
    matchedDiscovered && isString(matchedDiscovered.content)
      ? matchedDiscovered.content
      : '';
  const discoveredPath =
    matchedDiscovered && isString(matchedDiscovered.path)
      ? matchedDiscovered.path
      : null;
  const isBuiltInDiscovered = discoveredPath === BUILT_IN_SKILL_LOCATION;
  
  let mdPath: string | null = null;
  let mdScope: Scope | null = null;
  let mdSource: Source | null = null;
  let mdDir: string | null = null;
  
  if (isBuiltInDiscovered) {
    mdScope = matchedDiscovered?.scope || SKILL_SCOPE.USER;
    mdSource = matchedDiscovered?.source || 'opencode';
  } else if (discoveredPath) {
    mdPath = discoveredPath;
    mdScope = matchedDiscovered?.scope || null;
    mdSource = matchedDiscovered?.source || null;
    mdDir = await isReadableFile(discoveredPath) ? path.dirname(discoveredPath) : null;
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
  
  const mdExists = isBuiltInDiscovered || await isReadableFile(mdPath);
  if (!mdExists) {
    mdPath = null;
    mdDir = null;
    mdScope = null;
    mdSource = null;
  }

  const sources: SkillSources = {
    md: {
      exists: mdExists,
      path: mdPath,
      dir: mdDir,
      scope: mdScope,
      source: mdSource,
      fields: isBuiltInDiscovered ? ['description', 'instructions'] : [],
      name: matchedDiscovered?.name || skillName,
      description: discoveredDescription,
      instructions: isBuiltInDiscovered ? discoveredContent : '',
      disableModelInvocation: false
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

  if (mdExists && mdDir && mdPath) {
    const { frontmatter, body } = parsedFiles.get(mdPath) ?? await parseMdFileAsync(mdPath);
    if (!hasMarkdownFields(frontmatter)) throw new TypeError('Cannot read skill frontmatter');
    sources.md.fields = Object.keys(frontmatter);
    sources.md.description = frontmatter.description || '';
    sources.md.name = frontmatter.name || skillName;
    sources.md.disableModelInvocation = isModelInvocationDisabled(frontmatter);
    if (body) {
      sources.md.fields.push('instructions');
      sources.md.instructions = body;
    } else {
      sources.md.instructions = '';
    }
  }
  if (includeSupportingFiles) {
    sources.md.supportingFiles = mdExists && mdDir ? await listSkillSupportingFiles(mdDir) : [];
  }

  return sources;
}

function isValidSkillName(skillName: unknown): skillName is string {
  return typeof skillName === 'string'
    && skillName.length > 0
    && skillName.length <= 64
    && /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(skillName);
}

function assertValidSkillName(skillName: string) {
  if (!isValidSkillName(skillName)) {
    throw new Error(`Invalid skill name "${skillName}". Must be 1-64 lowercase alphanumeric characters with hyphens, cannot start or end with hyphen.`);
  }
}

let skillWriteQueue: Promise<void> = Promise.resolve();
function serializeSkillWrite(write: () => Promise<void>) {
  const run = skillWriteQueue.then(write, write);
  skillWriteQueue = run.catch(() => {});
  return run;
}

function createSkill(skillName: string, config: SkillConfig, workingDirectory: Directory, scope: SkillConfig['scope']) {
  return serializeSkillWrite(() => createSkillNow(skillName, config, workingDirectory, scope));
}

async function createSkillNow(skillName: string, config: SkillConfig, workingDirectory: Directory, scope: SkillConfig['scope']) {
  ensureDirs();
  assertValidSkillName(skillName);

  const existing = await getSkillScope(skillName, workingDirectory);
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
      targetPath = await getProjectSkillPath(workingDirectory, skillName);
    }
    targetScope = SKILL_SCOPE.PROJECT;
  } else {
    if (requestedSource === 'agents') {
      targetDir = getUserAgentsSkillDir(skillName);
      targetPath = getUserAgentsSkillPath(skillName);
    } else {
      targetDir = getUserSkillDir(skillName);
      targetPath = await getUserSkillPath(skillName);
    }
    targetScope = SKILL_SCOPE.USER;
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const {
    instructions,
    scope: _scopeFromConfig,
    source: _sourceFromConfig,
    supportingFiles,
    disableModelInvocation,
    ...frontmatter
  } = config;
  void _scopeFromConfig;
  void _sourceFromConfig;

  if (!frontmatter.name) {
    frontmatter.name = skillName;
  }
  if (!frontmatter.description) {
    throw new Error('Skill description is required');
  }
  if (disableModelInvocation === true) {
    applyModelInvocation(frontmatter, true);
  }

  try {
    writeMdFile(targetPath, frontmatter, instructions || '', { flag: 'wx' });
  } catch (error) {
    if (hasErrorCode(error) && error.code === 'EEXIST') {
      throw new Error(`Skill ${skillName} already exists at ${targetPath}`);
    }
    throw error;
  }
  
  if (supportingFiles && isUnknownList(supportingFiles)) {
    for (const file of supportingFiles) {
      if (!hasSupportingFields(file)) throw new TypeError('Cannot read skill supporting file');
      if (file.path && file.content !== undefined) {
        writeSkillSupportingFile(targetDir, file.path, file.content);
      }
    }
  }
  
  console.log(`Created new skill: ${skillName} (scope: ${targetScope}, path: ${targetPath})`);
}

function updateSkill<Updates>(skillName: string, updates: Updates, workingDirectory: Directory, targetPath: SkillConfig['source'] = null) {
  return serializeSkillWrite(() => updateSkillNow(skillName, updates, workingDirectory, targetPath));
}

async function updateSkillNow<Updates>(skillName: string, updates: Updates, workingDirectory: Directory, targetPath: SkillConfig['source'] = null) {
  ensureDirs();

  const requestedPath = isString(targetPath) && targetPath.trim()
    ? path.resolve(targetPath.trim())
    : null;
  const existing = requestedPath && fs.existsSync(requestedPath)
    ? { scope: null, path: requestedPath, source: null }
    : await getSkillScope(skillName, workingDirectory);
  if (!existing.path) {
    throw new Error(`Skill "${skillName}" not found`);
  }
  if (path.basename(existing.path) !== 'SKILL.md') {
    throw new Error(`Skill "${skillName}" target must be a SKILL.md file`);
  }
  
  const mdPath = existing.path;
  const mdDir = path.dirname(mdPath);
  const mdData = parseMdFile(mdPath);
  const frontmatterName = hasMarkdownFields(mdData.frontmatter) && isString(mdData.frontmatter.name) ? mdData.frontmatter.name : skillName;
  if (frontmatterName !== skillName) {
    throw new Error(`Skill "${skillName}" does not match ${mdPath}`);
  }

  let mdModified = false;

  if (updates == null) throw new TypeError('Cannot read skill updates');
  for (const [field, value] of Object.entries<SkillConfig['source']>(updates)) {
    if (field === 'scope' || field === 'source' || field === 'targetPath' || field === 'renameTo') {
      continue;
    }
    
    if (field === 'instructions') {
      const normalizedValue = isString(value) ? value : (value == null ? '' : String(value));
      mdData.body = normalizedValue;
      mdModified = true;
      continue;
    }

    if (field === 'supportingFiles') {
      if (isUnknownList(value)) {
        for (const file of value) {
          if (!hasSupportingFields(file)) throw new TypeError('Cannot read skill supporting file');
          if (file.delete && file.path) {
            deleteSkillSupportingFile(mdDir, file.path);
          } else if (file.path && file.content !== undefined) {
            writeSkillSupportingFile(mdDir, file.path, file.content);
          }
        }
      }
      continue;
    }

    if (field === 'disableModelInvocation') {
      if (value === true || value === false) {
        if (!isMutableFrontmatter(mdData.frontmatter)) throw new TypeError('Cannot change skill frontmatter');
        applyModelInvocation(mdData.frontmatter, value);
        mdModified = true;
      }
      continue;
    }

    if (!isMutableFrontmatter(mdData.frontmatter)) throw new TypeError('Cannot change skill frontmatter');
    mdData.frontmatter[field] = value;
    mdModified = true;
  }

  if (mdModified) {
    const frontmatter: object = Object(mdData.frontmatter);
    writeMdFile(mdPath, frontmatter, mdData.body);
  }

  console.log(`Updated skill: ${skillName} (path: ${mdPath})`);
}

function getSkillDirAt(location: SkillLocation, skillName: string, workingDirectory: Directory) {
  if (location.scope === SKILL_SCOPE.USER) {
    if (location.source === 'agents') return getUserAgentsSkillDir(skillName);
    if (location.source === 'claude') return getUserClaudeSkillDir(skillName);
    return getUserSkillDir(skillName);
  }
  if (!workingDirectory) return null;
  if (location.source === 'agents') return getProjectAgentsSkillDir(workingDirectory, skillName);
  if (location.source === 'claude') return getClaudeSkillDir(workingDirectory, skillName);
  return getProjectSkillDir(workingDirectory, skillName);
}

function deleteSkill(skillName: string, workingDirectory: Directory, location?: SkillLocation) {
  if (location) {
    const dir = getSkillDirAt(location, skillName, workingDirectory);
    if (!dir || !fs.existsSync(dir)) {
      throw new Error(`Skill "${skillName}" not found`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`Deleted skill directory: ${dir}`);
    return;
  }

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

function isPathInside(candidatePath: string, parentPath: string) {
  if (!candidatePath || !parentPath) return false;
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedParent = path.resolve(parentPath);
  return resolvedCandidate === resolvedParent
    || resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`);
}

function getManagedSkillRoots(workingDirectory: Directory) {
  const roots: string[] = [];
  const pushRoot = (dir: string) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (!roots.includes(resolved)) {
      roots.push(resolved);
    }
  };

  pushRoot(SKILL_DIR);
  pushRoot(path.join(OPENCODE_CONFIG_DIR, 'skill'));
  pushRoot(path.join(os.homedir(), '.opencode', 'skills'));
  pushRoot(path.join(os.homedir(), '.opencode', 'skill'));
  pushRoot(path.join(os.homedir(), '.claude', 'skills'));
  pushRoot(path.join(os.homedir(), '.agents', 'skills'));

  const customConfigDir = process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : null;
  if (customConfigDir) {
    pushRoot(path.join(customConfigDir, 'skills'));
    pushRoot(path.join(customConfigDir, 'skill'));
  }

  if (workingDirectory) {
    const worktreeRoot = findWorktreeRoot(workingDirectory) || path.resolve(workingDirectory);
    for (const ancestor of getAncestors(workingDirectory, worktreeRoot)) {
      pushRoot(path.join(ancestor, '.opencode', 'skills'));
      pushRoot(path.join(ancestor, '.opencode', 'skill'));
      pushRoot(path.join(ancestor, '.claude', 'skills'));
      pushRoot(path.join(ancestor, '.agents', 'skills'));
    }
  }

  return roots;
}

function isManagedSkillPath(skillMdPath: string | null, workingDirectory: Directory) {
  if (!skillMdPath || skillMdPath === BUILT_IN_SKILL_LOCATION) {
    return false;
  }
  const skillDir = path.dirname(path.resolve(skillMdPath));
  return getManagedSkillRoots(workingDirectory).some((root) => isPathInside(skillDir, root));
}

function renameSkill(oldName: string, newName: string, workingDirectory: Directory) {
  return serializeSkillWrite(() => renameSkillNow(oldName, newName, workingDirectory));
}

async function renameSkillNow(oldName: string, newName: string, workingDirectory: Directory) {
  ensureDirs();
  assertValidSkillName(newName);

  if (oldName === newName) {
    return;
  }

  const existing = await getSkillScope(oldName, workingDirectory);
  if (!existing.path) {
    throw new Error(`Skill "${oldName}" not found`);
  }
  if (existing.path === BUILT_IN_SKILL_LOCATION || !fs.existsSync(existing.path)) {
    throw new Error(`Skill "${oldName}" cannot be renamed`);
  }
  if (path.basename(existing.path) !== 'SKILL.md') {
    throw new Error(`Skill "${oldName}" target must be a SKILL.md file`);
  }
  if (!isManagedSkillPath(existing.path, workingDirectory)) {
    throw new Error(`Skill "${oldName}" is outside managed skill directories and cannot be renamed`);
  }

  const mdDataBeforeMove = parseMdFile(existing.path);
  const frontmatterName = hasMarkdownFields(mdDataBeforeMove.frontmatter) && isString(mdDataBeforeMove.frontmatter.name)
    ? mdDataBeforeMove.frontmatter.name
    : oldName;
  if (frontmatterName !== oldName) {
    throw new Error(`Skill "${oldName}" does not match ${existing.path}`);
  }

  const conflict = await getSkillScope(newName, workingDirectory);
  if (conflict.path) {
    throw new Error(`Skill ${newName} already exists at ${conflict.path}`);
  }

  const oldDir = path.dirname(existing.path);
  const newDir = path.join(path.dirname(oldDir), newName);
  const directoriesDiffer = path.resolve(oldDir) !== path.resolve(newDir);

  if (directoriesDiffer && fs.existsSync(newDir)) {
    throw new Error(`Skill directory already exists at ${newDir}`);
  }

  if (directoriesDiffer) {
    fs.renameSync(oldDir, newDir);
  }

  const newPath = path.join(newDir, 'SKILL.md');
  try {
    const mdData = parseMdFile(newPath);
    const fields: object = Object(mdData.frontmatter);
    const frontmatter = {
      ...fields,
      name: newName,
    };
    writeMdFile(newPath, frontmatter, mdData.body);
  } catch (error) {
    if (directoriesDiffer && fs.existsSync(newDir) && !fs.existsSync(oldDir)) {
      try {
        fs.renameSync(newDir, oldDir);
      } catch (rollbackError) {
        console.error(`Failed to rollback skill rename from ${newDir} to ${oldDir}:`, rollbackError);
      }
    }
    throw error;
  }

  console.log(`Renamed skill: ${oldName} -> ${newName} (path: ${newPath})`);
}

export {
  getSkillSources,
  discoverSkills,
  mergeDiscoveredSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  renameSkill,
  isManagedSkillPath,
};
