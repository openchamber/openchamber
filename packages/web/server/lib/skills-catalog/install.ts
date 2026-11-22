import fs from 'fs';
import os from 'os';
import path from 'path';

import { assertGitAvailable, looksLikeAuthError, runGit } from './git.js';
import { parseSkillRepoSource } from './source.js';
import { removeDirectory, removeStaleCatalogFolders } from './remove-directory.js';
import { OPENCODE_CONFIG_DIR } from '../opencode/config-files.js';
import { SKILL_SUPPORTING_FILE_MAX_BYTES } from '../opencode/skill-files.js';
import { SKILL_MD_MAX_BYTES } from './scan.js';

import type { CatalogGitOptions, GitResult } from './git.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

interface CatalogCloneOptions extends Pick<CatalogGitOptions, 'identity' | 'credentialResolver'> {
  cloneUrl: string;
  tempDir: string;
  ref?: string | null;
}

type CatalogCloneResult = { ok: true } | { ok: false; error: GitResult };

export interface SkillsInstallOptions extends Pick<CatalogGitOptions, 'identity' | 'credentialResolver'> {
  source?: JsonValue | undefined;
  subpath?: JsonValue | undefined;
  defaultSubpath?: string;
  scope?: JsonValue | undefined;
  targetSource?: JsonValue | undefined;
  workingDirectory?: string | null;
  userSkillDir?: string | null;
  selections?: { skillDir?: JsonValue }[] | null | undefined;
  conflictPolicy?: JsonValue | undefined;
  conflictDecisions?: JsonObject | null | undefined;
}

export interface SkillInstallConflict {
  skillName: string;
  scope: 'user' | 'project';
  source: 'agents' | 'opencode';
}

export interface InstalledSkill extends SkillInstallConflict {
  skillDir: string;
}

export interface SkippedSkill {
  skillName: string;
  reason: string;
}

export type SkillsInstallResult = {
  ok: true;
  installed: InstalledSkill[];
  skipped: SkippedSkill[];
} | {
  ok: false;
  error: {
    kind: 'gitUnavailable' | 'unknown' | 'invalidSource' | 'conflicts' | 'authRequired' | 'networkError';
    message: string;
    conflicts?: SkillInstallConflict[];
  };
};

interface TargetSkillOptions {
  scope: 'user' | 'project';
  targetSource: string | undefined;
  workingDirectory: string | null | undefined;
  userSkillDir: string;
  skillName: string;
}

const isDefaultSubpath = (value: unknown): value is string => typeof value === 'string';

// A skill is a SKILL.md plus small supporting text and assets, so an install
// never needs a large tree. These caps keep a cloned repository from turning
// one install into an unbounded copy: entries counts files and directories
// (a tree of empty directories is the same denial of service as a tree of
// files), and the per-file limit is the one the skill loader already enforces
// when it reads a supporting file.
export const SKILL_COPY_MAX_ENTRIES = 1_000;
export const SKILL_COPY_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

function normalizeUserSkillDir(userSkillDir: string | null | undefined) {
  if (!userSkillDir) return null;
  const legacySkillDir = path.join(OPENCODE_CONFIG_DIR, 'skill');
  const pluralSkillDir = path.join(OPENCODE_CONFIG_DIR, 'skills');
  if (userSkillDir === legacySkillDir) {
    if (fs.existsSync(legacySkillDir) && !fs.existsSync(pluralSkillDir)) return legacySkillDir;
    return pluralSkillDir;
  }
  return userSkillDir;
}

function validateSkillName(skillName: string) {
  if (skillName.length < 1 || skillName.length > 64) return false;
  return SKILL_NAME_PATTERN.test(skillName);
}

/**
 * A selection is unsafe when it is absolute or names a parent directory, under
 * either separator, so its filesystem path could leave the clone. The install
 * endpoint accepts selections that did not come from a scan, so this runs here
 * rather than relying on git's sparse-checkout normalisation.
 */
function isUnsafeSelectionPath(repoRelPosixPath: string) {
  const raw = String(repoRelPosixPath || '');
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) return true;
  return raw.split(/[\\/]+/).some((segment) => {
    const trimmed = segment.trim();
    return trimmed === '..' || trimmed === '.';
  });
}

