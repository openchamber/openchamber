import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { GitHubPullRequestStatus, RuntimeAPIs } from '@/lib/api/types';
import { mapWithConcurrency } from '@/lib/concurrency';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { getRuntimeKey } from '@/lib/runtime-switch';

const PR_REVALIDATE_TTL_MS = 90_000;
const PR_REVALIDATE_INTERVAL_MS = 15_000;
const PR_DISCOVERY_INTERVAL_MS = 5 * 60_000;
const PR_BOOTSTRAP_RETRY_DELAYS_MS = [2_000, 5_000] as const;
const PR_OPEN_BUSY_INTERVAL_MS = 60_000;
const PR_OPEN_DEFAULT_INTERVAL_MS = 2 * 60_000;
const PR_OPEN_STABLE_INTERVAL_MS = 5 * 60_000;
const PR_STATUS_REFRESH_CONCURRENCY = 4;
const PR_PERSIST_TTL_MS = 12 * 60 * 60_000;
const PR_STATUS_STORAGE_KEY = 'openchamber.github-pr-status';
const PR_MAX_ENTRIES = 200;

const isTerminalPrState = (state: string | null | undefined): boolean => state === 'closed' || state === 'merged';
const isPendingChecks = (status: GitHubPullRequestStatus | null): boolean => {
  const checks = status?.checks;
  if (!checks) {
    return false;
  }
  return checks.state === 'pending' || checks.pending > 0;
};

const getOpenPrRefreshInterval = (status: GitHubPullRequestStatus | null): number => {
  if (isPendingChecks(status)) return PR_OPEN_BUSY_INTERVAL_MS;
  if (status?.checks && status.checks.state !== 'pending') return PR_OPEN_STABLE_INTERVAL_MS;
  return PR_OPEN_DEFAULT_INTERVAL_MS;
};

export const getGitHubPrStatusKey = (directory: string, branch: string, remoteName?: string | null): string => {
  return JSON.stringify([getRuntimeKey(), directory, branch, remoteName ?? 'auto']);
};

type RefreshOptions = {
  force?: boolean;
  onlyExistingPr?: boolean;
  silent?: boolean;
  markInitialResolved?: boolean;
};

type PrTrackingTarget = {
  directory: string;
  branch: string;
  remoteName?: string | null;
};

type PrRuntimeParams = {
  runtimeKey?: string;
  directory: string;
  branch: string;
  remoteName: string | null;
  canShow: boolean;
  github?: RuntimeAPIs['github'];
  githubAuthChecked: boolean;
  githubConnected: boolean | null;
};

type PrEntryIdentity = {
  runtimeKey: string;
  directory: string;
  branch: string;
  remoteName: string | null;
};

type PrStatusEntry = {
  status: GitHubPullRequestStatus | null;
  isLoading: boolean;
  error: string | null;
  isInitialStatusResolved: boolean;
  lastRefreshAt: number;
  lastDiscoveryPollAt: number;
  watchers: number;
  params: PrRuntimeParams | null;
  identity: PrEntryIdentity | null;
  resolvedRemoteName: string | null;
  paramsRevision: number;
};

type PersistedPrStatusEntry = Pick<
  PrStatusEntry,
  'status' | 'isInitialStatusResolved' | 'lastRefreshAt' | 'lastDiscoveryPollAt' | 'identity' | 'resolvedRemoteName'
>;

type GitHubPrStatusStore = {
  entries: Record<string, PrStatusEntry>;
  activeRequestCount: number;
  totalRequestCount: number;
  ensureEntry: (key: string) => void;
  setParams: (key: string, params: PrRuntimeParams) => void;
  startWatching: (key: string) => void;
  stopWatching: (key: string) => void;
  refresh: (key: string, options?: RefreshOptions) => Promise<void>;
  refreshTargets: (targets: PrTrackingTarget[], options?: RefreshOptions) => Promise<void>;
  updateStatus: (key: string, updater: (prev: GitHubPullRequestStatus | null) => GitHubPullRequestStatus | null) => void;
  resetForRuntimeSwitch: () => void;
};

const timers = new Map<string, number>();
const bootstrapTimers = new Map<string, number[]>();
const inFlightBySignature = new Map<string, symbol>();
const lastRefreshBySignature = new Map<string, number>();
let prRuntimeGeneration = 0;

