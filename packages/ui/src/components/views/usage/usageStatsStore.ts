import { create } from 'zustand';

import { fetchUsageStats, resolveUsageProjectID, type UsageStats } from '@/lib/opencode/session-stats';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

import { rangeStart, type UsageRange } from './usageStatsModel';

/**
 * In-memory cache of Stats page reports for the app session, one entry per
 * (runtime, range, project). Reopening the page or going back to a filter
 * shows the cached report without refetching; only a key with nothing cached
 * loads on its own, and the refresh button forces a new read. A runtime
 * switch drops every entry and ignores answers still in flight.
 *
 * `7d`/`30d` are relative to now: an entry reports the range it was fetched
 * for (`stats.range`) and when (`fetchedAt`), which the page shows.
 */

export type UsageStatsRequest = { range: UsageRange; projectDirectory: string | null };

export type UsageStatsEntry = {
  /** Last successful report; kept on screen through refreshes and failed refreshes. */
  stats: UsageStats | null;
  fetchedAt: number | null;
  loading: boolean;
  /** Message of the last failed read; cleared by the next success. */
  error: string | null;
};

export type UsageStatsFetcher = (request: UsageStatsRequest, signal: AbortSignal) => Promise<UsageStats>;

export const usageStatsKey = (runtimeKey: string, request: UsageStatsRequest): string =>
  `${runtimeKey}::${request.range}::${request.projectDirectory ?? '__all__'}`;

type UsageStatsStore = {
  entries: Record<string, UsageStatsEntry>;
  /**
   * Loads a report for the request under the current runtime. Without `force`
   * this only reads a key that has no report, no error and no read running.
   */
  load: (request: UsageStatsRequest, options?: { force?: boolean }) => Promise<void>;
  /** Forgets every entry and ignores reads still in flight. */
  reset: () => void;
};

const viewerTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const fetchFromOpencode: UsageStatsFetcher = async ({ range, projectDirectory }, signal) => {
  // The `project` filter takes OpenCode's project id, which only OpenCode
  // knows: ask it for the id of the project's directory. A failed lookup is
  // an error for this choice, never an unfiltered or empty report.
  const projectID = projectDirectory ? await resolveUsageProjectID(projectDirectory) : undefined;
  signal.throwIfAborted();
  return fetchUsageStats({ from: rangeStart(range, new Date()), projectID, timezone: viewerTimeZone() }, signal);
};

export function createUsageStatsStore(fetcher: UsageStatsFetcher, runtimeKey: () => string, now: () => number = Date.now) {
  // Aborted and replaced on reset, so reads from a previous runtime can
  // neither commit nor keep a key marked as loading.
  let controller = new AbortController();

  return create<UsageStatsStore>()((set, get) => {
    const patch = (key: string, next: Partial<UsageStatsEntry>) =>
      set((state) => {
        const previous = state.entries[key] ?? { stats: null, fetchedAt: null, loading: false, error: null };
        return { entries: { ...state.entries, [key]: { ...previous, ...next } } };
      });

    return {
      entries: {},

      load: async (request, options) => {
        const key = usageStatsKey(runtimeKey(), request);
        const entry = get().entries[key];
        if (entry?.loading) return;
        if (!options?.force && (entry?.stats || entry?.error)) return;

        const { signal } = controller;
        patch(key, { loading: true });
        try {
          const stats = await fetcher(request, signal);
          if (signal.aborted) return;
          // Written under the key the read started for: switching filters
          // while it runs never lets it land on another filter.
          patch(key, { stats, fetchedAt: now(), loading: false, error: null });
        } catch (error) {
          if (signal.aborted) return;
          // A failed read keeps the last report; it never becomes zeros.
          patch(key, { loading: false, error: error instanceof Error ? error.message : String(error) });
        }
      },

      reset: () => {
        controller.abort();
        controller = new AbortController();
        set({ entries: {} });
      },
    };
  });
}

export const useUsageStatsStore = createUsageStatsStore(fetchFromOpencode, getRuntimeKey);

export const selectUsageStatsEntry = (
  state: Pick<UsageStatsStore, 'entries'>,
  request: UsageStatsRequest,
): UsageStatsEntry | undefined => state.entries[usageStatsKey(getRuntimeKey(), request)];

subscribeRuntimeEndpointChanged(() => useUsageStatsStore.getState().reset());
