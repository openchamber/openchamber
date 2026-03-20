#!/usr/bin/env node
/**
 * Unified i18n tooling:
 * - check-keys: verify t('...') usages exist in locale files
 * - scan-gaps: scan UI components for likely non-i18n literals
 * - clean-unused: remove unused locale keys
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const SUPPORTED_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SUPPORTED_GAP_SCAN_EXTENSIONS = new Set(['.tsx', '.jsx']);

const DEFAULT_SOURCE_ROOT = 'packages/ui/src';
const DEFAULT_GAP_SCAN_ROOT = 'packages/ui/src/components';
const DEFAULT_LOCALES = [
  'packages/ui/src/i18n/locales/en.json',
  'packages/ui/src/i18n/locales/zh.json',
];

const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.next',
  'coverage',
  '__tests__',
  '__mocks__',
]);

const USER_VISIBLE_PROPS = new Set([
  'title',
  'placeholder',
  'aria-label',
  'alt',
  'label',
  'description',
  'helperText',
  'tooltip',
  'message',
  'text',
]);

const USER_VISIBLE_OBJECT_KEYS = new Set([
  'title',
  'placeholder',
  'ariaLabel',
  'label',
  'description',
  'helperText',
  'tooltip',
  'message',
  'text',
  'category',
  'name',
]);

const NON_TRANSLATABLE_TERMS = new Set([
  'head',
  'worktree',
  'english',
  'español',
  'français',
  'deutsch',
  '日本語',
  '中文',
  'português',
  'italiano',
  '한국어',
  'українська',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
  'bun',
  'npm',
  'opencode',
  'opencode cli',
  'openchamber',
  'openchamber logo',
  'csv',
  'tsv',
  'markdown',
  'ctx',
  'out',
  'ms',
  'localhost',
  'parent',
  '$root_project_path',
  'plain',
  'esc',
]);

const LANGUAGE_SELF_NAMES = new Set([
  'English',
  '简体中文',
  '繁體中文',
  '日本語',
  '한국어',
  'Français',
  'Deutsch',
  'Español',
  'Português',
  'Italiano',
  'Українська',
]);

const T_CALL_PATTERN = /\bt\s*\(\s*(['"])([^'"`]+?)\1/g;
const T_DYNAMIC_PREFIX_PATTERN = /\bt\s*\(\s*`([a-z][\w-]*(?:\.[a-z][\w-]*)*\.)\$\{[^}]+\}[^`]*`\s*[),]/g;
const T_IDENTIFIER_CALL_PATTERN = /\bt\s*\(\s*([A-Za-z_$][\w$]*)\s*[),]/g;
const IDENTIFIER_KEY_ASSIGN_PATTERN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([a-z][\w-]*(?:\.[a-z][\w-]*)+)\2/g;
const IDENTIFIER_DYNAMIC_PREFIX_ASSIGN_PATTERN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*`([a-z][\w-]*(?:\.[a-z][\w-]*)*\.)\$\{[^}]+\}[^`]*`/g;
const I18N_KEY_LITERAL_PATTERN = /(['"])([a-z][\w-]*(?:\.[a-z][\w-]*)+)\1/g;
const I18N_CALL_PATTERN = /\b(?:i18n\.)?t\s*\(/;
const ONLY_SYMBOLS_PATTERN = /^[\s\d_\-:/.#()[\]{}|]+$/;
const URL_PATTERN = /^(?:https?:)?\/\//;
const FILE_LIKE_PATTERN = /^[./~]?[\w\-./]+\.[A-Za-z0-9]{1,8}$/;
const DURATION_LIKE_PATTERN = /^(?:\d+(?:\.\d+)?\s*(?:ms|s|m|h|d|w|mo|y))(?:\s+\d+(?:\.\d+)?\s*(?:ms|s|m|h|d|w|mo|y))*$/i;
const I18N_KEY_LIKE_PATTERN = /^[a-z][\w-]*(?:\.[\w-]+)+$/;
const CSS_VAR_PATTERN = /^var\(--[a-z0-9-]+\)$/i;
const SLASH_COMMAND_PATTERN = /^\/[a-z][\w-]*$/i;
const IDENTIFIER_TOKEN_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/i;
const SHELL_COMMAND_PATTERN = /^(?:brew|apt(?:-get)?|yum|dnf|pacman|choco|winget|npm|pnpm|yarn|bun|pip|pip3|cargo|go)\s+.+$/i;
const JSX_TEXT_PATTERN = />\s*([^<{}`\n][^<{}`\n]*?)\s*</g;
const JSX_MULTILINE_TEXT_PATTERN = /<([A-Za-z][\w.]*)[^>]*>\s*\n\s*([^<{}`\n][^<{}`\n]*?)\s*\n\s*<\/\1>/gm;
const PROP_LITERAL_PATTERN = /\b([A-Za-z][\w-]*)\s*=\s*(['"])([^'"\n]{2,})\2/g;
const OBJECT_LITERAL_PATTERN = /\b([A-Za-z][\w-]*)\s*:\s*(['"])([^'"\n]{2,})\2/g;
const TOAST_LITERAL_PATTERN = /\btoast\.(?:success|error|warning|info)\s*\(\s*(['"])([^'"\n]{2,})\1/g;
const ADD_OPERATION_LOG_LITERAL_PATTERN = /\baddOperationLog\s*\(\s*(['"])([^'"\n]{2,})\1/g;
const UPDATE_LAST_LOG_LITERAL_PATTERN = /\bupdateLastLog\s*\(\s*['"][^'"\n]+['"]\s*,\s*(['"])([^'"\n]{2,})\1/g;
const CODE_FRAGMENT_PATTERN = /(=>|\b(?:Record|Promise|Array|React)\b|[{};]|\bextends\b|\bas\s+[A-Za-z])/;
const PLURAL_SUFFIXES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

function getLineNumberFromPos(content, pos) {
  return content.slice(0, pos).split('\n').length;
}

function getJsxTagName(node) {
  if (!node) return '';
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return node.getText();
}

function getObjectPropertyName(node) {
  if (!node || !('name' in node) || !node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) {
    return node.name.text;
  }
  return null;
}

function isTranslationCallExpression(node) {
  if (!node || !ts.isCallExpression(node)) return false;
  const { expression } = node;
  if (ts.isIdentifier(expression)) {
    return expression.text === 't';
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === 't';
  }
  return false;
}

function expressionContainsTranslation(node) {
  let found = false;
  function visit(current) {
    if (found || !current) return;
    if (ts.isCallExpression(current) && isTranslationCallExpression(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function hasI18nIgnoreComment(sourceFile, node) {
  const trailing = ts.getTrailingCommentRanges(sourceFile.text, node.end) ?? [];
  if (trailing.some((range) => sourceFile.text.slice(range.pos, range.end).includes('i18n-scan-ignore'))) {
    return true;
  }
  const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.pos) ?? [];
  if (ranges.some((range) => sourceFile.text.slice(range.pos, range.end).includes('i18n-scan-ignore'))) {
    return true;
  }
  const lineStart = sourceFile.text.lastIndexOf('\n', Math.max(0, node.end - 1)) + 1;
  const lineEndIndex = sourceFile.text.indexOf('\n', node.end);
  const lineEnd = lineEndIndex === -1 ? sourceFile.text.length : lineEndIndex;
  const sameLineText = sourceFile.text.slice(lineStart, lineEnd);
  return sameLineText.includes('i18n-scan-ignore');
}

function isInsideIgnoredJsx(sourceFile, node) {
  let current = node;
  while (current) {
    if (hasI18nIgnoreComment(sourceFile, current)) return true;
    current = current.parent;
  }
  return false;
}

function isInsideTransComponent(node) {
  let current = node.parent;
  while (current) {
    if (ts.isJsxElement(current)) {
      return getJsxTagName(current.openingElement.tagName) === 'Trans';
    }
    if (ts.isJsxSelfClosingElement(current)) {
      return getJsxTagName(current.tagName) === 'Trans';
    }
    current = current.parent;
  }
  return false;
}

function pushAstHit(hits, seen, lineNumber, reason, text) {
  const normalized = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) return;
  const key = `${lineNumber}|${reason}|${normalized}`;
  if (seen.has(key)) return;
  seen.add(key);
  hits.push({ lineNumber, reason, text: normalized });
}

function scanFileForGapsAst(filePath, content) {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
  const hits = [];
  const seen = new Set();

  function visit(node) {
    if (isInsideIgnoredJsx(sourceFile, node)) {
      return;
    }

    if (ts.isJsxText(node)) {
      const text = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
      if (text && !isInsideTransComponent(node) && !shouldIgnoreLiteral(text, null, text)) {
        pushAstHit(hits, seen, getLineNumberFromPos(content, node.getStart(sourceFile)), 'jsx-text-visible', text);
      }
      return;
    }

    if (ts.isJsxAttribute(node)) {
      const propName = node.name.text;
      if (USER_VISIBLE_PROPS.has(propName) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          const literal = node.initializer.text.trim();
          if (!shouldIgnoreLiteral(node.getText(sourceFile), propName, literal)) {
            pushAstHit(hits, seen, getLineNumberFromPos(content, node.getStart(sourceFile)), 'jsx-prop-literal', literal);
          }
        }
        if (ts.isJsxExpression(node.initializer) && node.initializer.expression && expressionContainsTranslation(node.initializer.expression)) {
          return;
        }
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const propName = getObjectPropertyName(node);
      if (propName && USER_VISIBLE_OBJECT_KEYS.has(propName) && ts.isStringLiteralLike(node.initializer)) {
        const literal = node.initializer.text.trim();
        if (!shouldIgnoreLiteral(node.getText(sourceFile), propName, literal)) {
          pushAstHit(hits, seen, getLineNumberFromPos(content, node.getStart(sourceFile)), 'object-visible-literal', literal);
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const expressionText = node.expression.getText(sourceFile);
      const isToastCall = /^toast\.(success|error|warning|info)$/.test(expressionText);
      const isOperationLogCall = expressionText === 'addOperationLog';
      const isUpdateLastLogCall = expressionText === 'updateLastLog';

      if ((isToastCall || isOperationLogCall) && node.arguments.length > 0) {
        const firstArg = node.arguments[0];
        if (ts.isStringLiteralLike(firstArg)) {
          const literal = firstArg.text.trim();
          if (!shouldIgnoreLiteral(node.getText(sourceFile), 'message', literal)) {
            pushAstHit(hits, seen, getLineNumberFromPos(content, node.getStart(sourceFile)), isToastCall ? 'toast-literal' : 'call-literal', literal);
          }
        }
      }

      if (isUpdateLastLogCall && node.arguments.length > 1) {
        const secondArg = node.arguments[1];
        if (ts.isStringLiteralLike(secondArg)) {
          const literal = secondArg.text.trim();
          if (!shouldIgnoreLiteral(node.getText(sourceFile), 'message', literal)) {
            pushAstHit(hits, seen, getLineNumberFromPos(content, node.getStart(sourceFile)), 'call-literal', literal);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return hits;
}

function parseArgv(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.split('=', 2);
    const key = rawKey.slice(2);
    if (inlineValue !== undefined) {
      const list = flags.get(key) ?? [];
      list.push(inlineValue);
      flags.set(key, list);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      const list = flags.get(key) ?? [];
      list.push(true);
      flags.set(key, list);
      continue;
    }
    const list = flags.get(key) ?? [];
    list.push(next);
    flags.set(key, list);
    i += 1;
  }
  return { positional, flags };
}

function flagValues(flags, key) {
  return flags.get(key) ?? [];
}

function flagValue(flags, key, fallback) {
  const values = flagValues(flags, key);
  if (values.length === 0) return fallback;
  const last = values[values.length - 1];
  return last === true ? fallback : String(last);
}

function hasFlag(flags, key) {
  const values = flagValues(flags, key);
  if (values.length === 0) return false;
  return values.some((v) => v === true || v === 'true');
}

function cwdRel(filePath) {
  return path.relative(process.cwd(), filePath) || '.';
}

function walkFiles(rootDir, allowedExtensions, excludes = DEFAULT_EXCLUDE_DIRS) {
  const out = [];
  function walk(current) {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (excludes.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (!allowedExtensions.has(ext)) continue;
      out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

function flattenLocaleKeys(value, prefix = '') {
  const keys = new Set();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return keys;
  }
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      for (const nested of flattenLocaleKeys(child, full)) {
        keys.add(nested);
      }
    } else {
      keys.add(full);
    }
  }
  return keys;
}

function collectUsages(sourceRoot) {
  const usages = [];
  const dynamicPrefixes = new Set();
  const files = walkFiles(sourceRoot, SUPPORTED_SOURCE_EXTENSIONS);
  for (const filePath of files) {
    let text = '';
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      T_CALL_PATTERN.lastIndex = 0;
      let match;
      while ((match = T_CALL_PATTERN.exec(line)) !== null) {
        const key = String(match[2] ?? '').trim();
        if (!key) continue;
        usages.push({ key, filePath, lineNumber: i + 1 });
      }
    }

    T_DYNAMIC_PREFIX_PATTERN.lastIndex = 0;
    let prefixMatch;
    while ((prefixMatch = T_DYNAMIC_PREFIX_PATTERN.exec(text)) !== null) {
      const prefix = String(prefixMatch[1] ?? '').trim();
      if (!prefix) continue;
      dynamicPrefixes.add(prefix);
    }
  }
  return { usages, dynamicPrefixes };
}

function collectI18nReferences(sourceRoot, allowFlatKeys) {
  const files = walkFiles(sourceRoot, SUPPORTED_SOURCE_EXTENSIONS);
  const usedKeys = new Set();
  const inferredKeys = new Set();
  const dynamicPrefixes = new Set();

  for (const filePath of files) {
    let text = '';
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    // 1) Direct static t('a.b') usage.
    T_CALL_PATTERN.lastIndex = 0;
    let tMatch;
    while ((tMatch = T_CALL_PATTERN.exec(text)) !== null) {
      const key = String(tMatch[2] ?? '').trim();
      if (!key) continue;
      if (!allowFlatKeys && !key.includes('.')) continue;
      usedKeys.add(key);
    }

    // 2) Dynamic template literal usage: t(`prefix.${expr}`)
    T_DYNAMIC_PREFIX_PATTERN.lastIndex = 0;
    let prefixMatch;
    while ((prefixMatch = T_DYNAMIC_PREFIX_PATTERN.exec(text)) !== null) {
      const prefix = String(prefixMatch[1] ?? '').trim();
      if (!prefix) continue;
      dynamicPrefixes.add(prefix);
    }

    // 3) Simple identifier flow: const k='a.b'; t(k)
    const identifierToKey = new Map();
    const identifierToDynamicPrefix = new Map();
    IDENTIFIER_KEY_ASSIGN_PATTERN.lastIndex = 0;
    let assignMatch;
    while ((assignMatch = IDENTIFIER_KEY_ASSIGN_PATTERN.exec(text)) !== null) {
      const ident = String(assignMatch[1] ?? '');
      const key = String(assignMatch[3] ?? '');
      if (!allowFlatKeys && !key.includes('.')) continue;
      if (!ident || !key) continue;
      identifierToKey.set(ident, key);
      inferredKeys.add(key);
    }

    IDENTIFIER_DYNAMIC_PREFIX_ASSIGN_PATTERN.lastIndex = 0;
    let dynamicAssignMatch;
    while ((dynamicAssignMatch = IDENTIFIER_DYNAMIC_PREFIX_ASSIGN_PATTERN.exec(text)) !== null) {
      const ident = String(dynamicAssignMatch[1] ?? '');
      const prefix = String(dynamicAssignMatch[2] ?? '').trim();
      if (!ident || !prefix) continue;
      identifierToDynamicPrefix.set(ident, prefix);
    }

    T_IDENTIFIER_CALL_PATTERN.lastIndex = 0;
    let identCallMatch;
    while ((identCallMatch = T_IDENTIFIER_CALL_PATTERN.exec(text)) !== null) {
      const ident = String(identCallMatch[1] ?? '');
      const mapped = identifierToKey.get(ident);
      if (mapped) {
        usedKeys.add(mapped);
      }
      const dynamicPrefix = identifierToDynamicPrefix.get(ident);
      if (dynamicPrefix) {
        dynamicPrefixes.add(dynamicPrefix);
      }
    }

    // 4) Conservative fallback: keep any i18n-like key literal.
    // This covers patterns like { labelKey: 'x.y' } later passed to t(option.labelKey).
    I18N_KEY_LITERAL_PATTERN.lastIndex = 0;
    let literalMatch;
    while ((literalMatch = I18N_KEY_LITERAL_PATTERN.exec(text)) !== null) {
      const key = String(literalMatch[2] ?? '');
      if (!allowFlatKeys && !key.includes('.')) continue;
      inferredKeys.add(key);
    }
  }

  for (const inferred of inferredKeys) {
    usedKeys.add(inferred);
  }

  return { usedKeys, dynamicPrefixes };
}

function shouldAllowDynamic(key, prefixes) {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

function loadLocaleObject(localePath) {
  const text = fs.readFileSync(localePath, 'utf8');
  return JSON.parse(text);
}

function looksLikeHumanText(text) {
  const candidate = text.trim();
  if (candidate.length < 2) return false;
   if (LANGUAGE_SELF_NAMES.has(candidate)) return false;
  if (URL_PATTERN.test(candidate)) return false;
  if (FILE_LIKE_PATTERN.test(candidate)) return false;
  if (candidate.includes('/') && !candidate.includes(' ')) return false;
  if (DURATION_LIKE_PATTERN.test(candidate)) return false;
  if (I18N_KEY_LIKE_PATTERN.test(candidate)) return false;
  if (NON_TRANSLATABLE_TERMS.has(candidate.toLowerCase())) return false;
  if (CSS_VAR_PATTERN.test(candidate)) return false;
  if (SLASH_COMMAND_PATTERN.test(candidate)) return false;
  if (IDENTIFIER_TOKEN_PATTERN.test(candidate)) return false;
  if (SHELL_COMMAND_PATTERN.test(candidate)) return false;
  if (ONLY_SYMBOLS_PATTERN.test(candidate)) return false;
  if (candidate.includes('${')) return false;
  return /[A-Za-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(candidate);
}

function shouldIgnoreLiteral(line, propName, literal) {
  if (line.includes('// i18n-scan-ignore')) return true;
  if (I18N_CALL_PATTERN.test(line)) return true;
  if (line.includes('className=') && propName === 'className') return true;
  if (propName && !USER_VISIBLE_PROPS.has(propName)) return true;
  if (!propName && CODE_FRAGMENT_PATTERN.test(literal)) return true;
  if (!propName && /^[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*$/.test(literal) && NON_TRANSLATABLE_TERMS.has(literal.toLowerCase())) return true;
  if (!looksLikeHumanText(literal)) return true;
  return false;
}

function scanLine(line, lineNumber) {
  const hits = [];
  const hasJsxHint = line.includes('<') && line.includes('>');

  if (hasJsxHint) {
    JSX_TEXT_PATTERN.lastIndex = 0;
    let jsxMatch;
    while ((jsxMatch = JSX_TEXT_PATTERN.exec(line)) !== null) {
      const text = String(jsxMatch[1] ?? '').trim();
      if (text.startsWith('{') || text.endsWith('}')) continue;
      if (!line.includes('</') && !line.includes('/>')) continue;
      if (shouldIgnoreLiteral(line, null, text)) continue;
      hits.push({ lineNumber, reason: 'jsx-text', text });
    }
  }

  for (const [pattern, reason] of [
    [PROP_LITERAL_PATTERN, 'prop-literal'],
    [OBJECT_LITERAL_PATTERN, 'object-literal'],
  ]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const propName = String(match[1] ?? '');
      const literal = String(match[3] ?? '').trim();
      if (reason === 'object-literal' && !USER_VISIBLE_OBJECT_KEYS.has(propName)) continue;
      if (shouldIgnoreLiteral(line, propName, literal)) continue;
      hits.push({ lineNumber, reason, text: literal });
    }
  }

  for (const [pattern, reason] of [
    [TOAST_LITERAL_PATTERN, 'toast-literal'],
    [ADD_OPERATION_LOG_LITERAL_PATTERN, 'call-literal'],
    [UPDATE_LAST_LOG_LITERAL_PATTERN, 'call-literal'],
  ]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const literal = String(match[2] ?? '').trim();
      if (shouldIgnoreLiteral(line, 'message', literal)) continue;
      hits.push({ lineNumber, reason, text: literal });
    }
  }

  return hits;
}

function scanMultilineJsx(content) {
  const hits = [];
  JSX_MULTILINE_TEXT_PATTERN.lastIndex = 0;
  let match;
  while ((match = JSX_MULTILINE_TEXT_PATTERN.exec(content)) !== null) {
    const block = String(match[0] ?? '');
    const text = String(match[2] ?? '').trim();
    if (shouldIgnoreLiteral(block, null, text)) continue;
    const slice = content.slice(0, match.index);
    const lineNumber = slice.split('\n').length;
    hits.push({ lineNumber, reason: 'jsx-text-multiline', text });
  }
  return hits;
}

function scanFileForGaps(filePath) {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const astHits = scanFileForGapsAst(filePath, content);
  const hits = [];
  const seen = new Set();
  let inJsdoc = false;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const stripped = line.trim();
    if (!stripped || stripped.startsWith('//')) continue;
    if (stripped.startsWith('/**')) {
      inJsdoc = true;
      continue;
    }
    if (stripped.endsWith('*/')) {
      inJsdoc = false;
      continue;
    }
    if (inJsdoc || stripped.startsWith('*')) continue;

    for (const hit of scanLine(line, i + 1)) {
      const key = `${hit.lineNumber}|${hit.reason}|${hit.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
    }
  }

  for (const hit of scanMultilineJsx(content)) {
    const key = `${hit.lineNumber}|${hit.reason}|${hit.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(hit);
  }

  for (const hit of astHits) {
    const key = `${hit.lineNumber}|${hit.reason}|${hit.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(hit);
  }

  return hits.sort((a, b) => a.lineNumber - b.lineNumber || a.reason.localeCompare(b.reason) || a.text.localeCompare(b.text));
}

function removeUnusedKeys(node, prefix, keepKeys, keepPrefixes, removed) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return { next: node, keep: true };
  }

  const out = {};
  let hasAny = false;

  for (const [k, v] of Object.entries(node)) {
    const full = prefix ? `${prefix}.${k}` : k;
    const keepByPrefix = keepPrefixes.some((p) => full.startsWith(p));
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = removeUnusedKeys(v, full, keepKeys, keepPrefixes, removed);
      if (nested.keep || keepByPrefix) {
        out[k] = nested.next;
        hasAny = true;
      } else {
        removed.push(full);
      }
      continue;
    }
    let keepByPlural = false;
    const pluralSep = full.lastIndexOf('_');
    if (pluralSep > 0) {
      const suffix = full.slice(pluralSep + 1);
      if (PLURAL_SUFFIXES.has(suffix)) {
        const baseKey = full.slice(0, pluralSep);
        keepByPlural = keepKeys.has(baseKey);
      }
    }

    if (keepByPrefix || keepByPlural || keepKeys.has(full)) {
      out[k] = v;
      hasAny = true;
    } else {
      removed.push(full);
    }
  }

  return { next: out, keep: hasAny };
}

function buildSourceCorpus(sourceRoot) {
  const files = walkFiles(sourceRoot, SUPPORTED_SOURCE_EXTENSIONS);
  const chunks = [];
  for (const filePath of files) {
    try {
      chunks.push(fs.readFileSync(filePath, 'utf8'));
    } catch {
      // Skip unreadable files.
    }
  }
  return chunks.join('\n');
}

function printUsage() {
  console.log('Usage: node scripts/i18n-tools.mjs <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  check-keys   Check t(...) keys against locale JSON files');
  console.log('  scan-gaps    Scan UI JSX literals that may miss i18n');
  console.log('  clean-unused Remove locale keys unused by t(...)');
}

function runWithBanner(commandName, runner, flags) {
  console.log(`\n=== Running: ${commandName} ===`);
  return runner(flags);
}

function aggregateExitCode(current, next) {
  if (current === 2 || next === 2) return 2;
  if (current !== 0 || next !== 0) return 1;
  return 0;
}

function runCheckKeys(flags) {
  const sourceRoot = path.resolve(flagValue(flags, 'source-root', DEFAULT_SOURCE_ROOT));
  const localeArgs = flagValues(flags, 'locale').map((v) => String(v));
  const localePaths = (localeArgs.length > 0 ? localeArgs : DEFAULT_LOCALES).map((p) => path.resolve(p));
  const allowDynamicPrefix = flagValues(flags, 'allow-dynamic-prefix').map((v) => String(v));
  const allowFlatKeys = hasFlag(flags, 'allow-flat-keys');

  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    console.error(`[ERROR] source 根目录不存在: ${sourceRoot}`);
    return 2;
  }

  const localeKeyMap = new Map();
  try {
    for (const localePath of localePaths) {
      if (!fs.existsSync(localePath)) {
        console.error(`[ERROR] locale 文件不存在: ${localePath}`);
        return 2;
      }
      const localeObj = loadLocaleObject(localePath);
      localeKeyMap.set(localePath, flattenLocaleKeys(localeObj));
    }
  } catch (error) {
    console.error(`[ERROR] locale 解析失败: ${String(error)}`);
    return 2;
  }

  const usageData = collectUsages(sourceRoot);
  const usages = usageData.usages;
  const inferredReferences = collectI18nReferences(sourceRoot, allowFlatKeys);
  const detectedDynamicPrefixes = [...new Set([
    ...allowDynamicPrefix,
    ...usageData.dynamicPrefixes,
    ...inferredReferences.dynamicPrefixes,
  ])];
  const missingByLocale = new Map(localePaths.map((lp) => [lp, []]));

  for (const usage of usages) {
    if (!allowFlatKeys && !usage.key.includes('.')) continue;
    if (shouldAllowDynamic(usage.key, detectedDynamicPrefixes)) continue;
    for (const [localePath, keys] of localeKeyMap.entries()) {
      if (!keys.has(usage.key)) {
        missingByLocale.get(localePath).push(usage);
      }
    }
  }

  const totalMissing = Array.from(missingByLocale.values()).reduce((sum, items) => sum + items.length, 0);
  if (totalMissing === 0) {
    console.log(`OK: 未发现缺失 i18n keys。已检查 locale: ${localePaths.map(cwdRel).join(', ')}`);
    if (detectedDynamicPrefixes.length > 0) {
      console.log(`检测到动态 i18n 前缀: ${detectedDynamicPrefixes.sort().join(', ')}`);
    }
    return 0;
  }

  console.log('========================================================================');
  console.log('发现缺失 i18n keys');
  console.log('========================================================================');
  for (const localePath of localePaths) {
    const items = missingByLocale.get(localePath);
    const unique = [...new Set(items.map((i) => i.key))].sort();
    console.log(`\nLocale: ${cwdRel(localePath)}`);
    console.log(`缺失 key 数量: ${unique.length} (引用次数: ${items.length})`);
    for (const key of unique) {
      const first = items.find((i) => i.key === key);
      console.log(`  - ${key}  (${cwdRel(first.filePath)}:${first.lineNumber})`);
    }
  }
  if (detectedDynamicPrefixes.length > 0) {
    console.log(`\n动态 i18n 前缀: ${detectedDynamicPrefixes.sort().join(', ')}`);
  }
  return 1;
}

function runScanGaps(flags) {
  const root = path.resolve(flagValue(flags, 'root', DEFAULT_GAP_SCAN_ROOT));
  const maxHitsPerFile = Number(flagValue(flags, 'max-hits-per-file', '20'));

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`[ERROR] 扫描根目录不存在: ${root}`);
    return 2;
  }

  const files = walkFiles(root, SUPPORTED_GAP_SCAN_EXTENSIONS);
  const findings = new Map();
  for (const filePath of files) {
    const relParts = path.relative(root, filePath).split(path.sep);
    if (relParts.some((p) => DEFAULT_EXCLUDE_DIRS.has(p))) continue;
    const hits = scanFileForGaps(filePath);
    if (hits.length > 0) {
      findings.set(filePath, hits);
    }
  }

  if (findings.size === 0) {
    console.log('未发现疑似未做 i18n 处理的 UI 文件。');
    return 0;
  }

  console.log('============================================================');
  console.log('发现疑似未做 i18n 处理的文件');
  console.log('============================================================');

  let totalHits = 0;
  for (const filePath of [...findings.keys()].sort()) {
    const hits = findings.get(filePath);
    totalHits += hits.length;
    console.log(`\n📄 ${cwdRel(filePath)}`);
    console.log(`   共 ${hits.length} 处`);
    console.log('----------------------------------------');
    for (const hit of hits.slice(0, maxHitsPerFile)) {
      const display = hit.text.length > 60 ? `${hit.text.slice(0, 57)}...` : hit.text;
      console.log(`   L${String(hit.lineNumber).padEnd(5, ' ')} [${hit.reason}] "${display}"`);
    }
    if (hits.length > maxHitsPerFile) {
      console.log(`   ... 还有 ${hits.length - maxHitsPerFile} 处未显示 (使用 --max-hits-per-file 调整)`);
    }
  }

  console.log('\n============================================================');
  console.log(`总计: ${findings.size} 个文件, ${totalHits} 处疑似问题`);
  console.log('============================================================');
  return 1;
}

function runCleanUnused(flags) {
  const sourceRoot = path.resolve(flagValue(flags, 'source-root', DEFAULT_SOURCE_ROOT));
  const localeArgs = flagValues(flags, 'locale').map((v) => String(v));
  const localePaths = (localeArgs.length > 0 ? localeArgs : DEFAULT_LOCALES).map((p) => path.resolve(p));
  const allowDynamicPrefix = flagValues(flags, 'allow-dynamic-prefix').map((v) => String(v));
  const allowFlatKeys = hasFlag(flags, 'allow-flat-keys');
  const write = hasFlag(flags, 'write');

  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    console.error(`[ERROR] source 根目录不存在: ${sourceRoot}`);
    return 2;
  }

  const references = collectI18nReferences(sourceRoot, allowFlatKeys);
  const usedKeys = references.usedKeys;
  const keepPrefixes = [...new Set([...allowDynamicPrefix, ...references.dynamicPrefixes])];

  let totalRemoved = 0;
  for (const localePath of localePaths) {
    if (!fs.existsSync(localePath)) {
      console.error(`[ERROR] locale 文件不存在: ${localePath}`);
      return 2;
    }
    let localeObject;
    try {
      localeObject = loadLocaleObject(localePath);
    } catch (error) {
      console.error(`[ERROR] locale 解析失败: ${localePath}: ${String(error)}`);
      return 2;
    }

    const removed = [];
    const result = removeUnusedKeys(localeObject, '', usedKeys, keepPrefixes, removed);
    const uniqueRemoved = [...new Set(removed)].sort();
    totalRemoved += uniqueRemoved.length;

    console.log(`\nLocale: ${cwdRel(localePath)}`);
    if (uniqueRemoved.length === 0) {
      console.log('  - 未发现可清理 key');
      continue;
    }
    console.log(`  - 可清理 key: ${uniqueRemoved.length}`);
    for (const key of uniqueRemoved.slice(0, 80)) {
      console.log(`    * ${key}`);
    }
    if (uniqueRemoved.length > 80) {
      console.log(`    ... 还有 ${uniqueRemoved.length - 80} 个`);
    }

    if (write) {
      fs.writeFileSync(localePath, `${JSON.stringify(result.next, null, 2)}\n`, 'utf8');
      console.log('  - 已写入清理结果');
    } else {
      console.log('  - 预览模式（未写入），加 --write 执行清理');
    }
  }

  if (totalRemoved === 0) {
    console.log('\nOK: 未发现无用 key。');
    return 0;
  }

  if (write) {
    console.log(`\n完成: 已清理 ${totalRemoved} 个无用 key。`);
    return 0;
  }
  console.log(`\n检测到 ${totalRemoved} 个可清理 key（当前为预览模式）。`);
  return 1;
}

export {
  collectI18nReferences,
  looksLikeHumanText,
  removeUnusedKeys,
  runCheckKeys,
  scanFileForGaps,
  scanFileForGapsAst,
  runScanGaps,
};

function main() {
  const { positional, flags } = parseArgv(process.argv.slice(2));
  const command = positional[0];
  if (command === 'help' || command === '--help') {
    printUsage();
    return 0;
  }

  if (!command) {
    let code = 0;
    for (const [name, runner] of [
      ['scan-gaps', runScanGaps],
      ['clean-unused', runCleanUnused],
      ['check-keys', runCheckKeys],
    ]) {
      const next = runWithBanner(name, runner, flags);
      code = aggregateExitCode(code, next);
    }
    return code;
  }

  if (command === 'check-keys') return runWithBanner(command, runCheckKeys, flags);
  if (command === 'scan-gaps') return runWithBanner(command, runScanGaps, flags);
  if (command === 'clean-unused') return runWithBanner(command, runCleanUnused, flags);

  console.error(`[ERROR] Unknown command: ${command}`);
  printUsage();
  return 2;
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exit(main());
}
