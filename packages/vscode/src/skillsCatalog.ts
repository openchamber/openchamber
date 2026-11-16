import { OPENCODE_CONFIG_DIR } from './opencodeConfigPaths';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import yaml from 'yaml';

import { discoverSkills } from './opencodeConfig';
import { readEnterprisePolicy } from '../../web/server/lib/enterprise-mode.js';
import { isInstalledFromSource, readInstalledSources } from '../../web/server/lib/skills-catalog/installed-sources.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

// Same gate as the web scan: a clone-controlled SKILL.md is never buffered
// whole past the 4 MiB cap the git-show fallback already enforces.
const SKILL_MD_MAX_BYTES = DEFAULT_MAX_BUFFER;
const SKILL_MD_TOO_LARGE_WARNING = 'SKILL.md is larger than the 4 MiB size limit; skipped';

// Mirror of the web copy caps (packages/web/server/lib/skills-catalog/install.js):
// a skill is a SKILL.md plus small supporting assets, so entries (files and
// directories) and total bytes are bounded, and no single file may exceed the
// same 1 MiB limit the loader enforces when it reads a supporting file.
const SKILL_COPY_MAX_ENTRIES = 1_000;
const SKILL_COPY_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const SKILL_SUPPORTING_FILE_MAX_BYTES = 1024 * 1024;

// Mirror of readSkillMdFile in the web scan: open once and read from the
// handle so a symlink to a device or FIFO (stat size 0) cannot make the
// read unbounded; a non-regular file throws so the caller falls back to
// git show.
function isGitOutputTooLarge(result: { message?: string }): boolean {
  return /maxbuffer/i.test(String(result?.message || ''));
}

async function readSkillMdFile(filePath: string): Promise<{ tooLarge: boolean; content: string }> {
  // O_NONBLOCK (POSIX only): open() must not block on a FIFO with no writer
  // before handle.stat() can reject it as non-regular.
  const openFlags = process.platform === 'win32' ? 'r' : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
  const handle = await fs.promises.open(filePath, openFlags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`SKILL.md is not a regular file: ${filePath}`);
    }
    if (stat.size > SKILL_MD_MAX_BYTES) {
      return { tooLarge: true, content: '' };
    }
    const buffer = Buffer.alloc(SKILL_MD_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > SKILL_MD_MAX_BYTES) {
      return { tooLarge: true, content: '' };
    }
    return { tooLarge: false, content: buffer.toString('utf8', 0, total) };
  } finally {
    await handle.close();
  }
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

type SkillScope = 'user' | 'project';
type SkillInstallSource = 'opencode' | 'agents';

export type SkillsCatalogSourceConfig = {
  id: string;
  label: string;
  description?: string;
  source: string;
  defaultSubpath?: string;
};

type CuratedSource = SkillsCatalogSourceConfig;

type SkillFrontmatter = {
  name?: unknown;
  description?: unknown;
  [key: string]: unknown;
};

type SkillsCatalogItem = {
  repoSource: string;
  repoSubpath?: string;
  skillDir: string;
  skillName: string;
  frontmatterName?: string;
  description?: string;
  installable: boolean;
  warnings?: string[];
};
type SkillsCatalogItemWithBadge = SkillsCatalogItem & {
  sourceId: string;
  installed: { isInstalled: boolean; scope?: SkillScope; source?: SkillInstallSource };
};

type SkillsRepoError =
  | { kind: 'authRequired'; message: string; sshOnly: boolean }
  | { kind: 'invalidSource'; message: string }
  | { kind: 'gitUnavailable'; message: string }
  | { kind: 'networkError'; message: string }
  | { kind: 'unknown'; message: string }
  | { kind: 'conflicts'; message: string; conflicts: Array<{ skillName: string; scope: SkillScope; source?: SkillInstallSource }> };

type SkillsRepoScanResult =
  | { ok: true; items: SkillsCatalogItem[] }
  | { ok: false; error: SkillsRepoError };

type SkillsInstallResult =
  | { ok: true; installed: Array<{ skillName: string; skillDir: string; scope: SkillScope; source?: SkillInstallSource }>; skipped: Array<{ skillName: string; reason: string }> }
  | { ok: false; error: SkillsRepoError };

