import defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';

import { GUEST_FILE_CONTENT_MAX, GUEST_FILE_LIST_MAX, GUEST_FILE_PATH_MAX, guestFileScope } from '@openchamber/sdk';

/**
 * Guest file access. A relative path lives inside the open project and needs
 * the `files` grant. `/…` and `~/…` are outside the project, must match one
 * of the package's `contributes.filesystem` patterns, and need the
 * `filesystem` grant. Every comparison is made on canonical absolute paths so
 * a symlink cannot widen either scope.
 */

const failure = (code, message) => ({ ok: false, code, message });

const isGlobChar = (segment) => segment.includes('*') || segment.includes('?');

const escapeRegExp = (value) => value.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** Forward-slash form of a path so a glob written with `/` matches on every platform. */
const toPosix = (value, nodePath) => (nodePath.sep === '/' ? value : value.split(nodePath.sep).join('/'));

export const expandHome = (pattern, homeDir) => {
  if (pattern === '~') {
    return homeDir;
  }
  if (pattern.startsWith('~/')) {
    return `${homeDir.replace(/[\\/]+$/, '')}/${pattern.slice(2)}`;
  }
  return pattern;
};

/**
 * `**` spans any number of segments, `*` and `?` stay inside one segment. A
 * pattern that ends in `/**` also matches the directory itself, so a guest
 * may list the root it was granted.
 */
export const globToRegExp = (pattern) => {
  let source = '^';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      const afterSlash = index === 0 || pattern[index - 1] === '/';
      const beforeSlash = pattern[index + 2] === '/';
      const atEnd = index + 2 === pattern.length;
      if (afterSlash && beforeSlash) {
        source += '(?:.*/)?';
        index += 3;
        continue;
      }
      if (afterSlash && atEnd && source.endsWith('/')) {
        source = `${source.slice(0, -1)}(?:/.*)?`;
        index += 2;
        continue;
      }
      source += '.*';
      index += 2;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    source += escapeRegExp(char);
    index += 1;
  }
  return new RegExp(`${source}$`);
};

export const matchesFilesystemPattern = (canonicalPath, patterns, homeDir, nodePath = defaultPath) => {
  const candidate = toPosix(canonicalPath, nodePath);
  return patterns.some((pattern) => globToRegExp(expandHome(pattern, homeDir)).test(candidate));
};

/**
 * Realpath of the deepest existing ancestor plus the missing tail, so a path
 * that does not exist yet (a write) still resolves through the symlinks above
 * it. Permission errors propagate; the caller maps them to `DENIED`.
 */
const canonicalize = async (absolute, fsPromises, nodePath) => {
  let current = absolute;
  const tail = [];
  for (;;) {
    try {
      const real = await fsPromises.realpath(current);
      return tail.length > 0 ? nodePath.join(real, ...tail) : real;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw error;
      }
    }
    const parent = nodePath.dirname(current);
    if (parent === current) {
      return absolute;
    }
    tail.unshift(nodePath.basename(current));
    current = parent;
  }
};

/**
 * The literal prefix of a pattern (segments before the first glob) goes
 * through the same canonicalization as the candidate, so `/tmp/**` still
 * matches on a host where `/tmp` is a symlink to `/private/tmp`.
 */
const canonicalizePattern = async (pattern, homeDir, fsPromises, nodePath) => {
  const expanded = expandHome(pattern, homeDir);
  const segments = expanded.split('/');
  const firstGlob = segments.findIndex(isGlobChar);
  const literal = firstGlob === -1 ? segments : segments.slice(0, firstGlob);
  const rest = firstGlob === -1 ? [] : segments.slice(firstGlob);
  const literalPath = literal.join('/') || '/';
  const canonical = toPosix(await canonicalize(nodePath.resolve(literalPath), fsPromises, nodePath), nodePath);
  return rest.length > 0 ? `${canonical.replace(/\/+$/, '')}/${rest.join('/')}` : canonical;
};

const isInside = (candidate, root, nodePath) => (
  candidate === root || candidate.startsWith(root.endsWith(nodePath.sep) ? root : `${root}${nodePath.sep}`)
);

const hasDotDot = (value) => value.split('/').some((segment) => segment === '..');

export const resolveGuestFilePath = async ({
  path: rawPath,
  projectDirectory,
  patterns,
  homeDir,
  fsPromises = defaultFs,
  nodePath = defaultPath,
}) => {
  if (
    rawPath.length === 0
    || rawPath.length > GUEST_FILE_PATH_MAX
    || rawPath.includes('\0')
    || rawPath.includes('\\')
    || hasDotDot(rawPath)
  ) {
    return failure('BAD_PATH', 'File path is malformed or leaves its scope.');
  }
  if (guestFileScope(rawPath) === 'project') {
    if (!projectDirectory) {
      return failure('NO_DIRECTORY', 'No project is open.');
    }
    let projectReal;
    try {
      projectReal = await fsPromises.realpath(projectDirectory);
    } catch {
      return failure('NO_DIRECTORY', 'The open project directory is not available.');
    }
    const absolute = await canonicalize(nodePath.resolve(projectReal, rawPath), fsPromises, nodePath);
    if (!isInside(absolute, projectReal, nodePath)) {
      return failure('BAD_PATH', 'File path leaves the open project.');
    }
    return { ok: true, scope: 'project', absolute };
  }
  const absolute = await canonicalize(nodePath.resolve(expandHome(rawPath, homeDir)), fsPromises, nodePath);
  const canonicalPatterns = await Promise.all(
    (patterns ?? []).map((pattern) => canonicalizePattern(pattern, homeDir, fsPromises, nodePath)),
  );
  if (!matchesFilesystemPattern(absolute, canonicalPatterns, homeDir, nodePath)) {
    return failure('BAD_PATH', 'File path is not covered by a declared filesystem pattern.');
  }
  return { ok: true, scope: 'filesystem', absolute };
};