// Global concurrency gate for PR-status network requests.
//
// PR status is non-critical chrome, but each request can be slow (the server
// makes many serial GitHub API calls and GitHub secondary-rate-limits bursts,
// so a single request can take 20s+). The browser allows only ~6 concurrent
// HTTP/1.1 connections per origin. Without this cap, watching N worktrees fires
// N PR-status requests at once (each startWatching() calls refresh() directly,
// bypassing refreshTargets' batch limiter), which saturates the connection pool
// and starves the critical path (bootstrap session.status, diffs, sending
// messages) for the full duration — the whole UI appears frozen on startup.
//
// Capping concurrency low guarantees free sockets remain for critical traffic.
const PR_STATUS_NETWORK_CONCURRENCY = 2;
let prStatusNetworkActive = 0;
const prStatusNetworkWaiters: Array<() => void> = [];

const acquirePrStatusNetworkSlot = (): Promise<void> => {
  if (prStatusNetworkActive < PR_STATUS_NETWORK_CONCURRENCY) {
    prStatusNetworkActive += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    prStatusNetworkWaiters.push(resolve);
  });
};

const releasePrStatusNetworkSlot = (): void => {
  const next = prStatusNetworkWaiters.shift();
  if (next) {
    // Hand the slot directly to the next waiter — keep the active count steady.
    next();
    return;
  }
  prStatusNetworkActive = Math.max(0, prStatusNetworkActive - 1);
};

const createEntry = (): PrStatusEntry => ({
  status: null,
  isLoading: false,
  error: null,
  isInitialStatusResolved: false,
  lastRefreshAt: 0,
  lastDiscoveryPollAt: 0,
  watchers: 0,
  params: null,
  identity: null,
  resolvedRemoteName: null,
  paramsRevision: 0,
});

const getIdentityFromEntry = (entry: PrStatusEntry | null | undefined): PrEntryIdentity | null => {
  if (entry?.params?.directory && entry.params.branch) {
    return {
      directory: entry.params.directory,
      branch: entry.params.branch,
      runtimeKey: entry.params.runtimeKey ?? entry.identity?.runtimeKey ?? getRuntimeKey(),
      remoteName: entry.params.remoteName ?? entry.resolvedRemoteName ?? entry.identity?.remoteName ?? null,
    };
  }
  if (!entry?.identity?.directory || !entry.identity.branch) {
    return null;
  }
  return entry.identity;
};

const getSignatureFromEntry = (entry: PrStatusEntry | null | undefined): string | null => {
  const identity = getIdentityFromEntry(entry);
  if (!identity?.directory || !identity.branch) {
    return null;
  }
  return JSON.stringify([identity.runtimeKey, identity.directory, identity.branch, identity.remoteName ?? 'auto']);
};

const parseStatusKey = (key: string): { runtimeKey: string; directory: string; branch: string; remote: string } | null => {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length !== 4 || parsed.some((part) => typeof part !== 'string')) {
      return null;
    }
    const [runtimeKey, directory, branch, remote] = parsed as [string, string, string, string];
    return { runtimeKey, directory, branch, remote };
  } catch {
    return null;
  }
};

/**
 * Best already-resolved entry for the same directory+branch under a different
 * remote key. Used to seed a freshly created entry so switching remote keys
 * (e.g. 'auto' -> 'origin') shows the known PR immediately instead of a
 * "checking status" flash; the entry's own refresh remains authoritative.
 */
const findResolvedSiblingEntry = (
  entries: Record<string, PrStatusEntry>,
  key: string,
): PrStatusEntry | null => {
  const target = parseStatusKey(key);
  if (!target) {
    return null;
  }

  let fallback: PrStatusEntry | null = null;
  for (const [entryKey, entry] of Object.entries(entries)) {
    if (entryKey === key || !entry.isInitialStatusResolved || !entry.status) {
      continue;
    }
    const parsed = parseStatusKey(entryKey);
    if (!parsed
      || parsed.runtimeKey !== target.runtimeKey
      || parsed.directory !== target.directory
      || parsed.branch !== target.branch) {
      continue;
    }
    const resolvedRemote = entry.resolvedRemoteName ?? entry.status.resolvedRemoteName ?? null;
    if (target.remote !== 'auto' && resolvedRemote && resolvedRemote !== target.remote) {
      continue;
    }
    if (parsed.remote === 'auto') {
      return entry;
    }
    fallback = fallback ?? entry;
  }

  return fallback;
};

