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
import { readSectionEntry, readMcpEntry } from './config-v2.js';
import { resolveWorktreeDirectory } from './worktree-directory.js';
import { writeFileAtomic } from './atomic-write.js';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';
import { isString } from '../shared/guards.js';
import { createTraversalBudget } from '../shared/traversal-budget.js';

// ============== PATH CONSTANTS ==============

// OpenCode 2 resolves its global config directory as `OPENCODE_CONFIG_DIR`
// when set, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.
const OPENCODE_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR?.trim()
  ? path.resolve(process.env.OPENCODE_CONFIG_DIR.trim())
  : path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'opencode');
const AGENT_DIR = path.join(OPENCODE_CONFIG_DIR, 'agents');
const COMMAND_DIR = path.join(OPENCODE_CONFIG_DIR, 'commands');
const SKILL_DIR = path.join(OPENCODE_CONFIG_DIR, 'skills');
// OpenCode 2 reads only `opencode.json(c)`; the v1-era `config.json` is not
// discovered any more, so it is neither read nor written here.
const CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');
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

// Agent/command/skill/loop markdown is project/clone-controlled content;
// nothing bounds its on-disk size, so never buffer one whole past this cap
// (same 4 MiB precedent as SKILL_MD_MAX_BYTES in skills-catalog/scan.js).
const MD_FILE_MAX_BYTES = 4 * 1024 * 1024;

const mdFileTooLargeError = (filePath) => {
  const error = new Error(
    `Markdown file exceeds the ${MD_FILE_MAX_BYTES}-byte size limit: ${filePath}`,
  );
  error.code = 'ERR_MD_FILE_TOO_LARGE';
  return error;
};

// Read at most MD_FILE_MAX_BYTES from an already-open handle: stat-then-read
// by path would follow a symlink to a device/FIFO and a file swapped or grown
// between the two calls would escape the gate. O_NONBLOCK (POSIX only) keeps
// open() itself from blocking on a FIFO before the regular-file check runs.
const mdFileOpenFlags = () =>
  process.platform === 'win32'
    ? fs.constants.O_RDONLY
    : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;

function readMdFileSync(filePath) {
  const fd = fs.openSync(filePath, mdFileOpenFlags());
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Markdown file is not a regular file: ${filePath}`);
    }
    if (stat.size > MD_FILE_MAX_BYTES) {
      throw mdFileTooLargeError(filePath);
    }
    const buffer = Buffer.alloc(MD_FILE_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MD_FILE_MAX_BYTES) {
      throw mdFileTooLargeError(filePath);
    }
    return buffer.toString('utf8', 0, total);
  } finally {
    fs.closeSync(fd);
  }
}

async function readMdFileAsync(filePath) {
  const handle = await fs.promises.open(filePath, mdFileOpenFlags());
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Markdown file is not a regular file: ${filePath}`);
    }
    if (stat.size > MD_FILE_MAX_BYTES) {
      throw mdFileTooLargeError(filePath);
    }
    const buffer = Buffer.alloc(MD_FILE_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MD_FILE_MAX_BYTES) {
      throw mdFileTooLargeError(filePath);
    }
    return buffer.toString('utf8', 0, total);
  } finally {
    await handle.close();
  }
}

function parseMdFile(filePath) {
  return parseMdContent(readMdFileSync(filePath), filePath);
}

async function parseMdFileAsync(filePath) {
  return parseMdContent(await readMdFileAsync(filePath), filePath);
}