const entryKind = (dirent) => {
  if (dirent.isSymbolicLink()) return 'other';
  if (dirent.isFile()) return 'file';
  if (dirent.isDirectory()) return 'directory';
  return 'other';
};

const readOperation = async (absolute, fsPromises) => {
  const stat = await fsPromises.stat(absolute);
  if (stat.isDirectory()) {
    return failure('BAD_PATH', 'That path is a directory.');
  }
  if (stat.size > GUEST_FILE_CONTENT_MAX) {
    return failure('FILE_TOO_LARGE', `File is over ${GUEST_FILE_CONTENT_MAX} characters.`);
  }
  const content = await fsPromises.readFile(absolute, 'utf8');
  if (content.length > GUEST_FILE_CONTENT_MAX) {
    return failure('FILE_TOO_LARGE', `File is over ${GUEST_FILE_CONTENT_MAX} characters.`);
  }
  return { ok: true, result: { content } };
};

const writeOperation = async (absolute, content, fsPromises, nodePath) => {
  if (content === undefined || content === null) {
    return failure('BAD_PATH', 'Write needs content.');
  }
  if (content.length > GUEST_FILE_CONTENT_MAX) {
    return failure('FILE_TOO_LARGE', `Content is over ${GUEST_FILE_CONTENT_MAX} characters.`);
  }
  await fsPromises.mkdir(nodePath.dirname(absolute), { recursive: true });
  // Temp file plus rename: a concurrent reader never sees a truncated file.
  const tmp = `${absolute}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fsPromises.writeFile(tmp, content, 'utf8');
    await fsPromises.rename(tmp, absolute);
  } catch (error) {
    await fsPromises.unlink(tmp).catch(() => {});
    throw error;
  }
  return { ok: true, result: { written: true } };
};

const listOperation = async (absolute, fsPromises) => {
  const dirents = await fsPromises.readdir(absolute, { withFileTypes: true });
  const entries = dirents
    .map((dirent) => ({ name: dirent.name, kind: entryKind(dirent) }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .slice(0, GUEST_FILE_LIST_MAX);
  return { ok: true, result: { entries } };
};

const statOperation = async (absolute, fsPromises) => {
  let stat;
  try {
    stat = await fsPromises.stat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { ok: true, result: { kind: 'missing', size: 0, mtime: 0 } };
    }
    throw error;
  }
  const kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
  return { ok: true, result: { kind, size: stat.size, mtime: Math.floor(stat.mtimeMs) } };
};

const mapFsError = (error) => {
  const code = error?.code;
  if (code === 'ENOENT') {
    return failure('NOT_FOUND', 'No file at that path.');
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return failure('DENIED', 'The operating system refused access to that path.');
  }
  if (code === 'EISDIR' || code === 'ENOTDIR') {
    return failure('BAD_PATH', 'That path is not the right kind of entry for this operation.');
  }
  return null;
};

/**
 * One guest file call end to end: scope, grant, then the operation. Returns
 * `{ ok: true, result }` or `{ ok: false, code, message }`; only unexpected
 * OS errors throw.
 */
export const runGuestFileOperation = async ({
  op,
  path: rawPath,
  content,
  projectDirectory,
  patterns,
  grants,
  homeDir,
  fsPromises = defaultFs,
  nodePath = defaultPath,
}) => {
  // Grant first, from the raw path's scope, so an unapproved extension never
  // touches the disk (not even a realpath probe).
  const needed = guestFileScope(rawPath) === 'project' ? 'files' : 'filesystem';
  if (!(grants ?? []).includes(needed)) {
    return failure(
      'NOT_GRANTED',
      needed === 'files'
        ? 'This extension has not been allowed to read and write project files.'
        : 'This extension has not been allowed to read and write files outside the project.',
    );
  }
  let resolved;
  try {
    resolved = await resolveGuestFilePath({ path: rawPath, projectDirectory, patterns, homeDir, fsPromises, nodePath });
  } catch (error) {
    const mapped = mapFsError(error);
    if (mapped) return mapped;
    throw error;
  }
  if (!resolved.ok) {
    return resolved;
  }
  try {
    switch (op) {
      case 'read':
        return await readOperation(resolved.absolute, fsPromises);
      case 'write':
        return await writeOperation(resolved.absolute, content, fsPromises, nodePath);
      case 'list':
        return await listOperation(resolved.absolute, fsPromises);
      case 'stat':
        return await statOperation(resolved.absolute, fsPromises);
      default:
        return failure('BAD_PATH', 'Unknown file operation.');
    }
  } catch (error) {
    const mapped = mapFsError(error);
    if (mapped) return mapped;
    throw error;
  }
};