/**
 * Freshest known status for a directory+branch across ALL remote-keyed
 * entries. Passive readers (e.g. the git-view PR chip) should use this
 * instead of a single key: the entry being actively watched/refreshed may be
 * keyed by a concrete remote while the 'auto' entry goes stale.
 */
const getFreshestPrEntryForBranch = (
  entries: Record<string, PrStatusEntry>,
  directory: string,
  branch: string,
): PrStatusEntry | null => {
  const runtimeKey = getRuntimeKey();
  let best: PrStatusEntry | null = null;
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry.status) {
      continue;
    }
    const parsed = parseStatusKey(key);
    if (!parsed
      || parsed.runtimeKey !== runtimeKey
      || parsed.directory !== directory
      || parsed.branch !== branch) {
      continue;
    }
    if (!best || entry.lastRefreshAt > best.lastRefreshAt) {
      best = entry;
    }
  }
  return best;
};

export const getFreshestPrStatusForBranch = (
  entries: Record<string, PrStatusEntry>,
  directory: string,
  branch: string,
): GitHubPullRequestStatus | null => {
  return getFreshestPrEntryForBranch(entries, directory, branch)?.status ?? null;
};

const getKeysBySignature = (entries: Record<string, PrStatusEntry>, signature: string): string[] => {
  return Object.entries(entries)
    .filter(([, entry]) => getSignatureFromEntry(entry) === signature)
    .map(([key]) => key);
};

const mergeParams = (entry: PrStatusEntry, next: PrRuntimeParams): PrStatusEntry => {
  const runtimeKey = next.runtimeKey ?? getRuntimeKey();
  const remoteName = next.remoteName ?? entry.params?.remoteName ?? entry.resolvedRemoteName ?? entry.identity?.remoteName ?? null;
  const paramsChanged = !entry.params
    || entry.params.runtimeKey !== runtimeKey
    || entry.params.directory !== next.directory
    || entry.params.branch !== next.branch
    || entry.params.remoteName !== remoteName
    || entry.params.canShow !== next.canShow
    || entry.params.github !== next.github
    || entry.params.githubAuthChecked !== next.githubAuthChecked
    || entry.params.githubConnected !== next.githubConnected;
  return {
    ...entry,
    paramsRevision: paramsChanged ? entry.paramsRevision + 1 : entry.paramsRevision,
    ...(paramsChanged ? { isLoading: false, error: null } : {}),
    params: entry.params
      ? {
        ...entry.params,
        ...next,
        runtimeKey,
        remoteName,
      }
      : {
        ...next,
        runtimeKey,
        remoteName,
      },
    identity: {
      runtimeKey,
      directory: next.directory,
      branch: next.branch,
      remoteName,
    },
  };
};

const getFetchableParams = (entry: PrStatusEntry | null | undefined): PrRuntimeParams | null => {
  if (!entry?.params?.canShow || !entry.params.github?.prStatus) {
    return null;
  }
  return {
    ...entry.params,
    remoteName: entry.params.remoteName ?? entry.resolvedRemoteName ?? entry.identity?.remoteName ?? null,
  };
};

const pickFetchParamsForSignature = (
  entries: Record<string, PrStatusEntry>,
  signature: string,
  preferredKey: string,
): PrRuntimeParams | null => {
  const keys = getKeysBySignature(entries, signature);
  const candidates = keys
    .map((key) => getFetchableParams(entries[key]))
    .filter((params): params is PrRuntimeParams => Boolean(params));

  if (candidates.length === 0) {
    return null;
  }

  const preferred = getFetchableParams(entries[preferredKey]);
  if (preferred && getSignatureFromEntry(entries[preferredKey]) === signature) {
    return preferred;
  }

  const withResolvedRemote = keys
    .map((key) => entries[key])
    .find((entry) => Boolean(entry?.resolvedRemoteName && getFetchableParams(entry)));
  if (withResolvedRemote) {
    return getFetchableParams(withResolvedRemote);
  }

  const withRemote = candidates.find((params) => Boolean(params.remoteName));
  if (withRemote) {
    return withRemote;
  }

  return candidates[0] ?? null;
};

const toPersistedEntry = (entry: PrStatusEntry): PersistedPrStatusEntry => ({
  status: entry.status,
  isInitialStatusResolved: entry.isInitialStatusResolved,
  lastRefreshAt: entry.lastRefreshAt,
  lastDiscoveryPollAt: entry.lastDiscoveryPollAt,
  identity: getIdentityFromEntry(entry),
  resolvedRemoteName: entry.resolvedRemoteName ?? entry.status?.resolvedRemoteName ?? null,
});

