import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import yaml from 'yaml';
import AdmZip from 'adm-zip';

import { discoverSkills } from './opencodeConfig';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

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

export type ClawdHubSkillMetadata = {
  slug: string;
  version: string;
  displayName?: string;
  owner?: string;
  downloads?: number;
  stars?: number;
};

export type SkillsCatalogItem = {
  repoSource: string;
  repoSubpath?: string;
  skillDir: string;
  skillName: string;
  frontmatterName?: string;
  description?: string;
  installable: boolean;
  warnings?: string[];
  clawdhub?: ClawdHubSkillMetadata;
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
  | { ok: true; installed: Array<{ skillName: string; scope: SkillScope; source?: SkillInstallSource }>; skipped: Array<{ skillName: string; reason: string }> }
  | { ok: false; error: SkillsRepoError };

export const CURATED_SOURCES: CuratedSource[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: "Anthropic's public skills repository",
    source: 'anthropics/skills',
    defaultSubpath: 'skills',
  },
  {
    id: 'clawdhub',
    label: 'ClawdHub',
    description: 'Community skill registry with vector search',
    source: 'clawdhub:registry',
  },
];

// ============== ClawdHub API ==============

const CLAWDHUB_API_BASE = 'https://clawdhub.com/api/v1';
const CLAWDHUB_PAGE_LIMIT = 25;
const CLAWDHUB_RATE_LIMIT_MS = 100;
let clawdhubLastRequest = 0;

function isClawdHubSource(source: string): boolean {
  return typeof source === 'string' && source.startsWith('clawdhub:');
}

async function clawdhubFetch(url: string, options?: RequestInit): Promise<Response> {
  const maxAttempts = 10;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const now = Date.now();
    const elapsed = now - clawdhubLastRequest;
    if (elapsed < CLAWDHUB_RATE_LIMIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, CLAWDHUB_RATE_LIMIT_MS - elapsed));
    }
    clawdhubLastRequest = Date.now();

    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenChamber-VSCode/1.0',
        ...options?.headers,
      },
    });

    lastResponse = response;

    if (response.status === 429 || response.status >= 500) {
      if (attempt < maxAttempts - 1) {
        const waitMs = 50 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
    }

    return response;
  }

  return lastResponse as Response;
}

type ClawdHubSkillListItem = {
  slug: string;
  displayName?: string;
  summary?: string;
  tags?: { latest?: string };
  latestVersion?: { version?: string };
  stats?: { downloads?: number; stars?: number };
  owner?: { handle?: string };
};

type ClawdHubSkillsResponse = {
  items: ClawdHubSkillListItem[];
  nextCursor?: string;
};

async function scanClawdHub(): Promise<SkillsRepoScanResult> {
  try {
    const allItems: SkillsCatalogItem[] = [];
    let cursor: string | null = null;
    const maxPages = 20;

    for (let page = 0; page < maxPages; page++) {
      const url = cursor
        ? `${CLAWDHUB_API_BASE}/skills?cursor=${encodeURIComponent(cursor)}&limit=${CLAWDHUB_PAGE_LIMIT}`
        : `${CLAWDHUB_API_BASE}/skills?limit=${CLAWDHUB_PAGE_LIMIT}`;

      let data: ClawdHubSkillsResponse;

      try {
        const response = await clawdhubFetch(url);
        if (!response.ok) {
          throw new Error(`ClawdHub API error: ${response.status}`);
        }

        data = (await response.json()) as ClawdHubSkillsResponse;
      } catch (error) {
        if (page > 0 && allItems.length > 0) {
          break;
        }
        throw error;
      }

      for (const item of data.items || []) {
        const latestVersion = item.tags?.latest || item.latestVersion?.version || '1.0.0';

        allItems.push({
          repoSource: 'clawdhub:registry',
          skillDir: item.slug,
          skillName: item.slug,
          frontmatterName: item.displayName || item.slug,
          description: item.summary || undefined,
          installable: true,
          clawdhub: {
            slug: item.slug,
            version: latestVersion,
            displayName: item.displayName,
            owner: item.owner?.handle,
            downloads: item.stats?.downloads || 0,
            stars: item.stats?.stars || 0,
          },
        });
      }

      if (!data.nextCursor) break;
      cursor = data.nextCursor;
    }

    // Sort by downloads (most popular first)
    allItems.sort((a, b) => (b.clawdhub?.downloads || 0) - (a.clawdhub?.downloads || 0));

    return { ok: true, items: allItems };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: 'networkError',
        message: error instanceof Error ? error.message : 'Failed to fetch skills from ClawdHub',
      },
    };
  }
}