/** Whether `candidateReal` is `rootReal` or below it, on a separator boundary. */
function isPathWithin(rootReal: string, candidateReal: string) {
  if (candidateReal === rootReal) return true;
  const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  return candidateReal.startsWith(prefix);
}

function toFsPath(repoDir: string, repoRelPosixPath: string) {
  if (isUnsafeSelectionPath(repoRelPosixPath)) {
    throw new Error('Invalid skill directory path');
  }
  const parts = String(repoRelPosixPath || '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  return path.join(repoDir, ...parts);
}

async function ensureDir(dirPath: string) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

export async function copyDirectoryNoSymlinks(srcDir: string, dstDir: string, cloneRoot: string) {
  // Containment is anchored at the clone, not at the selected directory: a
  // selected directory that is itself a symlink resolves outside the clone, and
  // anchoring at it would make every below-root check pass vacuously.
  const cloneReal = await fs.promises.realpath(cloneRoot);

  const relative = path.relative(cloneRoot, srcDir);
  const segments = relative.split(path.sep).filter(Boolean);
  if (path.isAbsolute(relative) || segments.includes('..')) {
    throw new Error('Invalid source path traversal detected');
  }

  // Reject a selected directory that is a symlink, or that sits behind one.
  let current = cloneRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error('Symlinks are not supported in skills');
    }
  }

  const srcReal = await fs.promises.realpath(srcDir);
  if (!isPathWithin(cloneReal, srcReal)) {
    throw new Error('Invalid source path traversal detected');
  }

  await ensureDir(dstDir);

  const copyState = { entries: 0, bytes: 0 };
  const countEntry = (stat: import('node:fs').Stats, name: string) => {
    copyState.entries += 1;
    if (copyState.entries > SKILL_COPY_MAX_ENTRIES) {
      throw new Error(`Skill directory is too large to install: more than ${SKILL_COPY_MAX_ENTRIES} entries`);
    }
    if (!stat.isFile()) return;
    const perFileLimit = name === 'SKILL.md' ? SKILL_MD_MAX_BYTES : SKILL_SUPPORTING_FILE_MAX_BYTES;
    if (stat.size > perFileLimit) {
      throw new Error(`Skill file is too large to install: ${stat.size} bytes exceeds the ${perFileLimit} byte limit`);
    }
    copyState.bytes += stat.size;
    if (copyState.bytes > SKILL_COPY_MAX_TOTAL_BYTES) {
      throw new Error(`Skill directory is too large to install: more than ${SKILL_COPY_MAX_TOTAL_BYTES} bytes`);
    }
  };

  const walk = async (currentSrc: string, currentDst: string): Promise<void> => {
    const entries = await fs.promises.readdir(currentSrc, { withFileTypes: true });
    for (const entry of entries) {
      const nextSrc = path.join(currentSrc, entry.name);
      const nextDst = path.join(currentDst, entry.name);

      const stat = await fs.promises.lstat(nextSrc);
      if (stat.isSymbolicLink()) {
        throw new Error('Symlinks are not supported in skills');
      }

      // Guard against traversal: the resolved parent must stay inside the clone.
      const nextRealParent = await fs.promises.realpath(path.dirname(nextSrc));
      if (!isPathWithin(cloneReal, nextRealParent)) {
        throw new Error('Invalid source path traversal detected');
      }

      if (stat.isDirectory()) {
        countEntry(stat, entry.name);
        await ensureDir(nextDst);
        await walk(nextSrc, nextDst);
        continue;
      }

      if (stat.isFile()) {
        countEntry(stat, entry.name);
        await ensureDir(path.dirname(nextDst));
        await fs.promises.copyFile(nextSrc, nextDst);
        try {
          await fs.promises.chmod(nextDst, stat.mode & 0o777);
        } catch {
          continue;
        }
        continue;
      }
    }
  };

  await walk(srcDir, dstDir);
}