const hydrateEntry = (entry: PersistedPrStatusEntry | undefined): PrStatusEntry => {
  // A persisted closed/merged PR is restored so the panel keeps showing the
  // branch's PR history across a reload. It is never treated as live authority:
  // `lastDiscoveryPollAt` is reset so the watcher revalidates it immediately and
  // an open PR (or an authoritative empty result) replaces it.
  const hasTerminalPr = isTerminalPrState(entry?.status?.pr?.state);
  return {
    ...createEntry(),
    status: entry?.status ?? null,
    isInitialStatusResolved: entry?.isInitialStatusResolved ?? false,
    lastRefreshAt: entry?.lastRefreshAt ?? 0,
    lastDiscoveryPollAt: hasTerminalPr ? 0 : (entry?.lastDiscoveryPollAt ?? 0),
    identity: entry?.identity ?? null,
    resolvedRemoteName: entry?.resolvedRemoteName ?? entry?.status?.resolvedRemoteName ?? null,
  };
};

const boundEntries = (entries: Record<string, PrStatusEntry>): Record<string, PrStatusEntry> => {
  const all = Object.entries(entries);
  if (all.length <= PR_MAX_ENTRIES) return entries;
  return Object.fromEntries(all
    .sort(([, left], [, right]) => {
      const leftProtected = left.watchers > 0 || left.isLoading;
      const rightProtected = right.watchers > 0 || right.isLoading;
      if (leftProtected !== rightProtected) return leftProtected ? -1 : 1;
      return Math.max(right.lastRefreshAt, right.lastDiscoveryPollAt)
        - Math.max(left.lastRefreshAt, left.lastDiscoveryPollAt);
    })
    .slice(0, PR_MAX_ENTRIES));
};

