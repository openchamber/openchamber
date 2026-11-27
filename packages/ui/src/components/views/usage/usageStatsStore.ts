import React from 'react';
import { create } from 'zustand';

import { fetchUsageStats, fetchUsageTools, resolveUsageProjectID, type UsageStats, type UsageTokens, type UsageTools } from '@/lib/opencode/session-stats';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

import { bucketWindowKey, isSameLocalDay, rangeStart, type UsageRange } from './usageStatsModel';

export type UsageStatsRequest = { range: UsageRange; projectDirectory: string | null };

export type UsageStatsEntry = {
  stats: UsageStats | null;
  fetchedAt: number | null;
  loading: boolean;
  error: string | null;
};

export type UsageStatsFetcher = (request: UsageStatsRequest, signal: AbortSignal) => Promise<UsageStats>;

export type UsageToolsEntry = {
  tools: UsageTools | null;
  loading: boolean;
  error: string | null;
};

export type UsageToolsFetcher = (
  request: UsageStatsRequest,
  range: UsageStats['range'],
  signal: AbortSignal,
) => Promise<UsageTools>;

export type UsageTokenBucket = { from: number; to: number };

export type UsageTokenEntry = {
  tokens: UsageTokens | null;
  loading: boolean;
  error: string | null;
};

export type UsageTokenFetcher = (
  bucket: UsageTokenBucket,
  projectID: string | undefined,
  signal: AbortSignal,
) => Promise<UsageTokens>;

export type UsageProjectResolver = (directory: string) => Promise<string>;

export const usageStatsKey = (runtimeKey: string, request: UsageStatsRequest): string =>
  `${runtimeKey}::${request.range}::${request.projectDirectory ?? '__all__'}`;

export const usageTokenKey = (
  runtimeKey: string,
  projectDirectory: string | null,
  bucket: UsageTokenBucket,
): string => `${runtimeKey}::${projectDirectory ?? '__all__'}::${bucketWindowKey(bucket.from, bucket.to)}`;

type UsageStatsStore = {
  entries: Record<string, UsageStatsEntry>;
  load: (request: UsageStatsRequest, options?: { force?: boolean }) => Promise<void>;
  toolEntries: Record<string, UsageToolsEntry>;
  toolsRequested: boolean;
  loadTools: (request: UsageStatsRequest, options?: { force?: boolean }) => Promise<void>;
  tokenEntries: Record<string, UsageTokenEntry>;
  tokenVersion: number;
  loadTokens: (
    buckets: readonly UsageTokenBucket[],
    projectDirectory: string | null,
    options?: { force?: boolean },
  ) => Promise<void>;
  reset: () => void;
};

const viewerTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const fetchFromOpencode: UsageStatsFetcher = async ({ range, projectDirectory }, signal) => {
  const projectID = projectDirectory ? await resolveUsageProjectID(projectDirectory) : undefined;
  signal.throwIfAborted();
  return fetchUsageStats({ from: rangeStart(range, new Date()), projectID, timezone: viewerTimeZone() }, signal);
};

const fetchToolsFromOpencode: UsageToolsFetcher = async ({ projectDirectory }, window, signal) => {
  const projectID = projectDirectory ? await resolveUsageProjectID(projectDirectory) : undefined;
  signal.throwIfAborted();
  return fetchUsageTools({ from: window.from, to: window.to, projectID, timezone: viewerTimeZone() }, signal);
};

const TOKEN_READ_CONCURRENCY = 4;

const fetchTokenFromOpencode: UsageTokenFetcher = async (bucket, projectID, signal) => {
  const stats = await fetchUsageStats({ from: bucket.from, to: bucket.to, projectID, timezone: viewerTimeZone() }, signal);
  return stats.tokens;
};

const isExpiredToday = (request: UsageStatsRequest, entry: UsageStatsEntry | undefined, at: number): boolean =>
  request.range === '1d' && entry?.fetchedAt != null && !isSameLocalDay(entry.fetchedAt, at);