async function cloneRepo({ cloneUrl, identity, credentialResolver, tempDir, ref = null }: CatalogCloneOptions): Promise<CatalogCloneResult> {
  const branch = ref ? ['--branch', ref] : [];
  const preferred = ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', ...branch, cloneUrl, tempDir];
  const fallback = ['clone', '--depth', '1', '--no-checkout', ...branch, cloneUrl, tempDir];

  const options = { identity, credentialResolver, timeoutMs: 90_000 };
  const result = await runGit(preferred, options);
  if (result.ok) return { ok: true };
  if (looksLikeAuthError(`${result.stderr || ''}\n${result.message || ''}`)) {
    return { ok: false, error: result };
  }

  const fallbackResult = await runGit(fallback, options);
  if (fallbackResult.ok) return { ok: true };

  return {
    ok: false,
    error: fallbackResult,
  };
}

function getTargetSkillDir({ scope, targetSource, workingDirectory, userSkillDir, skillName }: TargetSkillOptions) {
  const source = targetSource === 'agents' ? 'agents' : 'opencode';

  if (scope === 'user') {
    if (source === 'agents') {
      return path.join(os.homedir(), '.agents', 'skills', skillName);
    }
    return path.join(userSkillDir, skillName);
  }

  if (!workingDirectory) {
    throw new Error('workingDirectory is required for project installs');
  }

  if (source === 'agents') {
    return path.join(workingDirectory, '.agents', 'skills', skillName);
  }

  return path.join(workingDirectory, '.opencode', 'skills', skillName);
}

