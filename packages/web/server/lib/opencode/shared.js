import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'yaml';
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  format,
  modify,
  parse as parseJsonc,
  parseTree,
  printParseErrorCode,
  SyntaxKind,
} from 'jsonc-parser';
import { readSectionEntry, readMcpEntry } from './config-v2.js';
import { resolveWorktreeDirectory } from './worktree-directory.js';
import { writeFileAtomic } from './atomic-write.js';


const OPENCODE_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR?.trim()
  ? path.resolve(process.env.OPENCODE_CONFIG_DIR.trim())
  : path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'opencode');
const AGENT_DIR = path.join(OPENCODE_CONFIG_DIR, 'agents');
const COMMAND_DIR = path.join(OPENCODE_CONFIG_DIR, 'commands');
const SKILL_DIR = path.join(OPENCODE_CONFIG_DIR, 'skills');
const CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');
const PROMPT_FILE_PATTERN = /^\{file:(.+)\}$/i;

const getOpenCodeDataDir = (env = process.env) =>
  path.join(env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share'), 'opencode');


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
  return parseMdContent(fs.readFileSync(filePath, 'utf8'), filePath);
}

async function parseMdFileAsync(filePath) {
  return parseMdContent(await fs.promises.readFile(filePath, 'utf8'), filePath);
}

function parseMdContent(rawContent, filePath) {
  const content = rawContent.charCodeAt(0) === 0xfeff ? rawContent.slice(1) : rawContent;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);

  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  let frontmatter = {};
  try {
    frontmatter = yaml.parse(match[1]) || {};
  } catch (error) {
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

function writeMdFile(filePath, frontmatter, body, { flag = 'w' } = {}) {
  try {
    const cleanedFrontmatter = Object.fromEntries(
      Object.entries(frontmatter).filter(([, value]) => value != null)
    );
    const yamlStr = yaml.stringify(cleanedFrontmatter);
    const content = `---\n${yamlStr}---\n\n${body}`;
    if (flag === 'wx') {
      fs.writeFileSync(filePath, content, { encoding: 'utf8', flag });
    } else {
      writeFileAtomic(filePath, content);
    }
    console.log(`Successfully wrote markdown file: ${filePath}`);
  } catch (error) {
    if (error?.code === 'EEXIST') throw error;
    console.error(`Failed to write markdown file ${filePath}:`, error);
    throw new Error('Failed to write agent markdown file');
  }
}


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

  return candidates[0];
}

