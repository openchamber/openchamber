import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { GitHubPullRequestStatus, RuntimeAPIs } from '@/lib/api/types';
import { getSafeStorage } from './utils/safeStorage';

const PR_REVALIDATE_TTL_MS = 90_000;
const PR_REVALIDATE_INTERVAL_MS = 15_000;
const PR_DISCOVERY_INTERVAL_MS = 5 * 60_000;
const PR_BOOTSTRAP_RETRY_DELAYS_MS = [2_000, 5_000] as const;
const PR_OPEN_BUSY_INTERVAL_MS = 60_000;
const PR_OPEN_DEFAULT_INTERVAL_MS = 2 * 60_000;
const PR_OPEN_STABLE_INTERVAL_MS = 5 * 60_000;
const PR_PERSIST_TTL_MS = 12 * 60 * 60_000;
const PR_STATUS_STORAGE_KEY = 'openchamber.github-pr-status';

const isTerminalPrState = (state: string | null | undefined): boolean => state === 'closed' || state === 'merged';
const isPendingChecks = (status: GitHubPullRequestStatus | null): boolean => {
  const checks = status?.checks;
  if (!checks) {
    return false;
  }
  return checks.state === 'pending' || checks.pending > 0;
};

export const getGitHubPrStatusKey = (directory: string, branch: string, remoteName?: string | null): string => {
  void remoteName;
  return `${directory}::${branch}`;
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
  directory: string;
  branch: string;
  remoteName: string | null;
  canShow: boolean;
  github?: RuntimeAPIs['github'];
  githubAuthChecked: boolean;
  githubConnected: boolean | null;
};

type PrEntryIdentity = {
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
};

const timers = new Map<string, number>();
const bootstrapTimers = new Map<string, number[]>();
const inFlightBySignature = new Set<string>();
const lastRefreshBySignature = new Map<string, number>();
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
});

