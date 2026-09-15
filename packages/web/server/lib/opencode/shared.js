import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'yaml';
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse as parseJsonc,
  parseTree,
  printParseErrorCode,
  SyntaxKind,
} from 'jsonc-parser';

// ============== PATH CONSTANTS ==============

const OPENCODE_CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'),
  'opencode',
);
const AGENT_DIR = path.join(OPENCODE_CONFIG_DIR, 'agents');
const COMMAND_DIR = path.join(OPENCODE_CONFIG_DIR, 'commands');
const SKILL_DIR = path.join(OPENCODE_CONFIG_DIR, 'skills');
const CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'config.json');
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

// Mirror of OpenCode's markdown frontmatter sanitizer (packages/opencode/src/
// config/markdown.ts): other coding agents accept unquoted colons in YAML
// values (e.g. `description: Build agent: creates builds`), which strict YAML
// rejects. Rewrite those values as block scalars and retry the parse, so files
// OpenCode accepts are parsed identically here.
function sanitizeFrontmatter(frontmatter) {
  return frontmatter
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.trim().startsWith('#') || line.trim() === '' || /^\s+/.test(line)) return [line];
      const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (!entry) return [line];
      const value = entry[2].trim();
      if (value === '' || value === '>' || value === '|' || value.startsWith('"') || value.startsWith("'")) return [line];
      if (!value.includes(':')) return [line];
      return [`${entry[1]}: |-`, `  ${value}`];
    })
    .join('\n');
}

function parseMdFile(filePath) {
  const rawContent = fs.readFileSync(filePath, 'utf8');
  // Strip a UTF-8 BOM so frontmatter is recognized regardless of the editor
  // that saved the file.
  const content = rawContent.charCodeAt(0) === 0xfeff ? rawContent.slice(1) : rawContent;
  // The closing `---` may sit at end-of-file without a trailing newline.
  // gray-matter (used by OpenCode) accepts that, so we must too: otherwise the
  // whole file is treated as the prompt body and a later save rewrites the
  // existing YAML block into the body, duplicating the frontmatter.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);

  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  let frontmatter = {};
  try {
    frontmatter = yaml.parse(match[1]) || {};
  } catch (error) {
    // Lenient fallback for frontmatter that strict YAML rejects but OpenCode
    // still accepts (unquoted colons in scalar values).
    try {
      frontmatter = yaml.parse(sanitizeFrontmatter(match[1])) || {};
    } catch {
      console.warn(`Failed to parse markdown frontmatter ${filePath}, treating as empty:`, error);
      frontmatter = {};
    }
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

function getProjectConfigPath(workingDirectory) {
  if (!workingDirectory) return null;

  const candidates = getProjectConfigCandidates(workingDirectory);

  for (const candidate of candidates) {
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
    // Resolve at call time so OPENCODE_CONFIG changes (and tests) take effect.
    customPath: process.env.OPENCODE_CONFIG
      ? path.resolve(process.env.OPENCODE_CONFIG)
      : null,
  };
}

function getPrimaryUserConfigPath(userPaths) {
  for (const userPath of userPaths) {
    if (fs.existsSync(userPath)) {
      return userPath;
    }
  }

  return CONFIG_FILE;
}

const INVALID_JSONC = 'INVALID_JSONC';

function isInvalidJsoncError(error) {
  return Boolean(error && typeof error === 'object' && error.code === INVALID_JSONC);
}

function formatJsoncParseError(filePath, errors) {
  const first = Array.isArray(errors) && errors.length > 0 ? errors[0] : null;
  const location = first && Number.isFinite(first.offset)
    ? ` (${printParseErrorCode(first.error)} at offset ${first.offset})`
    : '';
  return `OpenCode configuration at ${filePath} contains invalid JSONC and cannot be loaded safely${location}`;
}

function isCommentOnlyParse(parsed, errors) {
  // Comment-only / whitespace-only files parse to undefined with nothing but
  // ValueExpected. Any other error means real content we failed to understand
  // (YAML, plain text, a stray leading token), which must not read as empty.
  return parsed === undefined
    && errors.every((entry) => printParseErrorCode(entry.error) === 'ValueExpected');
}

function parseConfigResult(content, filePath) {
  const errors = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
  if (isCommentOnlyParse(parsed, errors)) {
    return { config: {}, value: {}, commentOnly: true };
  }
  if (errors.length > 0 || !isPlainObject(parsed)) {
    const error = new Error(formatJsoncParseError(filePath, errors));
    error.code = INVALID_JSONC;
    throw error;
  }
  return { config: parsed, value: parsed, commentOnly: false };
}

function parseConfigObject(content, filePath) {
  return parseConfigResult(content, filePath).config;
}

function readConfigFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const normalized = content.trim();
    if (!normalized) {
      return {};
    }
    // Refuse partial jsonc-parser trees. Ignoring errors previously let mutations
    // rewrite a truncated object (often only `$schema`) over the full config.
    return parseConfigObject(normalized, filePath);
  } catch (error) {
    if (isInvalidJsoncError(error)) {
      throw error;
    }
    console.error(`Failed to read config file: ${filePath}`, error);
    throw new Error('Failed to read OpenCode configuration');
  }
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

function readConfigLayer(filePath) {
  try {
    return { config: readConfigFile(filePath), error: null };
  } catch (error) {
    if (isInvalidJsoncError(error)) {
      console.error(error.message);
      return { config: {}, error };
    }
    throw error;
  }
}

function readConfigLayers(workingDirectory) {
  const { userPaths, projectPath, customPath } = getConfigPaths(workingDirectory);
  const userPath = getPrimaryUserConfigPath(userPaths);
  const userLayer = readConfigLayer(userPath);
  const projectLayer = readConfigLayer(projectPath);
  const customLayer = readConfigLayer(customPath);
  const mergedConfig = mergeConfigs(
    mergeConfigs(userLayer.config, projectLayer.config),
    customLayer.config,
  );

  const layerErrors = [];
  if (userLayer.error) {
    layerErrors.push({ path: userPath, code: userLayer.error.code, message: userLayer.error.message });
  }
  if (projectLayer.error && projectPath) {
    layerErrors.push({ path: projectPath, code: projectLayer.error.code, message: projectLayer.error.message });
  }
  if (customLayer.error && customPath) {
    layerErrors.push({ path: customPath, code: customLayer.error.code, message: customLayer.error.message });
  }

  return {
    userConfig: userLayer.config,
    projectConfig: projectLayer.config,
    customConfig: customLayer.config,
    mergedConfig,
    paths: { userPath, projectPath, customPath },
    layerErrors,
  };
}

function readConfig(workingDirectory) {
  return readConfigLayers(workingDirectory).mergedConfig;
}

function getConfigForPath(layers, targetPath) {
  if (!targetPath) {
    return layers.userConfig;
  }
  if (layers.paths.customPath && targetPath === layers.paths.customPath) {
    return layers.customConfig;
  }
  if (layers.paths.projectPath && targetPath === layers.paths.projectPath) {
    return layers.projectConfig;
  }
  return layers.userConfig;
}

function deepEqualJsonValue(a, b) {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqualJsonValue(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length
      && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqualJsonValue(a[key], b[key]));
  }
  return false;
}

