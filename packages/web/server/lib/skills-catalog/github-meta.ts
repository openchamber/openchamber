import { isPersistedCacheEntry, readDiskCache, writeDiskCache } from './disk-cache.js';
import { readBoundedResponseText } from '../shared/response-body.js';
import type { PersistedCacheEntry } from './disk-cache.js';

interface GitHubRepoMeta {
  stars: number | null;
  repoUpdatedAt: string | null;
}

const isGitHubPayload = (value: unknown): value is { stargazers_count?: unknown; pushed_at?: unknown } =>
  value !== null && typeof value === 'object';

const isFiniteStars = (value: unknown): value is number => Number.isFinite(value);

const isPushedAt = (value: unknown): value is string => typeof value === 'string';

const GITHUB_API_BASE = 'https://api.github.com';
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
const DISK_CACHE_FILE = 'skills-github-meta.json';
// Repo metadata needs only two scalar fields and ordinary responses are a
// few KiB; cap the body at 1 MiB (matching the GitLab auth-body precedent)
// so an oversized response cannot be buffered whole into the server.
const REPO_META_MAX_BYTES = 1 * 1024 * 1024;

const metaCache = new Map<string, PersistedCacheEntry>();
const inFlight = new Map<string, Promise<GitHubRepoMeta | null>>();

/** Remove expired entries so they do not accumulate until re-read. */
export function pruneExpiredGitHubMeta(now = Date.now()) {
  for (const [repo, entry] of metaCache.entries()) {
    if (!entry || now >= entry.expiresAt) {
      metaCache.delete(repo);
    }
  }
  return metaCache.size;
}

/** Raw entry count for tests (no implicit prune). */
export function getGitHubMetaCacheSize() {
  return metaCache.size;
}

let diskLoaded = false;
let diskWriteTimer: ReturnType<typeof setTimeout> | null = null;

const loadDiskEntries = () => {
  if (diskLoaded) {
    return;
  }
  diskLoaded = true;
  const persisted = readDiskCache(DISK_CACHE_FILE);
  if (!persisted) {
    return;
  }
  const now = Date.now();
  for (const [repo, entry] of Object.entries(persisted)) {
    if (
      isPersistedCacheEntry(entry)
      && entry.expiresAt > now
    ) {
      metaCache.set(repo, entry);
    }
  }
};

const scheduleDiskWrite = () => {
  if (diskWriteTimer) {
    return;
  }
  diskWriteTimer = setTimeout(() => {
    diskWriteTimer = null;
    const now = Date.now();
    const persisted: Record<string, PersistedCacheEntry> = {};
    for (const [repo, entry] of metaCache.entries()) {
      if (entry.expiresAt > now) {
        persisted[repo] = entry;
      }
    }
    writeDiskCache(DISK_CACHE_FILE, persisted);
  }, 1000);
  diskWriteTimer.unref();
};

const parseMeta = (payload: { stargazers_count?: unknown; pushed_at?: unknown }): GitHubRepoMeta => {
  const pushedAt = payload.pushed_at;
  return {
    stars: isFiniteStars(payload.stargazers_count) ? payload.stargazers_count : null,
    repoUpdatedAt: isPushedAt(pushedAt) && pushedAt ? pushedAt : null,
  };
};

const fetchRepoMeta = async (normalizedRepo: string) => {
  loadDiskEntries();
  pruneExpiredGitHubMeta();
  const cached = metaCache.get(normalizedRepo);
  if (cached) {
    if (Date.now() >= cached.expiresAt) {
      metaCache.delete(normalizedRepo);
    } else {
      return cached.value;
    }
  }

  const existing = inFlight.get(normalizedRepo);
  if (existing) {
    return existing;
  }

  const run = (async () => {
    try {
      const response = await fetch(`${GITHUB_API_BASE}/repos/${normalizedRepo}`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        metaCache.set(normalizedRepo, {
          expiresAt: Date.now() + FAILURE_CACHE_TTL_MS,
          value: { stars: null, repoUpdatedAt: null },
        });
        scheduleDiskWrite();
        return null;
      }

      const read = await readBoundedResponseText(response, REPO_META_MAX_BYTES);
      if (read.tooLarge) {
        // Over-cap must flow through the failure-cache path below, not
        // resolve as a (non-cached) null parse.
        throw new Error(`GitHub repo-meta response exceeded ${REPO_META_MAX_BYTES} bytes`);
      }
      // Response.json() strips a leading UTF-8 BOM; the bounded reader
      // does not, so strip it here. Invalid JSON throws, as before.
      const payload: unknown = JSON.parse(read.text.replace(/^\uFEFF/, ''));
      const value = isGitHubPayload(payload) ? parseMeta(payload) : null;
      if (value) {
        metaCache.set(normalizedRepo, { expiresAt: Date.now() + CACHE_TTL_MS, value });
        scheduleDiskWrite();
      }
      return value;
    } catch {
      metaCache.set(normalizedRepo, {
        expiresAt: Date.now() + FAILURE_CACHE_TTL_MS,
        value: { stars: null, repoUpdatedAt: null },
      });
      scheduleDiskWrite();
      return null;
    } finally {
      inFlight.delete(normalizedRepo);
    }
  })();

  inFlight.set(normalizedRepo, run);
  return run;
};

export async function fetchGitHubRepoMetas(normalizedRepos: Array<string | null | undefined>) {
  const unique = [...new Set(normalizedRepos.filter((repo): repo is string => Boolean(repo)))];
  const entries = await Promise.all(unique.map(async (repo): Promise<[string, object | null]> => [repo, await fetchRepoMeta(repo)]));
  return Object.fromEntries(entries);
}

export function clearGitHubMetaCache() {
  metaCache.clear();
  inFlight.clear();
  diskLoaded = true;
}
