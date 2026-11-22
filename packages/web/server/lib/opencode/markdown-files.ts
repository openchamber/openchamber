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

// Agent/command/skill/loop markdown is project/clone-controlled content;
// nothing bounds its on-disk size, so never buffer one whole past this cap
// (same 4 MiB precedent as SKILL_MD_MAX_BYTES in skills-catalog/scan.js).
const MD_FILE_MAX_BYTES = 4 * 1024 * 1024;

const mdFileTooLargeError = (filePath: string) => Object.assign(
  new Error(`Markdown file exceeds the ${MD_FILE_MAX_BYTES}-byte size limit: ${filePath}`),
  { code: 'ERR_MD_FILE_TOO_LARGE' },
);

// Read at most MD_FILE_MAX_BYTES from an already-open handle: stat-then-read
// by path would follow a symlink to a device/FIFO and a file swapped or grown
// between the two calls would escape the gate. O_NONBLOCK (POSIX only) keeps
// open() itself from blocking on a FIFO before the regular-file check runs.
const mdFileOpenFlags = () =>
  process.platform === 'win32'
    ? fs.constants.O_RDONLY
    : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;

function readMdFileSync(filePath: string) {
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

async function readMdFileAsync(filePath: string) {
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

function parseMdFile(filePath: string) {
  return parseMdContent(readMdFileSync(filePath), filePath);
}

async function parseMdFileAsync(filePath: string) {
  return parseMdContent(await readMdFileAsync(filePath), filePath);
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

const serializeMdContent = <Frontmatter extends object, Body>(frontmatter: Frontmatter, body: Body) => {
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
function assertMdFileWithinCap<Frontmatter extends object, Body>(filePath: string, frontmatter: Frontmatter, body: Body) {
  if (Buffer.byteLength(serializeMdContent(frontmatter, body), 'utf8') > MD_FILE_MAX_BYTES) {
    throw mdFileTooLargeError(filePath);
  }
}

// `flag: 'wx'` creates the file and fails with EEXIST when it is already
// there; that error is passed on as is so a caller can tell it apart.
function writeMdFile<Frontmatter extends object, Body>(filePath: string, frontmatter: Frontmatter, body: Body, { flag = 'w' }: { flag?: string } = {}) {
  try {
    const content = serializeMdContent(frontmatter, body);
    assertMdFileWithinCap(filePath, frontmatter, body);
    if (flag === 'wx') {
      fs.writeFileSync(filePath, content, { encoding: 'utf8', flag });
    } else {
      writeFileAtomic(filePath, content);
    }
    console.log(`Successfully wrote markdown file: ${filePath}`);
  } catch (error) {
    if (hasErrorCode(error) && error.code === 'EEXIST') throw error;
    if (hasErrorCode(error) && error.code === 'ERR_MD_FILE_TOO_LARGE') throw error;
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
  MD_FILE_MAX_BYTES,
  writeMdFile,
  assertMdFileWithinCap,
  isPromptFileReference,
  resolvePromptFilePath,
  writePromptFile
};