function getConfigPaths(workingDirectory) {
  return {
    userPaths: [
      path.join(OPENCODE_CONFIG_DIR, 'opencode.json'),
      path.join(OPENCODE_CONFIG_DIR, 'opencode.jsonc'),
    ],
    projectPath: getProjectConfigPath(workingDirectory),
    customPath: process.env.OPENCODE_CONFIG
      ? path.resolve(process.env.OPENCODE_CONFIG)
      : null,
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

function formatJsoncParseError(filePath, errors) {
  const first = Array.isArray(errors) && errors.length > 0 ? errors[0] : null;
  const location = first && Number.isFinite(first.offset)
    ? ` (${printParseErrorCode(first.error)} at offset ${first.offset})`
    : '';
  return `OpenCode configuration at ${filePath} contains invalid JSONC and cannot be loaded safely${location}`;
}

function isCommentOnlyParse(parsed, errors) {
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
  const userOverridePath = userPaths.find((candidate) => candidate !== userPath && fs.existsSync(candidate)) ?? null;
  const userLayer = readConfigLayer(userPath);
  const userOverrideLayer = readConfigLayer(userOverridePath);
  const projectLayer = readConfigLayer(projectPath);
  const customLayer = readConfigLayer(customPath);
  const mergedConfig = mergeConfigs(
    mergeConfigs(mergeConfigs(userLayer.config, userOverrideLayer.config), projectLayer.config),
    customLayer.config,
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
    paths: { userPath, userOverridePath, projectPath, customPath },
    layerErrors,
  };
}

function readConfig(workingDirectory) {
  return readConfigLayers(workingDirectory).mergedConfig;
}

function readWorktreeDirectorySetting(workingDirectory, primaryWorktree = workingDirectory) {
  const { userPaths, customPath } = getConfigPaths(workingDirectory);
  const sources = [...userPaths, customPath, ...getFolderConfigPaths(workingDirectory)];
  const mergedConfig = sources.reduce((config, filePath) => mergeConfigs(config, readConfigFile(filePath)), {});
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
  if (layers.paths.userOverridePath && targetPath === layers.paths.userOverridePath) {
    return layers.userOverrideConfig;
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

function arrayResizeEdits(current, next, basePath) {
  if (next.length > current.length) {
    if (!current.every((item, index) => deepEqualJsonValue(item, next[index]))) {
      return null;
    }
    return next.slice(current.length).map((value, offset) => ({
      type: 'append',
      path: [...basePath, current.length + offset],
      value,
    }));
  }
  const removed = [];
  let kept = 0;
  for (let index = 0; index < current.length; index += 1) {
    if (kept < next.length && deepEqualJsonValue(current[index], next[kept])) kept += 1;
    else removed.push(index);
  }
  if (kept !== next.length) {
    return null;
  }
  return removed.reverse().map((index) => ({ type: 'remove', path: [...basePath, index] }));
}

function collectConfigEdits(current, next, basePath, edits) {
  if (Array.isArray(current) && Array.isArray(next) && current.length !== next.length) {
    const resizeEdits = arrayResizeEdits(current, next, basePath);
    if (resizeEdits) {
      edits.push(...resizeEdits);
      return;
    }
  }
  if (Array.isArray(current) && Array.isArray(next) && current.length === next.length) {
    const changedIndices = [];
    for (let index = 0; index < current.length; index += 1) {
      if (!deepEqualJsonValue(current[index], next[index])) changedIndices.push(index);
    }
    const reordered = changedIndices.some((index) => changedIndices.some((otherIndex) => (
      index !== otherIndex && deepEqualJsonValue(current[index], next[otherIndex])
    )));
    if (!reordered) {
      for (const index of changedIndices) {
        collectConfigEdits(current[index], next[index], [...basePath, index], edits);
      }
      return;
    }
  }

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

function removeNodeEdits(text, nodePath) {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const valueNode = findNodeAtLocation(root, nodePath);
  const node = valueNode?.parent?.type === 'array' ? valueNode : valueNode?.parent;
  const container = node?.parent;
  if (
    !valueNode
    || !node
    || !container
    || (container.type !== 'object' && container.type !== 'array')
    || !Array.isArray(container.children)
    || !container.children.includes(node)
  ) {
    throw new Error('Failed to locate config node for removal');
  }

  const siblings = container.children;
  const index = siblings.indexOf(node);
  const nodeStart = node.offset;
  const nodeEnd = node.offset + node.length;
  const edits = [{ offset: nodeStart, length: nodeEnd - nodeStart, content: '' }];

  const containerEnd = container.offset + container.length;
  const nextSibling = index < siblings.length - 1 ? siblings[index + 1] : null;
  const afterGapEnd = nextSibling ? nextSibling.offset : containerEnd - 1;
  let commaOffset = findSeparatorComma(text, nodeEnd, afterGapEnd);
  if (commaOffset === -1) {
    const previousSibling = index > 0 ? siblings[index - 1] : null;
    const beforeGapStart = previousSibling
      ? previousSibling.offset + previousSibling.length
      : container.offset + 1;
    commaOffset = findSeparatorComma(text, beforeGapStart, nodeStart);
  }
  const commaBefore = commaOffset !== -1 && commaOffset < nodeStart;
  const lineStart = text.lastIndexOf('\n', nodeStart - 1) + 1;
  const removedEnd = commaOffset >= nodeEnd ? commaOffset + 1 : nodeEnd;
  const lineEnd = text.indexOf('\n', removedEnd);
  if (
    lineEnd !== -1
    && !text.slice(lineStart, nodeStart).trim()
    && !text.slice(nodeEnd, removedEnd).replace(',', '').trim()
    && !text.slice(removedEnd, lineEnd).trim()
  ) {
    edits[0] = { offset: lineStart, length: lineEnd + 1 - lineStart, content: '' };
    if (commaBefore) edits.push({ offset: commaOffset, length: 1, content: '' });
    return edits;
  }
  if (commaOffset !== -1) {
    edits.push({ offset: commaOffset, length: 1, content: '' });
  }
  return edits;
}

function appendElementEdits(text, elementPath, value, formattingOptions) {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const arrayNode = findNodeAtLocation(root, elementPath.slice(0, -1));
  const last = arrayNode?.type === 'array' ? arrayNode.children?.at(-1) : undefined;
  const lastEnd = last ? last.offset + last.length : -1;
  const closeOffset = arrayNode ? arrayNode.offset + arrayNode.length - 1 : -1;
  const closeLineStart = text.lastIndexOf('\n', closeOffset - 1) + 1;
  const indent = last ? text.slice(text.lastIndexOf('\n', last.offset - 1) + 1, last.offset) : '';
  if (!last || closeLineStart <= lastEnd || indent.trim() || text.slice(closeLineStart, closeOffset).trim()) {
    return modify(text, elementPath, value, { formattingOptions, isArrayInsertion: true });
  }

  const serialized = JSON.stringify(value);
  const lines = applyEdits(serialized, format(serialized, undefined, formattingOptions))
    .split(/\r?\n/)
    .map((line) => `${indent}${line}`);
  const edits = [{ offset: closeLineStart, length: 0, content: `${lines.join(formattingOptions.eol)}${formattingOptions.eol}` }];
  if (findSeparatorComma(text, lastEnd, closeOffset) === -1) {
    edits.unshift({ offset: lastEnd, length: 0, content: ',' });
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
      text = applyEdits(text, removeNodeEdits(text, edit.path));
    } else if (edit.type === 'append') {
      text = applyEdits(text, appendElementEdits(text, edit.path, edit.value, formattingOptions));
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
      existingRaw = fs.readFileSync(filePath, 'utf8');
      if (existingRaw.trim()) {
        existingParse = parseConfigResult(existingRaw.trim(), filePath);
      }

      const backupFile = `${filePath}.openchamber.backup`;
      fs.copyFileSync(filePath, backupFile);
      console.log(`Created config backup: ${backupFile}`);
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const desired = JSON.parse(JSON.stringify(config));
    writeFileAtomic(filePath, buildConfigFileContent(desired, existingRaw, existingParse));
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


async function pathExists(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

const SKILL_WALK_CONCURRENCY = 8;

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

  const walk = async (dir, ancestors) => {
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
    const skillEntry = entries.find((entry) => entry.name === 'SKILL.md');
    let holdsSkill = Boolean(skillEntry?.isFile());
    if (!holdsSkill && skillEntry?.isSymbolicLink()) {
      try {
        const target = await limited(() => fs.promises.stat(path.join(dir, skillEntry.name)));
        holdsSkill = target.isFile();
      } catch {
        holdsSkill = false;
      }
    }
    const found = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      let isDirectoryEntry = entry.isDirectory();
      let isFileEntry = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await limited(() => fs.promises.stat(fullPath));
          isDirectoryEntry = target.isDirectory();
          isFileEntry = target.isFile();
        } catch {
          return [];
        }
      }
      if (isDirectoryEntry) {
        if (holdsSkill || entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
        return walk(fullPath, childAncestors);
      }
      return isFileEntry && entry.name === 'SKILL.md' ? [fullPath] : [];
    }));
    return found.flat();
  };

  return walk(rootDir, new Set());
}

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
    return [];
  }

  const files = [];

  async function walkDir(dir, relativePath = '') {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;

      if (entry.isDirectory()) {
        await walkDir(fullPath, relPath);
      } else if (entry.name !== 'SKILL.md') {
        files.push({
          name: entry.name,
          path: relPath,
          fullPath: fullPath
        });
      }
    }
  }

  await walkDir(skillDir);
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
  getOpenCodeDataDir,
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
  writeMdFile,
  readConfigFile,
  readConfigLayer,
  isPlainObject,
  readConfigLayers,
  readConfig,
  readWorktreeDirectorySetting,
  getConfigForPath,
  writeConfig,
  getJsonEntrySource,
  getJsonWriteTarget,
  getLayerError,
  getProjectConfigCandidates,
  getFolderConfigPaths,
  getAncestors,
  findWorktreeRoot,
  isPromptFileReference,
  resolvePromptFilePath,
  writePromptFile,
  walkSkillMdFiles,
  pathExists,
  addSkillFromMdFile,
  resolveSkillSearchDirectories,
  listSkillSupportingFiles,
  readSkillSupportingFile,
  writeSkillSupportingFile,
  deleteSkillSupportingFile
};
