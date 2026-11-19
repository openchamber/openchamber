import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { writeFileAtomic } from './atomic-write.js';
import { OPENCODE_CONFIG_DIR } from './config-files.js';
import { isString } from '../shared/object-guards.js';

export interface MarkdownDocument {
  frontmatter: unknown;
  body: string;
}

const hasErrorCode = (value: unknown): value is { code?: unknown } => value != null;

const PROMPT_FILE_PATTERN = /^\{file:(.+)\}$/i;

function sanitizeFrontmatter(frontmatter: string) {
  return frontmatter
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.trim().startsWith('#') || line.trim() === '' || /^\s+/.test(line)) return [line];
      const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (!entry) return [line];
      const [, key, rawValue = ''] = entry;
      const value = rawValue.trim();
      if (value === '' || value === '>' || value === '|' || value.startsWith('"') || value.startsWith("'")) return [line];
      if (!value.includes(':')) return [line];
      return [`${key}: |-`, `  ${value}`];
    })
    .join('\n');
}

function parseMdFile(filePath: string) {
  return parseMdContent(fs.readFileSync(filePath, 'utf8'), filePath);
}

async function parseMdFileAsync(filePath: string) {
  return parseMdContent(await fs.promises.readFile(filePath, 'utf8'), filePath);
}

function parseMdContent(rawContent: string, filePath: string): MarkdownDocument {
  const content = rawContent.charCodeAt(0) === 0xfeff ? rawContent.slice(1) : rawContent;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);

  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  const [, rawFrontmatter = '', rawBody = ''] = match;
  let frontmatter: MarkdownDocument['frontmatter'] = {};
  try {
    frontmatter = yaml.parse(rawFrontmatter) || {};
  } catch (error) {
    try {
      frontmatter = yaml.parse(sanitizeFrontmatter(rawFrontmatter)) || {};
    } catch {
      console.warn(`Failed to parse markdown frontmatter ${filePath}, treating as empty:`, error);
      frontmatter = {};
    }
  }

  const body = rawBody.trim();
  return { frontmatter, body };
}

function writeMdFile<Frontmatter extends object, Body>(filePath: string, frontmatter: Frontmatter, body: Body, { flag = 'w' }: { flag?: string } = {}) {
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
    if (hasErrorCode(error) && error.code === 'EEXIST') throw error;
    console.error(`Failed to write markdown file ${filePath}:`, error);
    throw new Error('Failed to write agent markdown file');
  }
}

function isPromptFileReference(value: unknown): value is string {
  if (!isString(value)) {
    return false;
  }
  return PROMPT_FILE_PATTERN.test(value.trim());
}

function resolvePromptFilePath<Reference>(reference: Reference) {
  const match = isString(reference) ? reference.trim().match(PROMPT_FILE_PATTERN) : null;
  if (!match) {
    return null;
  }
  const [, rawTarget = ''] = match;
  let target = rawTarget.trim();
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

function writePromptFile(filePath: string, content?: string | null) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content ?? '', 'utf8');
  console.log(`Updated prompt file: ${filePath}`);
}

export {
  parseMdFile,
  parseMdFileAsync,
  writeMdFile,
  isPromptFileReference,
  resolvePromptFilePath,
  writePromptFile
};