const CURATED_SOURCES: CuratedSource[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: "Anthropic's public skills repository",
    source: 'anthropics/skills',
    defaultSubpath: 'skills',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: "OpenAI's curated skills",
    source: 'openai/skills',
    defaultSubpath: 'skills/.curated',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    description: "Cursor's plugin skills",
    source: 'cursor/plugins',
    defaultSubpath: 'pstack/skills',
  },
  {
    id: 'mattpocock',
    label: 'Matt Pocock',
    description: 'Matt Pocock skills collection',
    source: 'mattpocock/skills',
  },
];

function validateSkillName(skillName: string): boolean {
  if (skillName.length < 1 || skillName.length > 64) return false;
  return SKILL_NAME_PATTERN.test(skillName);
}

function looksLikeAuthError(message: string): boolean {
  return (
    /permission denied/i.test(message) ||
    /publickey/i.test(message) ||
    /could not read from remote repository/i.test(message) ||
    /authentication failed/i.test(message)
  );
}

async function runGit(args: string[], options?: { cwd?: string; timeoutMs?: number }) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: options?.cwd,
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    return { ok: true as const, stdout: stdout || '', stderr: stderr || '' };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false as const,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : '',
      message: typeof err.message === 'string' ? err.message : 'Git command failed',
    };
  }
}

async function assertGitAvailable() {
  const result = await runGit(['--version'], { timeoutMs: 5_000 });
  if (!result.ok) {
    return { ok: false as const, error: { kind: 'gitUnavailable' as const, message: 'Git is not available in PATH' } };
  }
  return { ok: true as const };
}

// Same rules as the server (web/server/lib/skills-catalog/source.js): a branch
// or tag after `#`, never starting with `-` and never holding `..`.
const GIT_REF_PATTERN = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

function parseSkillRepoSource(input: string, subpath?: string) {
  const trimmed = (input || '').trim();
  const hashIndex = trimmed.lastIndexOf('#');
  const raw = hashIndex >= 0 ? trimmed.slice(0, hashIndex).trim() : trimmed;
  const ref = hashIndex >= 0 ? trimmed.slice(hashIndex + 1).trim() || null : null;
  if (ref !== null && !GIT_REF_PATTERN.test(ref)) {
    return { ok: false as const, error: { kind: 'invalidSource' as const, message: `Invalid branch or tag "${ref}"` } };
  }
  if (!raw) {
    return { ok: false as const, error: { kind: 'invalidSource' as const, message: 'Repository source is required' } };
  }
  const urlFormat = raw.startsWith('https://') ? 'https' : raw.startsWith('git@') ? 'ssh' : 'shorthand';
  const gitHost = urlFormat === 'https' ? raw.split('/')[2] : urlFormat === 'ssh' ? raw.split('@')[1].split(':')[0] : null;

  if (gitHost === null && urlFormat !== 'shorthand') {
    return { ok: false as const, error: { kind: 'invalidSource' as const, message: 'Unsupported repository source format'} };
  }

  const pathSegments = urlFormat === 'https'
    ? raw.split('/').slice(3).filter(Boolean)
    : urlFormat === 'ssh'
      ? (raw.split('@')[1].split(':')[1] ?? '').split('/').filter(Boolean)
      : null;

  const repoName = pathSegments && pathSegments.length > 0
    ? pathSegments[pathSegments.length - 1].replace(/\.git$/i, '')
    : null;

  const gitOwner = pathSegments && pathSegments.length > 1
    ? pathSegments.slice(0, -1).join('/')
    : (pathSegments && pathSegments.length === 1 ? pathSegments[0] : null);

  const explicitSubpath = subpath?.trim() ? subpath.trim() : null;

  if (urlFormat === 'ssh' || urlFormat === 'https') {
    const owner = (gitOwner || '').trim();
    const repo = (repoName || '').trim();

    if (!owner || !repo) {
      return { ok: false as const, error: { kind: 'invalidSource' as const, message: `Invalid ${urlFormat} repository format.` } };
    }

    return {
      ok: true as const,
      normalizedRepo: `${owner}/${repo}`,
      cloneUrlHttps: `https://${gitHost}/${owner}/${repo}.git`,
      cloneUrlSsh: `git@${gitHost}:${owner}/${repo}.git`,
      effectiveSubpath: explicitSubpath,
      ref,
    }
  }

  const shorthandMatch = raw.match(/^([^/\s]+)\/([^/\s]+)(?:\/(.+))?$/);
  if (shorthandMatch) {
    const owner = shorthandMatch[1];
    const repo = shorthandMatch[2].replace(/\.git$/i, '');
    const shorthandSubpath = shorthandMatch[3]?.trim() || null;
    return {
      ok: true as const,
      normalizedRepo: `${owner}/${repo}`,
      cloneUrlHttps: `https://github.com/${owner}/${repo}.git`,
      cloneUrlSsh: `git@github.com:${owner}/${repo}.git`,
      effectiveSubpath: explicitSubpath || shorthandSubpath,
      ref,
    };
  }

  return { ok: false as const, error: { kind: 'invalidSource' as const, message: 'Unsupported repository source format' } };
}