export const useGitHubPrStatusStore = create<GitHubPrStatusStore>()(
  persist(
    (set, get) => ({
      entries: {},
      activeRequestCount: 0,
      totalRequestCount: 0,

      resetForRuntimeSwitch: () => {
        prRuntimeGeneration += 1;
        for (const timerId of timers.values()) window.clearInterval(timerId);
        for (const timerIds of bootstrapTimers.values()) timerIds.forEach((timerId) => window.clearTimeout(timerId));
        timers.clear();
        bootstrapTimers.clear();
        inFlightBySignature.clear();
        lastRefreshBySignature.clear();
        set((state) => ({
          activeRequestCount: 0,
          entries: Object.fromEntries(Object.entries(state.entries).map(([key, entry]) => [key, {
            ...entry,
            watchers: 0,
            isLoading: false,
            params: null,
            paramsRevision: entry.paramsRevision + 1,
          }])),
        }));
      },

      ensureEntry: (key) => {
        set((state) => {
          if (state.entries[key]) {
            return state;
          }
          const sibling = findResolvedSiblingEntry(state.entries, key);
          const seeded: PrStatusEntry = sibling
            ? {
                ...createEntry(),
                status: sibling.status,
                isInitialStatusResolved: true,
                resolvedRemoteName: sibling.resolvedRemoteName ?? sibling.status?.resolvedRemoteName ?? null,
              }
            : createEntry();
          return {
            entries: boundEntries({
              ...state.entries,
              [key]: seeded,
            }),
          };
        });
      },

      setParams: (key, params) => {
        set((state) => {
          const current = state.entries[key] ?? createEntry();
          return {
            entries: {
              ...state.entries,
              [key]: mergeParams(current, params),
            },
          };
        });
      },

      startWatching: (key) => {
        set((state) => {
          const current = state.entries[key] ?? createEntry();
          return {
            entries: {
              ...state.entries,
              [key]: {
                ...current,
                watchers: current.watchers + 1,
              },
            },
          };
        });

        if (timers.has(key)) {
          return;
        }

        const runBootstrapRefresh = (delayMs: number) => {
          const timerId = window.setTimeout(() => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
              return;
            }
            const entry = get().entries[key];
            if (!entry || entry.watchers <= 0) {
              return;
            }
            // Bootstrap retries only help discovery before any PR is known.
            // Once a PR is cached — open or historical — the discovery interval
            // owns revalidation.
            if (entry.status?.pr) {
              return;
            }
            void get().refresh(key, { force: true, silent: true, markInitialResolved: true });
          }, delayMs);
          const existing = bootstrapTimers.get(key) ?? [];
          existing.push(timerId);
          bootstrapTimers.set(key, existing);
        };

        void get().refresh(key, { force: true, silent: true, markInitialResolved: true });
        PR_BOOTSTRAP_RETRY_DELAYS_MS.forEach((delay) => runBootstrapRefresh(delay));

        const timerId = window.setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
            return;
          }

          const entry = get().entries[key];
          if (!entry || entry.watchers <= 0) {
            return;
          }

          const hasPr = Boolean(entry.status?.pr);
          // A closed/merged PR is history, not live status. It stays on the
          // discovery cadence like a branch with no PR at all, so a newer open
          // PR — or an authoritative empty result — replaces it on its own.
          const isTerminal = isTerminalPrState(entry.status?.pr?.state);
          if (!hasPr || isTerminal) {
            const now = Date.now();
            if (now - entry.lastDiscoveryPollAt < PR_DISCOVERY_INTERVAL_MS) {
              return;
            }
            set((state) => {
              const current = state.entries[key];
              if (!current) {
                return state;
              }
              return {
                entries: {
                  ...state.entries,
                  [key]: {
                    ...current,
                    lastDiscoveryPollAt: now,
                  },
                },
              };
            });
            void get().refresh(key, { force: true, silent: true, markInitialResolved: true });
            return;
          }

          const elapsed = Date.now() - entry.lastRefreshAt;
          const nextInterval = getOpenPrRefreshInterval(entry.status);
          if (elapsed < nextInterval) {
            return;
          }

          void get().refresh(key, { force: true, onlyExistingPr: true, silent: true, markInitialResolved: true });
        }, PR_REVALIDATE_INTERVAL_MS);

        timers.set(key, timerId);
      },

      stopWatching: (key) => {
        set((state) => {
          const current = state.entries[key];
          if (!current) {
            return state;
          }

          const watchers = Math.max(0, current.watchers - 1);
          return {
            entries: {
              ...state.entries,
              [key]: {
                ...current,
                watchers,
              },
            },
          };
        });

        const entry = get().entries[key];
        if (entry && entry.watchers > 0) {
          return;
        }

        const timerId = timers.get(key);
        if (typeof timerId === 'number') {
          window.clearInterval(timerId);
        }
        timers.delete(key);

        const pendingBootstrapTimers = bootstrapTimers.get(key);
        if (pendingBootstrapTimers && pendingBootstrapTimers.length > 0) {
          pendingBootstrapTimers.forEach((id) => {
            window.clearTimeout(id);
          });
        }
        bootstrapTimers.delete(key);
      },

      refresh: async (key, options) => {
        const state = get();
        const entry = state.entries[key];
        const signature = getSignatureFromEntry(entry);

        if (!entry || !signature) {
          return;
        }
        const signatureKeys = getKeysBySignature(state.entries, signature);
        const hasExistingPr = signatureKeys.some((signatureKey) => Boolean(state.entries[signatureKey]?.status?.pr));
        if (options?.onlyExistingPr && !hasExistingPr) {
          return;
        }
        const lastRefreshAt = lastRefreshBySignature.get(signature) ?? 0;
        if (!options?.force && Date.now() - lastRefreshAt < PR_REVALIDATE_TTL_MS) {
          return;
        }
        if (inFlightBySignature.has(signature)) {
          return;
        }

        const params = pickFetchParamsForSignature(state.entries, signature, key);
        if (!params) {
          return;
        }

        const requestToken = Symbol(signature);
        const runtimeGeneration = prRuntimeGeneration;
        const paramsRevision = entry.paramsRevision;
        const runtimeKey = entry.params?.runtimeKey ?? entry.identity?.runtimeKey ?? getRuntimeKey();
        const isCurrent = () => (
          runtimeGeneration === prRuntimeGeneration
          && runtimeKey === getRuntimeKey()
          && inFlightBySignature.get(signature) === requestToken
          && get().entries[key]?.paramsRevision === paramsRevision
        );
        inFlightBySignature.set(signature, requestToken);

        set((prev) => {
          const nextEntries = { ...prev.entries };
          signatureKeys.forEach((signatureKey) => {
            const current = nextEntries[signatureKey];
            if (!current) {
              return;
            }
            nextEntries[signatureKey] = {
              ...current,
              isLoading: options?.silent ? current.isLoading : true,
              error: null,
            };
          });
          return {
            entries: nextEntries,
          };
        });

        if (params.githubAuthChecked && params.githubConnected === false) {
          if (!isCurrent()) return;
          set((prev) => {
            const nextEntries = { ...prev.entries };
            signatureKeys.forEach((signatureKey) => {
              const current = nextEntries[signatureKey];
              if (!current) {
                return;
              }
              nextEntries[signatureKey] = {
                ...current,
                status: { connected: false },
                error: null,
                isLoading: options?.silent ? current.isLoading : false,
                isInitialStatusResolved: options?.markInitialResolved === false ? current.isInitialStatusResolved : true,
              };
            });
            return {
              entries: nextEntries,
            };
          });
          if (inFlightBySignature.get(signature) === requestToken) inFlightBySignature.delete(signature);
          return;
        }

        if (!params.github?.prStatus) {
          if (!isCurrent()) return;
          set((prev) => {
            const nextEntries = { ...prev.entries };
            signatureKeys.forEach((signatureKey) => {
              const current = nextEntries[signatureKey];
              if (!current) {
                return;
              }
              nextEntries[signatureKey] = {
                ...current,
                status: null,
                error: 'GitHub runtime API unavailable',
                isLoading: options?.silent ? current.isLoading : false,
                isInitialStatusResolved: options?.markInitialResolved === false ? current.isInitialStatusResolved : true,
              };
            });
            return {
              entries: nextEntries,
            };
          });
          if (inFlightBySignature.get(signature) === requestToken) inFlightBySignature.delete(signature);
          return;
        }

        try {
          set((prev) => ({
            ...prev,
            activeRequestCount: prev.activeRequestCount + 1,
            totalRequestCount: prev.totalRequestCount + 1,
          }));
          await acquirePrStatusNetworkSlot();
          let next: GitHubPullRequestStatus;
          try {
            if (!isCurrent()) return;
            // Failed requests need the same non-forced cooldown as successful
            // refreshes. Record only work that reaches the network slot so a
            // stale queued request cannot suppress its replacement.
            lastRefreshBySignature.set(signature, Date.now());
            next = await params.github.prStatus(params.directory, params.branch, params.remoteName ?? undefined, { force: options?.force });
          } finally {
            releasePrStatusNetworkSlot();
          }
          if (!isCurrent()) return;
          set((prev) => {
            const nextEntries = { ...prev.entries };
            signatureKeys.forEach((signatureKey) => {
              const current = nextEntries[signatureKey];
              if (!current) {
                return;
              }

              // Freshness guard: the server may serve this response from its
              // cache. If we already hold newer data (e.g. checks derived
              // from a fresher pulls/context fetch), keep it and only clear
              // the loading flag — never regress to an older snapshot.
              const currentFetchedAt = current.status?.fetchedAt;
              const nextFetchedAt = next.fetchedAt;
              if (typeof currentFetchedAt === 'number'
                && typeof nextFetchedAt === 'number'
                && nextFetchedAt < currentFetchedAt) {
                nextEntries[signatureKey] = {
                  ...current,
                  error: null,
                  isLoading: options?.silent ? current.isLoading : false,
                  isInitialStatusResolved: options?.markInitialResolved === false ? current.isInitialStatusResolved : true,
                  lastRefreshAt: Date.now(),
                };
                return;
              }

              const prevPr = current.status?.pr;
              const nextPr = next.pr;
              const shouldCarryBody = Boolean(
                nextPr
                && prevPr
                && nextPr.number === prevPr.number
                && (!nextPr.body || !nextPr.body.trim())
                && typeof prevPr.body === 'string'
                && prevPr.body.trim().length > 0,
              );

              const status = shouldCarryBody && nextPr && prevPr?.body
                ? {
                  ...next,
                  pr: {
                    ...nextPr,
                    body: prevPr.body,
                  },
                }
                : next;

              const resolvedRemoteName = status.resolvedRemoteName ?? current.resolvedRemoteName ?? params.remoteName ?? null;
              const identity = getIdentityFromEntry(current) ?? {
                runtimeKey,
                directory: params.directory,
                branch: params.branch,
                remoteName: params.remoteName ?? null,
              };

              nextEntries[signatureKey] = {
                ...current,
                status,
                error: null,
                isLoading: options?.silent ? current.isLoading : false,
                isInitialStatusResolved: options?.markInitialResolved === false ? current.isInitialStatusResolved : true,
                lastRefreshAt: Date.now(),
                resolvedRemoteName,
                identity: {
                  ...identity,
                  remoteName: resolvedRemoteName ?? identity.remoteName ?? null,
                },
              };
            });

            return {
              entries: nextEntries,
            };
          });
        } catch (error) {
          if (!isCurrent()) return;
          const message = error instanceof Error ? error.message : String(error);
          set((prev) => {
            const nextEntries = { ...prev.entries };
            signatureKeys.forEach((signatureKey) => {
              const current = nextEntries[signatureKey];
              if (!current) {
                return;
              }
              nextEntries[signatureKey] = {
                ...current,
                error: message || 'Failed to load PR status',
                isLoading: options?.silent ? current.isLoading : false,
                isInitialStatusResolved: options?.markInitialResolved === false ? current.isInitialStatusResolved : true,
              };
            });
            return {
              entries: nextEntries,
            };
          });
        } finally {
          if (inFlightBySignature.get(signature) === requestToken) inFlightBySignature.delete(signature);
          if (runtimeGeneration === prRuntimeGeneration) {
            set((prev) => ({ ...prev, activeRequestCount: Math.max(0, prev.activeRequestCount - 1) }));
          }
        }
      },

      refreshTargets: async (targets, options) => {
        const keys = Array.from(new Set(
          targets
            .map((target) => {
              const directory = target.directory.trim();
              const branch = target.branch.trim();
              if (!directory || !branch) {
                return null;
              }
              return getGitHubPrStatusKey(directory, branch, target.remoteName ?? null);
            })
            .filter((key): key is string => Boolean(key)),
        ));

        await mapWithConcurrency(keys, PR_STATUS_REFRESH_CONCURRENCY, (key) => get().refresh(key, options));
      },

      updateStatus: (key, updater) => {
        set((state) => {
          const current = state.entries[key] ?? createEntry();
          return {
            entries: {
              ...state.entries,
              [key]: {
                ...current,
                status: updater(current.status),
              },
            },
          };
        });
      },

    }),
    {
      name: PR_STATUS_STORAGE_KEY,
      storage: createDeferredSafeJSONStorage(),
      version: 2,
      migrate: (persistedState, version) => version < 2 ? { entries: {} } : persistedState,
      partialize: (state) => ({
        entries: Object.fromEntries(
          Object.entries(state.entries)
            .filter(([, entry]) => {
              const identity = getIdentityFromEntry(entry);
              if (!identity?.directory || !identity.branch) {
                return false;
              }
              const freshness = Math.max(entry.lastRefreshAt, entry.lastDiscoveryPollAt);
              return freshness > 0 && Date.now() - freshness < PR_PERSIST_TTL_MS;
            })
            .sort(([, left], [, right]) => Math.max(right.lastRefreshAt, right.lastDiscoveryPollAt)
              - Math.max(left.lastRefreshAt, left.lastDiscoveryPollAt))
            .slice(0, PR_MAX_ENTRIES)
            .map(([key, entry]) => [key, toPersistedEntry(entry)]),
        ),
      }),
      merge: (persistedState, currentState) => {
        const persistedEntries = (persistedState as { entries?: Record<string, PersistedPrStatusEntry> } | undefined)?.entries ?? {};
        const current = currentState as GitHubPrStatusStore;
        return {
          ...current,
          entries: Object.fromEntries(
            Object.entries(persistedEntries)
              .filter(([, entry]) => Boolean(
                entry.identity?.runtimeKey
                && Math.max(entry.lastRefreshAt, entry.lastDiscoveryPollAt) > 0
                && Date.now() - Math.max(entry.lastRefreshAt, entry.lastDiscoveryPollAt) < PR_PERSIST_TTL_MS,
              ))
              .slice(0, PR_MAX_ENTRIES)
              .map(([key, entry]) => [key, hydrateEntry(entry)]),
          ),
        };
      },
    },
  ),
);
export type PrVisualSummary = {
  number: number;
  visualState: string;
  prState: string;
  draft: boolean;
  title: string | null;
  url: string | null;
  base: string | null;
  head: string | null;
  checks: { state: string; total: number; success: number; failure: number; pending: number } | null;
  canMerge: boolean | null;
  mergeableState: string | null;
  repo: { owner: string; repo: string } | null;
};

