import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  format,
  modify,
  parse as parseJsonc,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';
import * as jsoncParser from 'jsonc-parser';
import { readSectionEntry, readMcpEntry } from './config-v2.js';
import { resolveWorktreeDirectory } from './worktree-directory.js';
import { writeFileAtomic } from './atomic-write.js';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';
import type { ParseError, JSONPath, FormattingOptions } from 'jsonc-parser';
import type { JsonValue } from '../shared/json-values.js';
import type { SectionKind } from './config-v2.js';

export interface OpenCodeConfigLayer {
  [key: string]: JsonValue;
}

export interface ConfigLayerError { path: string; code: string; message: string }

export interface OpenCodeConfigLayers {
  userConfig: OpenCodeConfigLayer;
  userOverrideConfig: OpenCodeConfigLayer;
  projectConfig: OpenCodeConfigLayer;
  customConfig: OpenCodeConfigLayer;
  mergedConfig: OpenCodeConfigLayer;
  paths: {
    userPath: string;
    userOverridePath: string | null;
    projectPath: string | null | undefined;
    customPath: string | null;
    // The legacy global files under ~/.opencode, lowest precedence.
    legacyGlobalPaths?: string[];
  };
  layerErrors: ConfigLayerError[];
}

interface InvalidJsoncError extends Error {
  code: string;
}

interface ConfigParseResult {
  config: OpenCodeConfigLayer;
  value: OpenCodeConfigLayer;
  commentOnly: boolean;
}

type ConfigEdit =
  | { type: 'remove'; path: JSONPath }
  | { type: 'set' | 'append'; path: JSONPath; value: JsonValue | undefined };

const { SyntaxKind }: { SyntaxKind: { readonly CommaToken: number } } = jsoncParser;


const OPENCODE_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR?.trim()
  ? path.resolve(process.env.OPENCODE_CONFIG_DIR.trim())
  : path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'opencode');
const AGENT_DIR = path.join(OPENCODE_CONFIG_DIR, 'agents');
const COMMAND_DIR = path.join(OPENCODE_CONFIG_DIR, 'commands');
const SKILL_DIR = path.join(OPENCODE_CONFIG_DIR, 'skills');
const CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');

