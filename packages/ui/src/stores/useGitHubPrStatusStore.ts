import { create } from 'zustand';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { persist } from 'zustand/middleware';
import { z } from 'zod';
import type {
  ChangeRequest,
  ChangeRequestStatus,
  CI,
  CISummary,
  Project,
  RuntimeAPIs,
  SourceControlIdentity,
  SourceControlProvider,
  SourceControlReadContext,
} from '@/lib/api/types';
import { mapWithConcurrency } from '@/lib/concurrency';
import { hasSameSourceControlReadContext } from '@/lib/source-control/identity';
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
const PR_STATUS_STORAGE_KEY = 'openchamber.source-control-status';
const LEGACY_PR_STATUS_STORAGE_KEY = 'openchamber.github-pr-status';
const PR_MAX_ENTRIES = 200;

const GITHUB_IDENTITY: SourceControlIdentity = { provider: 'github', instance: 'github.com' };
const statusKeySchema = z.union([
  z.tuple([z.string(), z.enum(['github', 'gitlab']), z.string(), z.string(), z.string(), z.number(), z.string(), z.string(), z.string()]),
  z.tuple([z.string(), z.enum(['github', 'gitlab']), z.string(), z.string(), z.string(), z.string()]),
  z.tuple([z.string(), z.string(), z.string(), z.string()]),
]);

export type SourceControlStatus = ChangeRequestStatus & {
  connected: boolean;
  pr: ChangeRequest | null;
  checks?: CISummary | null;
  repo: (Project & { repo: string }) | null;
} | {
  connected: boolean;
  identity?: SourceControlIdentity;
  fetchedAt?: number;
  project?: Project | null;
  branch?: string;
  changeRequest?: ChangeRequest | null;
  ci?: CI | null;
  canMerge?: boolean;
  defaultBranch?: string | null;
  resolvedRemoteName?: string | null;
  pr?: {
    number: number;
    title: string;
    body?: string;
    url: string;
    state: 'open' | 'closed' | 'merged';
    draft: boolean;
    base: string;
    head: string;
    headSha?: string;
    mergeable?: boolean | null;
    mergeableState?: string | null;
  } | null;
  checks?: CISummary | null;
  repo?: {
    owner: string;
    repo: string;
    url?: string;
    defaultBranch?: string;
    defaultBranchSha?: string | null;
    remoteName?: string | null;
  } | null;
};

const withStatusAliases = (status: ChangeRequestStatus): SourceControlStatus => ({
  ...status,
  connected: true,
  pr: status.changeRequest,
  checks: status.ci?.summary,
  repo: status.project ? { ...status.project, repo: status.project.name } : null,
});

const isTerminalPrState = (state: string | null | undefined): boolean => state === 'closed' || state === 'merged';
const isPendingChecks = (status: SourceControlStatus | null): boolean => {
  const checks = status?.checks;
  if (!checks) {
    return false;
  }
  return checks.state === 'pending' || checks.pending > 0;
};

const getOpenPrRefreshInterval = (status: SourceControlStatus | null): number => {
  if (isPendingChecks(status)) return PR_OPEN_BUSY_INTERVAL_MS;
  if (status?.checks && status.checks.state !== 'pending') return PR_OPEN_STABLE_INTERVAL_MS;
  return PR_OPEN_DEFAULT_INTERVAL_MS;
};

export const getGitHubPrStatusKey = (directory: string, branch: string, remoteName?: string | null): string =>
  JSON.stringify([getRuntimeKey(), GITHUB_IDENTITY.provider, GITHUB_IDENTITY.instance, directory, branch, remoteName ?? 'auto']);

type RefreshOptions = {
  force?: boolean;
  onlyExistingPr?: boolean;
  silent?: boolean;
  markInitialResolved?: boolean;
};

type PrTrackingTarget = {
  context?: SourceControlReadContext;
  identity?: SourceControlIdentity;
  directory?: string;
  branch: string;
  remoteName?: string | null;
};

type PrRuntimeParams = {
  runtimeKey?: string;
  directory: string;
  branch: string;
  remoteName: string | null;
  canShow: boolean;
  identity?: SourceControlIdentity;
  readContext?: SourceControlReadContext;
  sourceControl?: Pick<RuntimeAPIs['sourceControl'], 'changeRequestStatus'>;
  authChecked?: boolean;
  connected?: boolean | null;
};

