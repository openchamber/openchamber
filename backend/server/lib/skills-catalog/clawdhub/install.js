/**
 * ClawdHub skill installation
 * 
 * Downloads skills from ClawdHub as ZIP files and extracts them
 * to the appropriate skill directory.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

import { downloadClawdHubSkill, fetchClawdHubSkillInfo } from './api.js';

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

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
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

/**
 * Install skills from ClawdHub registry
 * @param {Object} options
 * @param {string} options.scope - 'user' or 'project'
 * @param {string} [options.targetSource] - 'opencode' or 'agents'
 * @param {string} [options.workingDirectory] - Required for project scope
 * @param {string} options.userSkillDir - User skills directory
 * @param {Array} options.selections - Array of { skillDir, clawdhub: { slug, version } }
 * @param {string} [options.conflictPolicy] - 'prompt', 'skipAll', or 'overwriteAll'
 * @param {Object} [options.conflictDecisions] - Per-skill conflict decisions
 * @returns {Promise<{ ok: boolean, installed?: Array, skipped?: Array, error?: Object }>}
 */
export async function installSkillsFromClawdHub({
  scope,
  targetSource,
  workingDirectory,
  userSkillDir,
  selections,
  conflictPolicy,
  conflictDecisions,
} = {}) {
  if (scope !== 'user' && scope !== 'project') {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid scope' } };
  }

  if (targetSource !== undefined && targetSource !== 'opencode' && targetSource !== 'agents') {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid target source' } };
  }

  if (!userSkillDir) {
    return { ok: false, error: { kind: 'unknown', message: 'userSkillDir is required' } };
  }

  const normalizedUserSkillDir = normalizeUserSkillDir(userSkillDir);
  if (normalizedUserSkillDir) {
    userSkillDir = normalizedUserSkillDir;
  }

  if (scope === 'project' && !workingDirectory) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Project installs require a directory parameter' } };
  }

  const requestedSkills = Array.isArray(selections) ? selections : [];
  if (requestedSkills.length === 0) {
    return { ok: false, error: { kind: 'invalidSource', message: 'No skills selected for installation' } };
  }

  // Build installation plans
  const skillPlans = requestedSkills.map((sel) => {
    const slug = sel.clawdhub?.slug || sel.skillDir;
    const version = sel.clawdhub?.version || 'latest';
    return {
      slug,
      version,
      installable: validateSkillName(slug),
    };
  });

  // Check for conflicts before downloading
  const conflicts = [];
  for (const plan of skillPlans) {
    if (!plan.installable) {
      continue;
    }

    const targetDir = getTargetSkillDir({ scope, targetSource, workingDirectory, userSkillDir, skillName: plan.slug });
    if (fs.existsSync(targetDir)) {
      const decision = conflictDecisions?.[plan.slug];
      const hasAutoPolicy = conflictPolicy === 'skipAll' || conflictPolicy === 'overwriteAll';
      if (!decision && !hasAutoPolicy) {
        conflicts.push({ skillName: plan.slug, scope, source: targetSource === 'agents' ? 'agents' : 'opencode' });
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

  const installed = [];
  const skipped = [];

  for (const plan of skillPlans) {
    if (!plan.installable) {
      skipped.push({ skillName: plan.slug, reason: 'Invalid skill name' });
      continue;
    }

    try {
      // Resolve 'latest' version if needed
      let resolvedVersion = plan.version;
      if (resolvedVersion === 'latest') {
        try {
          const info = await fetchClawdHubSkillInfo(plan.slug);
          const latest = info.skill?.tags?.latest || info.latestVersion?.version || null;
          if (latest) {
            resolvedVersion = latest;
          }
        } catch {
          // ignore
        }

        if (resolvedVersion === 'latest') {
          skipped.push({ skillName: plan.slug, reason: 'Unable to resolve latest version' });
          continue;
        }
      }

      const targetDir = getTargetSkillDir({ scope, targetSource, workingDirectory, userSkillDir, skillName: plan.slug });
      const exists = fs.existsSync(targetDir);

      // Determine conflict resolution
      let decision = conflictDecisions?.[plan.slug] || null;
      if (!decision) {
        if (exists && conflictPolicy === 'skipAll') decision = 'skip';
        if (exists && conflictPolicy === 'overwriteAll') decision = 'overwrite';
        if (!exists) decision = 'overwrite'; // No conflict, proceed
      }

      if (exists && decision === 'skip') {
        skipped.push({ skillName: plan.slug, reason: 'Already installed (skipped)' });
        continue;
      }

      if (exists && decision === 'overwrite') {
        await safeRm(targetDir);
      }

      // Download the skill ZIP
      const zipBuffer = await downloadClawdHubSkill(plan.slug, resolvedVersion);

      // Extract to a temp directory first for validation
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `clawdhub-${plan.slug}-`));
      
      try {
        const zip = new AdmZip(Buffer.from(zipBuffer));
        zip.extractAllTo(tempDir, true);

        // Verify SKILL.md exists
        const skillMdPath = path.join(tempDir, 'SKILL.md');
        if (!fs.existsSync(skillMdPath)) {
          skipped.push({ skillName: plan.slug, reason: 'SKILL.md not found in downloaded package' });
          continue;
        }

        // Move to target directory
        await ensureDir(path.dirname(targetDir));
        await fs.promises.rename(tempDir, targetDir);

        installed.push({ skillName: plan.slug, scope, source: targetSource === 'agents' ? 'agents' : 'opencode' });
      } catch (extractError) {
        await safeRm(tempDir);
        throw extractError;
      }
    } catch (error) {
      console.error(`Failed to install ClawdHub skill "${plan.slug}":`, error);
      skipped.push({
        skillName: plan.slug,
        reason: error instanceof Error ? error.message : 'Failed to download or extract skill',
      });
    }
  }

  return { ok: true, installed, skipped };
}
