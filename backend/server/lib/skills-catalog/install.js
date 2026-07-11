import fs from 'fs';
import os from 'os';
import path from 'path';

import { assertGitAvailable, looksLikeAuthError, runGit } from './git.js';
import { parseSkillRepoSource } from './source.js';

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

function normalizeUserSkillDir(userSkillDir) {
  if (!userSkillDir) return null;
  const legacySkillDir = path.join(os.homedir(), '.config', 'opencode', 'skill');
  const pluralSkillDir = path.join(os.homedir(), '.config', 'opencode', 'skills');
  if (userSkillDir === legacySkillDir) {
    if (fs.existsSync(legacySkillDir) && !fs.existsSync(pluralSkillDir)) return legacySkillDir;
    return pluralSkillDir;
  }
  return userSkillDir;
}

function validateSkillName(skillName) {
  if (typeof skillName !== 'string') return false;
  if (skillName.length < 1 || skillName.length > 64) return false;
  return SKILL_NAME_PATTERN.test(skillName);
}

async function safeRm(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function toFsPath(repoDir, repoRelPosixPath) {
  const parts = String(repoRelPosixPath || '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  return path.join(repoDir, ...parts);
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function copyDirectoryNoSymlinks(srcDir, dstDir) {
  const srcReal = await fs.promises.realpath(srcDir);
  await ensureDir(dstDir);

  const walk = async (currentSrc, currentDst) => {
    const entries = await fs.promises.readdir(currentSrc, { withFileTypes: true });
    for (const entry of entries) {
      const nextSrc = path.join(currentSrc, entry.name);
      const nextDst = path.join(currentDst, entry.name);

      const stat = await fs.promises.lstat(nextSrc);
      if (stat.isSymbolicLink()) {
        throw new Error('Symlinks are not supported in skills');
      }

      // Guard against traversal: ensure source is still under srcReal
      const nextRealParent = await fs.promises.realpath(path.dirname(nextSrc));
      if (!nextRealParent.startsWith(srcReal)) {
        throw new Error('Invalid source path traversal detected');
      }

      if (stat.isDirectory()) {
        await ensureDir(nextDst);
        await walk(nextSrc, nextDst);
        continue;
      }

      if (stat.isFile()) {
        await ensureDir(path.dirname(nextDst));
        await fs.promises.copyFile(nextSrc, nextDst);
        try {
          await fs.promises.chmod(nextDst, stat.mode & 0o777);
        } catch {
          // best-effort
        }
        continue;
      }

      // Skip other types (sockets, devices, etc.)
    }
  };

  await walk(srcDir, dstDir);
}

async function cloneRepo({ cloneUrl, identity, tempDir }) {
  const preferred = ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', cloneUrl, tempDir];
  const fallback = ['clone', '--depth', '1', '--no-checkout', cloneUrl, tempDir];

  const result = await runGit(preferred, { identity, timeoutMs: 90_000 });
  if (result.ok) return { ok: true };

  const fallbackResult = await runGit(fallback, { identity, timeoutMs: 90_000 });
  if (fallbackResult.ok) return { ok: true };

  return {
    ok: false,
    error: fallbackResult,
  };
}

function getTargetSkillDir({ scope, targetSource, workingDirectory, userSkillDir, skillName }) {
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
  scope,
  targetSource,
  workingDirectory,
  userSkillDir,
  selections,
  conflictPolicy,
  conflictDecisions,
} = {}) {
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

  const effectiveSubpath = parsed.effectiveSubpath || (typeof defaultSubpath === 'string' && defaultSubpath.trim() ? defaultSubpath.trim() : null);
  void effectiveSubpath;

  const cloneUrl = identity?.sshKey ? parsed.cloneUrlSsh : parsed.cloneUrlHttps;

  const requestedDirs = Array.isArray(selections) ? selections.map((s) => String(s?.skillDir || '').trim()).filter(Boolean) : [];
  if (requestedDirs.length === 0) {
    return { ok: false, error: { kind: 'invalidSource', message: 'No skills selected for installation' } };
  }

  // Validate names early and compute conflicts without mutating.
  const skillPlans = requestedDirs.map((skillDirPosix) => {
    const skillName = path.posix.basename(skillDirPosix);
    return { skillDirPosix, skillName, installable: validateSkillName(skillName) };
  });

  const conflicts = [];
  for (const plan of skillPlans) {
    if (!plan.installable) {
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

  const tempBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-skills-install-'));

  try {
    const cloned = await cloneRepo({ cloneUrl, identity, tempDir: tempBase });
    if (!cloned.ok) {
      const msg = `${cloned.error?.stderr || ''}\n${cloned.error?.message || ''}`.trim();
      if (looksLikeAuthError(msg)) {
        return { ok: false, error: { kind: 'authRequired', message: 'Authentication required to access this repository', sshOnly: true } };
      }
      return { ok: false, error: { kind: 'networkError', message: msg || 'Failed to clone repository' } };
    }

    // Selective checkout for only requested skill dirs.
    await runGit(['-C', tempBase, 'sparse-checkout', 'init', '--cone'], { identity, timeoutMs: 15_000 });
    const setResult = await runGit(['-C', tempBase, 'sparse-checkout', 'set', ...requestedDirs], { identity, timeoutMs: 30_000 });
    if (!setResult.ok) {
      return { ok: false, error: { kind: 'unknown', message: setResult.stderr || setResult.message || 'Failed to configure sparse checkout' } };
    }

    const checkoutResult = await runGit(['-C', tempBase, 'checkout', '--force', 'HEAD'], { identity, timeoutMs: 60_000 });
    if (!checkoutResult.ok) {
      return { ok: false, error: { kind: 'unknown', message: checkoutResult.stderr || checkoutResult.message || 'Failed to checkout repository' } };
    }

    const installed = [];
    const skipped = [];

    for (const plan of skillPlans) {
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
        if (!exists) decision = 'overwrite'; // no conflict, proceed
      }

      if (exists && decision === 'skip') {
        skipped.push({ skillName: plan.skillName, reason: 'Already installed (skipped)' });
        continue;
      }

      if (exists && decision === 'overwrite') {
        await safeRm(targetDir);
      }

      // Ensure project parent directories exist
      await ensureDir(path.dirname(targetDir));

      try {
        await copyDirectoryNoSymlinks(srcDir, targetDir);
        installed.push({ skillName: plan.skillName, scope, source: targetSource === 'agents' ? 'agents' : 'opencode' });
      } catch (error) {
        await safeRm(targetDir);
        skipped.push({
          skillName: plan.skillName,
          reason: error instanceof Error ? error.message : 'Failed to copy skill files',
        });
      }
    }

    return { ok: true, installed, skipped };
  } finally {
    await safeRm(tempBase);
  }
}
