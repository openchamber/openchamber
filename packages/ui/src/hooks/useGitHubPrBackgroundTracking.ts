import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import type { RuntimeAPIs } from '@/lib/api/types';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionStore } from '@/stores/useSessionStore';

const MAX_BACKGROUND_PR_DIRECTORIES = 20;
const ACTIVE_DIRECTORY_REFRESH_TTL_MS = 15_000;
const BACKGROUND_DIRECTORY_REFRESH_TTL_MS = 2 * 60_000;
const BRANCH_REFRESH_INTERVAL_MS = 15_000;
const MAX_STATUS_FETCH_PER_TICK = 3;
const MAX_STATUS_FETCH_ON_RESUME = 5;
const STATUS_FETCH_CONCURRENCY = 2;
const PR_EVENTUAL_CONSISTENCY_REFRESH_DELAY_MS = 5_000;
const RESUME_REFRESH_DEBOUNCE_MS = 700;
const RESUME_FORCE_COOLDOWN_MS = 8_000;

const normalizePath = (value?: string | null): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized === '/') {
    return '/';
  }
  return normalized.replace(/\/+$/, '');
};

type SessionLike = Session & {
  directory?: string | null;
  project?: { worktree?: string | null } | null;
};

type BranchCacheEntry = {
  branch: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
  fetchedAt: number;
};

type PrTarget = {
  directory: string;
  branch: string;
  remoteName?: string | null;
};

type BranchRefreshOptions = {
  forceCurrent?: boolean;
  maxFetchCount?: number;
};

const getBranchRefreshTtl = (directory: string, currentDirectory: string | null): number => {
  return directory === currentDirectory ? ACTIVE_DIRECTORY_REFRESH_TTL_MS : BACKGROUND_DIRECTORY_REFRESH_TTL_MS;
};

const hasRepoSignalChanged = (previous: BranchCacheEntry | undefined, next: BranchCacheEntry): boolean => {
  if (!previous) {
    return Boolean(next.branch);
  }

  return previous.branch !== next.branch
    || previous.tracking !== next.tracking
    || previous.ahead !== next.ahead
    || previous.behind !== next.behind;
};

const prioritizeDirectoriesForFetch = (
  directories: string[],
  cache: Map<string, BranchCacheEntry>,
  currentDirectory: string | null,
): string[] => {
  return [...directories].sort((left, right) => {
    const leftPriority = left === currentDirectory ? 0 : 1;
    const rightPriority = right === currentDirectory ? 0 : 1;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    const leftFetchedAt = cache.get(left)?.fetchedAt ?? 0;
    const rightFetchedAt = cache.get(right)?.fetchedAt ?? 0;
    if (leftFetchedAt !== rightFetchedAt) {
      return leftFetchedAt - rightFetchedAt;
    }

    return left.localeCompare(right);
  });
};

const mapWithConcurrency = async <T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> => {
  if (values.length === 0) {
    return [];
  }

  const safeConcurrency = Math.max(1, Math.min(concurrency, values.length));
  const results = new Array<R>(values.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const nextIndex = cursor;
      cursor += 1;
      if (nextIndex >= values.length) {
        return;
      }
      results[nextIndex] = await mapper(values[nextIndex]);
    }
  };

  await Promise.all(Array.from({ length: safeConcurrency }, () => worker()));
  return results;
};

const toPrTargets = (cache: Map<string, BranchCacheEntry>, directories: string[]): PrTarget[] => {
  const result: PrTarget[] = [];
  directories.forEach((directory) => {
    const cached = cache.get(directory);
    if (!cached?.branch) {
      return;
    }
    result.push({
      directory,
      branch: cached.branch,
      remoteName: null,
    });
  });
  return result;
};

