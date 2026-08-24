import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { getProviderApiBaseUrl, sanitizeGitProviders } from './config.js';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

// Per-project git provider overrides live in the same `projects/` directory as
// the scheduled-tasks/projectNotes config (`projects/<projectId>.json`).
export const OPENCHAMBER_PROJECTS_DIR = path.join(OPENCHAMBER_DATA_DIR, 'projects');

// Same rule used by `packages/web/server/lib/projects/project-config.js` to
// keep a projectId safe for use in a file path.
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

const isSafeProjectId = (projectId) =>
  typeof projectId === 'string' && projectId.length > 0 && PROJECT_ID_PATTERN.test(projectId);

const projectConfigPath = (projectId) => path.join(OPENCHAMBER_PROJECTS_DIR, `${projectId}.json`);

// Mirror the path normalization used by `createProjectIdFromPath`
// (packages/web/server/lib/projects/project-id.js) so directory matching and
// fallback id generation agree on the same canonical path.
const normalizeProjectPathForMatch = (value) => {
  if (typeof value !== 'string') return '';
  return value.replace(/\\/g, '/').replace(/\/+$/g, '') || value;
};

const GIT_PROVIDER_SET = new Set(['github', 'gitlab', 'gitea']);

/**
 * Validate/normalize a per-project `gitProviders` value. Same provider
 * allowlist and `normalizeBaseUrl` rules as `sanitizeGitProviders`, but the
 * per-project shape only carries `apiBaseUrl` (any `detectUrls` are tolerated
 * and stripped) plus an optional forced `provider` (github|gitlab|gitea) that
 * overrides automatic provider detection for the project. Returns undefined
 * when nothing valid remains.
 */
export function sanitizeProjectGitProviders(payload) {
  const result = {};
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const forcedProvider = typeof payload.provider === 'string' ? payload.provider.trim().toLowerCase() : '';
    if (GIT_PROVIDER_SET.has(forcedProvider)) {
      result.provider = forcedProvider;
    }
  }
  const sanitized = sanitizeGitProviders(payload);
  if (sanitized) {
    for (const provider of Object.keys(sanitized)) {
      const entry = sanitized[provider];
      const normalized = {};
      if (entry.apiBaseUrl) {
        normalized.apiBaseUrl = entry.apiBaseUrl;
      }
      if (Object.keys(normalized).length > 0) {
        result[provider] = normalized;
      }
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

const readRawProjectJson = async (projectId) => {
  const filePath = projectConfigPath(projectId);
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // Missing or malformed file: fail closed.
    return {};
  }
};

/**
 * Read the raw JSON object from `projects/<projectId>.json`. Returns `{}` when
 * the file is missing or malformed, `null` for an invalid projectId. Never
 * throws.
 */
export function readProjectJson(projectId) {
  if (!isSafeProjectId(projectId)) {
    return null;
  }
  const filePath = projectConfigPath(projectId);
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
  } catch {
    // ignore
  }
  return {};
}

/**
 * Effective per-project `gitProviders` overrides for a projectId. Returns {}
 * when unset or for an invalid projectId.
 */
export function getProjectGitProviders(projectId) {
  const json = readProjectJson(projectId);
  if (!json) {
    return {};
  }
  return sanitizeProjectGitProviders(json.gitProviders) ?? {};
}

const readProjectsFromSettings = () => {
  try {
    const settingsFile = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');
    if (fs.existsSync(settingsFile)) {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {};
      if (Array.isArray(parsed.projects)) {
        return parsed.projects.filter((entry) => entry && typeof entry === 'object');
      }
    }
  } catch {
    // ignore
  }
  return [];
};

// Per-directory projectId resolution is memoized for RESOLVE_CACHE_TTL_MS so
// forge hot paths (per-request effective base URL lookups) do not exec git or
// re-read settings.json on every call. Negative results are cached too. Mirrors
// the client-side per-directory cache in `packages/ui/src/lib/gitProvider.ts`.
const RESOLVE_CACHE_TTL_MS = 60_000;
const RESOLVE_CACHE_MAX_ENTRIES = 500;
const resolveCache = new Map();

// Short timeout so an unresponsive git cannot stall a forge hot path; failures
// fall through to the directory containment matching below.
const GIT_COMMON_DIR_TIMEOUT_MS = 3_000;

/**
 * Resolve a directory to its main repository root via
 * `git rev-parse --git-common-dir`. For both a main checkout and a linked
 * worktree this prints the main repo's `.git` path (a linked worktree points at
 * the main repo's git dir), so `path.dirname` yields the main repo root — the
 * directory a settings.json project path is recorded against. Also handles a
 * repository rooted at the filesystem root (`dirname('/.git') === '/'`).
 * Returns null on any failure (not a git repo, git unavailable, parse failure).
 */
const tryResolveGitCommonDirRoot = (directory) => {
  try {
    const output = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: GIT_COMMON_DIR_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const commonDir = String(output || '').trim();
    if (!commonDir) {
      return null;
    }
    return path.dirname(path.resolve(directory, commonDir));
  } catch {
    return null;
  }
};

// A project path contains a candidate directory when it equals it or is a
// path-prefix (mirrors the original exact/containment rules). The filesystem
// root `/` additionally contains every absolute path.
const projectMatches = (projectPath, candidate) => {
  if (projectPath === candidate) {
    return true;
  }
  if (projectPath === '/') {
    return candidate.startsWith('/');
  }
  return candidate.startsWith(`${projectPath}/`);
};