function parseMdContent(rawContent, filePath) {
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

// `flag: 'wx'` creates the file and fails with EEXIST when it is already
// there; that error is passed on as is so a caller can tell it apart.
const serializeMdContent = (frontmatter, body) => {
  const cleanedFrontmatter = Object.fromEntries(
    Object.entries(frontmatter).filter(([, value]) => value != null)
  );
  const yamlStr = yaml.stringify(cleanedFrontmatter);
  return `---\n${yamlStr}---\n\n${body}`;
};

// The write side of the parse cap (#1444): refuse a serialized result
// parseMdFile would refuse, so a save cannot strand the file. Callers
// that must not change anything else first (skill update applies
// supporting-file changes in the same request) assert through this
// before touching the disk at all.
function assertMdFileWithinCap(filePath, frontmatter, body) {
  if (Buffer.byteLength(serializeMdContent(frontmatter, body), 'utf8') > MD_FILE_MAX_BYTES) {
    throw mdFileTooLargeError(filePath);
  }
}

function writeMdFile(filePath, frontmatter, body, { flag = 'w' } = {}) {
  try {
    const content = serializeMdContent(frontmatter, body);
    assertMdFileWithinCap(filePath, frontmatter, body);
    if (flag === 'wx') {
      fs.writeFileSync(filePath, content, { encoding: 'utf8', flag });
    } else {
      // OpenCode watches its agent and command folders, so a rewrite must not
      // expose a half-written file.
      writeFileAtomic(filePath, content);
    }
    console.log(`Successfully wrote markdown file: ${filePath}`);
  } catch (error) {
    if (error?.code === 'EEXIST') throw error;
    if (error?.code === 'ERR_MD_FILE_TOO_LARGE') throw error;
    console.error(`Failed to write markdown file ${filePath}:`, error);
    throw new Error('Failed to write agent markdown file');
  }
}

// ============== CONFIG FILE OPERATIONS ==============

/**
 * Project config files in the order OpenCode 2 lets them win: a file under
 * `.opencode/` overrides the one beside it at the project root, and
 * `opencode.json` overrides `opencode.jsonc`. When several exist, the
 * highest-priority one is the file OpenChamber reads and writes for the
 * project scope (OpenCode merges them all; an entry that lives only in a
 * lower file is visible through the resolved catalog but not editable here).
 */
function getProjectConfigCandidates(workingDirectory) {
  if (!workingDirectory) return [];
  return [
    path.join(workingDirectory, '.opencode', 'opencode.json'),
    path.join(workingDirectory, '.opencode', 'opencode.jsonc'),
    path.join(workingDirectory, 'opencode.json'),
    path.join(workingDirectory, 'opencode.jsonc'),
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

  // A new project config goes beside the project's other `.opencode/` files.
  return candidates[0];
}

function getConfigPaths(workingDirectory) {
  return {
    userPaths: [
      path.join(OPENCODE_CONFIG_DIR, 'opencode.json'),
      path.join(OPENCODE_CONFIG_DIR, 'opencode.jsonc'),
    ],
    projectPath: getProjectConfigPath(workingDirectory),
    // Resolve at call time so OPENCODE_CONFIG changes (and tests) take effect.
    customPath: process.env.OPENCODE_CONFIG
      ? path.resolve(process.env.OPENCODE_CONFIG)
      : null,
    // The legacy global config files under ~/.opencode. readConfigSources
    // merges them as a global source; a project walk that ascends into the
    // home directory must not reclassify them as project files (#2309).
    legacyGlobalPaths: [
      path.join(os.homedir(), '.opencode', 'opencode.json'),
      path.join(os.homedir(), '.opencode', 'opencode.jsonc'),
    ],
  };
}

function realPathOrResolved(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Every config file OpenCode 2 finds by walking up from the project folder to
 * the filesystem root, lowest priority first, as `ConfigDiscovery.discover`
 * and `Config.load` order them: each folder's `opencode.json` then
 * `opencode.jsonc`, outermost folder first, followed by each folder's
 * `.opencode/opencode.json(c)` in the same order. The global config files are
 * left out, and there is no walk when the project folder is the global config
 * folder itself.
 */
function getFolderConfigPaths(workingDirectory) {
  if (!workingDirectory) return [];
  const globalDirectory = realPathOrResolved(OPENCODE_CONFIG_DIR);
  if (realPathOrResolved(workingDirectory) === globalDirectory) return [];
  const globalFiles = ['opencode.json', 'opencode.jsonc']
    .map((name) => realPathOrResolved(path.join(OPENCODE_CONFIG_DIR, name)));
  const isGlobal = (filePath) => globalFiles.includes(realPathOrResolved(filePath));
  const folders = getAncestors(workingDirectory).reverse();
  const configFilesIn = (folder) => ['opencode.json', 'opencode.jsonc']
    .map((name) => path.join(folder, name))
    .filter((filePath) => isFile(filePath) && !isGlobal(filePath));
  return [
    ...folders.flatMap(configFilesIn),
    ...folders
      .map((folder) => path.join(folder, '.opencode'))
      .filter((folder) => realPathOrResolved(folder) !== globalDirectory)
      .flatMap(configFilesIn),
  ];
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

const CONFIG_FILE_TOO_LARGE = 'CONFIG_FILE_TOO_LARGE';

// Config files are hand-written JSONC; the precedent caps in this server run
// 1-4 MiB (AGENTS.md 1 MiB, SKILL.md 4 MiB). 4 MiB is generous for a config
// while keeping a cloned project's oversized opencode.json(c) from being
// buffered whole, synchronously, on every settings/plugin/MCP read.
const MAX_CONFIG_FILE_BYTES = 4 * 1024 * 1024;

function isConfigFileTooLargeError(error) {
  return Boolean(error && error.code === CONFIG_FILE_TOO_LARGE);
}

// Open once and judge from the handle (design #1254): a
// stat-by-path-then-readFile-by-path gate lets a config grown or swapped
// after the stat buffer whole past the cap. The shared bounded read fixes
// the file identity at open, judges the size from the handle, and reads at
// most one byte over the cap, so growth is refused, never buffered. Its
// missing and non-regular answers are mapped back onto this module's
// existing contract: a file that vanishes after the exists check throws the
// ENOENT a stat would have thrown, and a non-regular file throws the EISDIR
// a read would have thrown.
function readCappedConfigFileSync(filePath) {
  const result = readBoundedFileSync(filePath, MAX_CONFIG_FILE_BYTES);
  if (result.ok) {
    return result.buffer.toString('utf8');
  }
  if (result.reason === 'too-large') {
    const error = new Error(
      `OpenCode configuration at ${filePath} exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit and cannot be loaded safely`,
    );
    error.code = CONFIG_FILE_TOO_LARGE;
    throw error;
  }
  if (result.reason === 'missing') {
    const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    error.code = 'ENOENT';
    throw error;
  }
  const error = new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`);
  error.code = 'EISDIR';
  throw error;
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
    const content = readCappedConfigFileSync(filePath);
    const normalized = content.trim();
    if (!normalized) {
      return {};
    }
    // Refuse partial jsonc-parser trees. Ignoring errors previously let mutations
    // rewrite a truncated object (often only `$schema`) over the full config.
    return parseConfigObject(normalized, filePath);
  } catch (error) {
    if (isInvalidJsoncError(error) || isConfigFileTooLargeError(error)) {
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
    if (isInvalidJsoncError(error) || isConfigFileTooLargeError(error)) {
      console.error(error.message);
      return { config: {}, error };
    }
    throw error;
  }
}

function readConfigLayers(workingDirectory) {
  const { userPaths, projectPath, customPath, legacyGlobalPaths } = getConfigPaths(workingDirectory);
  const userPath = getPrimaryUserConfigPath(userPaths);
  // OpenCode loads every global config file in order, so an `opencode.jsonc`
  // next to `opencode.json` overrides it. New entries still go to the primary
  // file; entries found in the override are edited where they live.
  const userOverridePath = userPaths.find((candidate) => candidate !== userPath && fs.existsSync(candidate)) ?? null;
  const userLayer = readConfigLayer(userPath);
  const userOverrideLayer = readConfigLayer(userOverridePath);
  const projectLayer = readConfigLayer(projectPath);
  const customLayer = readConfigLayer(customPath);
  // OpenCode's order: global, then the custom file (OPENCODE_CONFIG), then the
  // project; a later layer wins (https://opencode.ai/docs/config/#precedence-order).
  const mergedConfig = mergeConfigs(
    mergeConfigs(mergeConfigs(userLayer.config, userOverrideLayer.config), customLayer.config),
    projectLayer.config,
  );

  const layerErrors = [];
  if (userLayer.error) {
    layerErrors.push({ path: userPath, code: userLayer.error.code, message: userLayer.error.message });
  }
  if (userOverrideLayer.error && userOverridePath) {
    layerErrors.push({ path: userOverridePath, code: userOverrideLayer.error.code, message: userOverrideLayer.error.message });
  }
  if (projectLayer.error && projectPath) {
    layerErrors.push({ path: projectPath, code: projectLayer.error.code, message: projectLayer.error.message });
  }
  if (customLayer.error && customPath) {
    layerErrors.push({ path: customPath, code: customLayer.error.code, message: customLayer.error.message });
  }

  return {
    userConfig: userLayer.config,
    userOverrideConfig: userOverrideLayer.config,
    projectConfig: projectLayer.config,
    customConfig: customLayer.config,
    mergedConfig,
    paths: { userPath, userOverridePath, projectPath, customPath, legacyGlobalPaths },
    layerErrors,
  };
}

function readConfig(workingDirectory) {
  return readConfigLayers(workingDirectory).mergedConfig;
}

/**
 * The parent directory OpenCode would create a worktree in for this project,
 * read from the merged OpenCode configuration on the canonical checkout. Keeps
 * the `worktree.directory` rule in one place (`worktree-directory.js`) and
 * returns null when the setting is unset, so the caller can fall back to
 * OpenChamber's data-dir location.
 */
function readWorktreeDirectorySetting(workingDirectory, primaryWorktree = workingDirectory) {
  const { mergedConfig } = readConfigLayers(workingDirectory);
  return resolveWorktreeDirectory(mergedConfig, primaryWorktree);
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
    const hadExistingFile = fs.existsSync(filePath);
    if (hadExistingFile) {
      // Defense in depth: never overwrite a file we cannot fully parse.
      existingRaw = readCappedConfigFileSync(filePath);
      if (existingRaw.trim()) {
        existingParse = parseConfigResult(existingRaw.trim(), filePath);
      }
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // A JSON round-trip normalizes the config at the write boundary: it drops
    // `undefined` values exactly like the serialized write would.
    const desired = JSON.parse(JSON.stringify(config));
    const content = buildConfigFileContent(desired, existingRaw, existingParse);
    // Enforce the cap on the serialized result too: writing a config that
    // crosses the read cap would strand the layer — later reads omit it as
    // CONFIG_FILE_TOO_LARGE and later writes refuse it, so the user could
    // not undo the change through OpenChamber. Reject before replacing the
    // file, preserving the readable original.
    if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_FILE_BYTES) {
      const error = new Error(
        `Serialized OpenCode configuration for ${filePath} exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit and cannot be written safely`,
      );
      error.code = CONFIG_FILE_TOO_LARGE;
      throw error;
    }
    // The backup is part of the write, so it is created only once the
    // write is known acceptable: a refused write (unparseable, over-cap,
    // or a serialized result over the cap) leaves the previous backup —
    // the restore point from the last successful write — untouched.
    if (hadExistingFile) {
      const backupFile = `${filePath}.openchamber.backup`;
      fs.copyFileSync(filePath, backupFile);
      console.log(`Created config backup: ${backupFile}`);
    }
    writeFileAtomic(filePath, content);
    console.log(`Successfully wrote config file: ${filePath}`);
  } catch (error) {
    if (isInvalidJsoncError(error) || isConfigFileTooLargeError(error)) {
      throw error;
    }
    console.error(`Failed to write config file: ${filePath}`, error);
    throw new Error('Failed to write OpenCode configuration');
  }
}

/**
 * Every config file OpenCode 2 reads, lowest priority first, each with its
 * parsed content: the global files, `OPENCODE_CONFIG`, then the files found
 * walking up from the project folder (`getFolderConfigPaths`). Readers that
 * take an entry from the last file defining it, as OpenCode's MCP and model
 * route plugins do, use this list in place of `readConfigLayers`' single
 * project file and deep merge. `required` marks the global and
 * `OPENCODE_CONFIG` files, whose parse error a reader may surface; a broken
 * folder file carries its `error` and an empty config.
 */
function readConfigSources(workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const { userPath, userOverridePath, customPath } = layers.paths;
  const required = (filePath, config) => ({ path: filePath, config, error: getLayerError(layers, filePath), required: true });
  return [
    required(userPath, layers.userConfig),
    ...(userOverridePath ? [required(userOverridePath, layers.userOverrideConfig)] : []),
    ...(customPath ? [required(customPath, layers.customConfig)] : []),
    ...getFolderConfigPaths(workingDirectory).map((filePath) => ({ path: filePath, ...readConfigLayer(filePath), required: false })),
  ];
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

/**
 * Look one entry up in a config layer, accepting both OpenCode 2 section keys
 * and the v1 keys v2 still decodes. `sectionKind` is `agents`, `commands`,
 * `providers`, or `mcp`.
 */
function lookupSectionEntry(config, sectionKind, entryName) {
  if (sectionKind === 'mcp') {
    return readMcpEntry(config, entryName);
  }
  return readSectionEntry(config, sectionKind, entryName);
}

function getJsonEntrySource(layers, sectionKind, entryName) {
  const { userConfig, projectConfig, customConfig, paths } = layers;
  const found = (config, filePath) => {
    const entry = lookupSectionEntry(config, sectionKind, entryName);
    if (entry.value === undefined) return null;
    return {
      section: entry.value,
      config,
      path: filePath,
      exists: true,
      sectionKey: entry.key,
      legacy: entry.legacy,
    };
  };

  if (paths.customPath) {
    throwIfLayerError(layers, paths.customPath);
    const custom = found(customConfig, paths.customPath);
    if (custom) return custom;
  }

  if (paths.projectPath && !getLayerError(layers, paths.projectPath)) {
    const project = found(projectConfig, paths.projectPath);
    if (project) return project;
  }

  if (paths.userOverridePath) {
    throwIfLayerError(layers, paths.userOverridePath);
    const userOverride = found(layers.userOverrideConfig, paths.userOverridePath);
    if (userOverride) return userOverride;
  }

  throwIfLayerError(layers, paths.userPath);
  const user = found(userConfig, paths.userPath);
  if (user) return user;

  return { section: null, config: null, path: null, exists: false, sectionKey: null, legacy: false };
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

// Skill supporting files are hand-maintained docs and scripts shipped with
// third-party skills; nothing OpenChamber writes bounds their size, so the
// GET route must never buffer an arbitrary one whole. Judged from stat
// before any read (the house stat-gate pattern): a file over this cap is
// refused, never read. 1 MiB matches the AGENTS.md behavior-prompt cap.
const SKILL_SUPPORTING_FILE_MAX_BYTES = 1024 * 1024;
const SKILL_SUPPORTING_FILE_TOO_LARGE_CODE = 'skill_supporting_file_too_large';

async function pathExists(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

// At most this many file-system calls of one walk are in flight at once.
const SKILL_WALK_CONCURRENCY = 8;


// Async so a skills tree with tens of thousands of entries (a bundled `.venv`
// or `node_modules`) does not hold the server's event loop for seconds.
// Directories are visited one at a time in depth-first readdir order, so the
// order matches the old synchronous walk exactly and the directory cap below
// is allocated deterministically: an over-cap tree always yields the same
// partial result, never whichever subtree's readdir finished first.
async function walkSkillMdFiles(rootDir) {
  if (!rootDir || !(await pathExists(rootDir))) return [];

  let active = 0;
  const waiting = [];
  const limited = async (call) => {
    if (active >= SKILL_WALK_CONCURRENCY) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await call();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };

  // The shared traversal budget (design #1391) owns this walk's counting:
  // at most 5,000 directories per root, the root itself included, consulted
  // on entry in the walk's deterministic depth-first order, so the total
  // never passes the cap and the same tree always allocates the cap to the
  // same directories. A skills root is project-controlled, and a link
  // inside it can point at a tree with tens of thousands of directories;
  // past the cap the walk stops opening new directories and returns the
  // SKILL.md paths found so far (enumerate disposition). The VS Code twin
  // in opencodeConfig.ts states the same budget.
  const budget = createTraversalBudget({ maxDirs: 5000 });

  // `ancestors` holds the real paths of the directories on the path to `dir`.
  // Links (symlinks and Windows junctions) are followed at any depth; a link
  // back to one of its own ancestors is skipped instead of recursing forever.
  // Two links to the same target elsewhere in the tree are both walked, as the
  // top level always did.
  const walk = async (dir, ancestors) => {
    if (!budget.visitDir()) return [];

    let realDir;
    try {
      realDir = await limited(() => fs.promises.realpath(dir));
    } catch {
      return [];
    }
    if (ancestors.has(realDir)) return [];

    let entries = [];
    try {
      entries = await limited(() => fs.promises.readdir(dir, { withFileTypes: true }));
    } catch {
      return [];
    }

    const childAncestors = new Set(ancestors).add(realDir);
    // Entries are processed one at a time, in readdir order: recursing into
    // sibling subtrees in parallel would let their readdir completions race
    // for the shared directory cap, so an unchanged over-cap tree could
    // return different partial results (and different duplicate-name
    // winners) from one scan to the next.
    const found = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      // Junctions report as links, not directories. A link whose target cannot be
      // stat'ed is skipped, the way an unreadable directory is, instead of failing
      // the whole scan.
      let isDirectoryEntry = entry.isDirectory();
      let isFileEntry = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await limited(() => fs.promises.stat(fullPath));
          isDirectoryEntry = target.isDirectory();
          isFileEntry = target.isFile();
        } catch {
          continue;
        }
      }
      if (isDirectoryEntry) {
        found.push(...(await walk(fullPath, childAncestors)));
      } else if (isFileEntry && entry.name === 'SKILL.md') {
        found.push(fullPath);
      }
    }
    return found;
  };

  return walk(rootDir, new Set());
}

// `parsed` is what `parseMdFileAsync(skillMdPath)` resolved to, or null when
// the file could not be read; an unreadable file adds nothing.
function addSkillFromMdFile(skillsMap, skillMdPath, parsed, scope, source) {
  if (!parsed) {
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

async function listSkillSupportingFiles(skillDir) {
  if (!(await pathExists(skillDir))) {
    return { files: [], truncated: false };
  }

  // A skill folder can bundle an arbitrarily large tree (a vendored .venv,
  // node_modules, generated docs); one detail request must not walk all of
  // it. The shared traversal budget (design #1391) owns this walk's
  // counting: at most 5,000 directories and 5,000 files. The VS Code twin
  // in opencodeConfig.ts states the same budget.
  const budget = createTraversalBudget({ maxDirs: 5000, maxEntries: 5000 });
  const files = [];

  // Returns false once the budget is spent, so every caller unwinds and
  // the walk stops instead of merely stopping collection. Files and
  // directories seen before the bound are kept, in the original traversal
  // order; a tree that ends exactly at a bound is complete, not truncated
  // (the budget flags truncation only when a consultation is refused).
  async function walkDir(dir, relativePath = '') {
    if (!budget.visitDir()) {
      return false;
    }

    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;

      if (entry.isDirectory()) {
        if (!(await walkDir(fullPath, relPath))) {
          return false;
        }
      } else if (entry.name !== 'SKILL.md') {
        if (!budget.visitEntry()) {
          return false;
        }
        files.push({
          name: entry.name,
          path: relPath,
          fullPath: fullPath
        });
      }
    }
    return true;
  }

  await walkDir(skillDir);
  return { files, truncated: budget.truncated };
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
  const createTooLargeError = () => Object.assign(
    new Error(`Skill file is too large to read: ${relativePath} exceeds the ${SKILL_SUPPORTING_FILE_MAX_BYTES} byte limit`),
    { code: SKILL_SUPPORTING_FILE_TOO_LARGE_CODE },
  );
  const rejectNonRegularFile = () => {
    throw Object.assign(new Error('Access to file denied'), { code: 'EACCES' });
  };

  let pathStats;
  try {
    pathStats = fs.statSync(fullPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!pathStats.isFile()) rejectNonRegularFile();
  if (pathStats.size > SKILL_SUPPORTING_FILE_MAX_BYTES) throw createTooLargeError();

  let fileDescriptor;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
    fileDescriptor = fs.openSync(fullPath, flags);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  try {
    const openedFileStats = fs.fstatSync(fileDescriptor);
    if (!openedFileStats.isFile()) rejectNonRegularFile();
    if (openedFileStats.size > SKILL_SUPPORTING_FILE_MAX_BYTES) throw createTooLargeError();

    let buffer = Buffer.allocUnsafe(Math.max(1, openedFileStats.size + 1));
    let bytesRead = 0;
    while (true) {
      if (bytesRead === buffer.length) {
        if (bytesRead > SKILL_SUPPORTING_FILE_MAX_BYTES) throw createTooLargeError();
        const nextBuffer = Buffer.allocUnsafe(Math.min(buffer.length * 2, SKILL_SUPPORTING_FILE_MAX_BYTES + 1));
        buffer.copy(nextBuffer, 0, 0, bytesRead);
        buffer = nextBuffer;
      }
      const count = fs.readSync(
        fileDescriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > SKILL_SUPPORTING_FILE_MAX_BYTES) throw createTooLargeError();
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

// The write side of the read gate above (#1444): refuse content the
// capped reader would refuse, so a save cannot strand the file. Callers
// that write several files as one operation (skill create/update)
// assert every file up front, so a refusal cannot leave a partial set.
function assertSkillSupportingFileWithinCap(relativePath, content) {
  if (isString(content) && Buffer.byteLength(content, 'utf8') > SKILL_SUPPORTING_FILE_MAX_BYTES) {
    throw Object.assign(
      new Error(`Skill file is too large to write: ${relativePath} exceeds the ${SKILL_SUPPORTING_FILE_MAX_BYTES} byte limit`),
      { code: SKILL_SUPPORTING_FILE_TOO_LARGE_CODE },
    );
  }
}

function writeSkillSupportingFile(skillDir, relativePath, content) {
  const fullPath = assertPathWithinSkillDir(skillDir, relativePath);
  assertSkillSupportingFileWithinCap(relativePath, content);
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
  parseMdFileAsync,
  MD_FILE_MAX_BYTES,
  writeMdFile,
  assertMdFileWithinCap,
  MAX_CONFIG_FILE_BYTES,
  readConfigFile,
  readConfigLayer,
  isPlainObject,
  readConfigLayers,
  readConfigSources,
  readConfig,
  readWorktreeDirectorySetting,
  getConfigForPath,
  writeConfig,
  getJsonEntrySource,
  getJsonWriteTarget,
  getProjectConfigCandidates,
  getAncestors,
  findWorktreeRoot,
  isPromptFileReference,
  resolvePromptFilePath,
  writePromptFile,
  walkSkillMdFiles,
  addSkillFromMdFile,
  resolveSkillSearchDirectories,
  listSkillSupportingFiles,
  SKILL_SUPPORTING_FILE_MAX_BYTES,
  assertSkillSupportingFileWithinCap,
  SKILL_SUPPORTING_FILE_TOO_LARGE_CODE,
  readSkillSupportingFile,
  writeSkillSupportingFile,
  deleteSkillSupportingFile
};