const getIdentityFromEntry = (entry: PrStatusEntry | null | undefined): PrEntryIdentity | null => {
  if (entry?.params?.directory && entry.params.branch) {
    return {
      directory: entry.params.directory,
      branch: entry.params.branch,
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
  return `${identity.directory}::${identity.branch}`;
};

const getKeysBySignature = (entries: Record<string, PrStatusEntry>, signature: string): string[] => {
  return Object.entries(entries)
    .filter(([, entry]) => getSignatureFromEntry(entry) === signature)
    .map(([key]) => key);
};

const mergeParams = (entry: PrStatusEntry, next: PrRuntimeParams): PrStatusEntry => {
  const remoteName = next.remoteName ?? entry.params?.remoteName ?? entry.resolvedRemoteName ?? entry.identity?.remoteName ?? null;
  return {
    ...entry,
    params: entry.params
      ? {
        ...entry.params,
        ...next,
        remoteName,
      }
      : {
        ...next,
        remoteName,
      },
    identity: {
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

const hydrateEntry = (entry: PersistedPrStatusEntry | undefined): PrStatusEntry => ({
  ...createEntry(),
  status: entry?.status ?? null,
  isInitialStatusResolved: entry?.isInitialStatusResolved ?? false,
  lastRefreshAt: entry?.lastRefreshAt ?? 0,
  lastDiscoveryPollAt: entry?.lastDiscoveryPollAt ?? 0,
  identity: entry?.identity ?? null,
  resolvedRemoteName: entry?.resolvedRemoteName ?? entry?.status?.resolvedRemoteName ?? null,
});

export const useGitHubPrStatusStore = create<GitHubPrStatusStore>()(
  persist(
    (set, get) => ({
      entries: {},
      activeRequestCount: 0,
      totalRequestCount: 0,

      ensureEntry: (key) => {
        set((state) => {
          if (state.entries[key]) {
            return state;
          }
          return {
            entries: {
              ...state.entries,
              [key]: createEntry(),
            },
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
          if (!hasPr) {
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

          if (isTerminalPrState(entry.status?.pr?.state)) {
            return;
          }

          const elapsed = Date.now() - entry.lastRefreshAt;
          const nextInterval = isPendingChecks(entry.status)
            ? PR_OPEN_BUSY_INTERVAL_MS
            : (entry.status?.checks && entry.status.checks.state !== 'pending'
                ? PR_OPEN_STABLE_INTERVAL_MS
                : PR_OPEN_DEFAULT_INTERVAL_MS);
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

        inFlightBySignature.add(signature);
        lastRefreshBySignature.set(signature, Date.now());

        set((prev) => {
          const nextEntries = { ...prev.entries };
          signatureKeys.forEach((signatureKey) => {
            const current = nextEntries[signatureKey];
            if (!current) {
              return;
            }
            nextEntries[signatureKey] = {
              ...current,
              lastRefreshAt: Date.now(),
              isLoading: options?.silent ? current.isLoading : true,
              error: null,
            };
          });
          return {
            entries: nextEntries,
          };
        });

        if (params.githubAuthChecked && params.githubConnected === false) {
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
          inFlightBySignature.delete(signature);
          return;
        }

        if (!params.github?.prStatus) {
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
          inFlightBySignature.delete(signature);
          return;
        }

        try {
          set((prev) => ({
            ...prev,
            activeRequestCount: prev.activeRequestCount + 1,
            totalRequestCount: prev.totalRequestCount + 1,
          }));
          const next = await params.github.prStatus(params.directory, params.branch, params.remoteName ?? undefined);
          set((prev) => {
            const nextEntries = { ...prev.entries };
            signatureKeys.forEach((signatureKey) => {
              const current = nextEntries[signatureKey];
              if (!current) {
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
          inFlightBySignature.delete(signature);
          set((prev) => ({ ...prev, activeRequestCount: Math.max(0, prev.activeRequestCount - 1) }));
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

        await Promise.all(keys.map((key) => get().refresh(key, options)));
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
      storage: createJSONStorage(() => getSafeStorage()),
      partialize: (state) => ({
        entries: Object.fromEntries(
          Object.entries(state.entries)
            .filter(([, entry]) => {
              const identity = getIdentityFromEntry(entry);
              if (!identity?.directory || !identity.branch) {
                return false;
              }
              const freshness = Math.max(entry.lastRefreshAt, entry.lastDiscoveryPollAt);
              return freshness === 0 || Date.now() - freshness < PR_PERSIST_TTL_MS;
            })
            .map(([key, entry]) => [key, toPersistedEntry(entry)]),
        ),
      }),
      merge: (persistedState, currentState) => {
        const persistedEntries = (persistedState as { entries?: Record<string, PersistedPrStatusEntry> } | undefined)?.entries ?? {};
        const current = currentState as GitHubPrStatusStore;
        return {
          ...current,
          entries: Object.fromEntries(
            Object.entries(persistedEntries).map(([key, entry]) => [key, hydrateEntry(entry)]),
          ),
        };
      },
    },
  ),
);

export const usePrStatusForDirectoryBranch = (directory: string | null, branch: string | null) => {
  return useGitHubPrStatusStore((state) => {
    if (!directory || !branch) return null;
    const key = getGitHubPrStatusKey(directory, branch);
    return state.entries[key] ?? null;
  });
};

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

let prKeyedCacheSigs = new Map<string, string>();
let prKeyedCacheResult: Map<string, PrVisualSummary> = new Map();

export const usePrVisualSummaryByKeys = (keys: string[]) => {
  return useGitHubPrStatusStore((state) => {
    // Derive summaries for requested keys only
    const nextSigs = new Map<string, string>();
    const nextSummaries = new Map<string, PrVisualSummary>();

    for (const key of keys) {
      const entry = state.entries[key];
      if (!entry) continue;
      const summary = deriveSummary(entry);
      if (!summary) continue;
      const sig = summarySignature(summary);
      nextSigs.set(key, sig);
      nextSummaries.set(key, summary);
    }

    // Compare with cached signatures
    if (nextSigs.size === prKeyedCacheSigs.size) {
      let same = true;
      for (const [k, sig] of nextSigs) {
        if (prKeyedCacheSigs.get(k) !== sig) { same = false; break; }
      }
      if (same) return prKeyedCacheResult;
    }

    prKeyedCacheSigs = nextSigs;
    prKeyedCacheResult = nextSummaries;
    return nextSummaries;
  });
};
