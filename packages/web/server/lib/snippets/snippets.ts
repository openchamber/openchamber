import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { OPENCODE_CONFIG_DIR } from '../opencode/config-files.js';
import { isString } from '../shared/object-guards.js';

export type SnippetScope = 'global' | 'project';

export interface Snippet {
  name: string;
  content: string;
  aliases: string[];
  description: string | undefined;
  filePath: string;
  source: SnippetScope;
}

export interface SnippetConfig {
  content?: string | null;
  aliases?: unknown[];
  description?: string | undefined;
}

export interface SnippetUpdates extends SnippetConfig {
  name?: unknown;
  scope?: unknown;
}

interface SnippetBlocks {
  prepend: string[];
  append: string[];
}

interface SnippetFrontmatter {
  aliases?: unknown;
  alias?: unknown;
  description?: unknown;
}

interface WritableFrontmatter {
  aliases?: string[];
  description?: string;
}

const GLOBAL_SNIPPET_DIR = path.join(OPENCODE_CONFIG_DIR, 'snippet');
const GLOBAL_SNIPPET_DIR_ALT = path.join(OPENCODE_CONFIG_DIR, 'snippets');
const SNIPPET_EXTENSION = '.md';
const SNIPPET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const HASHTAG_PATTERN = /#([a-z0-9_-]+)/gi;
const MAX_EXPANSION_COUNT = 15;

function getProjectSnippetDirs(workingDirectory?: string | null) {
  if (!workingDirectory) return [];
  return [
    path.join(workingDirectory, '.opencode', 'snippets'),
    path.join(workingDirectory, '.opencode', 'snippet'),
  ];
}

function getGlobalSnippetDirs() {
  return [GLOBAL_SNIPPET_DIR_ALT, GLOBAL_SNIPPET_DIR];
}

function getLoadDirs(workingDirectory?: string | null) {
  return [
    ...getGlobalSnippetDirs().map((dir) => ({ dir, source: 'global' as const })),
    ...getProjectSnippetDirs(workingDirectory).map((dir) => ({ dir, source: 'project' as const })),
  ];
}

function assertValidSnippetName(name: string) {
  if (!isString(name) || !SNIPPET_NAME_PATTERN.test(name)) {
    throw new Error('Snippet name must use letters, numbers, dashes, or underscores');
  }
}

function parseMarkdownFile(filePath: string) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match || match[1] === undefined || match[2] === undefined) {
    return { frontmatter: {}, body: content.trim() };
  }
  const frontmatter: SnippetFrontmatter = Object(yaml.parse(match[1]) || {});
  return {
    frontmatter,
    body: match[2].trim(),
  };
}

function normalizeAliases(frontmatter: SnippetFrontmatter) {
  const raw = frontmatter.aliases ?? frontmatter.alias;
  if (!raw) return [];
  const aliases: unknown[] = Array.isArray(raw) ? raw : [raw];
  return aliases.map((alias) => String(alias).trim()).filter(Boolean);
}

function writeMarkdownFile(filePath: string, { content, aliases = [], description }: SnippetConfig) {
  const frontmatter: WritableFrontmatter = {};
  const normalizedAliases = aliases.map((alias) => String(alias).trim()).filter(Boolean);
  if (normalizedAliases.length > 0) frontmatter.aliases = normalizedAliases;
  if (description?.trim()) frontmatter.description = description.trim();

  const body = content ?? '';
  const output = Object.keys(frontmatter).length > 0
    ? `---\n${yaml.stringify(frontmatter)}---\n${body ? `\n${body}` : ''}`
    : body;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, output, 'utf8');
}

function loadSnippetFile(dir: string, filename: string, source: SnippetScope): Snippet | null {
  const name = path.basename(filename, SNIPPET_EXTENSION);
  if (!SNIPPET_NAME_PATTERN.test(name)) return null;
  const filePath = path.join(dir, filename);
  const { frontmatter, body } = parseMarkdownFile(filePath);
  return {
    name,
    content: body,
    aliases: normalizeAliases(frontmatter),
    description: isString(frontmatter.description) ? frontmatter.description : undefined,
    filePath,
    source,
  };
}

function removeSnippetAliases(registry: Map<string, Snippet>, snippet: Snippet, canonicalNames: Set<string>) {
  for (const alias of snippet.aliases) {
    const aliasKey = alias.toLowerCase();
    if (canonicalNames.has(aliasKey)) continue;
    if (registry.get(aliasKey) === snippet) registry.delete(aliasKey);
  }
}