const getParamsIdentity = (params: PrRuntimeParams): SourceControlIdentity => params.identity ?? GITHUB_IDENTITY;
const getAuthChecked = (params: PrRuntimeParams): boolean => params.authChecked ?? false;
const getConnected = (params: PrRuntimeParams): boolean | null => params.connected ?? null;

type PrEntryIdentity = {
  runtimeKey: string;
  provider?: SourceControlIdentity['provider'];
  instance?: string;
  directory: string;
  branch: string;
  remoteName: string | null;
  accountId?: string;
  repositoryId?: string;
  bindingRevision?: number;
};

type BoundPrEntryIdentity = PrEntryIdentity & {
  provider: SourceControlIdentity['provider'];
  instance: string;
  accountId: string;
  repositoryId: string;
  bindingRevision: number;
};

const createBoundEntryIdentity = (
  context: SourceControlReadContext,
  branch: string,
  runtimeKey: string,
): BoundPrEntryIdentity => ({
  runtimeKey,
  provider: context.provider,
  instance: context.instance,
  accountId: context.accountId,
  repositoryId: context.repositoryId,
  bindingRevision: context.bindingRevision,
  directory: context.directory,
  branch,
  remoteName: context.primaryRemote,
});

const hasSameReadContexts = (left: SourceControlReadContext[], right: SourceControlReadContext[]): boolean => (
  left.length === right.length && left.every((context, index) => {
    const candidate = right[index];
    return candidate !== undefined && hasSameSourceControlReadContext(context, candidate);
  })
);

const serializeBoundStatusKey = (identity: BoundPrEntryIdentity): string => JSON.stringify([
  identity.runtimeKey,
  identity.provider,
  identity.instance,
  identity.accountId,
  identity.repositoryId,
  identity.bindingRevision,
  identity.directory,
  identity.branch,
  identity.remoteName ?? 'auto',
]);

export const getSourceControlStatusKey = (
  context: SourceControlReadContext,
  branch: string,
): string => serializeBoundStatusKey(createBoundEntryIdentity(context, branch, getRuntimeKey()));