async function downloadClawdHubSkill(slug: string, version: string): Promise<Buffer> {
  const url = `${CLAWDHUB_API_BASE}/download?slug=${encodeURIComponent(slug)}&version=${encodeURIComponent(version)}`;
  const response = await clawdhubFetch(url, { headers: { Accept: 'application/zip' } });

  if (!response.ok) {
    throw new Error(`ClawdHub download error: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

type ClawdHubSkillInfoResponse = {
  skill?: { tags?: { latest?: string } };
  latestVersion?: { version?: string };
};

async function fetchClawdHubSkillInfo(slug: string): Promise<ClawdHubSkillInfoResponse> {
  const url = `${CLAWDHUB_API_BASE}/skills/${encodeURIComponent(slug)}`;
  const response = await clawdhubFetch(url);

  if (!response.ok) {
    throw new Error(`ClawdHub skill error: ${response.status}`);
  }

  return response.json() as Promise<ClawdHubSkillInfoResponse>;
}

export async function installSkillsFromClawdHub(options: {
  scope: SkillScope;
  targetSource?: SkillInstallSource;
  workingDirectory?: string;
  selections: Array<{ skillDir: string; clawdhub?: { slug: string; version: string } }>;
  conflictPolicy?: 'prompt' | 'skipAll' | 'overwriteAll';
  conflictDecisions?: Record<string, 'skip' | 'overwrite'>;
}): Promise<SkillsInstallResult> {
  if (options.scope === 'project' && !options.workingDirectory) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Project installs require a directory parameter' } };
  }

  const userSkillDir = getUserSkillBaseDir();
  const targetSource: SkillInstallSource = options.targetSource === 'agents' ? 'agents' : 'opencode';
  const requestedSkills = options.selections || [];

  if (requestedSkills.length === 0) {
    return { ok: false, error: { kind: 'invalidSource', message: 'No skills selected for installation' } };
  }

  // Check for conflicts
  const conflicts: Array<{ skillName: string; scope: SkillScope; source?: SkillInstallSource }> = [];
  for (const sel of requestedSkills) {
    const slug = sel.clawdhub?.slug || sel.skillDir;
    if (!validateSkillName(slug)) continue;

    const targetDir = options.scope === 'user'
      ? (targetSource === 'agents'
        ? path.join(os.homedir(), '.agents', 'skills', slug)
        : path.join(userSkillDir, slug))
      : (targetSource === 'agents'
        ? path.join(options.workingDirectory as string, '.agents', 'skills', slug)
        : path.join(options.workingDirectory as string, '.opencode', 'skills', slug));

    if (fs.existsSync(targetDir)) {
      const decision = options.conflictDecisions?.[slug];
      const hasAutoPolicy = options.conflictPolicy === 'skipAll' || options.conflictPolicy === 'overwriteAll';
      if (!decision && !hasAutoPolicy) {
        conflicts.push({ skillName: slug, scope: options.scope, source: targetSource });
      }
    }
  }

  if (conflicts.length > 0) {
    return { ok: false, error: { kind: 'conflicts', message: 'Some skills already exist in the selected scope', conflicts } };
  }

  const installed: Array<{ skillName: string; scope: SkillScope; source?: SkillInstallSource }> = [];
  const skipped: Array<{ skillName: string; reason: string }> = [];

  for (const sel of requestedSkills) {
    const slug = sel.clawdhub?.slug || sel.skillDir;
    let version = sel.clawdhub?.version || 'latest';

    if (!validateSkillName(slug)) {
      skipped.push({ skillName: slug, reason: 'Invalid skill name' });
      continue;
    }

    try {
      // Resolve 'latest' version
    if (version === 'latest') {
      try {
        const info = await fetchClawdHubSkillInfo(slug);
        const latest = info.skill?.tags?.latest || info.latestVersion?.version || null;
        if (latest) {
          version = latest;
        }
      } catch {
        // ignore
      }

      if (version === 'latest') {
        skipped.push({ skillName: slug, reason: 'Unable to resolve latest version' });
        continue;
      }
    }

      const targetDir = options.scope === 'user'
        ? (targetSource === 'agents'
          ? path.join(os.homedir(), '.agents', 'skills', slug)
          : path.join(userSkillDir, slug))
        : (targetSource === 'agents'
          ? path.join(options.workingDirectory as string, '.agents', 'skills', slug)
          : path.join(options.workingDirectory as string, '.opencode', 'skills', slug));

      const exists = fs.existsSync(targetDir);
      let decision = options.conflictDecisions?.[slug] || null;
      if (!decision) {
        if (exists && options.conflictPolicy === 'skipAll') decision = 'skip';
        if (exists && options.conflictPolicy === 'overwriteAll') decision = 'overwrite';
        if (!exists) decision = 'overwrite';
      }

      if (exists && decision === 'skip') {
        skipped.push({ skillName: slug, reason: 'Already installed (skipped)' });
        continue;
      }

      if (exists && decision === 'overwrite') {
        await safeRm(targetDir);
      }

      // Download and extract
      const zipBuffer = await downloadClawdHubSkill(slug, version);
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `clawdhub-${slug}-`));

      try {
        const zip = new AdmZip(zipBuffer);
        zip.extractAllTo(tempDir, true);

        // Verify SKILL.md exists
        const skillMdPath = path.join(tempDir, 'SKILL.md');
        if (!fs.existsSync(skillMdPath)) {
          skipped.push({ skillName: slug, reason: 'SKILL.md not found in downloaded package' });
          continue;
        }

        // Move to target directory
        await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });
        await fs.promises.rename(tempDir, targetDir);

        installed.push({ skillName: slug, scope: options.scope, source: targetSource });
      } catch (extractError) {
        await safeRm(tempDir);
        throw extractError;
      }
    } catch (error) {
      skipped.push({
        skillName: slug,
        reason: error instanceof Error ? error.message : 'Failed to download or extract skill',
      });
    }
  }

  return { ok: true, installed, skipped };
}

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

function parseSkillRepoSource(input: string, subpath?: string) {
  const raw = (input || '').trim();
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

async function cloneRepo(cloneUrl: string, targetDir: string) {
  const preferred = ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', cloneUrl, targetDir];
  const fallback = ['clone', '--depth', '1', '--no-checkout', cloneUrl, targetDir];

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
    const cloned = await cloneRepo(parsed.cloneUrlHttps, tempBase);
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

      try {
        content = await fs.promises.readFile(toFsPath(skillMdPath), 'utf8');
      } catch {
        const show = await runGit(['-C', tempBase, 'show', `HEAD:${skillMdPath}`], { timeoutMs: 15_000 });
        if (!show.ok) {
          warnings.push('Failed to read SKILL.md');
        } else {
          content = show.stdout;
        }
      }

      const parsedMd = parseSkillMd(content);
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

async function copyDirectoryNoSymlinks(srcDir: string, dstDir: string) {
  const srcReal = await fs.promises.realpath(srcDir);

  const ensureDir = async (dirPath: string) => {
    await fs.promises.mkdir(dirPath, { recursive: true });
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
      }
    }
  };

  await ensureDir(dstDir);
  await walk(srcDir, dstDir);
}

function getUserSkillBaseDir() {
  const pluralPath = path.join(os.homedir(), '.config', 'opencode', 'skills');
  const legacyPath = path.join(os.homedir(), '.config', 'opencode', 'skill');
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
    const cloned = await cloneRepo(parsed.cloneUrlHttps, tempBase);
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

    const installed: Array<{ skillName: string; scope: SkillScope; source?: SkillInstallSource }> = [];
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
        installed.push({ skillName: plan.skillName, scope: options.scope, source: targetSource });
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

const catalogCache = new Map<string, { expiresAt: number; items: SkillsCatalogItem[] }>();
const CATALOG_TTL_MS = 30 * 60 * 1000;

export async function getSkillsCatalog(
  workingDirectory?: string,
  refresh?: boolean,
  additionalSources?: SkillsCatalogSourceConfig[],
  installedSkills?: Array<{ name: string; scope: SkillScope; source?: 'opencode' | 'agents' | 'claude' }>
) {
  const sources = [...CURATED_SOURCES, ...(Array.isArray(additionalSources) ? additionalSources : [])];
  const discovered = Array.isArray(installedSkills) ? installedSkills : discoverSkills(workingDirectory);
  const installedByName = new Map(discovered.map((s) => [s.name, s]));

  const itemsBySource: Record<string, SkillsCatalogItemWithBadge[]> = {};

  for (const src of sources) {
    // Handle ClawdHub sources separately (API-based, not git-based)
    if (isClawdHubSource(src.source)) {
      const cacheKey = 'clawdhub:registry';
      let cached = !refresh ? catalogCache.get(cacheKey) : null;
      if (cached && Date.now() >= cached.expiresAt) {
        catalogCache.delete(cacheKey);
        cached = null;
      }

      let items: SkillsCatalogItem[] = [];
      if (cached) {
        items = cached.items;
      } else {
        const scanned = await scanClawdHub();
        if (!scanned.ok) {
          itemsBySource[src.id] = [];
          continue;
        }
        items = scanned.items || [];
        catalogCache.set(cacheKey, { expiresAt: Date.now() + CATALOG_TTL_MS, items });
      }

      itemsBySource[src.id] = items.map((item) => {
        const installed = installedByName.get(item.skillName);
        return {
          sourceId: src.id,
          ...item,
          installed: installed ? { isInstalled: true, scope: installed.scope, source: installed.source === 'agents' ? 'agents' : 'opencode' } : { isInstalled: false },
        };
      });
      continue;
    }

    // Handle GitHub sources (git clone based)
    const parsed = parseSkillRepoSource(src.source);
    if (!parsed.ok) {
      itemsBySource[src.id] = [];
      continue;
    }

    const effectiveSubpath = src.defaultSubpath || parsed.effectiveSubpath || '';
    const cacheKey = `${parsed.normalizedRepo}::${effectiveSubpath}`;

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
    }

    itemsBySource[src.id] = items.map((item) => {
      const installed = installedByName.get(item.skillName);
      return {
        sourceId: src.id,
        ...item,
        installed: installed ? { isInstalled: true, scope: installed.scope, source: installed.source === 'agents' ? 'agents' : 'opencode' } : { isInstalled: false },
      };
    });
  }

  return { ok: true as const, sources, itemsBySource };
}

export { isClawdHubSource };