function parseSkillMd(content: string): { frontmatter: SkillFrontmatter; warnings: string[] } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return {
      frontmatter: {},
      warnings: ['Invalid SKILL.md: missing YAML frontmatter delimiter'],
    };
  }

  try {
    const parsed = yaml.parse(match[1]);
    const frontmatter = parsed && typeof parsed === 'object' ? (parsed as SkillFrontmatter) : {};
    return { frontmatter, warnings: [] };
  } catch {
    return {
      frontmatter: {},
      warnings: ['Invalid SKILL.md: failed to parse YAML frontmatter'],
    };
  }
}

async function safeRm(dir: string) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function cloneRepo(cloneUrl: string, targetDir: string, ref: string | null = null) {
  const branch = ref ? ['--branch', ref] : [];
  const preferred = ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', ...branch, cloneUrl, targetDir];
  const fallback = ['clone', '--depth', '1', '--no-checkout', ...branch, cloneUrl, targetDir];

  const result = await runGit(preferred, { timeoutMs: 60_000 });
  if (result.ok) return { ok: true as const };

  const fallbackResult = await runGit(fallback, { timeoutMs: 60_000 });
  if (fallbackResult.ok) return { ok: true as const };

  const combined = `${fallbackResult.stderr}\n${fallbackResult.message}`.trim();
  if (looksLikeAuthError(combined)) {
    return {
      ok: false as const,
      error: {
        kind: 'authRequired' as const,
        message: 'Private repositories are not supported in VS Code yet. Use Desktop/Web.',
        sshOnly: true,
      },
    };
  }

  return { ok: false as const, error: { kind: 'networkError' as const, message: combined || 'Failed to clone repository' } };
}