const derivePrVisualState = (status: GitHubPullRequestStatus | null): string | null => {
  const pr = status?.pr;
  if (!pr) return null;
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.draft) return 'draft';
  const checksFailed = status?.checks?.state === 'failure';
  const ms = typeof pr.mergeableState === 'string' ? pr.mergeableState : '';
  const notMergeable = pr.mergeable === false || ms === 'blocked' || ms === 'dirty';
  if (checksFailed || notMergeable) return 'blocked';
  return 'open';
};

const deriveSummary = (entry: PrStatusEntry): PrVisualSummary | null => {
  const vs = derivePrVisualState(entry.status ?? null);
  const pr = entry.status?.pr;
  if (!vs || !pr?.number) return null;
  return {
    number: pr.number,
    visualState: vs,
    prState: pr.state,
    draft: Boolean(pr.draft),
    title: typeof pr.title === 'string' && pr.title.trim().length > 0 ? pr.title : null,
    url: typeof pr.url === 'string' && pr.url.trim().length > 0 ? pr.url : null,
    base: typeof pr.base === 'string' && pr.base.trim().length > 0 ? pr.base : null,
    head: typeof pr.head === 'string' && pr.head.trim().length > 0 ? pr.head : null,
    checks: entry.status?.checks
      ? { state: entry.status.checks.state, total: entry.status.checks.total, success: entry.status.checks.success, failure: entry.status.checks.failure, pending: entry.status.checks.pending }
      : null,
    canMerge: typeof entry.status?.canMerge === 'boolean' ? entry.status.canMerge : null,
    mergeableState: typeof pr.mergeableState === 'string' ? pr.mergeableState : null,
    repo: entry.status?.repo ? { owner: entry.status.repo.owner, repo: entry.status.repo.repo } : null,
  };
};