type PrStatusEntry = {
  status: SourceControlStatus | null;
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

type ActiveContextsRegistration = {
  requestId: number;
  contexts: SourceControlReadContext[];
};

type SourceControlStatusStore = {
  entries: Record<string, PrStatusEntry>;
  activeContextRegistrations: Record<string, Record<string, ActiveContextsRegistration>>;
  activeRequestCount: number;
  totalRequestCount: number;
  ensureEntry: (key: string) => void;
  beginActiveContextsLoad: (runtimeKey: string, directory: string, ownerId: string) => number;
  commitActiveContexts: (
    runtimeKey: string,
    directory: string,
    ownerId: string,
    requestId: number,
    contexts: SourceControlReadContext[],
  ) => boolean;
  releaseActiveContexts: (runtimeKey: string, directory: string, ownerId: string) => void;
  setParams: (key: string, params: PrRuntimeParams) => void;
  startWatching: (key: string) => void;
  stopWatching: (key: string) => void;
  refresh: (key: string, options?: RefreshOptions) => Promise<void>;
  refreshTargets: (targets: PrTrackingTarget[], options?: RefreshOptions) => Promise<void>;
  updateStatus: (key: string, updater: (prev: SourceControlStatus | null) => SourceControlStatus | null) => void;
  clearDirectoryStatus: (directory: string) => void;
  resetForRuntimeSwitch: () => void;
};

const timers = new Map<string, number>();
const bootstrapTimers = new Map<string, number[]>();
const inFlightBySignature = new Map<string, symbol>();
const lastRefreshBySignature = new Map<string, number>();
let prRuntimeGeneration = 0;
let activeContextsRequestId = 0;
const activeContextsRequestsByDirectory = new Map<string, Map<string, number>>();
const activeContextsCommitByDirectory = new Map<string, number>();

const getActiveContextsDirectoryKey = (runtimeKey: string, directory: string): string => (
  JSON.stringify([runtimeKey, directory])
);

const getActiveContexts = (
  registrations: Record<string, ActiveContextsRegistration> | undefined,
): SourceControlReadContext[] => {
  let latest: ActiveContextsRegistration | null = null;
  for (const registration of Object.values(registrations ?? {})) {
    if (!latest || registration.requestId > latest.requestId) {
      latest = registration;
    }
  }
  return latest?.contexts ?? [];
};

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
    const runtimeKey = entry.params.runtimeKey ?? entry.identity?.runtimeKey ?? getRuntimeKey();
    if (entry.params.readContext) {
      return {
        ...createBoundEntryIdentity(entry.params.readContext, entry.params.branch, runtimeKey),
        remoteName: entry.params.remoteName ?? entry.resolvedRemoteName ?? entry.identity?.remoteName ?? null,
      };
    }

    const identity = getParamsIdentity(entry.params);
    return {
      provider: identity.provider,
      instance: identity.instance,
      directory: entry.params.directory,
      branch: entry.params.branch,
      runtimeKey,
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
  return JSON.stringify([
    identity.runtimeKey, identity.provider, identity.instance, identity.directory, identity.branch, identity.remoteName ?? 'auto',
    identity.accountId, identity.repositoryId, identity.bindingRevision,
  ]);
};

const parseStatusKey = (key: string): PrEntryIdentity & { remote: string } | null => {
  try {
    const parsed = statusKeySchema.safeParse(JSON.parse(key));
    if (!parsed.success) return null;
    if (parsed.data.length === 4) {
      const [runtimeKey, directory, branch, remote] = parsed.data;
      return { runtimeKey, ...GITHUB_IDENTITY, directory, branch, remote, remoteName: remote === 'auto' ? null : remote };
    }
    if (parsed.data.length === 9) {
      const [runtimeKey, provider, instance, accountId, repositoryId, bindingRevision, directory, branch, remote] = parsed.data;
      return { runtimeKey, provider, instance, accountId, repositoryId, bindingRevision, directory, branch, remote, remoteName: remote };
    }
    const [runtimeKey, provider, instance, directory, branch, remote] = parsed.data;
    return { runtimeKey, provider, instance, directory, branch, remote, remoteName: remote === 'auto' ? null : remote };
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
      || parsed.provider !== target.provider
      || parsed.instance !== target.instance
      || parsed.accountId !== target.accountId
      || parsed.repositoryId !== target.repositoryId
      || parsed.bindingRevision !== target.bindingRevision
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
const getFreshestBoundPrEntryForBranch = (
  entries: Record<string, PrStatusEntry>,
  context: SourceControlReadContext,
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
      || parsed.provider !== context.provider
      || parsed.instance !== context.instance
      || parsed.accountId !== context.accountId
      || parsed.repositoryId !== context.repositoryId
      || parsed.bindingRevision !== context.bindingRevision
      || parsed.directory !== context.directory
      || parsed.branch !== branch
      || parsed.remoteName !== context.primaryRemote) {
      continue;
    }
    if (!best || entry.lastRefreshAt > best.lastRefreshAt) {
      best = entry;
    }
  }
  return best;
};

const getFreshestLegacyPrEntryForBranch = (
  entries: Record<string, PrStatusEntry>,
  identity: SourceControlIdentity,
  directory: string,
  branch: string,
): PrStatusEntry | null => {
  const runtimeKey = getRuntimeKey();
  let best: PrStatusEntry | null = null;
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry.status) continue;
    const parsed = parseStatusKey(key);
    if (!parsed
      || parsed.accountId
      || parsed.runtimeKey !== runtimeKey
      || parsed.provider !== identity.provider
      || parsed.instance !== identity.instance
      || parsed.directory !== directory
      || parsed.branch !== branch) continue;
    if (!best || entry.lastRefreshAt > best.lastRefreshAt) best = entry;
  }
  return best;
};