function registerSnippet(registry: Map<string, Snippet>, snippet: Snippet, canonicalNames: Set<string>) {
  const key = snippet.name.toLowerCase();
  const existing = registry.get(key);
  if (existing?.name.toLowerCase() === key) {
    removeSnippetAliases(registry, existing, canonicalNames);
  }
  registry.set(key, snippet);
  canonicalNames.add(key);
  for (const alias of snippet.aliases) {
    const aliasKey = alias.toLowerCase();
    if (SNIPPET_NAME_PATTERN.test(alias) && !canonicalNames.has(aliasKey)) registry.set(aliasKey, snippet);
  }
}

function loadSnippetRegistry(workingDirectory?: string | null) {
  const registry = new Map<string, Snippet>();
  const canonicalNames = new Set<string>();
  for (const { dir, source } of getLoadDirs(workingDirectory)) {
    if (!fs.existsSync(dir)) continue;
    for (const filename of fs.readdirSync(dir)) {
      if (!filename.endsWith(SNIPPET_EXTENSION)) continue;
      try {
        const snippet = loadSnippetFile(dir, filename, source);
        if (snippet) registerSnippet(registry, snippet, canonicalNames);
      } catch (error) {
        console.warn(`[Snippets] Failed to load ${path.join(dir, filename)}:`, error);
      }
    }
  }
  return registry;
}

