import fs from 'fs';
import path from 'path';
import os from 'os';
import { OPENCODE_CONFIG_DIR, getAncestors, findWorktreeRoot } from './config-files.js';
import { isString } from '../shared/object-guards.js';
import { writeFileAtomic } from './atomic-write.js';
import { createTraversalBudget } from '../shared/traversal-budget.js';
import type { MarkdownDocument } from './markdown-files.js';

// Skill supporting files are hand-maintained docs and scripts shipped with
// third-party skills; nothing OpenChamber writes bounds their size, so the
// GET route must never buffer an arbitrary one whole. Judged from stat
// before any read (the house stat-gate pattern): a file over this cap is
// refused, never read. 1 MiB matches the AGENTS.md behavior-prompt cap.
const SKILL_SUPPORTING_FILE_MAX_BYTES = 1024 * 1024;
const SKILL_SUPPORTING_FILE_TOO_LARGE_CODE = 'skill_supporting_file_too_large';

export interface DiscoveredSkill {
  name: string;
  path: string;
  scope: 'user' | 'project';
  source: 'opencode' | 'claude' | 'agents';
  description: string;
}
export interface SkillSupportingFile {
  name: string;
  path: string;
  fullPath: string;
}
const hasSkillFields = (value: unknown): value is { name?: unknown; description?: unknown } => value != null;
const isWritableView = (value: unknown): value is NodeJS.ArrayBufferView => ArrayBuffer.isView(value);

async function pathExists(target: string) {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

const SKILL_WALK_CONCURRENCY = 8;


// Async so a skills tree with tens of thousands of entries (a bundled `.venv`
// or `node_modules`) does not hold the server's event loop for seconds.
// Directories are visited one at a time in depth-first readdir order, so the
// order matches the old synchronous walk exactly and the directory cap below
// is allocated deterministically: an over-cap tree always yields the same
// partial result, never whichever subtree's readdir finished first.
async function walkSkillMdFiles(rootDir: string) {
  if (!rootDir || !(await pathExists(rootDir))) return [];

  let active = 0;
  const waiting: Array<() => void> = [];
  const limited = async <Result>(call: () => Promise<Result>) => {
    if (active >= SKILL_WALK_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
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

  const walk = async (dir: string, ancestors: Set<string>): Promise<string[]> => {
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
    // Entries are processed one at a time, in readdir order: recursing into
    // sibling subtrees in parallel would let their readdir completions race
    // for the shared directory cap, so an unchanged over-cap tree could
    // return different partial results (and different duplicate-name
    // winners) from one scan to the next.
    const found = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
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
        if (holdsSkill || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        found.push(...(await walk(fullPath, childAncestors)));
      } else if (isFileEntry && entry.name === 'SKILL.md') {
        found.push(fullPath);
      }
    }
    return found;
  };

  return walk(rootDir, new Set());
}

function addSkillFromMdFile(skillsMap: Map<string, DiscoveredSkill>, skillMdPath: string, parsed: MarkdownDocument | null | undefined, scope: DiscoveredSkill['scope'], source: DiscoveredSkill['source']) {
  if (!parsed) {
    return;
  }

  const frontmatter = hasSkillFields(parsed.frontmatter) ? parsed.frontmatter : undefined;
  const name = isString(frontmatter?.name)
    ? frontmatter.name.trim()
    : '';
  const description = isString(frontmatter?.description)
    ? frontmatter.description
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

function resolveSkillSearchDirectories(workingDirectory: string | null) {
  const directories: string[] = [];
  const pushDir = (dir: string | null) => {
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

async function listSkillSupportingFiles(skillDir: string) {
  if (!(await pathExists(skillDir))) {
    return { files: [], truncated: false };
  }

  // A skill folder can bundle an arbitrarily large tree (a vendored .venv,
  // node_modules, generated docs); one detail request must not walk all of
  // it. The shared traversal budget (design #1391) owns this walk's
  // counting: at most 5,000 directories and 5,000 files. The VS Code twin
  // in opencodeConfig.ts states the same budget.
  const budget = createTraversalBudget({ maxDirs: 5000, maxEntries: 5000 });
  const files: SkillSupportingFile[] = [];

  // Returns false once the budget is spent, so every caller unwinds and
  // the walk stops instead of merely stopping collection. Files and
  // directories seen before the bound are kept, in the original traversal
  // order; a tree that ends exactly at a bound is complete, not truncated
  // (the budget flags truncation only when a consultation is refused).
  async function walkDir(dir: string, relativePath = '') {
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

function assertPathWithinSkillDir<Path>(skillDir: string, relativePath: Path) {
  const root = fs.realpathSync(skillDir);
  if (!isString(relativePath)) {
    throw Object.assign(new TypeError('The skill file path must be a string'), { code: 'ERR_INVALID_ARG_TYPE' });
  }
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  const isWithin = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));

  if (!isWithin) {
    const error: NodeJS.ErrnoException = new Error('Access to file denied');
    error.code = 'EACCES';
    throw error;
  }

  return target;
}

function readSkillSupportingFile(skillDir: string, relativePath: string) {
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
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!pathStats.isFile()) rejectNonRegularFile();
  if (pathStats.size > SKILL_SUPPORTING_FILE_MAX_BYTES) throw createTooLargeError();

  let fileDescriptor;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
    fileDescriptor = fs.openSync(fullPath, flags);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
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
function assertSkillSupportingFileWithinCap<Path, Content>(relativePath: Path, content: Content) {
  if (isString(content) && Buffer.byteLength(content, 'utf8') > SKILL_SUPPORTING_FILE_MAX_BYTES) {
    throw Object.assign(
      new Error(`Skill file is too large to write: ${relativePath} exceeds the ${SKILL_SUPPORTING_FILE_MAX_BYTES} byte limit`),
      { code: SKILL_SUPPORTING_FILE_TOO_LARGE_CODE },
    );
  }
}

function writeSkillSupportingFile<Path, Content>(skillDir: string, relativePath: Path, content: Content) {
  const fullPath = assertPathWithinSkillDir(skillDir, relativePath);
  assertSkillSupportingFileWithinCap(relativePath, content);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  if (!isString(content) && !isWritableView(content)) {
    throw Object.assign(new TypeError('The skill file content must be a string or an ArrayBuffer view'), { code: 'ERR_INVALID_ARG_TYPE' });
  }
  writeFileAtomic(fullPath, content);
}

function deleteSkillSupportingFile<Path>(skillDir: string, relativePath: Path) {
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
  walkSkillMdFiles,
  pathExists,
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