const getFreshestSourceControlEntryForBranch = (
  entries: Record<string, PrStatusEntry>,
  contexts: SourceControlReadContext[],
  branch: string,
): PrStatusEntry | null => {
  let bestWithChangeRequest: PrStatusEntry | null = null;
  let bestEmpty: PrStatusEntry | null = null;
  for (const context of contexts) {
    const entry = getFreshestBoundPrEntryForBranch(entries, context, branch);
    if (!entry) continue;
    if (entry.status?.changeRequest || entry.status?.pr) {
      if (!bestWithChangeRequest || entry.lastRefreshAt > bestWithChangeRequest.lastRefreshAt) bestWithChangeRequest = entry;
    } else if (!bestEmpty || entry.lastRefreshAt > bestEmpty.lastRefreshAt) {
      bestEmpty = entry;
    }
  }
  return bestWithChangeRequest ?? bestEmpty;
};

export const getFreshestSourceControlStatusForBranch = (
  entries: Record<string, PrStatusEntry>,
  context: SourceControlReadContext,
  branch: string,
): SourceControlStatus | null => {
  return getFreshestBoundPrEntryForBranch(entries, context, branch)?.status ?? null;
};

export const getFreshestActiveSourceControlStatusForBranch = (
  entries: Record<string, PrStatusEntry>, contexts: SourceControlReadContext[], branch: string,
): SourceControlStatus | null => getFreshestSourceControlEntryForBranch(entries, contexts, branch)?.status ?? null;

export const getFreshestPrStatusForBranch = (
  entries: Record<string, PrStatusEntry>, directory: string, branch: string,
): SourceControlStatus | null => getFreshestLegacyPrEntryForBranch(entries, GITHUB_IDENTITY, directory, branch)?.status ?? null;

const getKeysBySignature = (entries: Record<string, PrStatusEntry>, signature: string): string[] => {
  return Object.entries(entries)
    .filter(([, entry]) => getSignatureFromEntry(entry) === signature)
    .map(([key]) => key);
};

const mergeParams = (entry: PrStatusEntry, next: PrRuntimeParams): PrStatusEntry => {
  const runtimeKey = next.runtimeKey ?? getRuntimeKey();
  const currentIdentity = entry.params ? getParamsIdentity(entry.params) : GITHUB_IDENTITY;
  const nextIdentity = getParamsIdentity(next);
  const remoteName = next.remoteName ?? entry.params?.remoteName ?? entry.resolvedRemoteName ?? entry.identity?.remoteName ?? null;
  const paramsChanged = !entry.params
    || entry.params.runtimeKey !== runtimeKey
    || entry.params.directory !== next.directory
    || entry.params.branch !== next.branch
    || entry.params.remoteName !== remoteName
    || entry.params.canShow !== next.canShow
    || entry.params.readContext?.accountId !== next.readContext?.accountId
    || entry.params.readContext?.repositoryId !== next.readContext?.repositoryId
    || entry.params.readContext?.bindingRevision !== next.readContext?.bindingRevision
    || entry.params.readContext?.primaryRemote !== next.readContext?.primaryRemote
    || currentIdentity.provider !== nextIdentity.provider
    || currentIdentity.instance !== nextIdentity.instance
    || entry.params.sourceControl !== next.sourceControl
    || entry.params.authChecked !== next.authChecked
    || entry.params.connected !== next.connected;
  const entryIdentity = next.readContext
    ? {
        ...createBoundEntryIdentity(next.readContext, next.branch, runtimeKey),
        remoteName,
      }
    : {
        runtimeKey,
        provider: nextIdentity.provider,
        instance: nextIdentity.instance,
        directory: next.directory,
        branch: next.branch,
        remoteName,
      };

  const updatedEntry = {
    ...entry,
    paramsRevision: paramsChanged ? entry.paramsRevision + 1 : entry.paramsRevision,
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
    identity: entryIdentity,
  };
  if (paramsChanged) {
    updatedEntry.isLoading = false;
    updatedEntry.error = null;
  }
  return updatedEntry;
};