export async function installSkillsFromRepository({
  source,
  subpath,
  defaultSubpath,
  identity,
  credentialResolver,
  scope,
  targetSource,
  workingDirectory,
  userSkillDir,
  selections,
  conflictPolicy,
  conflictDecisions,
}: SkillsInstallOptions = {}): Promise<SkillsInstallResult> {
  const gitCheck = await assertGitAvailable();
  if (!gitCheck.ok) {
    return { ok: false, error: gitCheck.error };
  }

  const normalizedUserSkillDir = normalizeUserSkillDir(userSkillDir);
  if (normalizedUserSkillDir) {
    userSkillDir = normalizedUserSkillDir;
  }

  if (!userSkillDir) {
    return { ok: false, error: { kind: 'unknown', message: 'userSkillDir is required' } };
  }

  if (scope !== 'user' && scope !== 'project') {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid scope' } };
  }

  if (targetSource !== undefined && targetSource !== 'opencode' && targetSource !== 'agents') {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid target source' } };
  }

  if (scope === 'project' && !workingDirectory) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Project installs require a directory parameter' } };
  }

  const parsed = parseSkillRepoSource(source, { subpath });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const effectiveSubpath = parsed.effectiveSubpath || (isDefaultSubpath(defaultSubpath) && defaultSubpath.trim() ? defaultSubpath.trim() : null);
  void effectiveSubpath;

  const cloneUrl = identity?.transport === 'ssh' ? parsed.cloneUrlSsh : parsed.cloneUrlHttps;

  const requestedDirs = Array.isArray(selections) ? selections.map((s) => String(s?.skillDir || '').trim()).filter(Boolean) : [];
  if (requestedDirs.length === 0) {
    return { ok: false, error: { kind: 'invalidSource', message: 'No skills selected for installation' } };
  }

  // Validate names and paths early and compute conflicts without mutating.
  const skillPlans = requestedDirs.map((skillDirPosix) => {
    const skillName = path.posix.basename(skillDirPosix);
    const pathError = isUnsafeSelectionPath(skillDirPosix) ? 'Invalid skill directory path' : null;
    return { skillDirPosix, skillName, pathError, installable: validateSkillName(skillName) };
  });

  // Only safe selections are worth checking out; an unsafe one would make git
  // reject the whole sparse-checkout set, so it is skipped rather than cloned.
  const checkoutDirs = skillPlans.filter((plan) => !plan.pathError).map((plan) => plan.skillDirPosix);
  if (checkoutDirs.length === 0) {
    return {
      ok: true,
      installed: [],
      skipped: skillPlans.map((plan) => ({ skillName: plan.skillName, reason: plan.pathError ?? 'invalid path' })),
    };
  }

  const conflicts: SkillInstallConflict[] = [];
  for (const plan of skillPlans) {
    if (plan.pathError || !plan.installable) {
      continue;
    }

    const targetDir = getTargetSkillDir({ scope, targetSource, workingDirectory, userSkillDir, skillName: plan.skillName });
    if (fs.existsSync(targetDir)) {
      const decision = conflictDecisions?.[plan.skillName];
      const hasAutoPolicy = conflictPolicy === 'skipAll' || conflictPolicy === 'overwriteAll';
      if (!decision && !hasAutoPolicy) {
        conflicts.push({ skillName: plan.skillName, scope, source: targetSource === 'agents' ? 'agents' : 'opencode' });
      }
    }
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      error: {
        kind: 'conflicts',
        message: 'Some skills already exist in the selected scope',
        conflicts,
      },
    };
  }

  void removeStaleCatalogFolders();
  const tempBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-skills-install-'));

  try {
    const cloned = await cloneRepo({ cloneUrl, identity, credentialResolver, tempDir: tempBase, ref: parsed.ref });
    if (!cloned.ok) {
      const msg = `${cloned.error?.stderr || ''}\n${cloned.error?.message || ''}`.trim();
      if (looksLikeAuthError(msg)) {
        return { ok: false, error: { kind: 'authRequired', message: 'Authentication required to access this repository' } };
      }
      return { ok: false, error: { kind: 'networkError', message: msg || 'Failed to clone repository' } };
    }

    await runGit(['-C', tempBase, 'sparse-checkout', 'init', '--cone'], { timeoutMs: 15_000 });
    const setResult = await runGit(['-C', tempBase, 'sparse-checkout', 'set', ...checkoutDirs], { timeoutMs: 30_000 });
    if (!setResult.ok) {
      return { ok: false, error: { kind: 'unknown', message: setResult.stderr || setResult.message || 'Failed to configure sparse checkout' } };
    }

    const checkoutResult = await runGit(['-C', tempBase, 'checkout', '--force', 'HEAD'], { identity, credentialResolver, timeoutMs: 60_000 });
    if (!checkoutResult.ok) {
      return { ok: false, error: { kind: 'unknown', message: checkoutResult.stderr || checkoutResult.message || 'Failed to checkout repository' } };
    }

    const installed: InstalledSkill[] = [];
    const skipped: SkippedSkill[] = [];

    for (const plan of skillPlans) {
      if (plan.pathError) {
        skipped.push({ skillName: plan.skillName, reason: plan.pathError });
        continue;
      }

      if (!plan.installable) {
        skipped.push({ skillName: plan.skillName, reason: 'Invalid skill name (directory basename)' });
        continue;
      }

      const srcDir = toFsPath(tempBase, plan.skillDirPosix);
      const skillMdPath = path.join(srcDir, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) {
        skipped.push({ skillName: plan.skillName, reason: 'SKILL.md not found in selected directory' });
        continue;
      }

      const targetDir = getTargetSkillDir({ scope, targetSource, workingDirectory, userSkillDir, skillName: plan.skillName });
      const exists = fs.existsSync(targetDir);

      let decision = conflictDecisions?.[plan.skillName] || null;
      if (!decision) {
        if (exists && conflictPolicy === 'skipAll') decision = 'skip';
        if (exists && conflictPolicy === 'overwriteAll') decision = 'overwrite';
        if (!exists) decision = 'overwrite';
      }

      if (exists && decision === 'skip') {
        skipped.push({ skillName: plan.skillName, reason: 'Already installed (skipped)' });
        continue;
      }

      if (exists && decision === 'overwrite') {
        await removeDirectory(targetDir);
      }

      await ensureDir(path.dirname(targetDir));

      try {
        await copyDirectoryNoSymlinks(srcDir, targetDir, tempBase);
        installed.push({ skillName: plan.skillName, skillDir: plan.skillDirPosix, scope, source: targetSource === 'agents' ? 'agents' : 'opencode' });
      } catch (error) {
        await removeDirectory(targetDir);
        skipped.push({
          skillName: plan.skillName,
          reason: error instanceof Error ? error.message : 'Failed to copy skill files',
        });
      }
    }

    return { ok: true, installed, skipped };
  } finally {
    await removeDirectory(tempBase);
  }
}
