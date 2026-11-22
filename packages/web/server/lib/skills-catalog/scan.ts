import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';

import { assertGitAvailable, looksLikeAuthError, runGit } from './git.js';
import { parseSkillRepoSource } from './source.js';
import { readBoundedFile } from '../shared/bounded-file-read.js';
import { removeDirectory, removeStaleCatalogFolders } from './remove-directory.js';
import type { CatalogGitOptions, GitResult } from './git.js';
import type { JsonValue } from '../shared/json-values.js';

interface CatalogCloneOptions extends Pick<CatalogGitOptions, 'identity' | 'credentialResolver'> {
  cloneUrl: string;
  tempDir: string;
  ref?: string | null;
}

type CatalogCloneResult = { ok: true } | { ok: false; error: GitResult };

export interface SkillsScanOptions extends Pick<CatalogGitOptions, 'identity' | 'credentialResolver'> {
  source?: string | undefined;
  subpath?: JsonValue | undefined;
  defaultSubpath?: string | undefined;
}

export interface SkillsCatalogItem {
  repoSource: string;
  repoSubpath: string | undefined;
  skillDir: string;
  skillName: string;
  frontmatterName: string | undefined;
  description: string | undefined;
  installable: boolean;
  warnings: string[] | undefined;
}

export type SkillsScanResult = {
  ok: true;
  normalizedRepo: string;
  effectiveSubpath: string | null;
  items: SkillsCatalogItem[];
} | {
  ok: false;
  error: { kind: 'gitUnavailable' | 'invalidSource' | 'authRequired' | 'networkError'; message: string };
};

const hasDescription = (value: unknown): value is { description: string } =>
  value !== null && typeof value === 'object' && 'description' in value && typeof value.description === 'string';

const hasName = (value: unknown): value is { name: string } =>
  value !== null && typeof value === 'object' && 'name' in value && typeof value.name === 'string';

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

// A catalog SKILL.md is clone-controlled content; never buffer one whole
// past the same 4 MiB cap the git-show fallback already enforces
// (DEFAULT_MAX_BUFFER in git.js).
export const SKILL_MD_MAX_BYTES = 4 * 1024 * 1024;
const SKILL_MD_TOO_LARGE_WARNING = 'SKILL.md is larger than the 4 MiB size limit; skipped';

// A failed git-show whose output exceeded the exec maxBuffer is an
// over-cap SKILL.md, not a generic read failure.
export function isGitOutputTooLarge(result: unknown) {
  if (!result || typeof result !== 'object') return false;
  if ('code' in result && result.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return true;
  return /maxbuffer/i.test(String('message' in result ? result.message || '' : ''));
}

export async function readSkillMdFile(filePath: string) {
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
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), { code: 'ENOENT' });
  }
  throw new Error(`SKILL.md is not a regular file: ${filePath}`);
}

function validateSkillName(skillName: string) {
  if (skillName.length < 1 || skillName.length > 64) return false;
  return SKILL_NAME_PATTERN.test(skillName);
}

function parseSkillMd(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return {
      ok: true,
      frontmatter: {},
      warnings: ['Invalid SKILL.md: missing YAML frontmatter delimiter'],
    };
  }

  try {
    const frontmatter: unknown = yaml.parse(match[1] ?? '') || {};
    return { ok: true, frontmatter, warnings: [] };
  } catch {
    return {
      ok: true,
      frontmatter: {},
      warnings: ['Invalid SKILL.md: failed to parse YAML frontmatter'],
    };
  }
}

async function cloneRepo({ cloneUrl, identity, credentialResolver, tempDir, ref = null }: CatalogCloneOptions): Promise<CatalogCloneResult> {
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
  source = '',
  subpath,
  defaultSubpath,
  identity,
  credentialResolver,
}: SkillsScanOptions = {}): Promise<SkillsScanResult> {
  const gitCheck = await assertGitAvailable();
  if (!gitCheck.ok) {
    return { ok: false, error: gitCheck.error };
  }

  const parsed = parseSkillRepoSource(source, { subpath });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const effectiveSubpath = parsed.effectiveSubpath || (defaultSubpath?.trim() || null);
  const cloneUrl = identity?.transport === 'ssh' ? parsed.cloneUrlSsh : parsed.cloneUrlHttps;
  const remoteGitOptions = { identity, credentialResolver };

  void removeStaleCatalogFolders();
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

    const toFsPath = (posixPath: string) => path.join(tempBase, ...String(posixPath || '').split('/').filter(Boolean));

    const patterns = effectiveSubpath
      ? [`${effectiveSubpath}/SKILL.md`, `${effectiveSubpath}/**/SKILL.md`]
      : ['SKILL.md', '**/SKILL.md'];

    let skillMdPaths: string[] | null = null;

    const sparseInit = await runGit(['-C', tempBase, 'sparse-checkout', 'init', '--no-cone'], { timeoutMs: 15_000 });
    if (sparseInit.ok) {
      const sparseSet = await runGit(['-C', tempBase, 'sparse-checkout', 'set', ...patterns], { timeoutMs: 30_000 });
      if (sparseSet.ok) {
        const checkout = await runGit(['-C', tempBase, 'checkout', '--force', 'HEAD'], { ...remoteGitOptions, timeoutMs: 60_000 });
        if (checkout.ok) {
          const lsFilesArgs = ['-C', tempBase, 'ls-files'];
          if (effectiveSubpath) {
            lsFilesArgs.push('--', effectiveSubpath);
          }
          const lsFiles = await runGit(lsFilesArgs, { timeoutMs: 15_000 });
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

    if (!Array.isArray(skillMdPaths)) {
      const listArgs = ['-C', tempBase, 'ls-tree', '-r', '--name-only', 'HEAD'];
      if (effectiveSubpath) {
        listArgs.push('--', effectiveSubpath);
      }

      const listResult = await runGit(listArgs, { timeoutMs: 30_000 });
      if (!listResult.ok) {
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

    const uniqueSkillDirs = Array.from(
      new Set(
        skillMdPaths
          .filter((p) => p !== 'SKILL.md')
          .map((p) => path.posix.dirname(p))
      )
    );

    const items: SkillsCatalogItem[] = [];
    const maxParallel = 10;
    let idx = 0;

    const worker = async () => {
      while (idx < uniqueSkillDirs.length) {
        const skillDir = uniqueSkillDirs[idx++];
        if (skillDir === undefined) throw new Error('Missing skill directory');
        const skillName = path.posix.basename(skillDir);
        const skillMdPath = path.posix.join(skillDir, 'SKILL.md');

        const warnings: string[] = [];
        let skillMdContent = '';
        let skillMdTooLarge = false;

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

        const description = hasDescription(parsedMd.frontmatter) ? parsedMd.frontmatter.description : undefined;
        const frontmatterName = hasName(parsedMd.frontmatter) ? parsedMd.frontmatter.name : undefined;

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

    items.sort((a, b) => a.skillName.localeCompare(b.skillName));

    return {
      ok: true,
      normalizedRepo: parsed.normalizedRepo,
      effectiveSubpath,
      items,
    };
  } finally {
    await removeDirectory(tempBase);
  }
}