export function createUsageStatsStore(
  fetcher: UsageStatsFetcher,
  runtimeKey: () => string,
  now: () => number = Date.now,
  toolsFetcher: UsageToolsFetcher = fetchToolsFromOpencode,
  tokenFetcher: UsageTokenFetcher = fetchTokenFromOpencode,
  projectResolver: UsageProjectResolver = resolveUsageProjectID,
) {
  let controller = new AbortController();
  let tokenController = new AbortController();
  let tokenGeneration = 0;
  const currentToolReads = new Map<string, symbol>();

  return create<UsageStatsStore>()((set, get) => {
    const patch = (key: string, next: Partial<UsageStatsEntry>) =>
      set((state) => {
        const previous = state.entries[key] ?? { stats: null, fetchedAt: null, loading: false, error: null };
        return { entries: { ...state.entries, [key]: { ...previous, ...next } } };
      });

    const patchTools = (key: string, next: Partial<UsageToolsEntry>) =>
      set((state) => {
        const previous = state.toolEntries[key] ?? { tools: null, loading: false, error: null };
        return { toolEntries: { ...state.toolEntries, [key]: { ...previous, ...next } } };
      });

    const patchTokens = (key: string, next: Partial<UsageTokenEntry>) =>
      set((state) => {
        const previous = state.tokenEntries[key] ?? { tokens: null, loading: false, error: null };
        return { tokenEntries: { ...state.tokenEntries, [key]: { ...previous, ...next } } };
      });

    const dropTokenReads = () => {
      tokenController.abort();
      tokenController = new AbortController();
      tokenGeneration += 1;
      set((state) => ({ tokenEntries: {}, tokenVersion: state.tokenVersion + 1 }));
    };

    return {
      entries: {},
      toolEntries: {},
      tokenEntries: {},
      tokenVersion: 0,
      toolsRequested: false,

      load: async (request, options) => {
        const key = usageStatsKey(runtimeKey(), request);
        const entry = get().entries[key];
        if (entry?.loading) return;
        const startedAt = now();
        const expired = isExpiredToday(request, entry, startedAt);
        if (!options?.force && !expired && (entry?.stats || entry?.error)) return;
        if (options?.force) dropTokenReads();

        const { signal } = controller;
        if (expired) {
          patch(key, { stats: null, fetchedAt: null, loading: true, error: null });
          currentToolReads.delete(key);
          set((state) => {
            const { [key]: _expiredTools, ...toolEntries } = state.toolEntries;
            return { toolEntries };
          });
        } else {
          patch(key, { loading: true });
        }
        try {
          const stats = await fetcher(request, signal);
          if (signal.aborted) return;
          patch(key, { stats, fetchedAt: startedAt, loading: false, error: null });
          if (get().toolsRequested) void get().loadTools(request, { force: Boolean(get().toolEntries[key]?.tools) });
        } catch (error) {
          if (signal.aborted) return;
          patch(key, { loading: false, error: error instanceof Error ? error.message : String(error) });
        }
      },

      loadTools: async (request, options) => {
        const key = usageStatsKey(runtimeKey(), request);
        const window = get().entries[key]?.stats?.range;
        if (!window) return;
        set({ toolsRequested: true });
        const entry = get().toolEntries[key];
        if (entry?.loading) return;
        if (!options?.force && (entry?.tools || entry?.error)) return;

        const { signal } = controller;
        const read = Symbol('usage tools read');
        currentToolReads.set(key, read);
        const isDropped = () => signal.aborted || currentToolReads.get(key) !== read;
        patchTools(key, { loading: true });
        try {
          const tools = await toolsFetcher(request, window, signal);
          if (isDropped()) return;
          patchTools(key, { tools, loading: false, error: null });
        } catch (error) {
          if (isDropped()) return;
          patchTools(key, { loading: false, error: error instanceof Error ? error.message : String(error) });
        }
      },

      loadTokens: async (buckets, projectDirectory, options) => {
        if (buckets.length === 0) return;
        const runtime = runtimeKey();
        const unique = [...new Map(buckets.map((bucket) => [bucketWindowKey(bucket.from, bucket.to), bucket])).values()];
        const keyFor = (bucket: UsageTokenBucket) => usageTokenKey(runtime, projectDirectory, bucket);

        tokenController.abort();
        const batchController = new AbortController();
        tokenController = batchController;
        const generation = ++tokenGeneration;
        const { signal } = batchController;

        set((state) => {
          const tokenEntries = { ...state.tokenEntries };
          for (const bucket of unique) {
            const key = keyFor(bucket);
            const entry = tokenEntries[key];
            if (entry?.loading) tokenEntries[key] = { ...entry, loading: false };
          }
          return { tokenEntries };
        });

        const toLoad = unique.filter((bucket) => {
          const entry = get().tokenEntries[keyFor(bucket)];
          if (!options?.force && (entry?.tokens || entry?.error)) return false;
          return true;
        });
        if (toLoad.length === 0) return;

        for (const bucket of toLoad) patchTokens(keyFor(bucket), { loading: true, error: null });

        let projectID: string | undefined;
        try {
          projectID = projectDirectory ? await projectResolver(projectDirectory) : undefined;
          signal.throwIfAborted();
        } catch (error) {
          if (signal.aborted || generation !== tokenGeneration) return;
          const message = error instanceof Error ? error.message : String(error);
          for (const bucket of toLoad) patchTokens(keyFor(bucket), { loading: false, error: message });
          return;
        }

        const queue = [...toLoad];
        const worker = async () => {
          for (;;) {
            if (signal.aborted || generation !== tokenGeneration) return;
            const bucket = queue.shift();
            if (!bucket) return;
            const key = keyFor(bucket);
            try {
              const tokens = await tokenFetcher(bucket, projectID, signal);
              if (signal.aborted || generation !== tokenGeneration) return;
              patchTokens(key, { tokens, loading: false, error: null });
            } catch (error) {
              if (signal.aborted || generation !== tokenGeneration) return;
              patchTokens(key, { loading: false, error: error instanceof Error ? error.message : String(error) });
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(TOKEN_READ_CONCURRENCY, toLoad.length) }, () => worker()));
      },

      reset: () => {
        controller.abort();
        controller = new AbortController();
        dropTokenReads();
        set({ entries: {}, toolEntries: {} });
      },
    };
  });
}

export const useUsageStatsStore = createUsageStatsStore(fetchFromOpencode, getRuntimeKey);

const TODAY_CHECK_INTERVAL_MS = 60_000;

export function useTodayRollover(enabled: boolean, load: () => void): void {
  React.useEffect(() => {
    if (!enabled) return undefined;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') load();
    };
    const interval = window.setInterval(load, TODAY_CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, load]);
}

export const selectUsageToolsEntry = (
  state: Pick<UsageStatsStore, 'toolEntries'>,
  request: UsageStatsRequest,
): UsageToolsEntry | undefined => state.toolEntries[usageStatsKey(getRuntimeKey(), request)];

export const selectUsageStatsEntry = (
  state: Pick<UsageStatsStore, 'entries'>,
  request: UsageStatsRequest,
): UsageStatsEntry | undefined => state.entries[usageStatsKey(getRuntimeKey(), request)];

subscribeRuntimeEndpointChanged(() => useUsageStatsStore.getState().reset());