// Longest matching project path from the projects list wins, as before.
// Returns `{ id, length }` (length of the matched project path) or null.
const matchProjectAgainst = (candidatePath, projects) => {
  const normalized = normalizeProjectPathForMatch(candidatePath).trim();
  if (!normalized) {
    return null;
  }
  let bestId = null;
  let bestPathLength = -1;
  for (const entry of projects) {
    if (typeof entry.id !== 'string' || !entry.id) {
      continue;
    }
    const projectPath = normalizeProjectPathForMatch(entry.path).trim();
    if (!projectPath) {
      continue;
    }
    if (projectMatches(projectPath, normalized) && projectPath.length > bestPathLength) {
      bestPathLength = projectPath.length;
      bestId = entry.id;
    }
  }
  return bestId ? { id: bestId, length: bestPathLength } : null;
};

// Cache overflow: drop the oldest entry so the map stays bounded.
const evictOldestResolveCacheEntry = () => {
  if (resolveCache.size < RESOLVE_CACHE_MAX_ENTRIES) {
    return;
  }
  let oldestKey = null;
  let oldestAt = Infinity;
  for (const [key, value] of resolveCache) {
    if (value.at < oldestAt) {
      oldestAt = value.at;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) {
    resolveCache.delete(oldestKey);
  }
};

/**
 * Test hook: drop all cached directory→projectId resolutions. Tests mutate the
 * settings file between assertions and must not observe the 60s TTL.
 */
export const _clearResolveProjectIdCache = () => {
  resolveCache.clear();
};

/**
 * Resolve the projectId for a directory. The directory is first resolved to
 * its main repo root via git (worktree-aware: a linked worktree created outside
 * the project root maps back to the main repo), then matched against the
 * settings.json `projects` list; the longest matching project path among the
 * git root and the directory itself wins (a nested project path under the
 * directory still wins over a broader repo-root match). When git is
 * unavailable or the directory is not a git repo, the directory's own
 * exact/containment match applies. Falls back to
 * `createProjectIdFromPath(directory)` when no project matches; null when the
 * directory is empty. Results are cached for RESOLVE_CACHE_TTL_MS.
 */
export function resolveProjectIdFromDirectory(directory) {
  const normalizedDirectory = normalizeProjectPathForMatch(directory).trim();
  if (!normalizedDirectory) {
    return null;
  }

  const cached = resolveCache.get(normalizedDirectory);
  if (cached && Date.now() - cached.at < RESOLVE_CACHE_TTL_MS) {
    return cached.projectId;
  }

  const projects = readProjectsFromSettings();
  const gitRoot = tryResolveGitCommonDirRoot(normalizedDirectory);
  const gitMatch = gitRoot ? matchProjectAgainst(gitRoot, projects) : null;
  const directoryMatch = matchProjectAgainst(normalizedDirectory, projects);

  let projectId;
  if (gitMatch && directoryMatch) {
    // Ties prefer the authoritative git-derived root.
    projectId = gitMatch.length >= directoryMatch.length ? gitMatch.id : directoryMatch.id;
  } else {
    projectId = gitMatch?.id || directoryMatch?.id || null;
  }

  if (!projectId) {
    projectId = createProjectIdFromPath(normalizedDirectory) || null;
  }

  evictOldestResolveCacheEntry();
  resolveCache.set(normalizedDirectory, { at: Date.now(), projectId });
  return projectId;
}

/**
 * Per-project API base URL override for a provider, or null when unset.
 */
export function getProjectProviderApiBaseUrl(provider, projectId) {
  return getProjectGitProviders(projectId)[provider]?.apiBaseUrl || null;
}

/**
 * The project's forced git provider (github|gitlab|gitea), or null when the
 * provider is auto-detected from the remote. Only meaningful for a projectId
 * that resolves to a project config; invalid ids yield null.
 */
export function getProjectProvider(projectId) {
  const providers = getProjectGitProviders(projectId);
  return providers.provider || null;
}

/**
 * The forced git provider for a directory's owning project, or null when
 * unset or when the directory resolves to no project.
 */
export function getProjectProviderFromDirectory(directory) {
  const projectId = resolveProjectIdFromDirectory(directory);
  if (!projectId) {
    return null;
  }
  return getProjectProvider(projectId);
}

/**
 * Effective API base URL for a provider given a directory: the project override
 * (when the directory resolves to a project with one) wins, else the global
 * settings.json value, else the built-in default. Null only when nothing
 * resolves.
 */
export function getEffectiveProviderApiBaseUrl(provider, directory) {
  const projectId = resolveProjectIdFromDirectory(directory);
  if (projectId) {
    const projectOverride = getProjectProviderApiBaseUrl(provider, projectId);
    if (projectOverride) {
      return projectOverride;
    }
  }
  return getProviderApiBaseUrl(provider);
}

/**
 * Persist the per-project `gitProviders` overrides for a projectId. All other
 * keys in the project JSON (projectNotes, scheduledTasks, version, ...) are
 * preserved; the `gitProviders` key is omitted entirely when the sanitized
 * payload is empty. Atomic write (tmp file + rename), mkdir recursive. Returns
 * the saved `gitProviders` object (or {}). Throws for an invalid projectId.
 */
export async function saveProjectGitProviders(projectId, payload) {
  if (!isSafeProjectId(projectId)) {
    throw new Error('projectId contains unsupported characters');
  }
  const sanitized = sanitizeProjectGitProviders(payload) ?? {};

  const existing = await readRawProjectJson(projectId);
  const merged = { ...existing };
  if (Object.keys(sanitized).length > 0) {
    merged.gitProviders = sanitized;
  } else {
    delete merged.gitProviders;
  }

  const filePath = projectConfigPath(projectId);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(temporaryPath, JSON.stringify(merged, null, 2), 'utf8');
  await fs.promises.rename(temporaryPath, filePath);

  return sanitized;
}