// Structural diff between the parsed on-disk config and the desired config.
// Object keys are compared per key (order-insensitive); arrays and scalars are
// replaced whole. The desired config must already be JSON-normalized (no
// `undefined` values), so absent keys are the only removal signal.
function collectConfigEdits(current, next, basePath, edits) {
  if (!isPlainObject(current) || !isPlainObject(next)) {
    if (!deepEqualJsonValue(current, next)) {
      edits.push({ type: 'set', path: basePath, value: next });
    }
    return;
  }

  for (const key of Object.keys(current)) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      edits.push({ type: 'remove', path: [...basePath, key] });
    }
  }
  for (const [key, nextValue] of Object.entries(next)) {
    const keyPath = [...basePath, key];
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      edits.push({ type: 'set', path: keyPath, value: nextValue });
      continue;
    }
    collectConfigEdits(current[key], nextValue, keyPath, edits);
  }
}

function findSeparatorComma(text, start, end) {
  if (end <= start) {
    return -1;
  }
  const scanner = createScanner(text, true);
  scanner.setPosition(start);
  const token = scanner.scan();
  const offset = scanner.getTokenOffset();
  if (token === SyntaxKind.CommaToken && offset < end) {
    return offset;
  }
  return -1;
}

// Removes exactly the property node plus one adjacent separator comma. The
// scanner-based comma lookup keeps comments in the surrounding gaps (including
// commas inside comments), and avoids jsonc-parser's own removal leaving a
// stray comma when the last property of an object is deleted.
function removePropertyEdits(text, propertyPath) {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const valueNode = findNodeAtLocation(root, propertyPath);
  const propertyNode = valueNode?.parent;
  const objectNode = propertyNode?.parent;
  if (
    !valueNode
    || !propertyNode
    || !objectNode
    || objectNode.type !== 'object'
    || !Array.isArray(objectNode.children)
    || !objectNode.children.includes(propertyNode)
  ) {
    throw new Error('Failed to locate config property for removal');
  }

  const siblings = objectNode.children;
  const index = siblings.indexOf(propertyNode);
  const propStart = propertyNode.offset;
  const propEnd = propertyNode.offset + propertyNode.length;
  const edits = [{ offset: propStart, length: propEnd - propStart, content: '' }];

  const objectEnd = objectNode.offset + objectNode.length;
  const nextSibling = index < siblings.length - 1 ? siblings[index + 1] : null;
  const afterGapEnd = nextSibling ? nextSibling.offset : objectEnd - 1;
  let commaOffset = findSeparatorComma(text, propEnd, afterGapEnd);
  if (commaOffset === -1) {
    const previousSibling = index > 0 ? siblings[index - 1] : null;
    const beforeGapStart = previousSibling
      ? previousSibling.offset + previousSibling.length
      : objectNode.offset + 1;
    commaOffset = findSeparatorComma(text, beforeGapStart, propStart);
  }
  if (commaOffset !== -1) {
    edits.push({ offset: commaOffset, length: 1, content: '' });
  }
  return edits;
}

