import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';

import { assertGitAvailable, looksLikeAuthError, runGit } from './git.js';
import { parseSkillRepoSource } from './source.js';
import { readBoundedFile } from '../shared/bounded-file-read.js';

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

// A catalog SKILL.md is clone-controlled content; never buffer one whole
// past the same 4 MiB cap the git-show fallback already enforces
// (DEFAULT_MAX_BUFFER in git.js).
export const SKILL_MD_MAX_BYTES = 4 * 1024 * 1024;
const SKILL_MD_TOO_LARGE_WARNING = 'SKILL.md is larger than the 4 MiB size limit; skipped';

// A failed git-show whose output exceeded the exec maxBuffer is an
// over-cap SKILL.md, not a generic read failure.
export function isGitOutputTooLarge(result) {
  if (!result) return false;
  if (result.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return true;
  return /maxbuffer/i.test(String(result.message || ''));
}

export async function readSkillMdFile(filePath) {
  // The shared bounded read (design #1254) does the open-once,
  // handle-judged, cap-enforced-in-flight read this module originated.
  // Its outcomes are mapped back onto this module's existing contract:
  // over-cap is an answer, while missing and non-regular files throw so
  // the caller falls back to git show exactly as before (a non-regular
  // file there throws, and a missing file's git show reports the failure
  // the caller already handles).
  const result = await readBoundedFile(filePath, SKILL_MD_MAX_BYTES);
  if (result.ok) {
    return { tooLarge: false, content: result.buffer.toString('utf8') };
  }
  if (result.reason === 'too-large') {
    return { tooLarge: true, content: '' };
  }
  if (result.reason === 'missing') {
    const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    error.code = 'ENOENT';
    throw error;
  }
  throw new Error(`SKILL.md is not a regular file: ${filePath}`);
}

function validateSkillName(skillName) {
  if (typeof skillName !== 'string') return false;
  if (skillName.length < 1 || skillName.length > 64) return false;
  return SKILL_NAME_PATTERN.test(skillName);
}

function parseSkillMd(content) {
  const text = typeof content === 'string' ? content : '';
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return {
      ok: true,
      frontmatter: {},
      warnings: ['Invalid SKILL.md: missing YAML frontmatter delimiter'],
    };
  }

  try {
    const frontmatter = yaml.parse(match[1]) || {};
    return { ok: true, frontmatter, warnings: [] };
  } catch {
    return {
      ok: true,
      frontmatter: {},
      warnings: ['Invalid SKILL.md: failed to parse YAML frontmatter'],
    };
  }
}

