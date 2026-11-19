import fs from 'fs';
import path from 'path';
import os from 'os';
import { OPENCODE_CONFIG_DIR, getAncestors, findWorktreeRoot } from './config-files.js';

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
  walkSkillMdFiles,
  pathExists,
  addSkillFromMdFile,
  resolveSkillSearchDirectories,
  listSkillSupportingFiles,
  readSkillSupportingFile,
  writeSkillSupportingFile,
  deleteSkillSupportingFile
};