function applyConfigEdits(existingText, edits) {
  const formattingOptions = {
    tabSize: 2,
    insertSpaces: true,
    eol: existingText.includes('\r\n') ? '\r\n' : '\n',
  };
  let text = existingText;
  for (const edit of edits) {
    if (edit.type === 'remove') {
      text = applyEdits(text, removePropertyEdits(text, edit.path));
    } else {
      text = applyEdits(text, modify(text, edit.path, edit.value, { formattingOptions }));
    }
  }
  return text;
}

function parsedConfigEquals(text, desired) {
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const errors = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isPlainObject(parsed)) {
    return false;
  }
  return deepEqualJsonValue(parsed, desired);
}

function buildConfigFileContent(desired, existingRaw, existingParse) {
  if (!existingRaw.trim()) {
    return JSON.stringify(desired, null, 2);
  }
  if (!existingParse || existingParse.commentOnly) {
    // A comment-only file has no root object to merge into: keep the user's
    // comments and append the serialized config below them.
    return `${existingRaw.trimEnd()}\n${JSON.stringify(desired, null, 2)}`;
  }
  if (!isPlainObject(desired)) {
    return JSON.stringify(desired, null, 2);
  }

  const edits = [];
  collectConfigEdits(existingParse.value, desired, [], edits);
  if (edits.length === 0) {
    return existingRaw;
  }
  const rewritten = applyConfigEdits(existingRaw, edits);
  if (parsedConfigEquals(rewritten, desired)) {
    return rewritten;
  }
  console.warn('Comment-preserving config edit did not round-trip; writing a normalized config instead');
  return JSON.stringify(desired, null, 2);
}

function writeConfig(config, filePath = CONFIG_FILE) {
  try {
    let existingRaw = '';
    let existingParse = null;
    if (fs.existsSync(filePath)) {
      // Defense in depth: never overwrite a file we cannot fully parse.
      existingRaw = fs.readFileSync(filePath, 'utf8');
      if (existingRaw.trim()) {
        existingParse = parseConfigResult(existingRaw.trim(), filePath);
      }

      const backupFile = `${filePath}.openchamber.backup`;
      fs.copyFileSync(filePath, backupFile);
      console.log(`Created config backup: ${backupFile}`);
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // A JSON round-trip normalizes the config at the write boundary: it drops
    // `undefined` values exactly like the serialized write would.
    const desired = JSON.parse(JSON.stringify(config));
    fs.writeFileSync(filePath, buildConfigFileContent(desired, existingRaw, existingParse), 'utf8');
    console.log(`Successfully wrote config file: ${filePath}`);
  } catch (error) {
    if (isInvalidJsoncError(error)) {
      throw error;
    }
    console.error(`Failed to write config file: ${filePath}`, error);
    throw new Error('Failed to write OpenCode configuration');
  }
}

function getLayerError(layers, filePath) {
  if (!filePath || !Array.isArray(layers?.layerErrors)) {
    return null;
  }
  return layers.layerErrors.find((entry) => entry.path === filePath) || null;
}

function throwIfLayerError(layers, filePath) {
  const failed = getLayerError(layers, filePath);
  if (!failed) {
    return;
  }
  const error = new Error(failed.message);
  error.code = failed.code;
  throw error;
}

function getJsonEntrySource(layers, sectionKey, entryName) {
  const { userConfig, projectConfig, customConfig, paths } = layers;
  if (paths.customPath) {
    throwIfLayerError(layers, paths.customPath);
    const customSection = customConfig?.[sectionKey]?.[entryName];
    if (customSection !== undefined) {
      return { section: customSection, config: customConfig, path: paths.customPath, exists: true };
    }
  }

  if (paths.projectPath && !getLayerError(layers, paths.projectPath)) {
    const projectSection = projectConfig?.[sectionKey]?.[entryName];
    if (projectSection !== undefined) {
      return { section: projectSection, config: projectConfig, path: paths.projectPath, exists: true };
    }
  }

  throwIfLayerError(layers, paths.userPath);
  const userSection = userConfig?.[sectionKey]?.[entryName];
  if (userSection !== undefined) {
    return { section: userSection, config: userConfig, path: paths.userPath, exists: true };
  }

  return { section: null, config: null, path: null, exists: false };
}

function getJsonWriteTarget(layers, preferredScope) {
  const { userConfig, projectConfig, customConfig, paths } = layers;
  if (paths.customPath) {
    throwIfLayerError(layers, paths.customPath);
    return { config: customConfig, path: paths.customPath };
  }
  if (preferredScope === AGENT_SCOPE.PROJECT && paths.projectPath) {
    throwIfLayerError(layers, paths.projectPath);
    return { config: projectConfig, path: paths.projectPath };
  }
  throwIfLayerError(layers, paths.userPath);
  return { config: userConfig, path: paths.userPath };
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
  readConfigLayer,
  isPlainObject,
  readConfigLayers,
  readConfig,
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