async function safeRm(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function cloneRepo({ cloneUrl, identity, credentialResolver, tempDir, ref = null }) {
  // A `#ref` on the source picks the branch or tag; otherwise the default branch.
  const branch = ref ? ['--branch', ref] : [];
  const preferred = ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', ...branch, cloneUrl, tempDir];
  const fallback = ['clone', '--depth', '1', '--no-checkout', ...branch, cloneUrl, tempDir];

  const options = { identity, credentialResolver, timeoutMs: 60_000 };
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

export async function scanSkillsRepository({
  source,
  subpath,
  defaultSubpath,
  identity,
  credentialResolver,
} = {}) {
  const gitCheck = await assertGitAvailable();
  if (!gitCheck.ok) {
    return { ok: false, error: gitCheck.error };
  }

  const parsed = parseSkillRepoSource(source, { subpath });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const effectiveSubpath = parsed.effectiveSubpath || (typeof defaultSubpath === 'string' && defaultSubpath.trim() ? defaultSubpath.trim() : null);
  const cloneUrl = identity?.transport === 'ssh' ? parsed.cloneUrlSsh : parsed.cloneUrlHttps;
  // Only commands that reach the remote get the identity: the clone, and the
  // checkout or `show` that lazily fetch blobs from the partial clone.
  const remoteGitOptions = { identity, credentialResolver };

  const tempBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-skills-scan-'));

  try {
    const cloned = await cloneRepo({ cloneUrl, identity, credentialResolver, tempDir: tempBase, ref: parsed.ref });
    if (!cloned.ok) {
      const msg = `${cloned.error?.stderr || ''}\n${cloned.error?.message || ''}`.trim();
      if (looksLikeAuthError(msg)) {
        return { ok: false, error: { kind: 'authRequired', message: 'Authentication required to access this repository' } };
      }
      return { ok: false, error: { kind: 'networkError', message: msg || 'Failed to clone repository' } };
    }

    const toFsPath = (posixPath) => path.join(tempBase, ...String(posixPath || '').split('/').filter(Boolean));

    const patterns = effectiveSubpath
      ? [`${effectiveSubpath}/SKILL.md`, `${effectiveSubpath}/**/SKILL.md`]
      : ['SKILL.md', '**/SKILL.md'];

    let skillMdPaths = null;

    // Fast path: sparse checkout only SKILL.md files, then parse from disk.
    // This avoids one `git show` per skill.
    const sparseInit = await runGit(['-C', tempBase, 'sparse-checkout', 'init', '--no-cone'], { timeoutMs: 15_000 });
    if (sparseInit.ok) {
      const sparseSet = await runGit(['-C', tempBase, 'sparse-checkout', 'set', ...patterns], { timeoutMs: 30_000 });
      if (sparseSet.ok) {
        const checkout = await runGit(['-C', tempBase, 'checkout', '--force', 'HEAD'], { ...remoteGitOptions, timeoutMs: 60_000 });
        if (checkout.ok) {
          const lsFiles = await runGit(['-C', tempBase, 'ls-files'], { timeoutMs: 15_000 });
          if (lsFiles.ok) {
            skillMdPaths = lsFiles.stdout
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
              .filter((p) => p.endsWith('/SKILL.md') || p === 'SKILL.md');
          }
        }
      }
    }

    // Fallback: list tree and read SKILL.md blobs via git.
    if (!Array.isArray(skillMdPaths)) {
      const listArgs = ['-C', tempBase, 'ls-tree', '-r', '--name-only', 'HEAD'];
      if (effectiveSubpath) {
        listArgs.push('--', effectiveSubpath);
      }

      const listResult = await runGit(listArgs, { timeoutMs: 30_000 });
      if (!listResult.ok) {
        // If subpath doesn't exist, treat as empty scan.
        return {
          ok: true,
          normalizedRepo: parsed.normalizedRepo,
          effectiveSubpath,
          items: [],
        };
      }

      skillMdPaths = listResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((p) => p.endsWith('/SKILL.md') || p === 'SKILL.md');
    }

    // Root-level SKILL.md doesn't map cleanly to OpenCode's "skill name == folder name" convention.
    const uniqueSkillDirs = Array.from(
      new Set(
        skillMdPaths
          .filter((p) => p !== 'SKILL.md')
          .map((p) => path.posix.dirname(p))
      )
    );

    const items = [];
    const maxParallel = 10;
    let idx = 0;

    const worker = async () => {
      while (idx < uniqueSkillDirs.length) {
        const skillDir = uniqueSkillDirs[idx++];
        const skillName = path.posix.basename(skillDir);
        const skillMdPath = path.posix.join(skillDir, 'SKILL.md');

        const warnings = [];
        let skillMdContent = '';
        let skillMdTooLarge = false;

        // Prefer filesystem reads when sparse checkout succeeded.
        const filePath = toFsPath(skillMdPath);
        try {
          const diskRead = await readSkillMdFile(filePath);
          if (diskRead.tooLarge) {
            skillMdTooLarge = true;
            warnings.push(SKILL_MD_TOO_LARGE_WARNING);
          } else {
            skillMdContent = diskRead.content;
          }
        } catch {
          const showResult = await runGit(['-C', tempBase, 'show', `HEAD:${skillMdPath}`], { ...remoteGitOptions, timeoutMs: 15_000 });
          if (!showResult.ok && isGitOutputTooLarge(showResult)) {
            skillMdTooLarge = true;
            warnings.push(SKILL_MD_TOO_LARGE_WARNING);
          } else if (!showResult.ok) {
            warnings.push('Failed to read SKILL.md');
          } else {
            skillMdContent = showResult.stdout;
          }
        }

        // An oversized file was skipped, not read: parsing its empty
        // content would report a bogus missing-frontmatter warning.
        const parsedMd = skillMdTooLarge ? { frontmatter: {}, warnings: [] } : parseSkillMd(skillMdContent);
        warnings.push(...(parsedMd.warnings || []));

        const description = typeof parsedMd.frontmatter?.description === 'string' ? parsedMd.frontmatter.description : undefined;
        const frontmatterName = typeof parsedMd.frontmatter?.name === 'string' ? parsedMd.frontmatter.name : undefined;

        const installable = validateSkillName(skillName);
        if (!installable) {
          warnings.push('Skill directory name is not a valid OpenCode skill name');
        }

        items.push({
          repoSource: source,
          repoSubpath: effectiveSubpath || undefined,
          skillDir,
          skillName,
          frontmatterName,
          description,
          installable,
          warnings: warnings.length ? warnings : undefined,
        });
      }
    };

    await Promise.all(Array.from({ length: Math.min(maxParallel, uniqueSkillDirs.length || 1) }, () => worker()));

    // Stable ordering for UX
    items.sort((a, b) => a.skillName.localeCompare(b.skillName));

    return {
      ok: true,
      normalizedRepo: parsed.normalizedRepo,
      effectiveSubpath,
      items,
    };
  } finally {
    await safeRm(tempBase);
  }
}
