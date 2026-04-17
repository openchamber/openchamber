import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { mapWithConcurrency } from '@/lib/concurrency';
import { normalizePath } from '../utils';

type ProjectLike = { path: string };

type DirectoryStatusValue = 'unknown' | 'exists' | 'missing';

type Args = {
  sortedSessions: Session[];
  projects: ProjectLike[];
  directoryStatus: Map<string, DirectoryStatusValue>;
  setDirectoryStatus: React.Dispatch<React.SetStateAction<Map<string, DirectoryStatusValue>>>;
};

const PROBE_CONCURRENCY = 3;
const MISSING_CACHE_KEY = 'oc.directoryProbe.missing';
// Re-probe missing directories periodically in case they're recreated
const MISSING_REPROBE_MS = 10 * 60 * 1000; // 10 minutes

type MissingCache = Record<string, number>; // directory -> timestamp

function loadMissingCache(): MissingCache {
  try {
    const raw = localStorage.getItem(MISSING_CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as MissingCache;
  } catch {
    return {};
  }
}

function saveMissingCache(cache: MissingCache): void {
  try {
    localStorage.setItem(MISSING_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // ignore quota errors
  }
}

async function probeDirectory(directory: string): Promise<DirectoryStatusValue> {
  try {
    await opencodeClient.listLocalDirectory(directory);
    return 'exists';
  } catch (error) {
    const looksLikeSdkWorktree =
      directory.includes('/opencode/worktree/') ||
      directory.includes('/.opencode/data/worktree/') ||
      directory.includes('/.local/share/opencode/worktree/');

    const reachable = await opencodeClient.probeDirectory(directory).catch(() => false);
    if (reachable) {
      return 'exists';
    }

    const message = error instanceof Error ? error.message.toLowerCase() : '';
    const definitelyMissing =
      message.includes('enoent') ||
      message.includes('not found') ||
      message.includes('does not exist') ||
      message.includes('no such file');

    if (definitelyMissing || looksLikeSdkWorktree) {
      return 'missing';
    }

    return 'unknown';
  }
}

export const useDirectoryStatusProbe = ({
  sortedSessions,
  projects,
  directoryStatus,
  setDirectoryStatus,
}: Args): void => {
  const directoryStatusRef = React.useRef<Map<string, DirectoryStatusValue>>(new Map());
  const probeInFlightRef = React.useRef(false);
  const missingCacheRef = React.useRef<MissingCache>(loadMissingCache());

  React.useEffect(() => {
    directoryStatusRef.current = directoryStatus;
  }, [directoryStatus]);

  React.useEffect(() => {
    const directories = new Set<string>();
    const normalizedProjectRoots = new Set<string>();
    sortedSessions.forEach((session) => {
      const dir = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
      if (dir) directories.add(dir);
    });
    projects.forEach((project) => {
      const normalized = normalizePath(project.path);
      if (normalized) {
        directories.add(normalized);
        normalizedProjectRoots.add(normalized);
      }
    });

    const now = Date.now();
    const missingCache = missingCacheRef.current;
    const toProbe: string[] = [];
    const preseeded = new Map<string, DirectoryStatusValue>();

    for (const directory of directories) {
      const isProjectRoot = normalizedProjectRoots.has(directory);
      const known = directoryStatusRef.current.get(directory);
      if (known === 'exists') continue;

      const cachedAt = missingCache[directory];
      if (known === 'missing') {
        if (isProjectRoot) {
          toProbe.push(directory);
          continue;
        }
        if (cachedAt && now - cachedAt < MISSING_REPROBE_MS) {
          continue;
        }
        toProbe.push(directory);
        continue;
      }

      // Use cached "missing" status if fresh enough — skip the HTTP probe
      if (!isProjectRoot && cachedAt && now - cachedAt < MISSING_REPROBE_MS) {
        preseeded.set(directory, 'missing');
        continue;
      }

      toProbe.push(directory);
    }

    // Apply preseeded missing statuses immediately (no HTTP call)
    if (preseeded.size > 0) {
      setDirectoryStatus((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [dir, status] of preseeded) {
          if (next.get(dir) !== status) {
            next.set(dir, status);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }

    if (toProbe.length === 0 || probeInFlightRef.current) return;
    probeInFlightRef.current = true;

    let cancelled = false;
    let cacheChanged = false;

    void mapWithConcurrency(toProbe, PROBE_CONCURRENCY, async (directory) => {
      const status = await probeDirectory(directory);

      // Update missing cache
      if (status === 'missing') {
        missingCache[directory] = Date.now();
        cacheChanged = true;
      } else if (missingCache[directory]) {
        delete missingCache[directory];
        cacheChanged = true;
      }

      if (!cancelled) {
        setDirectoryStatus((prev) => {
          if (prev.get(directory) === status) return prev;
          const next = new Map(prev);
          next.set(directory, status);
          return next;
        });
      }
      return { directory, status };
    }).finally(() => {
      probeInFlightRef.current = false;
      if (cacheChanged) {
        saveMissingCache(missingCache);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [sortedSessions, projects, setDirectoryStatus]);
};