function listUniqueSnippets(registry: Map<string, Snippet>) {
  const seen = new Set<string>();
  const snippets = [];
  for (const snippet of registry.values()) {
    const key = `${snippet.source}:${snippet.filePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    snippets.push(snippet);
  }
  return snippets.sort((a, b) => a.name.localeCompare(b.name));
}

function getWritableSnippetDir(scope: string, workingDirectory?: string | null) {
  if (scope === 'project') {
    if (!workingDirectory) throw new Error('Project directory is required for project snippets');
    const preferred = path.join(workingDirectory, '.opencode', 'snippet');
    const alternate = path.join(workingDirectory, '.opencode', 'snippets');
    return fs.existsSync(alternate) && !fs.existsSync(preferred) ? alternate : preferred;
  }
  return fs.existsSync(GLOBAL_SNIPPET_DIR_ALT) && !fs.existsSync(GLOBAL_SNIPPET_DIR)
    ? GLOBAL_SNIPPET_DIR_ALT
    : GLOBAL_SNIPPET_DIR;
}

function findSnippetByName(name: string, workingDirectory?: string | null) {
  assertValidSnippetName(name);
  const registry = loadSnippetRegistry(workingDirectory);
  return registry.get(name.toLowerCase()) ?? null;
}

function assertSnippetNameFree(name: string, registry: Map<string, Snippet>, owner: Snippet | null = null) {
  const current = registry.get(name.toLowerCase());
  if (current && current !== owner) throw new Error(`Snippet "${name}" already exists`);
}

function isSameFile(a: string, b: string) {
  const first = fs.statSync(a);
  const second = fs.statSync(b);
  return first.dev === second.dev && first.ino === second.ino;
}

function moveSnippetFile(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (!hasCrossDeviceCode(error)) throw error;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

function hasCrossDeviceCode(error: unknown): error is { code: 'EXDEV' } {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'EXDEV';
}

function parseSnippetBlocks(content: string) {
  const blocks: SnippetBlocks = { prepend: [], append: [] };
  let inline = content;
  for (const type of ['prepend', 'append'] as const) {
    const regex = new RegExp(`<${type}>([\\s\\S]*?)(?:<\\/${type}>|$)`, 'gi');
    inline = inline.replace(regex, (_match: string, value: string) => {
      const normalized = String(value).trim();
      if (normalized) blocks[type].push(normalized);
      return '';
    });
  }
  inline = inline.replace(/<inject>[\s\S]*?(?:<\/inject>|$)/gi, '').trim();
  return { inline, prepend: blocks.prepend, append: blocks.append };
}

function expandText(text: string, registry: Map<string, Snippet>, expansionCounts: Map<string, number>, collector: SnippetBlocks): string {
  let expanded = text;
  let changed = true;

  while (changed) {
    const previous = expanded;
    let loopDetected = false;
    HASHTAG_PATTERN.lastIndex = 0;

    expanded = expanded.replace(HASHTAG_PATTERN, (match: string, name: string, offset: number, input: string) => {
      if (name.toLowerCase() === 'skill' && input[offset + match.length] === '(') return match;
      const snippet = registry.get(name.toLowerCase());
      if (!snippet) return match;

      const key = snippet.name.toLowerCase();
      const count = (expansionCounts.get(key) || 0) + 1;
      if (count > MAX_EXPANSION_COUNT) {
        loopDetected = true;
        return match;
      }
      expansionCounts.set(key, count);

      const parsed = parseSnippetBlocks(snippet.content);
      for (const block of parsed.prepend) collector.prepend.push(expandText(block, registry, expansionCounts, collector));
      for (const block of parsed.append) collector.append.push(expandText(block, registry, expansionCounts, collector));
      return expandText(parsed.inline, registry, expansionCounts, collector);
    });

    changed = expanded !== previous && !loopDetected;
  }

  return expanded;
}

export function listSnippets(workingDirectory?: string | null) {
  return listUniqueSnippets(loadSnippetRegistry(workingDirectory));
}

export function getSnippet(name: string, workingDirectory?: string | null) {
  return findSnippetByName(name, workingDirectory);
}

export function createSnippet(name: string, config: SnippetConfig | null | undefined, workingDirectory?: string | null, scope = 'global') {
  assertValidSnippetName(name);
  assertSnippetNameFree(name, loadSnippetRegistry(workingDirectory));
  const dir = getWritableSnippetDir(scope, workingDirectory);
  const filePath = path.join(dir, `${name}${SNIPPET_EXTENSION}`);
  if (fs.existsSync(filePath)) throw new Error(`Snippet "${name}" already exists`);
  writeMarkdownFile(filePath, config || {});
  return getSnippet(name, workingDirectory);
}

export function updateSnippet(name: string, updates: SnippetUpdates | null | undefined, workingDirectory?: string | null) {
  assertValidSnippetName(name);
  const registry = loadSnippetRegistry(workingDirectory);
  const existing = registry.get(name.toLowerCase());
  if (!existing) throw new Error(`Snippet "${name}" not found`);
  const { name: nextNameInput, scope: nextScopeInput, ...fields } = updates || {};
  const nextName = String(nextNameInput ?? '').trim() || existing.name;
  const nextScope = nextScopeInput === 'project' || nextScopeInput === 'global' ? nextScopeInput : existing.source;
  assertValidSnippetName(nextName);

  const targetPath = nextName === existing.name && nextScope === existing.source
    ? existing.filePath
    : path.join(getWritableSnippetDir(nextScope, workingDirectory), `${nextName}${SNIPPET_EXTENSION}`);
  if (targetPath !== existing.filePath) {
    assertSnippetNameFree(nextName, registry, existing);
    if (fs.existsSync(targetPath) && !isSameFile(targetPath, existing.filePath)) {
      throw new Error(`Snippet "${nextName}" already exists`);
    }
  }

  writeMarkdownFile(existing.filePath, { ...existing, ...fields });
  if (targetPath !== existing.filePath) moveSnippetFile(existing.filePath, targetPath);
  return getSnippet(nextName, workingDirectory);
}

export function deleteSnippet(name: string, workingDirectory?: string | null) {
  const existing = findSnippetByName(name, workingDirectory);
  if (!existing) throw new Error(`Snippet "${name}" not found`);
  fs.unlinkSync(existing.filePath);
}

export function expandSnippets(text: string | null | undefined, workingDirectory?: string | null) {
  const registry = loadSnippetRegistry(workingDirectory);
  const collector: SnippetBlocks = { prepend: [], append: [] };
  const expanded = expandText(text || '', registry, new Map(), collector).trim();
  return [...collector.prepend, expanded, ...collector.append].filter(Boolean).join('\n\n');
}

export function previewSnippet(content: string | null | undefined, workingDirectory?: string | null) {
  const registry = loadSnippetRegistry(workingDirectory);
  const collector: SnippetBlocks = { prepend: [], append: [] };
  const counts = new Map<string, number>();
  const parsed = parseSnippetBlocks(content || '');
  for (const block of parsed.prepend) collector.prepend.push(expandText(block, registry, counts, collector));
  for (const block of parsed.append) collector.append.push(expandText(block, registry, counts, collector));
  const inline = expandText(parsed.inline, registry, counts, collector).trim();
  return [...collector.prepend, inline, ...collector.append].filter(Boolean).join('\n\n');
}
