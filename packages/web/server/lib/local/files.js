import fs from 'fs';
import path from 'path';
import { isString } from '../shared/guards.js';

// The six fixed issue states (`stateId` equals the category). Custom states are
// a later milestone and never produced by the writer.
export const STATES = ['triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled'];

export const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

export const ISSUE_FILE_PATTERN = /^LOCAL-(\d{1,6})-([a-z0-9-]*)\.md$/;

const COMMENTS_HEADING = '## Comments';
const COMMENT_HEADING_SEPARATOR = ' · ';
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const SLUG_MAX_LENGTH = 60;

// User-facing errors (bad file name, malformed frontmatter, identifier
// mismatch). Callers distinguish them from I/O failures via `userError`.
export class LocalIssueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalIssueError';
    this.userError = true;
  }
}

export function sanitizeSlug(input) {
  let slug = String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    slug = 'issue';
  }
  if (WINDOWS_RESERVED_NAME.test(slug)) {
    slug = `issue-${slug}`;
  }
  slug = slug.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '');
  return slug || 'issue';
}

export function issueFileName(number, slug) {
  return `LOCAL-${number}-${slug}.md`;
}

export function normalizeSource(raw) {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function unquote(value) {
  if (value.length >= 2
    && ((value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('"') && value.endsWith('"')))) {
    return value.slice(1, -1);
  }
  return value;
}

// Hand-written YAML subset (zero dependencies): `null` literal, `[a, b]`
// string arrays, and otherwise plain or quoted strings.
function parseFrontmatterValue(raw) {
  const value = raw.trim();
  if (value === 'null') {
    return null;
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner.split(',').map((item) => unquote(item.trim())).filter((item) => item.length > 0);
  }
  return unquote(value);
}

function serializeFrontmatterValue(value) {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.join(', ')}]`;
  }
  // Quote strings that would otherwise reparse as a different type (the
  // `null` literal or a `[...]` array); the parser strips the surrounding
  // quotes on read. Quote characters inside the value are not escaped —
  // out of scope for this minimal wrapper.
  if (isString(value) && (value === 'null' || (value.startsWith('[') && value.endsWith(']')))) {
    return `"${value}"`;
  }
  return value;
}

export function parseIssueFile(raw, fileName) {
  const match = ISSUE_FILE_PATTERN.exec(fileName);
  if (!match) {
    throw new LocalIssueError(`Invalid issue file name: ${fileName}`);
  }
  const number = Number.parseInt(match[1], 10);
  const slug = match[2];
  const identifier = `LOCAL-${number}`;

  const source = normalizeSource(raw);
  const lines = source.split('\n');
  if (lines[0] !== '---') {
    throw new LocalIssueError(`${fileName}: missing frontmatter block`);
  }
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    throw new LocalIssueError(`${fileName}: unterminated frontmatter block`);
  }

  const fields = [];
  for (let i = 1; i < closeIndex; i++) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new LocalIssueError(`${fileName}: malformed frontmatter line: ${line}`);
    }
    const key = line.slice(0, separator).trim();
    if (!key) {
      throw new LocalIssueError(`${fileName}: malformed frontmatter line: ${line}`);
    }
    fields.push([key, parseFrontmatterValue(line.slice(separator + 1))]);
  }

  const identifierField = fields.find(([key]) => key === 'identifier');
  const frontmatterIdentifier = identifierField && isString(identifierField[1])
    ? identifierField[1]
    : null;
  if (frontmatterIdentifier !== identifier) {
    throw new LocalIssueError(
      `${fileName}: frontmatter identifier ${frontmatterIdentifier ?? '(missing)'} does not match file name (${identifier})`,
    );
  }

  const body = lines.slice(closeIndex + 1).join('\n');
  return { fileName, number, slug, identifier, fields, body };
}

export function serializeIssue(issue) {
  const frontmatter = issue.fields
    .map(([key, value]) => `${key}: ${serializeFrontmatterValue(value)}`)
    .join('\n');
  return `---\n${frontmatter}\n---\n${issue.body}`;
}

// Updates existing keys at their position, appends new keys, and removes keys
// set to `null`. Returns a new issue; the input is not mutated.
export function setFields(issue, patch) {
  const fields = issue.fields.map(([key, value]) => [key, value]);
  for (const [key, value] of Object.entries(patch)) {
    const index = fields.findIndex(([existing]) => existing === key);
    if (value === null) {
      if (index !== -1) {
        fields.splice(index, 1);
      }
      continue;
    }
    if (index !== -1) {
      fields[index] = [key, value];
    } else {
      fields.push([key, value]);
    }
  }
  return { ...issue, fields };
}

function setUpdatedAt(fields, iso) {
  const index = fields.findIndex(([key]) => key === 'updatedAt');
  if (index !== -1) {
    const next = [...fields];
    next[index] = ['updatedAt', iso];
    return next;
  }
  const createdAt = fields.findIndex(([key]) => key === 'createdAt');
  const next = [...fields];
  if (createdAt !== -1) {
    next.splice(createdAt + 1, 0, ['updatedAt', iso]);
  } else {
    next.push(['updatedAt', iso]);
  }
  return next;
}

export function splitComments(body) {
  const lines = body.split('\n');
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === COMMENTS_HEADING) {
      sectionStart = i;
      break;
    }
  }
  if (sectionStart === -1) {
    return { head: body, comments: [] };
  }
  const head = lines.slice(0, sectionStart).join('\n');
  const comments = [];
  let current = null;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('### ')) {
      if (current) {
        comments.push(current);
      }
      const entry = line.slice(4);
      const separator = entry.indexOf(COMMENT_HEADING_SEPARATOR);
      // A heading without the `<iso> · <source>` shape is mangled content;
      // skip it instead of failing the whole section.
      current = separator === -1
        ? null
        : { iso: entry.slice(0, separator), source: entry.slice(separator + COMMENT_HEADING_SEPARATOR.length), text: '' };
      continue;
    }
    if (current && line.trim()) {
      current.text = current.text ? `${current.text}\n${line}` : line;
    }
  }
  if (current) {
    comments.push(current);
  }
  return { head, comments };
}

// Rebuilds the `## Comments` section in normalized form and appends the new
// entry. Unparseable leftovers of a mangled section are dropped on rewrite;
// everything above the section (head) is preserved verbatim.
export function appendComment(issue, { iso, source, text }) {
  const { head, comments } = splitComments(issue.body);
  let section = `${COMMENTS_HEADING}\n`;
  for (const entry of [...comments, { iso, source, text }]) {
    section += `\n### ${entry.iso} · ${entry.source}\n\n${entry.text}\n`;
  }
  const normalizedHead = head === '' || head.endsWith('\n') ? head : `${head}\n`;
  return {
    ...issue,
    fields: setUpdatedAt(issue.fields, iso),
    body: `${normalizedHead}${section}`,
  };
}

export function readIssue(dirPath, fileName) {
  const filePath = path.join(dirPath, fileName);
  try {
    return parseIssueFile(fs.readFileSync(filePath, 'utf8'), fileName);
  } catch (error) {
    console.warn(`Skipping issue file ${filePath}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export function writeIssue(dirPath, issue) {
  const filePath = path.join(dirPath, issue.fileName);
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, serializeIssue(issue), 'utf8');
  fs.renameSync(tmpFile, filePath);
}