export const useGitHubPrBackgroundTracking = (
  github: RuntimeAPIs['github'] | undefined,
  git: RuntimeAPIs['git'],
): void => {
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const projects = useProjectsStore((state) => state.projects);
  const sessions = useSessionStore((state) => state.sessions);
  const archivedSessions = useSessionStore((state) => state.archivedSessions);
  const availableWorktreesByProject = useSessionStore((state) => state.availableWorktreesByProject);
  const worktreeMetadata = useSessionStore((state) => state.worktreeMetadata);

  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);

  const syncBackgroundTargets = useGitHubPrStatusStore((state) => state.syncBackgroundTargets);
  const refreshPrTargets = useGitHubPrStatusStore((state) => state.refreshTargets);

  const [branchCache, setBranchCache] = React.useState<Map<string, BranchCacheEntry>>(new Map());
  const branchCacheRef = React.useRef<Map<string, BranchCacheEntry>>(new Map());
  const targetsRef = React.useRef<PrTarget[]>([]);
  const burstTimeoutsRef = React.useRef<Map<string, number>>(new Map());
  const refreshInFlightRef = React.useRef(false);
  const pendingRefreshRef = React.useRef<BranchRefreshOptions | null>(null);
  const resumeRefreshTimeoutRef = React.useRef<number | null>(null);
  const lastResumeRefreshAtRef = React.useRef(0);

  React.useEffect(() => {
    branchCacheRef.current = branchCache;
  }, [branchCache]);

  const scheduleBurstRefresh = React.useCallback((targetsToRefresh: PrTarget[]) => {
    if (targetsToRefresh.length === 0) {
      return;
    }

    const dedupedTargets = new Map<string, PrTarget>();
    targetsToRefresh.forEach((target) => {
      const key = `${target.directory}::${target.branch}`;
      dedupedTargets.set(key, target);
    });

    dedupedTargets.forEach((target, key) => {
      const existing = burstTimeoutsRef.current.get(key);
      if (typeof existing === 'number') {
        window.clearTimeout(existing);
      }

      const timeoutId = window.setTimeout(() => {
        burstTimeoutsRef.current.delete(key);
        void refreshPrTargets([target], {
          force: true,
          silent: true,
          markInitialResolved: true,
        });
      }, PR_EVENTUAL_CONSISTENCY_REFRESH_DELAY_MS);

      burstTimeoutsRef.current.set(key, timeoutId);
    });
  }, [refreshPrTargets]);

  React.useEffect(() => {
    if (!github || githubAuthChecked) {
      return;
    }
    void refreshGitHubAuthStatus(github);
  }, [github, githubAuthChecked, refreshGitHubAuthStatus]);

  const candidateDirectories = React.useMemo(() => {
    const ordered = new Map<string, string>();
    const add = (value?: string | null) => {
      const normalized = normalizePath(value);
      if (!normalized || ordered.has(normalized)) {
        return;
      }
      ordered.set(normalized, normalized);
    };

    add(currentDirectory);
    projects.forEach((project) => {
      add(project.path);
    });
    availableWorktreesByProject.forEach((worktrees) => {
      worktrees.forEach((worktree) => {
        add(worktree.path);
      });
    });
    worktreeMetadata.forEach((metadata) => {
      add(metadata.path);
    });

    [...sessions, ...archivedSessions]
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .forEach((rawSession) => {
        const session = rawSession as SessionLike;
        add(session.directory ?? null);
        add(session.project?.worktree ?? null);
      });

    return Array.from(ordered.values()).slice(0, MAX_BACKGROUND_PR_DIRECTORIES);
  }, [archivedSessions, availableWorktreesByProject, currentDirectory, projects, sessions, worktreeMetadata]);

  React.useEffect(() => {
    let cancelled = false;

    const refreshBranches = async (options?: BranchRefreshOptions): Promise<PrTarget[]> => {
      const forceCurrent = options?.forceCurrent === true;
      const maxFetchCount = Math.max(1, options?.maxFetchCount ?? MAX_STATUS_FETCH_PER_TICK);
      const now = Date.now();
      const dueDirectories = candidateDirectories.filter((directory) => {
        const cached = branchCacheRef.current.get(directory);
        if (!cached) {
          return true;
        }

        if (forceCurrent && currentDirectory && directory === currentDirectory) {
          return true;
        }

        return now - cached.fetchedAt > getBranchRefreshTtl(directory, currentDirectory);
      });

      const directoriesToFetch = prioritizeDirectoriesForFetch(
        dueDirectories,
        branchCacheRef.current,
        currentDirectory,
      ).slice(0, maxFetchCount);

      if (directoriesToFetch.length === 0) {
        return toPrTargets(branchCacheRef.current, candidateDirectories);
      }

      const results = await mapWithConcurrency(
        directoriesToFetch,
        STATUS_FETCH_CONCURRENCY,
        async (directory) => {
          try {
            const status = await git.getGitStatus(directory);
            const branch = typeof status.current === 'string' ? status.current.trim() : '';
            return {
              directory,
              branch: branch && branch !== 'HEAD' ? branch : null,
              tracking: typeof status.tracking === 'string' ? status.tracking : null,
              ahead: typeof status.ahead === 'number' ? status.ahead : 0,
              behind: typeof status.behind === 'number' ? status.behind : 0,
            };
          } catch {
            return { directory, branch: null, tracking: null, ahead: 0, behind: 0 };
          }
        },
      );

      if (cancelled) {
        return [];
      }

      const nextCache = new Map(branchCacheRef.current);
      const changedTargets: PrTarget[] = [];

      results.forEach(({ directory, branch, tracking, ahead, behind }) => {
        const previous = nextCache.get(directory);
        const nextEntry = {
          branch,
          tracking,
          ahead,
          behind,
          fetchedAt: Date.now(),
        };

        nextCache.set(directory, nextEntry);

        if (branch && hasRepoSignalChanged(previous, nextEntry)) {
          changedTargets.push({
            directory,
            branch,
            remoteName: null,
          });
        }
      });

      setBranchCache((prev) => {
        let changed = false;
        if (prev.size !== nextCache.size) {
          changed = true;
        } else {
          for (const [key, value] of nextCache.entries()) {
            const previous = prev.get(key);
            if (!previous
              || previous.branch !== value.branch
              || previous.tracking !== value.tracking
              || previous.ahead !== value.ahead
              || previous.behind !== value.behind) {
              changed = true;
              break;
            }
          }
        }

        branchCacheRef.current = nextCache;

        if (!changed) {
          return prev;
        }

        return nextCache;
      });

      if (changedTargets.length > 0) {
        void refreshPrTargets(changedTargets, {
          force: true,
          silent: true,
          markInitialResolved: true,
        });
        scheduleBurstRefresh(changedTargets);
      }

      return toPrTargets(nextCache, candidateDirectories);
    };

    const runRefresh = async (options?: BranchRefreshOptions): Promise<PrTarget[]> => {
      if (refreshInFlightRef.current) {
        const previousPending = pendingRefreshRef.current;
        pendingRefreshRef.current = {
          forceCurrent: Boolean(previousPending?.forceCurrent || options?.forceCurrent),
          maxFetchCount: Math.max(
            previousPending?.maxFetchCount ?? 1,
            options?.maxFetchCount ?? 1,
          ),
        };
        return [];
      }

      refreshInFlightRef.current = true;
      try {
        return await refreshBranches(options);
      } finally {
        refreshInFlightRef.current = false;
        const pending = pendingRefreshRef.current;
        pendingRefreshRef.current = null;
        if (pending) {
          void runRefresh(pending);
        }
      }
    };

    void runRefresh({ forceCurrent: true, maxFetchCount: MAX_STATUS_FETCH_ON_RESUME });

    const intervalId = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void runRefresh({ maxFetchCount: MAX_STATUS_FETCH_PER_TICK });
    }, BRANCH_REFRESH_INTERVAL_MS);

    const refreshOnResume = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }

      const now = Date.now();
      if (now - lastResumeRefreshAtRef.current < RESUME_FORCE_COOLDOWN_MS) {
        return;
      }

      if (resumeRefreshTimeoutRef.current !== null) {
        window.clearTimeout(resumeRefreshTimeoutRef.current);
      }

      resumeRefreshTimeoutRef.current = window.setTimeout(() => {
        resumeRefreshTimeoutRef.current = null;
        lastResumeRefreshAtRef.current = Date.now();
        void runRefresh({ forceCurrent: true, maxFetchCount: MAX_STATUS_FETCH_ON_RESUME }).then((nextTargets) => {
          const currentTargets = nextTargets.length > 0 ? nextTargets : targetsRef.current;
          if (currentTargets.length === 0) {
            return;
          }

          const activeTargets = currentDirectory
            ? currentTargets.filter((target) => target.directory === currentDirectory)
            : [];

          if (activeTargets.length > 0) {
            void refreshPrTargets(activeTargets, {
              force: true,
              silent: true,
              markInitialResolved: true,
            });
          }

          void refreshPrTargets(currentTargets, {
            force: true,
            onlyExistingPr: true,
            silent: true,
            markInitialResolved: true,
          });
        });
      }, RESUME_REFRESH_DEBOUNCE_MS);
    };

    window.addEventListener('focus', refreshOnResume);
    document.addEventListener('visibilitychange', refreshOnResume);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshOnResume);
      document.removeEventListener('visibilitychange', refreshOnResume);
      if (resumeRefreshTimeoutRef.current !== null) {
        window.clearTimeout(resumeRefreshTimeoutRef.current);
        resumeRefreshTimeoutRef.current = null;
      }
      pendingRefreshRef.current = null;
      refreshInFlightRef.current = false;
    };
  }, [candidateDirectories, currentDirectory, git, refreshPrTargets, scheduleBurstRefresh]);

  React.useEffect(() => {
    const validDirectories = new Set(candidateDirectories);
    setBranchCache((prev) => {
      let changed = false;
      const next = new Map<string, BranchCacheEntry>();
      prev.forEach((value, key) => {
        if (!validDirectories.has(key)) {
          changed = true;
          return;
        }
        next.set(key, value);
      });
      if (!changed) {
        return prev;
      }
      branchCacheRef.current = next;
      return next;
    });
  }, [candidateDirectories]);

  const targets = React.useMemo(() => {
    return toPrTargets(branchCache, candidateDirectories);
  }, [branchCache, candidateDirectories]);

  React.useEffect(() => {
    targetsRef.current = targets;
  }, [targets]);

  React.useEffect(() => {
    const burstTimeouts = burstTimeoutsRef.current;
    return () => {
      burstTimeouts.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      burstTimeouts.clear();
    };
  }, []);

  React.useEffect(() => {
    syncBackgroundTargets({
      targets,
      github,
      githubAuthChecked,
      githubConnected: githubAuthStatus?.connected ?? null,
    });
  }, [github, githubAuthChecked, githubAuthStatus?.connected, syncBackgroundTargets, targets]);
};