const getFetchableParams = (entry: PrStatusEntry | null | undefined): PrRuntimeParams | null => {
  if (!entry?.params?.canShow
    || !entry.params.sourceControl?.changeRequestStatus
    || !entry.params.readContext) {
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

const toPersistedEntry = (entry: PrStatusEntry): PersistedPrStatusEntry | null => {
  const parsed = persistedPrStatusEntrySchema.safeParse({
    status: entry.status,
    isInitialStatusResolved: entry.isInitialStatusResolved,
    lastRefreshAt: entry.lastRefreshAt,
    lastDiscoveryPollAt: entry.lastDiscoveryPollAt,
    identity: getIdentityFromEntry(entry),
    resolvedRemoteName: entry.resolvedRemoteName ?? entry.status?.resolvedRemoteName ?? null,
  });
  return parsed.success ? parsed.data : null;
};

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

const persistedPrStatusEntrySchema = z.object({
  status: z.object({
    connected: z.boolean(),
    fetchedAt: z.number().optional(),
    branch: z.string().optional(),
    canMerge: z.boolean().optional(),
    defaultBranch: z.string().nullable().optional(),
    resolvedRemoteName: z.string().nullable().optional(),
    pr: z.object({
      number: z.number(),
      title: z.string(),
      body: z.string().optional(),
      url: z.string(),
      state: z.enum(['open', 'closed', 'merged']),
      draft: z.boolean(),
      base: z.string(),
      head: z.string(),
      headSha: z.string().optional(),
      mergeable: z.boolean().nullable().optional(),
      mergeableState: z.string().nullable().optional(),
    }).strip().nullable().optional(),
    checks: z.object({
      state: z.enum(['success', 'failure', 'pending', 'unknown']),
      total: z.number(),
      success: z.number(),
      failure: z.number(),
      pending: z.number(),
      inProgress: z.number().optional(),
      queued: z.number().optional(),
      startedAt: z.string().optional(),
    }).strip().nullable().optional(),
    repo: z.object({
      owner: z.string(),
      repo: z.string(),
      url: z.string().optional(),
      defaultBranch: z.string().optional(),
      defaultBranchSha: z.string().nullable().optional(),
      remoteName: z.string().nullable().optional(),
    }).strip().nullable().optional(),
  }).strip().nullable().default(null),
  isInitialStatusResolved: z.boolean(),
  lastRefreshAt: z.number(),
  lastDiscoveryPollAt: z.number(),
  identity: z.object({
    runtimeKey: z.string(),
    provider: z.enum(['github', 'gitlab']),
    instance: z.string(),
    accountId: z.string(),
    repositoryId: z.string(),
    bindingRevision: z.number().int().positive(),
    directory: z.string(),
    branch: z.string(),
    remoteName: z.string().nullable(),
  }).nullable().default(null),
  resolvedRemoteName: z.string().nullable().default(null),
});
const persistedStatusStateSchema = z.object({
  entries: z.record(z.string(), z.unknown()).optional(),
});

const migratePersistedStatus = (persistedState: z.output<typeof persistedStatusStateSchema>) => {
  const entries = persistedState.entries ?? {};
  return {
    entries: Object.fromEntries(Object.entries(entries).flatMap(([key, rawEntry]) => {
      const parsedEntry = persistedPrStatusEntrySchema.safeParse(rawEntry);
      if (!parsedEntry.success) return [];
      const entry = parsedEntry.data;
      const parsed = parseStatusKey(key);
      if (!parsed?.accountId || !parsed.repositoryId || !parsed.bindingRevision || !entry.identity) return [];
      if (parsed.runtimeKey !== entry.identity.runtimeKey
        || parsed.provider !== entry.identity.provider
        || parsed.instance !== entry.identity.instance
        || parsed.accountId !== entry.identity.accountId
        || parsed.repositoryId !== entry.identity.repositoryId
        || parsed.bindingRevision !== entry.identity.bindingRevision
        || parsed.directory !== entry.identity.directory
        || parsed.branch !== entry.identity.branch
        || parsed.remoteName !== entry.identity.remoteName) return [];
      if (entry.status?.branch !== undefined && entry.status.branch !== parsed.branch) return [];
      const identity: BoundPrEntryIdentity = {
        ...entry.identity,
        remoteName: entry.identity.remoteName ?? parsed.remoteName,
      };
      const normalizedKey = serializeBoundStatusKey(identity);
      return [[normalizedKey, { ...entry, identity }]];
    })),
  };
};

const createPrStatusStorage = () => {
  const storage = createDeferredSafeJSONStorage<{ entries: Record<string, PersistedPrStatusEntry> }>();
  if (!storage) return undefined;
  return {
    ...storage,
    getItem: (name: string) => {
      const current = storage.getItem(name);
      if (current instanceof Promise) {
        return current.then((value) => value ?? storage.getItem(LEGACY_PR_STATUS_STORAGE_KEY));
      }
      return current ?? storage.getItem(LEGACY_PR_STATUS_STORAGE_KEY);
    },
  };
};

const boundEntries = (entries: Record<string, PrStatusEntry>, retainedKey: string): Record<string, PrStatusEntry> => {
  const all = Object.entries(entries);
  if (all.length <= PR_MAX_ENTRIES) return entries;
  const protectedEntries = all.filter(([key, entry]) => key === retainedKey || entry.watchers > 0 || entry.isLoading);
  const available = Math.max(0, PR_MAX_ENTRIES - protectedEntries.length);
  const recentEntries = all
    .filter(([key, entry]) => key !== retainedKey && entry.watchers === 0 && !entry.isLoading)
    .sort(([, left], [, right]) => Math.max(right.lastRefreshAt, right.lastDiscoveryPollAt)
      - Math.max(left.lastRefreshAt, left.lastDiscoveryPollAt))
    .slice(0, available);
  return Object.fromEntries([...protectedEntries, ...recentEntries]);
};

export const useGitHubPrStatusStore = create<SourceControlStatusStore>()(
  persist(
    (set, get) => ({
      entries: {},
      activeContextRegistrations: {},
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
        activeContextsRequestsByDirectory.clear();
        activeContextsCommitByDirectory.clear();
        set((state) => ({
          activeRequestCount: 0,
          activeContextRegistrations: {},
          entries: Object.fromEntries(Object.entries(state.entries).map(([key, entry]) => [key, {
            ...entry,
            watchers: 0,
            isLoading: false,
            params: null,
            paramsRevision: entry.paramsRevision + 1,
          }])),
        }));
      },

      beginActiveContextsLoad: (runtimeKey, directory, ownerId) => {
        const directoryKey = getActiveContextsDirectoryKey(runtimeKey, directory);
        const requestId = ++activeContextsRequestId;
        const requests = activeContextsRequestsByDirectory.get(directoryKey) ?? new Map<string, number>();
        requests.set(ownerId, requestId);
        activeContextsRequestsByDirectory.set(directoryKey, requests);
        return requestId;
      },

      commitActiveContexts: (runtimeKey, directory, ownerId, requestId, contexts) => {
        const directoryKey = getActiveContextsDirectoryKey(runtimeKey, directory);
        const requests = activeContextsRequestsByDirectory.get(directoryKey);
        const latestPendingRequestId = requests ? Math.max(...requests.values()) : 0;
        const latestCommittedRequestId = activeContextsCommitByDirectory.get(directoryKey) ?? 0;
        if (requests?.get(ownerId) !== requestId
          || latestPendingRequestId !== requestId
          || latestCommittedRequestId > requestId) {
          return false;
        }
        activeContextsCommitByDirectory.set(directoryKey, requestId);
        set((state) => {
          const directoryRegistrations = state.activeContextRegistrations[directoryKey] ?? {};
          const current = directoryRegistrations[ownerId];
          if (current?.requestId === requestId && hasSameReadContexts(current.contexts, contexts)) {
            return state;
          }

          const activeOwnerIds = [...Object.keys(directoryRegistrations), ownerId];
          return {
            activeContextRegistrations: {
              ...state.activeContextRegistrations,
              [directoryKey]: Object.fromEntries(
                activeOwnerIds.map((activeOwnerId) => [activeOwnerId, { requestId, contexts }]),
              ),
            },
          };
        });
        return true;
      },

      releaseActiveContexts: (runtimeKey, directory, ownerId) => {
        const directoryKey = getActiveContextsDirectoryKey(runtimeKey, directory);
        const requests = activeContextsRequestsByDirectory.get(directoryKey);
        requests?.delete(ownerId);
        if (requests?.size === 0) {
          activeContextsRequestsByDirectory.delete(directoryKey);
        }
        set((state) => {
          if (!state.activeContextRegistrations[directoryKey]?.[ownerId]) return state;
          const registrations = { ...state.activeContextRegistrations };
          const directoryRegistrations = { ...registrations[directoryKey] };
          delete directoryRegistrations[ownerId];
          if (Object.keys(directoryRegistrations).length === 0) {
            delete registrations[directoryKey];
          } else {
            registrations[directoryKey] = directoryRegistrations;
          }
          return { activeContextRegistrations: registrations };
        });
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
            }, key),
          };
        });
      },

      setParams: (key, params) => {
        set((state) => {
          const current = state.entries[key] ?? createEntry();
          const target = parseStatusKey(key);
          const entries = { ...state.entries };
          if (target && !target.accountId) {
            for (const [entryKey, entry] of Object.entries(entries)) {
              if (entryKey === key || entry.watchers > 0 || !entry.status) continue;
              const parsed = parseStatusKey(entryKey);
              if (!parsed
                || parsed.runtimeKey !== target.runtimeKey
                || parsed.directory !== target.directory
                || parsed.branch !== target.branch) continue;
              const sameAuthority = target.accountId
                ? parsed.provider === target.provider
                  && parsed.instance === target.instance
                  && parsed.accountId === target.accountId
                  && parsed.repositoryId === target.repositoryId
                  && parsed.bindingRevision === target.bindingRevision
                : parsed.provider === target.provider && parsed.instance === target.instance;
              if (sameAuthority) continue;
              entries[entryKey] = { ...entry, status: null, isInitialStatusResolved: false };
            }
          }
          return {
            entries: { ...entries, [key]: mergeParams(current, params) },
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

        const sourceControlIdentity = getParamsIdentity(params);
        if (getAuthChecked(params) && getConnected(params) === false) {
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
                status: {
                  identity: sourceControlIdentity,
                  connected: false,
                  project: null,
                  branch: params.branch,
                  changeRequest: null,
                  pr: null,
                  repo: null,
                },
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

        if (!params.sourceControl?.changeRequestStatus || !params.readContext) {
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
                error: 'Source control runtime API unavailable',
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

        const sourceControl = params.sourceControl;
        const readContext = params.readContext;
        try {
          set((prev) => ({
            ...prev,
            activeRequestCount: prev.activeRequestCount + 1,
            totalRequestCount: prev.totalRequestCount + 1,
          }));
          await acquirePrStatusNetworkSlot();
          let next: SourceControlStatus | null;
          try {
            next = await runBackgroundNetworkTask(async () => {
              if (!isCurrent()) return null;
              // Keep PR reads inside the aggregate HTTP budget as well as the
              // PR-specific cap. Separate caps otherwise occupy every socket.
              lastRefreshBySignature.set(signature, Date.now());
              return withStatusAliases(await sourceControl.changeRequestStatus(
                readContext,
                params.branch,
                { force: options?.force },
              ));
            });
          } finally {
            releasePrStatusNetworkSlot();
          }
          if (!next || !isCurrent()) return;
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
                provider: sourceControlIdentity.provider,
                instance: sourceControlIdentity.instance,
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
              const directory = target.context?.directory ?? target.directory?.trim() ?? '';
              const branch = target.branch.trim();
              if (!target.context || !directory || !branch) {
                return null;
              }
              return getSourceControlStatusKey(target.context, branch);
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

      clearDirectoryStatus: (directory) => {
        set((state) => {
          let changed = false;
          const entries = { ...state.entries };
          for (const [key, entry] of Object.entries(entries)) {
            if (parseStatusKey(key)?.directory !== directory
              || (!entry.status && !entry.isInitialStatusResolved && !entry.params)) continue;
            entries[key] = {
              ...entry,
              status: null,
              isLoading: false,
              isInitialStatusResolved: false,
              params: null,
              paramsRevision: entry.paramsRevision + 1,
            };
            changed = true;
          }
          return changed ? { entries } : state;
        });
      },

    }),
    {
      name: PR_STATUS_STORAGE_KEY,
      storage: createPrStatusStorage(),
      version: 3,
      migrate: (persistedState) => {
        const parsed = persistedStatusStateSchema.safeParse(persistedState);
        return migratePersistedStatus(parsed.success ? parsed.data : {});
      },
      partialize: (state) => ({
        entries: Object.fromEntries(
          Object.entries(state.entries)
            .filter(([, entry]) => {
              const identity = getIdentityFromEntry(entry);
              if (!identity?.directory || !identity.branch || !identity.accountId || !identity.repositoryId || !identity.bindingRevision) {
                return false;
              }
              const freshness = Math.max(entry.lastRefreshAt, entry.lastDiscoveryPollAt);
              return freshness > 0 && Date.now() - freshness < PR_PERSIST_TTL_MS;
            })
            .sort(([, left], [, right]) => Math.max(right.lastRefreshAt, right.lastDiscoveryPollAt)
              - Math.max(left.lastRefreshAt, left.lastDiscoveryPollAt))
            .slice(0, PR_MAX_ENTRIES)
            .flatMap(([key, entry]) => {
              const persisted = toPersistedEntry(entry);
              return persisted ? [[key, persisted]] : [];
            }),
        ),
      }),
      merge: (persistedState, currentState) => {
        const parsed = persistedStatusStateSchema.safeParse(persistedState);
        const persistedEntries = migratePersistedStatus(parsed.success ? parsed.data : {}).entries;
        const current = currentState as SourceControlStatusStore;
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
type PrVisualSummary = {
  provider: SourceControlProvider | null;
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

const derivePrVisualState = (status: SourceControlStatus | null): string | null => {
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
  const pr = entry.status?.changeRequest ?? entry.status?.pr;
  const checks = entry.status?.ci?.summary ?? entry.status?.checks;
  const project = entry.status?.project;
  const legacyRepo = entry.status?.repo;
  if (!vs || !pr?.number) return null;
  return {
    provider: entry.status?.identity?.provider ?? entry.identity?.provider ?? null,
    number: pr.number,
    visualState: vs,
    prState: pr.state,
    draft: Boolean(pr.draft),
    title: typeof pr.title === 'string' && pr.title.trim().length > 0 ? pr.title : null,
    url: typeof pr.url === 'string' && pr.url.trim().length > 0 ? pr.url : null,
    base: typeof pr.base === 'string' && pr.base.trim().length > 0 ? pr.base : null,
    head: typeof pr.head === 'string' && pr.head.trim().length > 0 ? pr.head : null,
    checks: checks
      ? { state: checks.state, total: checks.total, success: checks.success, failure: checks.failure, pending: checks.pending }
      : null,
    canMerge: typeof entry.status?.canMerge === 'boolean' ? entry.status.canMerge : null,
    mergeableState: typeof pr.mergeableState === 'string' ? pr.mergeableState : null,
    repo: project
      ? { owner: project.owner, repo: project.name }
      : legacyRepo ? { owner: legacyRepo.owner, repo: legacyRepo.repo } : null,
  };
};

const summarySignature = (s: PrVisualSummary): string =>
  `${s.provider ?? ''}:${s.number}:${s.visualState}:${s.prState}:${s.draft}:${s.title ?? ''}:${s.url ?? ''}:${s.base ?? ''}:${s.head ?? ''}:${s.canMerge ?? ''}:${s.mergeableState ?? ''}:${s.checks?.state ?? ''}:${s.checks?.total ?? ''}:${s.checks?.success ?? ''}:${s.checks?.failure ?? ''}:${s.checks?.pending ?? ''}:${s.repo?.owner ?? ''}:${s.repo?.repo ?? ''}`;

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

export const useFreshestSourceControlVisualSummaryForBranch = (
  directory: string | null,
  branch: string | null,
): PrVisualSummary | null => {
  const cacheKey = directory && branch ? JSON.stringify(['source-control-branch', getRuntimeKey(), directory, branch]) : null;
  return useGitHubPrStatusStore((state) => {
    if (!directory || !branch || !cacheKey) return null;
    const directoryKey = getActiveContextsDirectoryKey(getRuntimeKey(), directory);
    const contexts = getActiveContexts(state.activeContextRegistrations[directoryKey]);
    return getCachedPrSummary(cacheKey, getFreshestSourceControlEntryForBranch(state.entries, contexts, branch));
  });
};