const summarySignature = (s: PrVisualSummary): string =>
  `${s.number}:${s.visualState}:${s.prState}:${s.draft}:${s.title ?? ''}:${s.url ?? ''}:${s.base ?? ''}:${s.head ?? ''}:${s.canMerge ?? ''}:${s.mergeableState ?? ''}:${s.checks?.state ?? ''}:${s.checks?.total ?? ''}:${s.checks?.success ?? ''}:${s.checks?.failure ?? ''}:${s.checks?.pending ?? ''}:${s.repo?.owner ?? ''}:${s.repo?.repo ?? ''}`;

// Per-key summary cache so many independent row subscribers (one key each)
// keep referential stability.
// Practically bounded by the number of worktree branches observed in a
// session; the explicit cap below guards long-running documents that rotate
// through many branches/runtimes (entries are tiny; insertion-order eviction
// only costs a one-frame identity change for the evicted key's subscriber).
const PR_SUMMARY_CACHE_MAX_ENTRIES = 300;
const prSummaryCacheByKey = new Map<string, { sig: string; summary: PrVisualSummary }>();

const getCachedPrSummary = (cacheKey: string, entry: PrStatusEntry | null | undefined): PrVisualSummary | null => {
  const summary = entry ? deriveSummary(entry) : null;
  if (!summary) {
    prSummaryCacheByKey.delete(cacheKey);
    return null;
  }

  const sig = summarySignature(summary);
  const cached = prSummaryCacheByKey.get(cacheKey);
  if (cached?.sig === sig) return cached.summary;

  if (!cached && prSummaryCacheByKey.size >= PR_SUMMARY_CACHE_MAX_ENTRIES) {
    const oldestKey = prSummaryCacheByKey.keys().next().value;
    if (oldestKey !== undefined) prSummaryCacheByKey.delete(oldestKey);
  }
  prSummaryCacheByKey.set(cacheKey, { sig, summary });
  return summary;
};

export const usePrVisualSummary = (key: string | null): PrVisualSummary | null => {
  return useGitHubPrStatusStore((state) => {
    if (!key) return null;
    return getCachedPrSummary(key, state.entries[key]);
  });
};

export const useFreshestPrVisualSummaryForBranch = (
  directory: string | null,
  branch: string | null,
): PrVisualSummary | null => {
  const cacheKey = directory && branch ? JSON.stringify(['branch', getRuntimeKey(), directory, branch]) : null;
  return useGitHubPrStatusStore((state) => {
    if (!directory || !branch || !cacheKey) return null;
    return getCachedPrSummary(cacheKey, getFreshestPrEntryForBranch(state.entries, directory, branch));
  });
};