const getOpenCodeDataDir = (env: NodeJS.ProcessEnv = process.env) =>
  path.join(env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share'), 'opencode');


const AGENT_SCOPE = {
  USER: 'user',
  PROJECT: 'project'
} satisfies { USER: 'user'; PROJECT: 'project' };

const COMMAND_SCOPE = {
  USER: 'user',
  PROJECT: 'project'
} satisfies { USER: 'user'; PROJECT: 'project' };

const SKILL_SCOPE = {
  USER: 'user',
  PROJECT: 'project'
} satisfies { USER: 'user'; PROJECT: 'project' };


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


function getProjectConfigCandidates(workingDirectory?: string | null): string[] {
  if (!workingDirectory) return [];
  return [
    path.join(workingDirectory, '.opencode', 'opencode.json'),
    path.join(workingDirectory, '.opencode', 'opencode.jsonc'),
    path.join(workingDirectory, 'opencode.json'),
    path.join(workingDirectory, 'opencode.jsonc'),
  ];
}

function getProjectConfigPath(workingDirectory?: string | null) {
  if (!workingDirectory) return null;

  const candidates = getProjectConfigCandidates(workingDirectory);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function getConfigPaths(workingDirectory?: string | null) {
  return {
    userPaths: [
      path.join(OPENCODE_CONFIG_DIR, 'opencode.json'),
      path.join(OPENCODE_CONFIG_DIR, 'opencode.jsonc'),
    ],
    projectPath: getProjectConfigPath(workingDirectory),
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

function realPathOrResolved(filePath: string) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isFile(filePath: string) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getFolderConfigPaths(workingDirectory?: string | null) {
  if (!workingDirectory) return [];
  const globalDirectory = realPathOrResolved(OPENCODE_CONFIG_DIR);
  if (realPathOrResolved(workingDirectory) === globalDirectory) return [];
  const globalFiles = ['opencode.json', 'opencode.jsonc']
    .map((name) => realPathOrResolved(path.join(OPENCODE_CONFIG_DIR, name)));
  const isGlobal = (filePath: string) => globalFiles.includes(realPathOrResolved(filePath));
  const folders = getAncestors(workingDirectory).reverse();
  const configFilesIn = (folder: string) => ['opencode.json', 'opencode.jsonc']
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

function getPrimaryUserConfigPath(userPaths: string[]) {
  for (const userPath of userPaths) {
    if (fs.existsSync(userPath)) {
      return userPath;
    }
  }

  return CONFIG_FILE;
}

const INVALID_JSONC = 'INVALID_JSONC';

function isInvalidJsoncError(error: unknown): error is InvalidJsoncError {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === INVALID_JSONC);
}

const CONFIG_FILE_TOO_LARGE = 'CONFIG_FILE_TOO_LARGE';

// Config files are hand-written JSONC; the precedent caps in this server run
// 1-4 MiB (AGENTS.md 1 MiB, SKILL.md 4 MiB). 4 MiB is generous for a config
// while keeping a cloned project's oversized opencode.json(c) from being
// buffered whole, synchronously, on every settings/plugin/MCP read.
const MAX_CONFIG_FILE_BYTES = 4 * 1024 * 1024;

function isConfigFileTooLargeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && error.code === CONFIG_FILE_TOO_LARGE;
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
function readCappedConfigFileSync(filePath: string) {
  const result = readBoundedFileSync(filePath, MAX_CONFIG_FILE_BYTES);
  if (result.ok) {
    return result.buffer.toString('utf8');
  }
  if (result.reason === 'too-large') {
    throw Object.assign(new Error(
      `OpenCode configuration at ${filePath} exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit and cannot be loaded safely`,
    ), { code: CONFIG_FILE_TOO_LARGE });
  }
  if (result.reason === 'missing') {
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), { code: 'ENOENT' });
  }
  throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`), { code: 'EISDIR' });
}

function formatJsoncParseError(filePath: string, errors: ParseError[]) {
  const first = Array.isArray(errors) && errors.length > 0 ? errors[0] : null;
  const location = first && Number.isFinite(first.offset)
    ? ` (${printParseErrorCode(first.error)} at offset ${first.offset})`
    : '';
  return `OpenCode configuration at ${filePath} contains invalid JSONC and cannot be loaded safely${location}`;
}

function isCommentOnlyParse(parsed: JsonValue | undefined, errors: ParseError[]) {
  return parsed === undefined
    && errors.every((entry) => printParseErrorCode(entry.error) === 'ValueExpected');
}

function parseConfigResult(content: string, filePath: string): ConfigParseResult {
  const errors: ParseError[] = [];
  const parsed: JsonValue | undefined = parseJsonc(content, errors, { allowTrailingComma: true });
  if (isCommentOnlyParse(parsed, errors)) {
    return { config: {}, value: {}, commentOnly: true };
  }
  if (errors.length > 0 || !isPlainObject(parsed)) {
    const error: Error & { code?: string } = new Error(formatJsoncParseError(filePath, errors));
    error.code = INVALID_JSONC;
    throw error;
  }
  return { config: parsed, value: parsed, commentOnly: false };
}

function parseConfigObject(content: string, filePath: string) {
  return parseConfigResult(content, filePath).config;
}

function readConfigFile(filePath?: string | null): OpenCodeConfigLayer {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }
  try {
    const content = readCappedConfigFileSync(filePath);
    const normalized = content.trim();
    if (!normalized) {
      return {};
    }
    return parseConfigObject(normalized, filePath);
  } catch (error) {
    if (isInvalidJsoncError(error) || isConfigFileTooLargeError(error)) {
      throw error;
    }
    console.error(`Failed to read config file: ${filePath}`, error);
    throw new Error('Failed to read OpenCode configuration');
  }
}

function isPlainObject(value: JsonValue | undefined): value is OpenCodeConfigLayer;
function isPlainObject(value: unknown): value is Record<string, unknown>;
function isPlainObject<Value>(value: Value) {
  return value && isNonArrayObject(value);
}

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mergeConfigs(base: OpenCodeConfigLayer, override: OpenCodeConfigLayer): OpenCodeConfigLayer {
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

type ConfigLayerRead = { config: OpenCodeConfigLayer; error: (Error & { code: string }) | null };

function readConfigLayer(filePath?: string | null): ConfigLayerRead {
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

function readConfigLayers(workingDirectory?: string | null): OpenCodeConfigLayers {
  const { userPaths, projectPath, customPath, legacyGlobalPaths } = getConfigPaths(workingDirectory);
  const userPath = getPrimaryUserConfigPath(userPaths);
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

function readConfig(workingDirectory?: string | null) {
  return readConfigLayers(workingDirectory).mergedConfig;
}

function readWorktreeDirectorySetting(workingDirectory: string, primaryWorktree = workingDirectory) {
  const { userPaths, customPath } = getConfigPaths(workingDirectory);
  const sources = [...userPaths, customPath, ...getFolderConfigPaths(workingDirectory)];
  const mergedConfig = sources.reduce((config, filePath) => mergeConfigs(config, readConfigFile(filePath)), {});
  return resolveWorktreeDirectory(mergedConfig, primaryWorktree);
}

function getConfigForPath(layers: OpenCodeConfigLayers, targetPath?: string | null) {
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

function deepEqualJsonValue(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
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

function arrayResizeEdits(current: JsonValue[], next: JsonValue[], basePath: JSONPath): ConfigEdit[] | null {
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

function collectConfigEdits(current: JsonValue | undefined, next: JsonValue | undefined, basePath: JSONPath, edits: ConfigEdit[]) {
  if (Array.isArray(current) && Array.isArray(next) && current.length !== next.length) {
    const resizeEdits = arrayResizeEdits(current, next, basePath);
    if (resizeEdits) {
      edits.push(...resizeEdits);
      return;
    }
  }
  if (Array.isArray(current) && Array.isArray(next) && current.length === next.length) {
    const changedIndices: number[] = [];
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

function findSeparatorComma(text: string, start: number, end: number) {
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

function removeNodeEdits(text: string, nodePath: JSONPath) {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const valueNode = root && findNodeAtLocation(root, nodePath);
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

function appendElementEdits(text: string, elementPath: JSONPath, value: JsonValue | undefined, formattingOptions: FormattingOptions & { eol: string }) {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const arrayNode = root && findNodeAtLocation(root, elementPath.slice(0, -1));
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

function applyConfigEdits(existingText: string, edits: ConfigEdit[]) {
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

function parsedConfigEquals(text: string, desired: JsonValue) {
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const errors: ParseError[] = [];
  const parsed: JsonValue | undefined = parseJsonc(content, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isPlainObject(parsed)) {
    return false;
  }
  return deepEqualJsonValue(parsed, desired);
}

// Some config maps have a visible order, such as model pools. Move only their
// property nodes after the value edits so comments inside values and all trivia
// between properties survive. Ordinary config objects stay order-insensitive.
function reorderConfigProperties(text: string, desired: JsonValue, orderedPaths: string[][]) {
  let reordered = text;
  for (const propertyPath of orderedPaths) {
    const root = parseTree(reordered, [], { allowTrailingComma: true });
    const object = root ? findNodeAtLocation(root, propertyPath) : undefined;
    if (object?.type !== 'object' || !object.children) continue;
    let next: JsonValue | undefined = desired;
    for (const key of propertyPath) next = isPlainObject(next) ? next[key] : undefined;
    if (!isPlainObject(next)) continue;
    const keys = Object.keys(next);
    const properties = object.children;
    const currentKeys = properties.map((property) => property.children?.[0]?.value);
    if (keys.length !== properties.length || keys.every((key, index) => key === currentKeys[index])) continue;
    const bodies = new Map(properties.map((property) => [
      property.children?.[0]?.value,
      reordered.slice(property.offset, property.offset + property.length),
    ]));
    const edits = properties.map((property, index) => ({
      offset: property.offset,
      length: property.length,
      content: bodies.get(keys[index]),
    }));
    const complete = edits.flatMap((edit) => (edit.content === undefined ? [] : [{ ...edit, content: edit.content }]));
    if (complete.length !== edits.length) throw new Error('Could not preserve ordered config properties');
    reordered = applyEdits(reordered, complete);
  }
  return reordered;
}

function buildConfigFileContent(desired: JsonValue, existingRaw: string, existingParse: ConfigParseResult | null, orderedPaths: string[][] = []) {
  if (!existingRaw.trim()) {
    return JSON.stringify(desired, null, 2);
  }
  if (!existingParse || existingParse.commentOnly) {
    return `${existingRaw.trimEnd()}\n${JSON.stringify(desired, null, 2)}`;
  }
  if (!isPlainObject(desired)) {
    return JSON.stringify(desired, null, 2);
  }

  const edits: ConfigEdit[] = [];
  collectConfigEdits(existingParse.value, desired, [], edits);
  if (edits.length === 0 && orderedPaths.length === 0) {
    return existingRaw;
  }
  const rewritten = reorderConfigProperties(applyConfigEdits(existingRaw, edits), desired, orderedPaths);
  if (parsedConfigEquals(rewritten, desired)) {
    return rewritten;
  }
  console.warn('Comment-preserving config edit did not round-trip; writing a normalized config instead');
  return JSON.stringify(desired, null, 2);
}

function writeConfig(config: OpenCodeConfigLayer, filePath = CONFIG_FILE, { orderedPaths = [] }: { orderedPaths?: string[][] } = {}) {
  try {
    let existingRaw = '';
    let existingParse = null;
    const hadExistingFile = fs.existsSync(filePath);
    if (hadExistingFile) {
      existingRaw = readCappedConfigFileSync(filePath);
      if (existingRaw.trim()) {
        existingParse = parseConfigResult(existingRaw.trim(), filePath);
      }
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const desired: JsonValue = JSON.parse(JSON.stringify(config));
    const content = buildConfigFileContent(desired, existingRaw, existingParse, orderedPaths);
    // Enforce the cap on the serialized result too: writing a config that
    // crosses the read cap would strand the layer — later reads omit it as
    // CONFIG_FILE_TOO_LARGE and later writes refuse it, so the user could
    // not undo the change through OpenChamber. Reject before replacing the
    // file, preserving the readable original.
    if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_FILE_BYTES) {
      throw Object.assign(new Error(
        `Serialized OpenCode configuration for ${filePath} exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit and cannot be written safely`,
      ), { code: CONFIG_FILE_TOO_LARGE });
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
function readConfigSources(workingDirectory?: string | null) {
  const layers = readConfigLayers(workingDirectory);
  const { userPath, userOverridePath, customPath } = layers.paths;
  const required = (filePath: string, config: OpenCodeConfigLayer) => ({ path: filePath, config, error: getLayerError(layers, filePath), required: true });
  return [
    required(userPath, layers.userConfig),
    ...(userOverridePath ? [required(userOverridePath, layers.userOverrideConfig)] : []),
    ...(customPath ? [required(customPath, layers.customConfig)] : []),
    ...getFolderConfigPaths(workingDirectory).map((filePath) => ({ path: filePath, ...readConfigLayer(filePath), required: false })),
  ];
}

function getLayerError(layers: OpenCodeConfigLayers, filePath?: string | null) {
  if (!filePath || !Array.isArray(layers?.layerErrors)) {
    return null;
  }
  return layers.layerErrors.find((entry) => entry.path === filePath) || null;
}

function throwIfLayerError(layers: OpenCodeConfigLayers, filePath?: string | null) {
  const failed = getLayerError(layers, filePath);
  if (!failed) {
    return;
  }
  const error: Error & { code?: string } = new Error(failed.message);
  error.code = failed.code;
  throw error;
}

function lookupSectionEntry(config: OpenCodeConfigLayer, sectionKind: SectionKind | 'mcp', entryName: string) {
  if (sectionKind === 'mcp') {
    return readMcpEntry(config, entryName);
  }
  return readSectionEntry(config, sectionKind, entryName);
}

function getJsonEntrySource(layers: OpenCodeConfigLayers, sectionKind: SectionKind | 'mcp', entryName: string) {
  const { userConfig, projectConfig, customConfig, paths } = layers;
  const found = (config: OpenCodeConfigLayer, filePath: string) => {
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

function getJsonWriteTarget(layers: OpenCodeConfigLayers, preferredScope?: string) {
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


function getAncestors(startDir?: string | null, stopDir?: string | null) {
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

function findWorktreeRoot(startDir?: string | null): string | null {
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
  getLayerError,
  getProjectConfigCandidates,
  getFolderConfigPaths,
  getAncestors,
  findWorktreeRoot
};