export async function scanSkillsRepository(options: { source: string; subpath?: string; defaultSubpath?: string }): Promise<SkillsRepoScanResult> {
  const gitCheck = await assertGitAvailable();
  if (!gitCheck.ok) {
    return { ok: false as const, error: gitCheck.error };
  }

  const parsed = parseSkillRepoSource(options.source, options.subpath);
  if (!parsed.ok) {
    return { ok: false as const, error: parsed.error };
  }

  const effectiveSubpath = parsed.effectiveSubpath || options.defaultSubpath || null;
  const tempBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-vscode-skills-scan-'));

  try {
    const cloned = await cloneRepo(parsed.cloneUrlHttps, tempBase, parsed.ref);
    if (!cloned.ok) {
      return { ok: false as const, error: cloned.error };
    }

    const toFsPath = (posixPath: string) => path.join(tempBase, ...posixPath.split('/').filter(Boolean));

    const patterns = effectiveSubpath
      ? [`${effectiveSubpath}/SKILL.md`, `${effectiveSubpath}/**/SKILL.md`]
      : ['SKILL.md', '**/SKILL.md'];

    let skillMdPaths: string[] | null = null;

    const sparseInit = await runGit(['-C', tempBase, 'sparse-checkout', 'init', '--no-cone'], { timeoutMs: 15_000 });
    if (sparseInit.ok) {
      const sparseSet = await runGit(['-C', tempBase, 'sparse-checkout', 'set', ...patterns], { timeoutMs: 30_000 });
      if (sparseSet.ok) {
        const checkout = await runGit(['-C', tempBase, 'checkout', '--force', 'HEAD'], { timeoutMs: 60_000 });
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

    if (!Array.isArray(skillMdPaths)) {
      const listArgs = ['-C', tempBase, 'ls-tree', '-r', '--name-only', 'HEAD'];
      if (effectiveSubpath) {
        listArgs.push('--', effectiveSubpath);
      }

      const list = await runGit(listArgs, { timeoutMs: 30_000 });
      if (!list.ok) {
        return { ok: true as const, items: [] as SkillsCatalogItem[] };
      }

      skillMdPaths = list.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((p) => p.endsWith('/SKILL.md') || p === 'SKILL.md');
    }

    const skillDirs = Array.from(new Set(skillMdPaths.filter((p) => p !== 'SKILL.md').map((p) => path.posix.dirname(p))));

    const items: SkillsCatalogItem[] = [];

    for (const skillDir of skillDirs) {
      const skillName = path.posix.basename(skillDir);
      const skillMdPath = path.posix.join(skillDir, 'SKILL.md');

      const warnings: string[] = [];
      let content = '';
      let skillMdTooLarge = false;

      try {
        const diskRead = await readSkillMdFile(toFsPath(skillMdPath));
        if (diskRead.tooLarge) {
          skillMdTooLarge = true;
          warnings.push(SKILL_MD_TOO_LARGE_WARNING);
        } else {
          content = diskRead.content;
        }
      } catch {
        const show = await runGit(['-C', tempBase, 'show', `HEAD:${skillMdPath}`], { timeoutMs: 15_000 });
        if (!show.ok && isGitOutputTooLarge(show)) {
          skillMdTooLarge = true;
          warnings.push(SKILL_MD_TOO_LARGE_WARNING);
        } else if (!show.ok) {
          warnings.push('Failed to read SKILL.md');
        } else {
          content = show.stdout;
        }
      }

      // An oversized file was skipped, not read: parsing its empty
      // content would report a bogus missing-frontmatter warning.
      const parsedMd: ReturnType<typeof parseSkillMd> = skillMdTooLarge ? { frontmatter: {}, warnings: [] } : parseSkillMd(content);
      warnings.push(...parsedMd.warnings);

      const description = typeof parsedMd.frontmatter.description === 'string' ? parsedMd.frontmatter.description : undefined;
      const frontmatterName = typeof parsedMd.frontmatter.name === 'string' ? parsedMd.frontmatter.name : undefined;

      const installable = validateSkillName(skillName);
      if (!installable) {
        warnings.push('Skill directory name is not a valid OpenCode skill name');
      }

      items.push({
        repoSource: options.source,
        repoSubpath: effectiveSubpath || undefined,
        skillDir,
        skillName,
        frontmatterName,
        description,
        installable,
        warnings: warnings.length ? warnings : undefined,
      });
    }

    items.sort((a, b) => String(a.skillName).localeCompare(String(b.skillName)));

    return { ok: true as const, items };
  } finally {
    await safeRm(tempBase);
  }
}

export async function copyDirectoryNoSymlinks(srcDir: string, dstDir: string) {
  const srcReal = await fs.promises.realpath(srcDir);

  const ensureDir = async (dirPath: string) => {
    await fs.promises.mkdir(dirPath, { recursive: true });
  };

  const copyState = { entries: 0, bytes: 0 };
  const countEntry = (stat: fs.Stats, name?: string) => {
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

  const walk = async (currentSrc: string, currentDst: string) => {
    const entries = await fs.promises.readdir(currentSrc, { withFileTypes: true });
    for (const entry of entries) {
      const nextSrc = path.join(currentSrc, entry.name);
      const nextDst = path.join(currentDst, entry.name);

      const stat = await fs.promises.lstat(nextSrc);
      if (stat.isSymbolicLink()) {
        throw new Error('Symlinks are not supported in skills');
      }

      const nextRealParent = await fs.promises.realpath(path.dirname(nextSrc));
      if (!nextRealParent.startsWith(srcReal)) {
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
          // best-effort
        }
      }
    }
  };

  await ensureDir(dstDir);
  await walk(srcDir, dstDir);
}

function getUserSkillBaseDir() {
  const pluralPath = path.join(OPENCODE_CONFIG_DIR, 'skills');
  const legacyPath = path.join(OPENCODE_CONFIG_DIR, 'skill');
  if (fs.existsSync(legacyPath) && !fs.existsSync(pluralPath)) return legacyPath;
  return pluralPath;
}

function toFsPath(repoDir: string, repoRelPosixPath: string) {
  const parts = repoRelPosixPath.split('/').filter(Boolean);
  return path.join(repoDir, ...parts);
}

export async function installSkillsFromRepository(options: {
  source: string;
  subpath?: string;
  scope: SkillScope;
  targetSource?: SkillInstallSource;
  workingDirectory?: string;
  selections: Array<{ skillDir: string }>;
  conflictPolicy?: 'prompt' | 'skipAll' | 'overwriteAll';
  conflictDecisions?: Record<string, 'skip' | 'overwrite'>;
}): Promise<SkillsInstallResult> { 
  const gitCheck = await assertGitAvailable();
  if (!gitCheck.ok) {
    return { ok: false as const, error: gitCheck.error };
  }

  if (options.scope === 'project' && !options.workingDirectory) {
    return { ok: false as const, error: { kind: 'invalidSource' as const, message: 'Project installs require a directory parameter' } };
  }

  const parsed = parseSkillRepoSource(options.source, options.subpath);
  if (!parsed.ok) {
    return { ok: false as const, error: parsed.error };
  }

  const requestedDirs = options.selections.map((s) => String(s.skillDir || '').trim()).filter(Boolean);
  if (requestedDirs.length === 0) {
    return { ok: false as const, error: { kind: 'invalidSource' as const, message: 'No skills selected for installation' } };
  }

  const userSkillDir = getUserSkillBaseDir();
  const targetSource: SkillInstallSource = options.targetSource === 'agents' ? 'agents' : 'opencode';

  const skillPlans = requestedDirs.map((dir) => {
    const skillName = path.posix.basename(dir);
    return { skillDirPosix: dir, skillName, installable: validateSkillName(skillName) };
  });

  const conflicts: Array<{ skillName: string; scope: SkillScope; source?: SkillInstallSource }> = [];
  for (const plan of skillPlans) {
    if (!plan.installable) continue;
    const targetDir = options.scope === 'user'
      ? (targetSource === 'agents'
        ? path.join(os.homedir(), '.agents', 'skills', plan.skillName)
        : path.join(userSkillDir, plan.skillName))
      : (targetSource === 'agents'
        ? path.join(options.workingDirectory as string, '.agents', 'skills', plan.skillName)
        : path.join(options.workingDirectory as string, '.opencode', 'skills', plan.skillName));

    if (fs.existsSync(targetDir)) {
      const decision = options.conflictDecisions?.[plan.skillName];
      const hasAutoPolicy = options.conflictPolicy === 'skipAll' || options.conflictPolicy === 'overwriteAll';
      if (!decision && !hasAutoPolicy) {
        conflicts.push({ skillName: plan.skillName, scope: options.scope, source: targetSource });
      }
    }
  }

  if (conflicts.length > 0) {
    return {
      ok: false as const,
      error: { kind: 'conflicts' as const, message: 'Some skills already exist in the selected scope', conflicts },
    };
  }

  const tempBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-vscode-skills-install-'));

  try {
    const cloned = await cloneRepo(parsed.cloneUrlHttps, tempBase, parsed.ref);
    if (!cloned.ok) {
      return { ok: false as const, error: cloned.error };
    }

    await runGit(['-C', tempBase, 'sparse-checkout', 'init', '--cone'], { timeoutMs: 15_000 });
    const setResult = await runGit(['-C', tempBase, 'sparse-checkout', 'set', ...requestedDirs], { timeoutMs: 30_000 });
    if (!setResult.ok) {
      return { ok: false as const, error: { kind: 'unknown' as const, message: setResult.stderr || setResult.message || 'Failed to configure sparse checkout' } };
    }

    const checkoutResult = await runGit(['-C', tempBase, 'checkout', '--force', 'HEAD'], { timeoutMs: 60_000 });
    if (!checkoutResult.ok) {
      return { ok: false as const, error: { kind: 'unknown' as const, message: checkoutResult.stderr || checkoutResult.message || 'Failed to checkout repository' } };
    }

    const installed: Array<{ skillName: string; skillDir: string; scope: SkillScope; source?: SkillInstallSource }> = [];
    const skipped: Array<{ skillName: string; reason: string }> = [];

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

      const targetDir = options.scope === 'user'
        ? (targetSource === 'agents'
          ? path.join(os.homedir(), '.agents', 'skills', plan.skillName)
          : path.join(userSkillDir, plan.skillName))
        : (targetSource === 'agents'
          ? path.join(options.workingDirectory as string, '.agents', 'skills', plan.skillName)
          : path.join(options.workingDirectory as string, '.opencode', 'skills', plan.skillName));

      const exists = fs.existsSync(targetDir);
      let decision = options.conflictDecisions?.[plan.skillName] || null;
      if (!decision) {
        if (exists && options.conflictPolicy === 'skipAll') decision = 'skip';
        if (exists && options.conflictPolicy === 'overwriteAll') decision = 'overwrite';
        if (!exists) decision = 'overwrite';
      }

      if (exists && decision === 'skip') {
        skipped.push({ skillName: plan.skillName, reason: 'Already installed (skipped)' });
        continue;
      }

      if (exists && decision === 'overwrite') {
        await safeRm(targetDir);
      }

      await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });

      try {
        await copyDirectoryNoSymlinks(srcDir, targetDir);
        installed.push({ skillName: plan.skillName, skillDir: plan.skillDirPosix, scope: options.scope, source: targetSource });
      } catch (error) {
        await safeRm(targetDir);
        skipped.push({
          skillName: plan.skillName,
          reason: error instanceof Error ? error.message : 'Failed to copy skill files',
        });
      }
    }

    return { ok: true as const, installed, skipped };
  } finally {
    await safeRm(tempBase);
  }
}

export const catalogCache = new Map<string, { expiresAt: number; items: SkillsCatalogItem[] }>();
const CATALOG_TTL_MS = 30 * 60 * 1000;
export const CATALOG_CACHE_MAX_ENTRIES = 500;

// The TTL bounds freshness, not retention: without a sweep, an entry for a
// source that is never requested again stays for the life of the extension
// host, items array and all. Mirror pruneNpmInfoCache in opencodeConfig.ts:
// expired entries are swept and the cache is capped oldest-first whenever
// the catalog is read or a fresh entry lands.
export const pruneCatalogCache = (now = Date.now()): void => {
  for (const [cacheKey, entry] of catalogCache) {
    if (now >= entry.expiresAt) {
      catalogCache.delete(cacheKey);
    }
  }
  while (catalogCache.size > CATALOG_CACHE_MAX_ENTRIES) {
    const oldest = catalogCache.keys().next().value;
    if (oldest === undefined) break;
    catalogCache.delete(oldest);
  }
};

export const clearCatalogCacheForTests = (): void => {
  catalogCache.clear();
};

export async function getSkillsCatalog(
  workingDirectory?: string,
  refresh?: boolean,
  additionalSources?: SkillsCatalogSourceConfig[],
  installedSkills?: Array<{ name: string; scope: SkillScope; source?: 'opencode' | 'agents' | 'claude' }>
) {
  pruneCatalogCache();
  // The machine policy can hide the built-in catalogs (see enterprise-mode.js).
  const curated = readEnterprisePolicy().hideBuiltinSkillCatalogs ? [] : CURATED_SOURCES;
  const sources = [...curated, ...(Array.isArray(additionalSources) ? additionalSources : [])];
  const discovered = Array.isArray(installedSkills) ? installedSkills : discoverSkills(workingDirectory);
  const installedByName = new Map(discovered.map((s) => [s.name, s]));
  // Same source-aware rule as the web catalog route (#4756).
  const provenanceByName = readInstalledSources();

  const itemsBySource: Record<string, SkillsCatalogItemWithBadge[]> = {};

  for (const src of sources) {
    const parsed = parseSkillRepoSource(src.source);
    if (!parsed.ok) {
      itemsBySource[src.id] = [];
      continue;
    }

    const effectiveSubpath = src.defaultSubpath || parsed.effectiveSubpath || '';
    const cacheKey = `${parsed.normalizedRepo}${parsed.ref ? `#${parsed.ref}` : ''}::${effectiveSubpath}`;

    let cached = !refresh ? catalogCache.get(cacheKey) : null;
    if (cached && Date.now() >= cached.expiresAt) {
      catalogCache.delete(cacheKey);
      cached = null;
    }

    let items: SkillsCatalogItem[] = [];
    if (cached) {
      items = cached.items;
    } else {
      const scanned = await scanSkillsRepository({ source: src.source, defaultSubpath: src.defaultSubpath });
      if (!scanned.ok) {
        itemsBySource[src.id] = [];
        continue;
      }
      items = scanned.items || [];
      catalogCache.set(cacheKey, { expiresAt: Date.now() + CATALOG_TTL_MS, items });
      pruneCatalogCache();
    }

    itemsBySource[src.id] = items.map((item) => {
      const installed = installedByName.get(item.skillName);
      return {
        sourceId: src.id,
        ...item,
        installed: installed && isInstalledFromSource(provenanceByName, item.skillName, src.id, item.skillDir) ? { isInstalled: true, scope: installed.scope, source: installed.source === 'agents' ? 'agents' : 'opencode' } : { isInstalled: false },
      };
    });
  }

  return { ok: true as const, sources, itemsBySource };
}
